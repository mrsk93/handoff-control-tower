import { config as loadDotEnv } from "dotenv";
import { parseConfig } from "@handoff/config";
import { closeDatabase, createDatabase } from "@handoff/db";

async function main(): Promise<void> {
  loadDotEnv();
  const config = parseConfig(process.env);
  const handle = createDatabase(config);
  try {
    const result = await handle.pool.query<{ invalid_count: string }>(`
      select count(*)::text as invalid_count
      from order_lines
      where cancelled_qty < 0 or ordered_qty < 0 or cancelled_qty > ordered_qty
    `);
    const invalidCount = Number(result.rows[0]?.invalid_count ?? "0");
    if (invalidCount !== 0) throw new Error(`found ${invalidCount} invalid order line rows`);
    console.log("database quantity invariants are valid");
  } finally {
    await closeDatabase(handle);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
