import { createHash } from "node:crypto";

export const REDACTED_VALUE = "[REDACTED]";

const sensitiveKeyPattern =
  /(?:authorization|api[-_]?key|client[-_]?secret|cookie|card|cvv|email|first[-_]?name|full[-_]?name|last[-_]?name|mobile|password|phone|postal|secret|signature|ssn|token|address|zip)/i;

export type RedactionOptions = {
  replacement?: string;
  maxDepth?: number;
};

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}

export function redactSensitive(value: unknown, options: RedactionOptions = {}): unknown {
  const replacement = options.replacement ?? REDACTED_VALUE;
  const maxDepth = options.maxDepth ?? 8;

  function redact(input: unknown, depth: number, key?: string): unknown {
    if (key && isSensitiveKey(key)) return replacement;
    if (input === null || typeof input === "string" || typeof input === "number") return input;
    if (typeof input === "boolean") return input;
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Buffer.isBuffer(input)) return "[REDACTED_BINARY]";
    if (depth >= maxDepth) return "[REDACTED_DEPTH]";
    if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1));
    if (typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([entryKey, entryValue]) => [
          entryKey,
          redact(entryValue, depth + 1, entryKey),
        ]),
      );
    }
    return replacement;
  }

  return redact(value, 0);
}

export type HeaderValue = string | readonly string[] | undefined;

export function redactHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
  options: RedactionOptions = {},
): Record<string, string | string[]> {
  const replacement = options.replacement ?? REDACTED_VALUE;
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isSensitiveKey(name)) result[name] = replacement;
    else if (typeof value === "string" || value === undefined) result[name] = value ?? "";
    else result[name] = Array.from(value);
  }
  return result;
}

export function redactQueryString(query: string, options: RedactionOptions = {}): string {
  const replacement = options.replacement ?? REDACTED_VALUE;
  const prefix = query.startsWith("?") ? "?" : "";
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  for (const key of params.keys()) {
    if (isSensitiveKey(key)) params.set(key, replacement);
  }
  const rendered = params.toString();
  return rendered.length > 0 ? `${prefix}${rendered}` : prefix;
}

