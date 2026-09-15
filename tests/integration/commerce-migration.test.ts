import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import { type DatabaseHandle } from "@handoff/db";

describe.skipIf(!testDatabaseUrl)("canonical commerce schema", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("stores catalog, customer, exact money, and address extensions", async () => {
    if (!handle) throw new Error("database was not opened");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const catalogId = "a1111111-1111-4111-8111-111111111111";
    const customerId = "a2222222-2222-4222-8222-222222222222";
    const orderId = "a3333333-3333-4333-8333-333333333333";
    const lineId = "a4444444-4444-4444-8444-444444444444";
    await handle.pool.query(
      `insert into catalog_items
       (id, tenant_id, sku, normalized_sku, name, active, requires_shipping, unit, created_at, updated_at)
       values ($1, $2, 'sku-100', 'SKU-100', 'Demo Widget', true, true, 'EA', $3, $3)`,
      [catalogId, tenantId, timestamp],
    );
    await handle.pool.query(
      `insert into customers
       (id, tenant_id, email, display_name, shipping_addresses, created_at, updated_at)
       values ($1, $2, 'customer@example.com', 'Demo Customer', $3::jsonb, $4, $4)`,
      [
        customerId,
        tenantId,
        JSON.stringify([{ address1: "1 Main St", city: "Austin", countryCode: "US" }]),
        timestamp,
      ],
    );
    await handle.pool.query(
      `insert into orders
       (id, tenant_id, source, source_order_id, source_version, order_number, currency,
        accepted_at, release_status, canonical_hash, customer_id, lifecycle_status,
        shipping_address, subtotal_minor, shipping_total_minor, tax_total_minor,
        discount_total_minor, grand_total_minor, created_at, updated_at)
       values ($1, $2, 'commerce', 'COM-T013-1001', '1', '#T013-1001', 'USD',
        $3, 'pending', 't013-hash', $4, 'received',
        $5::jsonb, 1000, 100, 80, 0, 1180, $3, $3)`,
      [
        orderId,
        tenantId,
        timestamp,
        customerId,
        JSON.stringify({ address1: "1 Main St", city: "Austin", countryCode: "US" }),
      ],
    );
    await handle.pool.query(
      `insert into order_lines
       (id, tenant_id, order_id, source_line_id, line_number, sku_id, sku, title, unit,
        ordered_quantity, unit_price_minor, discount_total_minor, tax_total_minor, ordered_qty, cancelled_qty)
       values ($1, $2, $3, 'line-1', '1', $4, 'SKU-100', 'Demo Widget', 'EA',
        '{"value":"2","unit":"EA"}'::jsonb, 500, 0, 80, 2, 0)`,
      [lineId, tenantId, orderId, catalogId],
    );
    const row = await handle.pool.query<{
      normalized_sku: string;
      grand_total_minor: string;
      customer_id: string;
      ordered_quantity: { value: string; unit: string };
    }>(
      `select ci.normalized_sku, o.grand_total_minor::text, o.customer_id::text, ol.ordered_quantity
       from orders o
       join customers c on c.id = o.customer_id
       join order_lines ol on ol.order_id = o.id
       join catalog_items ci on ci.id = ol.sku_id
       where o.id = $1`,
      [orderId],
    );
    expect(row.rows[0]).toEqual({
      normalized_sku: "SKU-100",
      grand_total_minor: "1180",
      customer_id: customerId,
      ordered_quantity: { value: "2", unit: "EA" },
    });
    await expect(
      handle.pool.query(
        `insert into catalog_items
         (id, tenant_id, sku, normalized_sku, name, created_at, updated_at)
         values ($1, $2, 'sku-duplicate', 'SKU-100', 'Duplicate', $3, $3)`,
        ["a5555555-5555-4555-8555-555555555555", tenantId, timestamp],
      ),
    ).rejects.toThrow();
  });

  it("allows multiple shipment records for one fulfillment", async () => {
    if (!handle) throw new Error("database was not opened");
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const orderId = "a3333333-3333-4333-8333-333333333333";
    const fulfillmentId = "a6666666-6666-4666-8666-666666666666";
    const timestamp = "2026-01-01T00:00:00.000Z";
    await handle.pool.query(
      `insert into fulfillments
       (id, tenant_id, order_id, warehouse_order_id, status, provider, created_at, updated_at)
       values ($1, $2, $3, 'shipbob-order-t013', 'accepted', 'shipbob', $4, $4)`,
      [fulfillmentId, tenantId, orderId, timestamp],
    );
    for (const [shipmentId, externalId, tracking] of [
      ["a7777777-7777-4777-8777-777777777771", "shipbob-shipment-1", "TRACK-T013-1"],
      ["a7777777-7777-4777-8777-777777777772", "shipbob-shipment-2", "TRACK-T013-2"],
    ]) {
      await handle.pool.query(
        `insert into shipments
         (id, tenant_id, order_id, fulfillment_id, provider, external_shipment_id,
          carrier_code, service_code, tracking_number, status, created_at, updated_at)
         values ($1, $2, $3, $4, 'shipbob', $5, 'synthetic', 'ground', $6, 'shipped', $7, $7)`,
        [shipmentId, tenantId, orderId, fulfillmentId, externalId, tracking, timestamp],
      );
    }
    const count = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from shipments where fulfillment_id = $1`,
      [fulfillmentId],
    );
    expect(count.rows[0]?.count).toBe("2");
  });
});
