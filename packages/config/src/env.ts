export type AppEnvironment = "development" | "test" | "production";

export type MockWebhookSecrets = {
  commerce: string;
  wms: string;
  carrier: string;
};

export type AdapterMode = "mock" | "sandbox";
export type RetryProfile = "local" | "production-like";

export type ShopifyIntegrationConfig = {
  apiVersion: string;
  shopDomain: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  adminAccessToken: string | undefined;
};

export type ErpNextIntegrationConfig = {
  apiVersion: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  webhookSecret: string | undefined;
  submitTransactions: boolean;
};

export type ShipBobIntegrationConfig = {
  environment: "sandbox";
  apiVersion: string;
  baseUrl: string | undefined;
  personalAccessToken: string | undefined;
  channelId: string | undefined;
  webhookSecret: string | undefined;
};

export type AppConfig = {
  appEnv: AppEnvironment;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  adapterMode: AdapterMode;
  integrationMode: AdapterMode;
  publicBaseUrl: string | undefined;
  retryProfile: RetryProfile;
  shopify: ShopifyIntegrationConfig;
  erpnext: ErpNextIntegrationConfig;
  shipbob: ShipBobIntegrationConfig;
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

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function versionValue(value: string | undefined, name: string, fallback: string): string {
  const candidate = value === undefined || value.trim() === "" ? fallback : value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) {
    throw new Error(`${name} must be a pinned version value`);
  }
  return candidate;
}

function datedVersionValue(value: string | undefined, name: string, fallback: string): string {
  const candidate = versionValue(value, name, fallback);
  if (!/^\d{4}-\d{2}$/.test(candidate)) {
    throw new Error(`${name} must be a pinned YYYY-MM API version`);
  }
  return candidate;
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

function assertHttpsUrl(value: string, name: string): string {
  return assertUrl(value, name, ["https:"]);
}

function assertShopifyDomain(value: string, name: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/i.test(value)) {
    throw new Error(`${name} must be a *.myshopify.com development-store domain`);
  }
  return value.toLowerCase();
}

function assertSandboxShipBobUrl(value: string, name: string): string {
  const url = new URL(assertHttpsUrl(value, name));
  if (url.hostname !== "sandbox-api.shipbob.com") {
    throw new Error(`${name} must use the sandbox-api.shipbob.com host in sandbox mode`);
  }
  return value;
}

