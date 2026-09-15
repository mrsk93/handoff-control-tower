import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import { listMigrations, resetPublicSchema, runMigrations, type DatabaseHandle } from "@handoff/db";

async function applyMigrationsThrough(
  handle: DatabaseHandle,
  lastMigration: string,
): Promise<void> {
  await handle.pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migration of (await listMigrations()).filter(({ name }) => name <= lastMigration)) {
    const sql = await readFile(migration.filePath, "utf8");
    await handle.pool.query("begin");
    try {
      await handle.pool.query(sql);
      await handle.pool.query("insert into schema_migrations (name) values ($1)", [migration.name]);
      await handle.pool.query("commit");
    } catch (error) {
      await handle.pool.query("rollback");
      throw error;
    }
  }
}

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
        'exceptions', 'reconciliation_runs', 'reconciliation_findings', 'audit_events',
        'external_references', 'catalog_items', 'customers')
       order by table_name`,
    );
    expect(applied.rows.map((row) => row.name)).toEqual(
      migrations.map((migration) => migration.name),
    );
    expect(tables.rows).toHaveLength(18);
    const connectionColumns = await handle.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'connections' and column_name = 'environment'`,
    );
    expect(connectionColumns.rows).toEqual([{ column_name: "environment" }]);
    const referenceIndexes = await handle.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'external_references'`,
    );
    expect(referenceIndexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "external_references_tenant_system_resource_external_uq",
        "external_references_tenant_connection_canonical_uq",
      ]),
    );
  });

  it("upgrades a legacy 0011 connection row without losing identity", async () => {
    if (!handle) throw new Error("database was not opened");
    await resetPublicSchema(handle.pool);
    await applyMigrationsThrough(handle, "0011_command_trace_ids");
    await handle.pool.query(
      `insert into tenants (id, slug, name, status, created_at, updated_at)
       values ('91111111-1111-4111-8111-111111111111', 'legacy-t012', 'Legacy T012', 'active', now(), now())`,
    );
    await handle.pool.query(
      `insert into connections (id, tenant_id, system_type, adapter_key, status, config, created_at, updated_at)
       values ('92222222-2222-4222-8222-222222222222', '91111111-1111-4111-8111-111111111111', 'commerce', 'mock-commerce', 'active', '{}', now(), now())`,
    );
    await runMigrations(handle.pool);
    const legacy = await handle.pool.query<{ id: string; environment: string }>(
      `select id, environment from connections where id = '92222222-2222-4222-8222-222222222222'`,
    );
    expect(legacy.rows).toEqual([
      { id: "92222222-2222-4222-8222-222222222222", environment: "mock" },
    ]);
    await handle.pool.query(
      `insert into connections (id, tenant_id, system_type, environment, adapter_key, status, config, created_at, updated_at)
       values ('93333333-3333-4333-8333-333333333333', '91111111-1111-4111-8111-111111111111', 'commerce', 'sandbox', 'shopify', 'active', '{}', now(), now())`,
    );
    const environments = await handle.pool.query<{ environment: string }>(
      `select environment from connections where tenant_id = '91111111-1111-4111-8111-111111111111' order by environment`,
    );
    expect(environments.rows).toEqual([{ environment: "mock" }, { environment: "sandbox" }]);
  });
});