export function redactUrl(rawUrl: string, options: RedactionOptions = {}): string {
  try {
    const url = new URL(rawUrl);
    const query = redactQueryString(url.search, options);
    url.search = query;
    url.hash = "";
    return url.toString();
  } catch {
    return redactQueryString(rawUrl, options);
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export class CredentialAccessDeniedError extends Error {
  readonly code = "CREDENTIAL_ACCESS_DENIED";

  constructor() {
    super("credential access is limited to the owning tenant");
    this.name = "CredentialAccessDeniedError";
  }
}

export type CredentialAccessRequest = {
  ownerTenantId: string;
  requesterTenantId: string;
  systemType: string;
};

export function assertCredentialAccess(request: CredentialAccessRequest): void {
  if (
    request.ownerTenantId.trim().length === 0 ||
    request.requesterTenantId.trim().length === 0 ||
    request.systemType.trim().length === 0 ||
    request.ownerTenantId !== request.requesterTenantId
  ) {
    throw new CredentialAccessDeniedError();
  }
}

export type CredentialCipherLike = {
  encrypt(plaintext: Buffer, context: { tenantId: string; systemType: string }): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context: { tenantId: string; systemType: string }): Promise<Buffer>;
};

export type CredentialMetadata = {
  tenantId: string;
  systemType: string;
  updatedAt: string;
};

export type CredentialVault = {
  put(input: {
    tenantId: string;
    systemType: string;
    plaintext: Buffer;
    updatedAt?: Date;
  }): Promise<CredentialMetadata>;
  get(input: {
    tenantId: string;
    systemType: string;
    requesterTenantId: string;
  }): Promise<Buffer | null>;
};

export function createInMemoryCredentialVault(cipher: CredentialCipherLike): CredentialVault {
  const records = new Map<string, { metadata: CredentialMetadata; ciphertext: Buffer }>();

  return {
    async put(input) {
      assertCredentialAccess({
        ownerTenantId: input.tenantId,
        requesterTenantId: input.tenantId,
        systemType: input.systemType,
      });
      const metadata: CredentialMetadata = {
        tenantId: input.tenantId,
        systemType: input.systemType,
        updatedAt: (input.updatedAt ?? new Date()).toISOString(),
      };
      records.set(`${input.tenantId}:${input.systemType}`, {
        metadata,
        ciphertext: Buffer.from(
          await cipher.encrypt(input.plaintext, {
            tenantId: input.tenantId,
            systemType: input.systemType,
          }),
        ),
      });
      return { ...metadata };
    },
    async get(input) {
      assertCredentialAccess({
        ownerTenantId: input.tenantId,
        requesterTenantId: input.requesterTenantId,
        systemType: input.systemType,
      });
      const record = records.get(`${input.tenantId}:${input.systemType}`);
      if (!record) return null;
      return cipher.decrypt(Buffer.from(record.ciphertext), {
        tenantId: record.metadata.tenantId,
        systemType: record.metadata.systemType,
      });
    },
  };
}

export type ReplayMetadata = {
  replayId: string;
  tenantId: string;
  source: string;
  receivedAt: string;
  expiresAt: string;
  bodySha256: string;
};

export type ReplayAuditEvent = {
  action: "replay.stored" | "replay.read" | "replay.purged";
  replayId: string;
  tenantId: string;
  occurredAt: string;
  bodySha256: string;
};

export type ProtectedReplayStore = {
  put(input: {
    replayId: string;
    tenantId: string;
    source: string;
    rawBody: Buffer;
    receivedAt: Date;
    expiresAt: Date;
  }): Promise<ReplayMetadata>;
  read(input: { replayId: string; tenantId: string; now?: Date }): Promise<Buffer | null>;
  purgeExpired(now?: Date): Promise<ReplayMetadata[]>;
};

export function createInMemoryProtectedReplayStore(
  cipher: CredentialCipherLike,
  options: {
    maxTtlMs?: number;
    now?: () => Date;
    audit?: (event: ReplayAuditEvent) => void;
  } = {},
): ProtectedReplayStore {
  const maxTtlMs = options.maxTtlMs ?? 15 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  const records = new Map<string, { metadata: ReplayMetadata; ciphertext: Buffer }>();

  function recordAudit(
    action: ReplayAuditEvent["action"],
    metadata: ReplayMetadata,
    at: Date,
  ): void {
    options.audit?.({
      action,
      replayId: metadata.replayId,
      tenantId: metadata.tenantId,
      occurredAt: at.toISOString(),
      bodySha256: metadata.bodySha256,
    });
  }

  return {
    async put(input) {
      const ttlMs = input.expiresAt.getTime() - input.receivedAt.getTime();
      if (ttlMs <= 0 || ttlMs > maxTtlMs) {
        throw new Error("replay expiry must be in the allowed short-lived window");
      }
      if (input.replayId.trim().length === 0 || input.tenantId.trim().length === 0) {
        throw new Error("replayId and tenantId are required");
      }
      const existing = records.get(input.replayId);
      if (existing) {
        assertCredentialAccess({
          ownerTenantId: existing.metadata.tenantId,
          requesterTenantId: input.tenantId,
          systemType: "replay",
        });
        return { ...existing.metadata };
      }
      const metadata: ReplayMetadata = {
        replayId: input.replayId,
        tenantId: input.tenantId,
        source: input.source,
        receivedAt: input.receivedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        bodySha256: sha256Hex(input.rawBody),
      };
      records.set(input.replayId, {
        metadata,
        ciphertext: Buffer.from(
          await cipher.encrypt(input.rawBody, { tenantId: input.tenantId, systemType: "replay" }),
        ),
      });
      recordAudit("replay.stored", metadata, input.receivedAt);
      return { ...metadata };
    },
    async read(input) {
      const record = records.get(input.replayId);
      if (!record) return null;
      assertCredentialAccess({
        ownerTenantId: record.metadata.tenantId,
        requesterTenantId: input.tenantId,
        systemType: "replay",
      });
      const observedAt = input.now ?? now();
      if (observedAt.getTime() >= Date.parse(record.metadata.expiresAt)) {
        records.delete(input.replayId);
        recordAudit("replay.purged", record.metadata, observedAt);
        return null;
      }
      recordAudit("replay.read", record.metadata, observedAt);
      return cipher.decrypt(Buffer.from(record.ciphertext), {
        tenantId: record.metadata.tenantId,
        systemType: "replay",
      });
    },
    purgeExpired(observedAt = now()) {
      const expired: ReplayMetadata[] = [];
      for (const [replayId, record] of records) {
        if (observedAt.getTime() < Date.parse(record.metadata.expiresAt)) continue;
        records.delete(replayId);
        expired.push({ ...record.metadata });
        recordAudit("replay.purged", record.metadata, observedAt);
      }
      return Promise.resolve(expired);
    },
  };
}
