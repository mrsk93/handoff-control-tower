import { describe, expect, it } from "vitest";
import {
  runScenario,
  runScenarioCampaign,
  scenarioFixtures,
  scenarioIds,
} from "@handoff/scenarios";

describe("M11 named scenario campaign", () => {
  it("declares every named scenario with a complete fixture contract", () => {
    expect(scenarioFixtures).toHaveLength(15);
    expect(scenarioFixtures.map((fixture) => fixture.id)).toEqual(scenarioIds);
    for (const fixture of scenarioFixtures) {
      expect(fixture.inputs.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.expected.exceptionCodes, fixture.id).toBeDefined();
      expect(fixture.expected.outboxEffects, fixture.id).toBeDefined();
      expect(fixture.expected.auditActions, fixture.id).toBeDefined();
    }
  });

  it.each(scenarioIds)("passes %s through the public runner", async (id) => {
    const result = await runScenario(id);
    expect(result.passed, result.evidence.join("; ")).toBe(true);
  });

  it("runs the complete campaign with a reproducible seed", async () => {
    const first = await runScenarioCampaign(20260907);
    const second = await runScenarioCampaign(20260907);
    expect(first.passed).toBe(true);
    expect(second).toEqual(first);
  });
});