function assertSandboxErpNextUrl(value: string, name: string): string {
  const url = new URL(assertHttpsUrl(value, name));
  if (url.hostname === "erpnext.com" || url.hostname.endsWith(".erpnext.com")) {
    throw new Error(
      `${name} must point to a disposable ERPNext site, not the public production host`,
    );
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
  const configuredAdapterMode = optionalValue(env.ADAPTER_MODE);
  const configuredIntegrationMode = optionalValue(env.INTEGRATION_MODE);
  if (
    configuredAdapterMode !== undefined &&
    configuredIntegrationMode !== undefined &&
    configuredAdapterMode !== configuredIntegrationMode
  ) {
    throw new Error("ADAPTER_MODE and INTEGRATION_MODE must match when both are configured");
  }
  const modeValue = configuredAdapterMode ?? configuredIntegrationMode ?? "mock";
  const adapterMode = enumValue(
    modeValue,
    configuredAdapterMode === undefined ? "INTEGRATION_MODE" : "ADAPTER_MODE",
    ["mock", "sandbox"] as const,
  );
  const enableDemoSimulator = booleanValue(
    env.ENABLE_DEMO_SIMULATOR,
    "ENABLE_DEMO_SIMULATOR",
    true,
  );

  if (appEnv === "production" && enableDemoSimulator) {
    throw new Error("ENABLE_DEMO_SIMULATOR=true is not allowed when APP_ENV=production");
  }

  const publicBaseUrlValue = optionalValue(env.PUBLIC_BASE_URL);
  const publicBaseUrl =
    publicBaseUrlValue === undefined
      ? undefined
      : appEnv === "production"
        ? assertHttpsUrl(publicBaseUrlValue, "PUBLIC_BASE_URL")
        : assertUrl(publicBaseUrlValue, "PUBLIC_BASE_URL", ["http:", "https:"]);
  const retryProfile = enumValue(
    env.RETRY_PROFILE ?? (adapterMode === "sandbox" ? "production-like" : "local"),
    "RETRY_PROFILE",
    ["local", "production-like"] as const,
  );
  const erpnextSubmitTransactions = booleanValue(
    env.ERPNEXT_SUBMIT_TRANSACTIONS,
    "ERPNEXT_SUBMIT_TRANSACTIONS",
    false,
  );

  const shopifyApiVersion = datedVersionValue(
    env.SHOPIFY_API_VERSION,
    "SHOPIFY_API_VERSION",
    "2026-07",
  );
  const erpnextApiVersion = versionValue(env.ERPNEXT_API_VERSION, "ERPNEXT_API_VERSION", "v1");
  const shipbobApiVersion = datedVersionValue(
    env.SHIPBOB_API_VERSION,
    "SHIPBOB_API_VERSION",
    "2026-07",
  );
  const shopifyShopDomain = optionalValue(env.SHOPIFY_SHOP_DOMAIN);
  const erpnextBaseUrl = optionalValue(env.ERPNEXT_BASE_URL);
  const shipbobBaseUrl = optionalValue(env.SHIPBOB_BASE_URL);

  const shopify: ShopifyIntegrationConfig = {
    apiVersion: shopifyApiVersion,
    shopDomain:
      shopifyShopDomain === undefined
        ? undefined
        : assertShopifyDomain(shopifyShopDomain, "SHOPIFY_SHOP_DOMAIN"),
    clientId: optionalValue(env.SHOPIFY_CLIENT_ID),
    clientSecret: optionalValue(env.SHOPIFY_CLIENT_SECRET),
    adminAccessToken: optionalValue(env.SHOPIFY_ADMIN_ACCESS_TOKEN),
  };
  const erpnext: ErpNextIntegrationConfig = {
    apiVersion: erpnextApiVersion,
    baseUrl:
      erpnextBaseUrl === undefined
        ? undefined
        : assertUrl(erpnextBaseUrl, "ERPNEXT_BASE_URL", ["http:", "https:"]),
    apiKey: optionalValue(env.ERPNEXT_API_KEY),
    apiSecret: optionalValue(env.ERPNEXT_API_SECRET),
    webhookSecret: optionalValue(env.ERPNEXT_WEBHOOK_SECRET),
    submitTransactions: erpnextSubmitTransactions,
  };
  const shipbobEnvironment = enumValue(env.SHIPBOB_ENV ?? "sandbox", "SHIPBOB_ENV", [
    "sandbox",
  ] as const);
  const shipbob: ShipBobIntegrationConfig = {
    environment: shipbobEnvironment,
    apiVersion: shipbobApiVersion,
    baseUrl:
      shipbobBaseUrl === undefined
        ? undefined
        : assertUrl(shipbobBaseUrl, "SHIPBOB_BASE_URL", ["http:", "https:"]),
    personalAccessToken: optionalValue(env.SHIPBOB_PAT),
    channelId: optionalValue(env.SHIPBOB_CHANNEL_ID),
    webhookSecret: optionalValue(env.SHIPBOB_WEBHOOK_SECRET),
  };

  if (adapterMode === "sandbox") {
    if (appEnv === "production" && env.SHIPBOB_ENV !== "sandbox") {
      throw new Error("SHIPBOB_ENV must be sandbox for the sandbox adapter mode");
    }
    if (publicBaseUrl === undefined) {
      throw new Error("PUBLIC_BASE_URL is required in sandbox adapter mode");
    }
    if (retryProfile !== "production-like") {
      throw new Error("RETRY_PROFILE must be production-like in sandbox adapter mode");
    }
    if (erpnextSubmitTransactions && env.ERPNEXT_SUBMIT_TRANSACTIONS === undefined) {
      throw new Error(
        "ERPNEXT_SUBMIT_TRANSACTIONS must be explicit when submitting ERPNext transactions",
      );
    }
    shopify.shopDomain = assertShopifyDomain(
      required(env.SHOPIFY_SHOP_DOMAIN, "SHOPIFY_SHOP_DOMAIN"),
      "SHOPIFY_SHOP_DOMAIN",
    );
    shopify.clientId = required(env.SHOPIFY_CLIENT_ID, "SHOPIFY_CLIENT_ID");
    shopify.clientSecret = required(env.SHOPIFY_CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET");
    shopify.adminAccessToken = required(
      env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      "SHOPIFY_ADMIN_ACCESS_TOKEN",
    );
    erpnext.baseUrl = assertSandboxErpNextUrl(
      required(env.ERPNEXT_BASE_URL, "ERPNEXT_BASE_URL"),
      "ERPNEXT_BASE_URL",
    );
    erpnext.apiKey = required(env.ERPNEXT_API_KEY, "ERPNEXT_API_KEY");
    erpnext.apiSecret = required(env.ERPNEXT_API_SECRET, "ERPNEXT_API_SECRET");
    erpnext.webhookSecret = required(env.ERPNEXT_WEBHOOK_SECRET, "ERPNEXT_WEBHOOK_SECRET");
    shipbob.baseUrl = assertSandboxShipBobUrl(
      required(env.SHIPBOB_BASE_URL, "SHIPBOB_BASE_URL"),
      "SHIPBOB_BASE_URL",
    );
    shipbob.personalAccessToken = required(env.SHIPBOB_PAT, "SHIPBOB_PAT");
    shipbob.webhookSecret = required(env.SHIPBOB_WEBHOOK_SECRET, "SHIPBOB_WEBHOOK_SECRET");
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
    integrationMode: adapterMode,
    publicBaseUrl,
    retryProfile,
    shopify,
    erpnext,
    shipbob,
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
