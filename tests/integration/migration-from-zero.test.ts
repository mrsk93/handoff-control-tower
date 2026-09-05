import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import { listMigrations, type DatabaseHandle } from "@handoff/db";

describe.skipIf(!testDatabaseUrl)("migration-from-zero", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("applies every checked-in migration and creates the required tables", async () => {
    if (!handle) throw new Error("test database was not opened");
    const migrations = await listMigrations();
    const applied = await handle.pool.query<{ name: string }>(
      "select name from schema_migrations order by name",
    );
    const tables = await handle.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in
       ('tenants', 'connections', 'inbox_messages', 'outbox_messages', 'orders', 'order_lines',
        'fulfillments', 'fulfillment_lines', 'shipments', 'shipment_lines', 'process_instances',
        'exceptions', 'reconciliation_runs', 'reconciliation_findings', 'audit_events')
       order by table_name`,
    );
    expect(applied.rows.map((row) => row.name)).toEqual(
      migrations.map((migration) => migration.name),
    );
    expect(tables.rows).toHaveLength(15);
  });
});
