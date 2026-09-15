import { describe, expect, it } from "vitest";
import { parseConfig } from "@handoff/config";

const baseEnv = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:app@127.0.0.1:5432/handoff_control_tower_demo",
  REDIS_URL: "redis://127.0.0.1:6379",
  ADAPTER_MODE: "mock",
  ENABLE_DEMO_SIMULATOR: "true",
};

const sandboxEnv = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://app:app@127.0.0.1:5432/handoff_control_tower_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  ADAPTER_MODE: "sandbox",
  ENABLE_DEMO_SIMULATOR: "false",
  PUBLIC_BASE_URL: "https://demo.example.test",
  RETRY_PROFILE: "production-like",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_SHOP_DOMAIN: "demo-shop.myshopify.com",
  SHOPIFY_CLIENT_ID: "shopify-client-id",
  SHOPIFY_CLIENT_SECRET: "shopify-client-secret",
  SHOPIFY_ADMIN_ACCESS_TOKEN: "shopify-admin-token",
  ERPNEXT_API_VERSION: "v1",
  ERPNEXT_BASE_URL: "https://erpnext-sandbox.example.test",
  ERPNEXT_API_KEY: "erpnext-api-key",
  ERPNEXT_API_SECRET: "erpnext-api-secret",
  ERPNEXT_WEBHOOK_SECRET: "erpnext-webhook-secret",
  ERPNEXT_SUBMIT_TRANSACTIONS: "false",
  SHIPBOB_ENV: "sandbox",
  SHIPBOB_API_VERSION: "2026-07",
  SHIPBOB_BASE_URL: "https://sandbox-api.shipbob.com",
  SHIPBOB_PAT: "shipbob-pat",
  SHIPBOB_WEBHOOK_SECRET: "shipbob-webhook-secret",
};

describe("configuration", () => {
  it("parses safe local defaults", () => {
    const config = parseConfig(baseEnv);
    expect(config.appEnv).toBe("development");
    expect(config.adapterMode).toBe("mock");
    expect(config.outboxMaxAttempts).toBe(5);
    expect(config.outboxRetryBaseMs).toBe(1000);
    expect(config.outboxRetryMaxMs).toBe(60000);
    expect(config.outboxRetryJitterMs).toBe(250);
  });

  it("refuses the demo simulator in production", () => {
    expect(() => parseConfig({ ...baseEnv, APP_ENV: "production" })).toThrow(
      "ENABLE_DEMO_SIMULATOR=true is not allowed",
    );
  });

  it("rejects non-PostgreSQL database URLs", () => {
    expect(() => parseConfig({ ...baseEnv, DATABASE_URL: "sqlite://local" })).toThrow(
      "DATABASE_URL must use postgres: or postgresql:",
    );
  });

  it("requires a sufficiently strong credential encryption secret", () => {
    expect(() => parseConfig({ ...baseEnv, CREDENTIAL_ENCRYPTION_SECRET: "too-short" })).toThrow(
      "CREDENTIAL_ENCRYPTION_SECRET must be at least 16 characters",
    );
    expect(parseConfig(baseEnv).credentialEncryptionSecret).toBe(
      "local-credential-encryption-secret",
    );
  });

  it("accepts the integration mode compatibility alias and exposes typed provider defaults", () => {
    const config = parseConfig({ ...baseEnv, ADAPTER_MODE: undefined, INTEGRATION_MODE: "mock" });
    expect(config.adapterMode).toBe("mock");
    expect(config.integrationMode).toBe("mock");
    expect(config.retryProfile).toBe("local");
    expect(config.shopify.apiVersion).toBe("2026-07");
    expect(config.erpnext.apiVersion).toBe("v1");
    expect(config.shipbob.environment).toBe("sandbox");
  });

  it("rejects conflicting mode aliases", () => {
    expect(() =>
      parseConfig({ ...baseEnv, ADAPTER_MODE: "mock", INTEGRATION_MODE: "sandbox" }),
    ).toThrow("ADAPTER_MODE and INTEGRATION_MODE must match");
  });

  it("fails closed when sandbox credentials are incomplete without echoing secrets", () => {
    expect(() => parseConfig({ ...sandboxEnv, SHOPIFY_ADMIN_ACCESS_TOKEN: undefined })).toThrow(
      "SHOPIFY_ADMIN_ACCESS_TOKEN is required",
    );
    expect(() => parseConfig({ ...sandboxEnv, SHOPIFY_ADMIN_ACCESS_TOKEN: undefined })).not.toThrow(
      "shopify-admin-token",
    );
  });

  it("parses a complete sandbox profile with explicit provider policy", () => {
    const config = parseConfig(sandboxEnv);
    expect(config.adapterMode).toBe("sandbox");
    expect(config.integrationMode).toBe("sandbox");
    expect(config.retryProfile).toBe("production-like");
    expect(config.publicBaseUrl).toBe("https://demo.example.test");
    expect(config.shopify.shopDomain).toBe("demo-shop.myshopify.com");
    expect(config.erpnext.submitTransactions).toBe(false);
    expect(config.shipbob.baseUrl).toBe("https://sandbox-api.shipbob.com");
  });

  it("rejects invalid or production provider endpoints in sandbox mode", () => {
    expect(() => parseConfig({ ...sandboxEnv, SHOPIFY_API_VERSION: "latest" })).toThrow(
      "SHOPIFY_API_VERSION must be a pinned YYYY-MM API version",
    );
    expect(() =>
      parseConfig({ ...sandboxEnv, SHIPBOB_BASE_URL: "https://api.shipbob.com" }),
    ).toThrow("must use the sandbox-api.shipbob.com host");
    expect(() => parseConfig({ ...sandboxEnv, ERPNEXT_BASE_URL: "http://erpnext.com" })).toThrow(
      "ERPNEXT_BASE_URL must use https:",
    );
    expect(() => parseConfig({ ...sandboxEnv, SHOPIFY_SHOP_DOMAIN: "admin.shopify.com" })).toThrow(
      "SHOPIFY_SHOP_DOMAIN must be a *.myshopify.com development-store domain",
    );
  });
});
