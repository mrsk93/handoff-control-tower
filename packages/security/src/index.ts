import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type ApplicationEnvironment = "development" | "test" | "production";

export const operatorRoles = ["viewer", "operator", "admin"] as const;
export type OperatorRole = (typeof operatorRoles)[number];

export type OperatorPermission = "read" | "command" | "simulator";

const rolePermissions: Record<OperatorRole, readonly OperatorPermission[]> = {
  viewer: ["read"],
  operator: ["read", "command"],
  admin: ["read", "command", "simulator"],
};

export class AuthenticationError extends Error {
  readonly code = "AUTHENTICATION_REQUIRED";

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AccessDeniedError extends Error {
  readonly code = "FORBIDDEN_ROLE";

  constructor(
    readonly role: OperatorRole,
    readonly permission: OperatorPermission,
  ) {
    super(`role ${role} is not allowed to ${permission}`);
    this.name = "AccessDeniedError";
  }
}

export type OperatorPrincipal = {
  tenantId: string;
  subject: string;
  role: OperatorRole;
  authMethod: "synthetic-header";
  authorize(permission: OperatorPermission): void;
};

function required(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new AuthenticationError(`${name} is required`);
  }
  return value.trim();
}

export function authenticateSyntheticPrincipal(input: {
  tenantId: string | undefined;
  subject: string | undefined;
  role: string | undefined;
  appEnv: ApplicationEnvironment;
}): OperatorPrincipal {
  if (input.appEnv === "production") {
    throw new AuthenticationError("external operator authentication adapter is required");
  }
  const tenantId = required(input.tenantId, "tenantId");
  const subject = required(input.subject, "operatorId");
  const roleValue = required(input.role, "operatorRole");
  if (!operatorRoles.includes(roleValue as OperatorRole)) {
    throw new AuthenticationError("operatorRole is invalid");
  }
  const role = roleValue as OperatorRole;
  return {
    tenantId,
    subject,
    role,
    authMethod: "synthetic-header",
    authorize(permission: OperatorPermission): void {
      if (!rolePermissions[role].includes(permission)) {
        throw new AccessDeniedError(role, permission);
      }
    },
  };
}

export type RateLimitRule = {
  limit: number;
  windowMs: number;
};

export type RateLimitStore = {
  increment(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }>;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
};

export class RateLimitExceededError extends Error {
  readonly code = "RATE_LIMITED";

  constructor(readonly decision: RateLimitDecision) {
    super("rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

type Bucket = { startAt: number; count: number };

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  increment(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> {
    const startAt = Math.floor(now.getTime() / windowMs) * windowMs;
    const current = this.buckets.get(key);
    const bucket = current?.startAt === startAt ? current : { startAt, count: 0 };
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return Promise.resolve({ count: bucket.count, resetAt: new Date(startAt + windowMs) });
  }
}

export class FixedWindowRateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly rules: Readonly<Record<string, RateLimitRule>>,
  ) {}

  async consume(key: string, ruleName: string, now = new Date()): Promise<RateLimitDecision> {
    const rule = this.rules[ruleName];
    if (
      !rule ||
      !Number.isInteger(rule.limit) ||
      rule.limit < 1 ||
      !Number.isInteger(rule.windowMs) ||
      rule.windowMs < 1
    ) {
      throw new Error(`rate limit rule ${ruleName} is invalid or missing`);
    }
    const result = await this.store.increment(`${ruleName}:${key}`, rule.windowMs, now);
    const remaining = Math.max(0, rule.limit - result.count);
    const decision: RateLimitDecision = {
      allowed: result.count <= rule.limit,
      limit: rule.limit,
      remaining,
      resetAt: result.resetAt,
      retryAfterMs: Math.max(0, result.resetAt.getTime() - now.getTime()),
    };
    return decision;
  }
}

export function assertRateLimit(decision: RateLimitDecision): void {
  if (!decision.allowed) throw new RateLimitExceededError(decision);
}

export type CredentialEncryptionContext = {
  tenantId: string;
  systemType: string;
};

export type CredentialCipher = {
  encrypt(plaintext: Buffer, context: CredentialEncryptionContext): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context: CredentialEncryptionContext): Promise<Buffer>;
};

const CREDENTIAL_FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function associatedData(context: CredentialEncryptionContext): Buffer {
  return Buffer.from(`${context.tenantId}:${context.systemType}`, "utf8");
}

export function createAesGcmCredentialCipher(masterKey: Buffer): CredentialCipher {
  if (masterKey.length !== 32) throw new Error("credential encryption key must be 32 bytes");
  const key = Buffer.from(masterKey);
  return {
    async encrypt(plaintext, context): Promise<Buffer> {
      await Promise.resolve();
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(associatedData(context));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([
        Buffer.from([CREDENTIAL_FORMAT_VERSION]),
        nonce,
        cipher.getAuthTag(),
        encrypted,
      ]);
    },
    async decrypt(ciphertext, context): Promise<Buffer> {
      await Promise.resolve();
      if (ciphertext.length < 1 + NONCE_BYTES + AUTH_TAG_BYTES) {
        throw new Error("credential ciphertext is truncated");
      }
      if (ciphertext[0] !== CREDENTIAL_FORMAT_VERSION) {
        throw new Error("credential ciphertext version is unsupported");
      }
      const nonce = ciphertext.subarray(1, 1 + NONCE_BYTES);
      const tagStart = 1 + NONCE_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(ciphertext.subarray(tagStart, tagStart + AUTH_TAG_BYTES));
      return Buffer.concat([
        decipher.update(ciphertext.subarray(tagStart + AUTH_TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
}

export function deriveCredentialKey(secret: string): Buffer {
  if (secret.trim().length < 16) throw new Error("credential encryption secret is too short");
  return createHash("sha256").update(secret, "utf8").digest();
}
