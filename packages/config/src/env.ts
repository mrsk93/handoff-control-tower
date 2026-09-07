export type AppEnvironment = "development" | "test" | "production";

export type MockWebhookSecrets = {
  commerce: string;
  wms: string;
  carrier: string;
};

export type AppConfig = {
  appEnv: AppEnvironment;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  adapterMode: "mock";
  outboxMaxAttempts: number;
  outboxRetryBaseMs: number;
  outboxRetryMaxMs: number;
  outboxRetryJitterMs: number;
  parkedEventMaxAgeMinutes: number;
  reconciliationIntervalMinutes: number;
  allowPartialInvoiceEligibility: boolean;
  enableDemoSimulator: boolean;
  ingestMaxBodyBytes: number;
  credentialEncryptionSecret: string;
  rateLimits: {
    ingestionPerMinute: number;
    commandPerMinute: number;
    retryPerMinute: number;
    reconciliationPerMinute: number;
  };
  mockWebhookSecrets: MockWebhookSecrets;
};

function required(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function enumValue<T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
): T {
  const candidate = required(value, name);
  if (!values.includes(candidate as T)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return candidate as T;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  const raw = value === undefined || value.trim() === "" ? String(fallback) : value.trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, name: string, fallback: boolean): boolean {
  const raw = value === undefined || value.trim() === "" ? String(fallback) : value.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function assertUrl(value: string, name: string, protocols: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  return value;
}

function secretValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  appEnv: AppEnvironment,
): string {
  const value = (env[name] ?? fallback).trim();
  if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
  if (appEnv === "production" && value === fallback) {
    throw new Error(`${name} must be explicitly configured in production`);
  }
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const appEnv = enumValue(env.APP_ENV ?? "development", "APP_ENV", [
    "development",
    "test",
    "production",
  ] as const);
  const adapterMode = enumValue(env.ADAPTER_MODE ?? "mock", "ADAPTER_MODE", ["mock"] as const);
  const enableDemoSimulator = booleanValue(
    env.ENABLE_DEMO_SIMULATOR,
    "ENABLE_DEMO_SIMULATOR",
    true,
  );

  if (appEnv === "production" && enableDemoSimulator) {
    throw new Error("ENABLE_DEMO_SIMULATOR=true is not allowed when APP_ENV=production");
  }

  return {
    appEnv,
    port: positiveInteger(env.PORT, "PORT", 3000),
    databaseUrl: assertUrl(required(env.DATABASE_URL, "DATABASE_URL"), "DATABASE_URL", [
      "postgres:",
      "postgresql:",
    ]),
    redisUrl: assertUrl(required(env.REDIS_URL, "REDIS_URL"), "REDIS_URL", ["redis:", "rediss:"]),
    adapterMode,
    outboxMaxAttempts: positiveInteger(env.OUTBOX_MAX_ATTEMPTS, "OUTBOX_MAX_ATTEMPTS", 5),
    outboxRetryBaseMs: positiveInteger(env.OUTBOX_RETRY_BASE_MS, "OUTBOX_RETRY_BASE_MS", 1_000),
    outboxRetryMaxMs: positiveInteger(env.OUTBOX_RETRY_MAX_MS, "OUTBOX_RETRY_MAX_MS", 60_000),
    outboxRetryJitterMs: positiveInteger(env.OUTBOX_RETRY_JITTER_MS, "OUTBOX_RETRY_JITTER_MS", 250),
    parkedEventMaxAgeMinutes: positiveInteger(
      env.PARKED_EVENT_MAX_AGE_MINUTES,
      "PARKED_EVENT_MAX_AGE_MINUTES",
      30,
    ),
    reconciliationIntervalMinutes: positiveInteger(
      env.RECONCILIATION_INTERVAL_MINUTES,
      "RECONCILIATION_INTERVAL_MINUTES",
      15,
    ),
    allowPartialInvoiceEligibility: booleanValue(
      env.ALLOW_PARTIAL_INVOICE_ELIGIBILITY,
      "ALLOW_PARTIAL_INVOICE_ELIGIBILITY",
      false,
    ),
    enableDemoSimulator,
    ingestMaxBodyBytes: positiveInteger(
      env.INGEST_MAX_BODY_BYTES,
      "INGEST_MAX_BODY_BYTES",
      1_048_576,
    ),
    credentialEncryptionSecret: secretValue(
      env,
      "CREDENTIAL_ENCRYPTION_SECRET",
      "local-credential-encryption-secret",
      appEnv,
    ),
    rateLimits: {
      ingestionPerMinute: positiveInteger(
        env.INGEST_RATE_LIMIT_PER_MINUTE,
        "INGEST_RATE_LIMIT_PER_MINUTE",
        60,
      ),
      commandPerMinute: positiveInteger(
        env.COMMAND_RATE_LIMIT_PER_MINUTE,
        "COMMAND_RATE_LIMIT_PER_MINUTE",
        30,
      ),
      retryPerMinute: positiveInteger(
        env.RETRY_RATE_LIMIT_PER_MINUTE,
        "RETRY_RATE_LIMIT_PER_MINUTE",
        10,
      ),
      reconciliationPerMinute: positiveInteger(
        env.RECONCILIATION_RATE_LIMIT_PER_MINUTE,
        "RECONCILIATION_RATE_LIMIT_PER_MINUTE",
        5,
      ),
    },
    mockWebhookSecrets: {
      commerce: secretValue(env, "MOCK_COMMERCE_WEBHOOK_SECRET", "local-commerce-secret", appEnv),
      wms: secretValue(env, "MOCK_WMS_WEBHOOK_SECRET", "local-wms-secret", appEnv),
      carrier: secretValue(env, "MOCK_CARRIER_WEBHOOK_SECRET", "local-carrier-secret", appEnv),
    },
  };
}

export function databaseName(databaseUrl: string): string {
  const pathname = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!pathname) {
    throw new Error("DATABASE_URL must include a database name");
  }
  return decodeURIComponent(pathname);
}

export function assertSafeResetDatabase(config: Pick<AppConfig, "appEnv" | "databaseUrl">): void {
  const name = databaseName(config.databaseUrl);
  const allowedEnvironment = config.appEnv === "development" || config.appEnv === "test";
  const allowedName = /^handoff_control_tower_(demo|test)(?:_[a-z0-9_]+)?$/.test(name);
  if (!allowedEnvironment || !allowedName) {
    throw new Error(
      `Refusing reset for database "${name}". Use APP_ENV=development/test and an explicit handoff_control_tower_demo/test database.`,
    );
  }
}
