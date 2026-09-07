import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  AuthenticationError,
  FixedWindowRateLimiter,
  InMemoryRateLimitStore,
  authenticateSyntheticPrincipal,
  createAesGcmCredentialCipher,
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
});
