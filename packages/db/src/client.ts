import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AppConfig } from "@handoff/config";
import { schema } from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  db: Database;
  pool: Pool;
};

export function createDatabase(config: Pick<AppConfig, "databaseUrl">): DatabaseHandle {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    application_name: "handoff-control-tower",
  });
  return { pool, db: drizzle(pool, { schema }) };
}

export async function closeDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.pool.end();
}
