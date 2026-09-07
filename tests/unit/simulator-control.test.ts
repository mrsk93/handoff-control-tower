import { describe, expect, it } from "vitest";
import { createMockAdapterSuite } from "@handoff/adapters";
import { parseConfig } from "@handoff/config";
import { HttpException } from "@nestjs/common";
import { parseScenario, SimulatorController } from "../../apps/api/src/simulator.controller";

const baseEnv = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:app@127.0.0.1:5432/handoff_control_tower_demo",
  REDIS_URL: "redis://127.0.0.1:6379",
  ADAPTER_MODE: "mock",
  ENABLE_DEMO_SIMULATOR: "true",
};

describe("simulator control seam", () => {
  it("applies and resets a reproducible scenario", () => {
    const suite = createMockAdapterSuite();
    const controller = new SimulatorController(parseConfig(baseEnv), suite);
    const scenario = {
      seed: 42,
      failureRate: 0.25,
      delayMs: 3,
      failures: { "commerce.get_order": 1 },
    };

    expect(controller.setScenario(scenario, "operator-m5", "admin")).toEqual({
      enabled: true,
      scenario,
    });
    expect(controller.getScenario("operator-m5", "admin")).toEqual({ enabled: true, scenario });
    expect(controller.resetScenario("operator-m5", "admin")).toMatchObject({
      enabled: true,
      scenario: { seed: 1, failureRate: 0, delayMs: 0 },
    });
  });

  it("rejects unknown operations and invalid scenario values", () => {
    expect(() =>
      parseScenario({ seed: 1, failureRate: 0, delayMs: 0, failures: { unknown: 1 } }),
    ).toThrow(HttpException);
    expect(() => parseScenario({ seed: -1, failureRate: 0, delayMs: 0 })).toThrow(HttpException);
    expect(() => parseScenario({ seed: 1, failureRate: 2, delayMs: 0 })).toThrow(HttpException);
  });

  it("is unavailable when the demo simulator is disabled", () => {
    const suite = createMockAdapterSuite();
    const controller = new SimulatorController(
      parseConfig({ ...baseEnv, ENABLE_DEMO_SIMULATOR: "false" }),
      suite,
    );
    try {
      controller.getScenario("operator-m5", "admin");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(404);
      expect((error as HttpException).getResponse()).toEqual({
        error: "DEMO_SIMULATOR_DISABLED",
      });
    }
  });
});
