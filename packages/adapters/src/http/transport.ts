import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  PermanentConnectorError,
  RetryableConnectorError,
  UnsupportedConnectorError,
  connectorErrorFromStatus,
} from "@handoff/domain";
import type { ConnectorResult } from "@handoff/domain";

export type HttpBody = string | Uint8Array | ArrayBuffer;
export type HttpResponseType = "json" | "text" | "bytes";

export type ConnectorHttpRequest = {
  method?: string;
  url: string;
  operation: string;
  requestId?: string;
  headers?: Readonly<Record<string, string>>;
  body?: HttpBody;
  responseType?: HttpResponseType;
  signal?: AbortSignal;
};

export type ConnectorHttpResponse<T> = ConnectorResult<T> & {
  statusCode: number;
  contentType?: string;
};

export type ConnectorHttpTransportOptions = {
  allowedHosts: readonly string[];
  allowedProtocols?: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 0;

function normalizeHosts(hosts: readonly string[]): Set<string> {
  return new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0));
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function safeStatusMetadata(
  response: Response,
  requestId: string,
  operation: string,
): { requestId: string; operation: string; statusCode: number; retryAfterMs?: number } {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return {
    requestId,
    operation,
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function validateDestination(
  rawUrl: string,
  allowedHosts: Set<string>,
  allowedProtocols: readonly string[],
  operation: string,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PermanentConnectorError(
      "connector URL is invalid",
      "CONNECTOR_INVALID_URL",
      { operation },
      "validation",
    );
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new UnsupportedConnectorError("connector URL protocol is not allowed", {
      operation,
    });
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new UnsupportedConnectorError("connector URL host is not allowlisted", {
      operation,
    });
  }
  return url;
}

async function readBody(
  response: Response,
  maxBytes: number,
  metadata: { requestId: string; operation: string; statusCode: number },
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new PermanentConnectorError(
        "connector response exceeded the configured byte limit",
        "CONNECTOR_RESPONSE_TOO_LARGE",
        metadata,
        "validation",
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Uint8Array.from(next.value as ArrayLike<number>);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PermanentConnectorError(
          "connector response exceeded the configured byte limit",
          "CONNECTOR_RESPONSE_TOO_LARGE",
          metadata,
          "validation",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

function parseBody<T>(
  body: Buffer,
  responseType: HttpResponseType,
  metadata: { requestId: string; operation: string },
): T {
  if (responseType === "bytes") return body as T;
  const text = body.toString("utf8");
  if (responseType === "text") return text as T;
  if (text.trim().length === 0) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PermanentConnectorError(
      "connector returned malformed JSON",
      "CONNECTOR_INVALID_JSON",
      metadata,
      "validation",
    );
  }
}

export class ConnectorHttpTransport {
  private readonly allowedHosts: Set<string>;
  private readonly allowedProtocols: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ConnectorHttpTransportOptions) {
    this.allowedHosts = normalizeHosts(options.allowedHosts);
    if (this.allowedHosts.size === 0)
      throw new Error("at least one allowed connector host is required");
    this.allowedProtocols = options.allowedProtocols ?? ["https:"];
    this.timeoutMs = validatePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxResponseBytes = validatePositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    if (
      !Number.isInteger(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS) ||
      (options.maxRedirects ?? 0) < 0
    ) {
      throw new Error("maxRedirects must be a non-negative integer");
    }
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(request: ConnectorHttpRequest): Promise<ConnectorHttpResponse<T>> {
    const requestId = request.requestId ?? randomUUID();
    return this.execute<T>(request, requestId, 0);
  }

  private async execute<T>(
    request: ConnectorHttpRequest,
    requestId: string,
    redirectCount: number,
  ): Promise<ConnectorHttpResponse<T>> {
    const url = validateDestination(
      request.url,
      this.allowedHosts,
      this.allowedProtocols,
      request.operation,
    );
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abortCaller = () => controller.abort();
    request.signal?.addEventListener("abort", abortCaller, { once: true });
    if (request.signal?.aborted) controller.abort();
    const headers = new Headers(request.headers);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("x-request-id", requestId);
    if (this.options.apiVersion) headers.set("x-api-version", this.options.apiVersion);
    if (request.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    try {
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.body !== undefined) init.body = request.body;
      const response = await this.fetchImpl(url, init);
      const metadata = safeStatusMetadata(response, requestId, request.operation);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) {
          throw new UnsupportedConnectorError(
            "connector redirect did not include a location",
            metadata,
          );
        }
        if (redirectCount >= this.maxRedirects) {
          throw new UnsupportedConnectorError("connector redirect limit was reached", metadata);
        }
        const target = validateDestination(
          new URL(location, url).toString(),
          this.allowedHosts,
          this.allowedProtocols,
          request.operation,
        );
        return this.execute<T>(
          { ...request, url: target.toString() },
          requestId,
          redirectCount + 1,
        );
      }
      const body = await readBody(response, this.maxResponseBytes, metadata);
      if (!response.ok)
        throw connectorErrorFromStatus(response.status, request.operation, metadata);
      const responseType = request.responseType ?? "json";
      const contentType = response.headers.get("content-type");
      return {
        value: parseBody<T>(body, responseType, metadata),
        requestId,
        statusCode: response.status,
        ...(contentType === null ? {} : { contentType }),
        ...(metadata.retryAfterMs === undefined
          ? {}
          : { rateLimit: { resetAt: new Date(Date.now() + metadata.retryAfterMs).toISOString() } }),
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (timedOut) {
        throw new RetryableConnectorError("connector request timed out", "CONNECTOR_TIMEOUT", {
          operation: request.operation,
          requestId,
        });
      }
      if (request.signal?.aborted) {
        throw new RetryableConnectorError("connector request was aborted", "CONNECTOR_ABORTED", {
          operation: request.operation,
          requestId,
        });
      }
      throw new RetryableConnectorError(
        "connector request failed before receiving a response",
        "CONNECTOR_NETWORK_ERROR",
        {
          operation: request.operation,
          requestId,
        },
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortCaller);
    }
  }
}
