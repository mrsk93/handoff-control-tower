import type { Pool } from "pg";

export const DEMO_TENANTS = {
  northstar: "11111111-1111-4111-8111-111111111111",
  bluebird: "22222222-2222-4222-8222-222222222222",
} as const;

const DEMO_CONNECTIONS = {
  northstarCommerce: "31111111-1111-4111-8111-111111111111",
  northstarWms: "31111111-1111-4111-8111-111111111112",
  bluebirdCommerce: "32222222-2222-4222-8222-222222222221",
  bluebirdWms: "32222222-2222-4222-8222-222222222222",
} as const;

const DEMO_ORDERS = {
  northstar: "41111111-1111-4111-8111-111111111111",
  bluebird: "42222222-2222-4222-8222-222222222222",
} as const;

export async function seedDemoData(pool: Pool): Promise<void> {
  const timestamp = "2026-01-01T00:00:00.000Z";
  await pool.query("begin");
  try {
    await pool.query(
      `insert into tenants (id, slug, name, status, created_at, updated_at)
       values
         ($1, 'northstar-demo', 'Northstar Fulfillment Demo', 'active', $3, $3),
         ($2, 'bluebird-demo', 'Bluebird Fulfillment Demo', 'active', $3, $3)
       on conflict (id) do update set slug = excluded.slug, name = excluded.name, updated_at = excluded.updated_at`,
      [DEMO_TENANTS.northstar, DEMO_TENANTS.bluebird, timestamp],
    );
    await pool.query(
      `insert into connections (id, tenant_id, system_type, adapter_key, status, config, created_at, updated_at)
       values
         ($1, $5, 'commerce', 'mock-commerce', 'active', '{"fixture":"northstar"}', $7, $7),
         ($2, $5, 'wms', 'mock-wms', 'active', '{"fixture":"northstar"}', $7, $7),
         ($3, $6, 'commerce', 'mock-commerce', 'active', '{"fixture":"bluebird"}', $7, $7),
         ($4, $6, 'wms', 'mock-wms', 'active', '{"fixture":"bluebird"}', $7, $7)
       on conflict (id) do update set config = excluded.config, updated_at = excluded.updated_at`,
      [
        DEMO_CONNECTIONS.northstarCommerce,
        DEMO_CONNECTIONS.northstarWms,
        DEMO_CONNECTIONS.bluebirdCommerce,
        DEMO_CONNECTIONS.bluebirdWms,
        DEMO_TENANTS.northstar,
        DEMO_TENANTS.bluebird,
        timestamp,
      ],
    );
    await pool.query(
      `insert into orders (id, tenant_id, source, source_order_id, source_version, order_number, currency,
                          accepted_at, release_status, canonical_hash, row_version, created_at, updated_at)
       values
         ($1, $3, 'commerce', 'COM-DEMO-1001', '1', '#D1001', 'USD', $5, 'released', 'demo-hash-1001', 1, $5, $5),
         ($2, $4, 'commerce', 'COM-DEMO-2001', '1', '#D2001', 'USD', $5, 'pending', 'demo-hash-2001', 1, $5, $5)
       on conflict (id) do update set release_status = excluded.release_status, updated_at = excluded.updated_at`,
      [
        DEMO_ORDERS.northstar,
        DEMO_ORDERS.bluebird,
        DEMO_TENANTS.northstar,
        DEMO_TENANTS.bluebird,
        timestamp,
      ],
    );
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }
  await pool.query("commit");
}
