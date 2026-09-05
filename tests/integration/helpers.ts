import { assertSafeResetDatabase, parseConfig } from "@handoff/config";
import {
  closeDatabase,
  createDatabase,
  resetPublicSchema,
  runMigrations,
  seedDemoData,
  type DatabaseHandle,
} from "@handoff/db";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export async function openPreparedTestDatabase(): Promise<DatabaseHandle> {
  if (!testDatabaseUrl)
    throw new Error("TEST_DATABASE_URL is required for database integration tests");
  const config = parseConfig({
    ...process.env,
    APP_ENV: "test",
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    ADAPTER_MODE: "mock",
    ENABLE_DEMO_SIMULATOR: "false",
  });
  assertSafeResetDatabase(config);
  const handle = createDatabase(config);
  await resetPublicSchema(handle.pool);
  await runMigrations(handle.pool);
  await seedDemoData(handle.pool);
  return handle;
}

export async function closeTestDatabase(handle: DatabaseHandle | undefined): Promise<void> {
  if (handle) await closeDatabase(handle);
}
