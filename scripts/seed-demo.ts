import { config as loadDotEnv } from "dotenv";
import { parseConfig } from "@handoff/config";
import { closeDatabase, createDatabase, seedDemoData } from "@handoff/db";

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const handle = createDatabase(config);
  try {
    await seedDemoData(handle.pool);
    console.log("seeded two synthetic tenants and deterministic demo records");
  } finally {
    await closeDatabase(handle);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
