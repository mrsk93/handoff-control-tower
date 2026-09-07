import { runScenarioCampaign } from "@handoff/scenarios";

async function main(): Promise<void> {
  const seed = Number(process.env.SCENARIO_SEED ?? "20260907");
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error("SCENARIO_SEED must be a non-negative integer");
  }

  const runs = [];
  for (const run of [1, 2]) {
    const result = await runScenarioCampaign(seed);
    if (!result.passed) {
      console.error(JSON.stringify({ run, result }, null, 2));
      process.exitCode = 1;
      break;
    }
    runs.push({
      run,
      reset: "fresh in-memory scenario state",
      seed: result.seed,
      scenarioCount: result.scenarioCount,
      passed: result.passed,
      scenarios: result.scenarios.map((scenario) => ({
        id: scenario.id,
        passed: scenario.passed,
        exceptionCodes: scenario.state.exceptionCodes,
        outboxEffects: scenario.state.outboxEffects,
        findingCategories: scenario.state.findingCategories,
        remoteEffectCount: scenario.state.remoteEffectCount,
      })),
    });
  }

  console.log(
    JSON.stringify(
      {
        synthetic: true,
        deliveryGuarantee: "at-least-once",
        runs,
        passed: runs.length === 2 && runs.every((run) => run.passed),
      },
      null,
      2,
    ),
  );
}

void main();
