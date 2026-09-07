export type {
  ScenarioCampaignResult,
  ScenarioExpected,
  ScenarioFixture,
  ScenarioId,
  ScenarioRunResult,
  ScenarioRunState,
  ScenarioStep,
} from "./types";
export { scenarioFixtures, scenarioIds } from "./fixtures";

export function runScenario(_id: string, _seed?: number): never {
  throw new Error("scenario runner is not implemented");
}

export function runScenarioCampaign(_seed?: number): never {
  throw new Error("scenario campaign is not implemented");
}
