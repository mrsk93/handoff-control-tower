import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanonicalRepository, DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import type { CanonicalCustomer, CanonicalOrder, Shipment } from "@handoff/domain";

const now = new Date("2026-01-02T00:00:00.000Z");
const northstarOrderId = "61111111-1111-4111-8111-111111111111";
const northstarCustomerId = "51111111-1111-4111-8111-111111111111";
const bluebirdOrderId = "62222222-2222-4222-8222-222222222222";

function customer(
  id = northstarCustomerId,
  tenantId: CanonicalCustomer["tenantId"] = DEMO_TENANTS.northstar,
): CanonicalCustomer {
  return {
    id,
    tenantId,
    email: "buyer@example.invalid",
    displayName: "Canonical Buyer",
    shippingAddresses: [
      {
        name: "Canonical Buyer",
        address1: "1 Test Street",
        city: "Austin",
        postalCode: "78701",
        countryCode: "US",
      },
    ],
    externalRefs: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function order(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    tenantId: DEMO_TENANTS.northstar,
    orderId: northstarOrderId,
    source: "commerce",
    sourceOrderId: "COM-T017-1001",
    sourceVersion: "1",
    orderNumber: "#T017-1001",
    currency: "USD",
    acceptedAt: now.toISOString(),
    observedAt: now.toISOString(),
    customerId: northstarCustomerId,
    customer: customer(),
    shippingAddress: {
      name: "Canonical Buyer",
      address1: "1 Test Street",
      city: "Austin",
      postalCode: "78701",
      countryCode: "US",
    },
    subtotal: { amountMinor: 1299n, currency: "USD" },
    shippingTotal: { amountMinor: 500n, currency: "USD" },
    taxTotal: { amountMinor: 104n, currency: "USD" },
    grandTotal: { amountMinor: 1903n, currency: "USD" },
    lifecycleStatus: "received",
    releaseStatus: "pending",
    lines: [
      {
        lineId: "COM-T017-1001:1",
        sourceLineId: "line-1",
        sku: "SKU-T017",
        title: "Test item",
        unit: "EA",
        orderedQty: 2,
        cancelledQty: 0,
        orderedQuantity: { value: "2", unit: "EA" },
        unitPrice: { amountMinor: 649n, currency: "USD" },
        discountTotal: { amountMinor: 0n, currency: "USD" },
        taxTotal: { amountMinor: 104n, currency: "USD" },
      },
    ],
    ...overrides,
  };
}

describe.skipIf(!testDatabaseUrl)("canonical commerce repositories", () => {
  let handle: DatabaseHandle | undefined;
  let repository: ReturnType<typeof createCanonicalRepository>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    if (!handle) throw new Error("test database was not opened");
    repository = createCanonicalRepository(handle.db);
    await repository.upsertCatalogItem(
      { tenantId: DEMO_TENANTS.northstar },
      {
        id: "51111111-1111-4111-8111-111111111112",
        sku: "SKU-T017",
        normalizedSku: "sku-t017",
        name: "Test item",
        active: true,
        requiresShipping: true,
        unit: "EA",
      },
      now,
    );
  });

  afterAll(async () => closeTestDatabase(handle));

  it("upserts catalog and customer snapshots within tenant scope", async () => {
    if (!handle) throw new Error("test database was not opened");
    const item = await repository.upsertCatalogItem(
      { tenantId: DEMO_TENANTS.northstar },
      {
        id: "51111111-1111-4111-8111-111111111112",
        sku: "SKU-T017",
        normalizedSku: "sku-t017",
        name: "Test item v2",
        active: true,
        requiresShipping: true,
        unit: "EA",
        sourceUpdatedAt: "2026-01-02T00:01:00.000Z",
      },
      new Date("2026-01-02T00:01:00.000Z"),
    );
    expect(item.name).toBe("Test item v2");
    const storedCustomer = await repository.upsertCustomer(
      { tenantId: DEMO_TENANTS.northstar },
      customer(),
      now,
    );
    expect(storedCustomer.tenantId).toBe(DEMO_TENANTS.northstar);
    const crossTenant = await repository.upsertCustomer(
      { tenantId: DEMO_TENANTS.bluebird },
      customer("52222222-2222-4222-8222-222222222222", DEMO_TENANTS.bluebird),
      now,
    );
    expect(crossTenant.tenantId).toBe(DEMO_TENANTS.bluebird);
    const customerCount = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from customers where id = $1 and tenant_id = $2",
      [northstarCustomerId, DEMO_TENANTS.northstar],
    );
    expect(customerCount.rows).toEqual([{ count: "1" }]);
  });

  it("persists exact order values, no-ops equal revisions, and rejects conflicting revisions", async () => {
    const first = await repository.upsertOrder({ tenantId: DEMO_TENANTS.northstar }, order(), now);
    expect(first).toMatchObject({ created: true, changed: true, stale: false });
    expect(first.order.grandTotal?.amountMinor).toBe(1903n);
    expect(first.order.lines[0]?.orderedQuantity).toEqual({ value: "2", unit: "EA" });

    const noOp = await repository.upsertOrder(
      { tenantId: DEMO_TENANTS.northstar },
      order(),
      new Date("2026-01-02T00:02:00.000Z"),
    );
    expect(noOp).toMatchObject({ created: false, changed: false, stale: false });

    await expect(
      repository.upsertOrder(
        { tenantId: DEMO_TENANTS.northstar },
        order({ grandTotal: { amountMinor: 1904n, currency: "USD" } }),
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_REVISION_CONFLICT" });

    const stale = await repository.upsertOrder(
      { tenantId: DEMO_TENANTS.northstar },
      order({ sourceVersion: "0" }),
    );
    expect(stale).toMatchObject({ created: false, changed: false, stale: true });

    const next = await repository.upsertOrder(
      { tenantId: DEMO_TENANTS.northstar },
      order({ sourceVersion: "2", lifecycleStatus: "erp_pending" }),
      new Date("2026-01-02T00:03:00.000Z"),
    );
    expect(next).toMatchObject({ created: false, changed: true, stale: false });
    expect(next.order.lifecycleStatus).toBe("erp_pending");
    expect(
      await repository.findOrder({ tenantId: DEMO_TENANTS.northstar }, northstarOrderId),
    ).toMatchObject({
      orderId: northstarOrderId,
      grandTotal: { amountMinor: 1903n, currency: "USD" },
    });
  });

  it("rolls back customer and order state when line persistence fails", async () => {
    const failedOrder = order({
      orderId: "63333333-3333-4333-8333-333333333333",
      sourceOrderId: "COM-T017-ROLLBACK",
      customerId: "53333333-3333-4333-8333-333333333333",
      customer: customer("53333333-3333-4333-8333-333333333333"),
      lines: [
        {
          lineId: "COM-T017-ROLLBACK:1",
          sourceLineId: "rollback-line",
          sku: "SKU-T017",
          orderedQty: -1,
          cancelledQty: 0,
        },
      ],
    });
    await expect(
      repository.upsertOrder({ tenantId: DEMO_TENANTS.northstar }, failedOrder),
    ).rejects.toThrow();
    if (!handle) throw new Error("test database was not opened");
    const counts = await handle.pool.query<{ orders: string; customers: string }>(
      `select
         (select count(*)::text from orders where id = $1) as orders,
         (select count(*)::text from customers where id = $2) as customers`,
      [failedOrder.orderId, failedOrder.customerId],
    );
    expect(counts.rows[0]).toEqual({ orders: "0", customers: "0" });
  });

  it("persists shipment evidence idempotently and keeps tenant reads isolated", async () => {
    const shipment: Shipment = {
      tenantId: DEMO_TENANTS.northstar,
      shipmentId: "SHIP-T017-1001",
      orderId: northstarOrderId,
      carrierCode: "UPS",
      serviceCode: "GROUND",
      trackingNumber: "1Z-T017-1001",
      status: "shipped",
      observedAt: now.toISOString(),
      occurredAt: now.toISOString(),
      lines: [{ lineId: "line-1", quantity: 2 }],
    };
    const first = await repository.upsertShipmentEvidence(
      { tenantId: DEMO_TENANTS.northstar },
      shipment,
      now,
    );
    expect(first).toMatchObject({ created: true, changed: true });
    const duplicate = await repository.upsertShipmentEvidence(
      { tenantId: DEMO_TENANTS.northstar },
      shipment,
      new Date("2026-01-02T00:04:00.000Z"),
    );
    expect(duplicate).toMatchObject({ created: false, changed: false, stale: false });
    await expect(
      repository.upsertShipmentEvidence(
        { tenantId: DEMO_TENANTS.northstar },
        { ...shipment, trackingNumber: "1Z-T017-CONFLICT" },
        now,
      ),
    ).rejects.toMatchObject({ code: "CANONICAL_REVISION_CONFLICT" });
    const next = await repository.upsertShipmentEvidence(
      { tenantId: DEMO_TENANTS.northstar },
      {
        ...shipment,
        trackingNumber: "1Z-T017-1002",
        observedAt: "2026-01-02T00:05:00.000Z",
        occurredAt: "2026-01-02T00:05:00.000Z",
      },
      new Date("2026-01-02T00:05:00.000Z"),
    );
    expect(next.shipment.trackingNumber).toBe("1Z-T017-1002");
    expect(
      await repository.findOrder({ tenantId: DEMO_TENANTS.bluebird }, northstarOrderId),
    ).toBeNull();

    const bluebirdInput = order({
      tenantId: DEMO_TENANTS.bluebird,
      orderId: bluebirdOrderId,
      sourceOrderId: "COM-T017-2001",
    });
    delete bluebirdInput.customerId;
    delete bluebirdInput.customer;
    const bluebird = await repository.upsertOrder(
      { tenantId: DEMO_TENANTS.bluebird },
      bluebirdInput,
      now,
    );
    expect(bluebird.order.tenantId).toBe(DEMO_TENANTS.bluebird);
  });
});
