import "reflect-metadata";
import { config as loadDotEnv } from "dotenv";
import { parseConfig } from "@handoff/config";
import { closeDatabase, createDatabase, runMigrations } from "@handoff/db";

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const handle = createDatabase(config);
  try {
    const applied = await runMigrations(handle.pool);
    console.log(JSON.stringify({ applied, message: "database migrations complete" }));
  } finally {
    await closeDatabase(handle);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
