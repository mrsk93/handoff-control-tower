import { config as loadDotEnv } from "dotenv";
import { assertSafeResetDatabase, parseConfig } from "@handoff/config";
import { closeDatabase, createDatabase, resetPublicSchema, runMigrations } from "@handoff/db";

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  assertSafeResetDatabase(config);
  const handle = createDatabase(config);
  try {
    await resetPublicSchema(handle.pool);
    await runMigrations(handle.pool);
    console.log("reset and migrated the explicitly allowed demo/test database");
  } finally {
    await closeDatabase(handle);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
