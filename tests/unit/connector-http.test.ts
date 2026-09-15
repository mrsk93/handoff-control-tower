import { describe, expect, it } from "vitest";
import { ConnectorHttpTransport } from "@handoff/adapters";
import { ConnectorError } from "@handoff/domain";

type FixtureHandler = (request: Request) => Response | Promise<Response>;

function fixtureFetch(routes: Readonly<Record<string, FixtureHandler>>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const handler = routes[new URL(request.url).pathname];
    return handler ? handler(request) : new Response("not found", { status: 404 });
  };
}

function delayedResponse(delayMs: number, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ ok: true })), delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function transport(
  routes: Readonly<Record<string, FixtureHandler>>,
  options: Partial<ConstructorParameters<typeof ConnectorHttpTransport>[0]> = {},
) {
  return new ConnectorHttpTransport({
    allowedHosts: ["fixture.test"],
    allowedProtocols: ["https:"],
    timeoutMs: 250,
    maxResponseBytes: 1024,
    fetchImpl: fixtureFetch(routes),
    ...options,
  });
}

describe("connector HTTP transport", () => {
  it("adds request metadata and parses a bounded JSON response", async () => {
    const requests: Request[] = [];
    const result = await transport(
      {
        "/orders": (request) => {
          requests.push(request);
          return Response.json(
            { ok: true },
            { headers: { "x-provider-request-id": "provider-1" } },
          );
        },
      },
      { apiVersion: "2026-07" },
    ).request<{ ok: boolean }>({
      url: "https://fixture.test/orders",
      operation: "orders.list",
      requestId: "request-1",
    });
    expect(requests[0]?.headers.get("x-request-id")).toBe("request-1");
    expect(requests[0]?.headers.get("x-api-version")).toBe("2026-07");
    expect(result).toMatchObject({
      value: { ok: true },
      requestId: "request-1",
      statusCode: 200,
      contentType: "application/json",
    });
  });

  it("classifies timeouts and caller aborts as retryable without provider payloads", async () => {
    const timeoutError = await transport(
      { "/timeout": (request) => delayedResponse(100, request.signal) },
      { timeoutMs: 10 },
    )
      .request({
        url: "https://fixture.test/timeout",
        operation: "orders.timeout",
        requestId: "timeout-1",
      })
      .catch((error: unknown) => error);
    expect(timeoutError).toMatchObject({
      code: "CONNECTOR_TIMEOUT",
      category: "retryable",
      retryable: true,
      metadata: { requestId: "timeout-1", operation: "orders.timeout" },
    });
    expect(String(timeoutError)).not.toContain("never logged");

    const controller = new AbortController();
    const pending = transport({
      "/abort": (request) => delayedResponse(100, request.signal),
    }).request({
      url: "https://fixture.test/abort",
      operation: "orders.abort",
      requestId: "abort-1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CONNECTOR_ABORTED",
      category: "retryable",
      metadata: { requestId: "abort-1", operation: "orders.abort" },
    });
  });

  it("rejects oversized and malformed responses before exposing their payload", async () => {
    await expect(
      transport(
        {
          "/large": () =>
            new Response("x".repeat(2048), {
              headers: { "content-length": "2048" },
            }),
        },
        { maxResponseBytes: 64 },
      ).request({
        url: "https://fixture.test/large",
        operation: "orders.large",
        requestId: "large-1",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_RESPONSE_TOO_LARGE", category: "validation" });
    await expect(
      transport({
        "/malformed": () =>
          new Response("{not-json", { headers: { "content-type": "application/json" } }),
      }).request({
        url: "https://fixture.test/malformed",
        operation: "orders.malformed",
        requestId: "json-1",
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_INVALID_JSON",
      category: "validation",
      metadata: { operation: "orders.malformed" },
    });
  });

  it.each([
    [401, "authentication", false],
    [422, "validation", false],
    [429, "rate_limited", true],
    [500, "retryable", true],
  ] as const)("maps HTTP %s to connector category %s", async (statusCode, category, retryable) => {
    const result = await transport({
      "/status": () => {
        const init: ResponseInit =
          statusCode === 429
            ? { status: statusCode, headers: { "retry-after": "3" } }
            : { status: statusCode };
        return new Response("provider details must not escape", init);
      },
    })
      .request({
        url: "https://fixture.test/status",
        operation: "orders.status",
        requestId: `status-${statusCode}`,
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ConnectorError);
    expect(result).toMatchObject({
      category,
      retryable,
      metadata: { statusCode, requestId: `status-${statusCode}`, operation: "orders.status" },
    });
    if (statusCode === 429) expect(result).toMatchObject({ metadata: { retryAfterMs: 3000 } });
    expect(String(result)).not.toContain("provider details");
  });

  it("follows only allowlisted redirects and rejects unsafe destinations", async () => {
    await expect(
      transport(
        {
          "/redirect": () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.test/orders" },
            }),
        },
        { maxRedirects: 1 },
      ).request({
        url: "https://fixture.test/redirect",
        operation: "orders.redirect",
        requestId: "redirect-1",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_CAPABILITY_UNSUPPORTED", category: "unsupported" });
    await expect(
      transport({}).request({
        url: "https://not-allowlisted.example.test/orders",
        operation: "orders.host",
        requestId: "host-1",
      }),
    ).rejects.toMatchObject({ code: "CONNECTOR_CAPABILITY_UNSUPPORTED", category: "unsupported" });
  });
});
