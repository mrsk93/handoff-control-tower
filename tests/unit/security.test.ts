import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  AuthenticationError,
  CredentialAccessDeniedError,
  FixedWindowRateLimiter,
  InMemoryRateLimitStore,
  authenticateSyntheticPrincipal,
  createAesGcmCredentialCipher,
  createInMemoryCredentialVault,
  createInMemoryProtectedReplayStore,
  redactHeaders,
  redactSensitive,
  redactUrl,
  sha256Hex,
  type OperatorPrincipal,
} from "@handoff/security";

const principalInput = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  subject: "operator-synthetic-1",
  role: "operator",
} as const;

describe("operator security seam", () => {
  it("authenticates a synthetic non-production principal and applies role permissions", () => {
    const principal = authenticateSyntheticPrincipal({
      ...principalInput,
      appEnv: "test",
    });

    expect(principal).toMatchObject({
      tenantId: principalInput.tenantId,
      subject: principalInput.subject,
      role: "operator",
      authMethod: "synthetic-header",
    });
    expect(() => principal.authorize("read")).not.toThrow();
    expect(() => principal.authorize("command")).not.toThrow();
    expect(() => principal.authorize("simulator")).toThrow(AccessDeniedError);
  });

  it("rejects missing role identity and synthetic authentication in production", () => {
    expect(() =>
      authenticateSyntheticPrincipal({ ...principalInput, role: undefined, appEnv: "test" }),
    ).toThrow(AuthenticationError);
    expect(() =>
      authenticateSyntheticPrincipal({ ...principalInput, appEnv: "production" }),
    ).toThrow("external operator authentication adapter is required");
  });

  it("enforces a deterministic fixed-window command limit", async () => {
    const limiter = new FixedWindowRateLimiter(new InMemoryRateLimitStore(), {
      command: { limit: 2, windowMs: 60_000 },
    });
    const now = new Date("2026-01-01T00:00:00.000Z");

    await expect(limiter.consume("tenant:operator", "command", now)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(
      limiter.consume("tenant:operator", "command", new Date(now.getTime() + 1)),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(
      limiter.consume("tenant:operator", "command", new Date(now.getTime() + 2)),
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });
    await expect(
      limiter.consume("tenant:operator", "command", new Date(now.getTime() + 60_000)),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
  });
});

describe("credential encryption seam", () => {
  it("round-trips credentials and binds ciphertext to tenant and system context", async () => {
    const cipher = createAesGcmCredentialCipher(Buffer.alloc(32, 7));
    const context = { tenantId: principalInput.tenantId, systemType: "commerce" };
    const plaintext = Buffer.from('{"clientSecret":"synthetic-only"}', "utf8");
    const ciphertext = await cipher.encrypt(plaintext, context);

    await expect(cipher.decrypt(ciphertext, context)).resolves.toEqual(plaintext);
    await expect(
      cipher.decrypt(ciphertext, { ...context, tenantId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow();
    expect(ciphertext).not.toContain(plaintext);
  });

  it("does not expose a credential key through the principal shape", () => {
    const principal: OperatorPrincipal = authenticateSyntheticPrincipal({
      ...principalInput,
      appEnv: "test",
    });
    expect(JSON.stringify(principal)).not.toContain("credential");
  });

  it("redacts nested PII, sensitive headers, and URL query values", () => {
    const redacted = redactSensitive({
      orderId: "order-1",
      customer: { email: "customer@example.com", address: { line1: "1 Main St" } },
      accessToken: "token-value",
      quantity: 2,
    }) as Record<string, unknown>;
    expect(redacted).toMatchObject({
      orderId: "order-1",
      customer: { email: "[REDACTED]", address: "[REDACTED]" },
      accessToken: "[REDACTED]",
      quantity: 2,
    });
    expect(
      redactHeaders({
        authorization: "Bearer secret-token",
        "x-request-id": "request-1",
        "x-tags": ["a", "b"],
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      "x-request-id": "request-1",
      "x-tags": ["a", "b"],
    });
    const safeUrl = redactUrl("https://example.test/orders?page=2&token=secret#private");
    expect(safeUrl).toContain("page=2");
    expect(safeUrl).not.toContain("secret");
    expect(safeUrl).not.toContain("private");
  });

  it("keeps credential vault reads tenant-scoped", async () => {
    const vault = createInMemoryCredentialVault(createAesGcmCredentialCipher(Buffer.alloc(32, 8)));
    const metadata = await vault.put({
      tenantId: principalInput.tenantId,
      systemType: "shopify",
      plaintext: Buffer.from("client-secret", "utf8"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(metadata).toEqual({
      tenantId: principalInput.tenantId,
      systemType: "shopify",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      vault.get({
        tenantId: principalInput.tenantId,
        systemType: "shopify",
        requesterTenantId: principalInput.tenantId,
      }),
    ).resolves.toEqual(Buffer.from("client-secret", "utf8"));
    await expect(
      vault.get({
        tenantId: principalInput.tenantId,
        systemType: "shopify",
        requesterTenantId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow(CredentialAccessDeniedError);
  });

  it("expires protected replay bodies and records redacted purge evidence", async () => {
    const receivedAt = new Date("2026-01-01T00:00:00.000Z");
    let currentTime = receivedAt;
    const audits: Array<{ action: string; replayId: string; bodySha256: string }> = [];
    const store = createInMemoryProtectedReplayStore(
      createAesGcmCredentialCipher(Buffer.alloc(32, 9)),
      {
        now: () => currentTime,
        audit: (event) => audits.push(event),
      },
    );
    const rawBody = Buffer.from('{"email":"customer@example.com"}', "utf8");
    const metadata = await store.put({
      replayId: "replay-1",
      tenantId: principalInput.tenantId,
      source: "shopify",
      rawBody,
      receivedAt,
      expiresAt: new Date(receivedAt.getTime() + 60_000),
    });
    expect(metadata.bodySha256).toBe(sha256Hex(rawBody));
    expect(JSON.stringify(metadata)).not.toContain("customer@example.com");
    await expect(
      store.read({ replayId: "replay-1", tenantId: principalInput.tenantId }),
    ).resolves.toEqual(rawBody);
    await expect(
      store.read({
        replayId: "replay-1",
        tenantId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow(CredentialAccessDeniedError);
    currentTime = new Date(receivedAt.getTime() + 60_000);
    await expect(
      store.read({ replayId: "replay-1", tenantId: principalInput.tenantId }),
    ).resolves.toBeNull();
    expect(audits.map(({ action }) => action)).toEqual([
      "replay.stored",
      "replay.read",
      "replay.purged",
    ]);
    await expect(
      store.put({
        replayId: "replay-too-long",
        tenantId: principalInput.tenantId,
        source: "shopify",
        rawBody,
        receivedAt,
        expiresAt: new Date(receivedAt.getTime() + 16 * 60_000),
      }),
    ).rejects.toThrow("short-lived window");
  });
});
