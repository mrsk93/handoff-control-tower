import { describe, expect, it } from "vitest";
import { parseConfig } from "@handoff/config";

const baseEnv = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:app@127.0.0.1:5432/handoff_control_tower_demo",
  REDIS_URL: "redis://127.0.0.1:6379",
  ADAPTER_MODE: "mock",
  ENABLE_DEMO_SIMULATOR: "true",
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
});
