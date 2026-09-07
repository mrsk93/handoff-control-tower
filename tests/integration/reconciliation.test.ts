import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockAdapterSuite } from "@handoff/adapters";
import { DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import type { CanonicalOrder } from "@handoff/domain";
import { createReconciliationService } from "@handoff/queue";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

describe.skipIf(!testDatabaseUrl)("reconciliation execution", () => {
  let handle: DatabaseHandle | undefined;
  const suite = createMockAdapterSuite();

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("repairs a missing local authoritative order and is safe to repeat", async () => {
    if (!handle) throw new Error("test database was not opened");
    const tenantId = DEMO_TENANTS.northstar;
    const now = new Date("2026-01-03T01:00:00.000Z");
    const remoteOrder: CanonicalOrder = {
      tenantId,
      orderId: "remote-order-m8-1",
      source: "commerce",
      sourceOrderId: "COM-M8-MISSING-LOCAL",
      sourceVersion: "1",
      orderNumber: "#M8-1001",
      currency: "USD",
      acceptedAt: now.toISOString(),
      releaseStatus: "released",
      lines: [
        {
          lineId: "COM-M8-MISSING-LOCAL:line-1",
          sourceLineId: "line-1",
          sku: "SKU-M8-1",
          orderedQty: 1,
          cancelledQty: 0,
        },
      ],
    };
    await suite.commerce.upsertOrder(
      {
        tenantId,
        idempotencyKey: "m8-remote-order-1",
        correlationId: "m8-remote-order-1",
        requestedAt: now.toISOString(),
      },
      remoteOrder,
    );
    const service = createReconciliationService({
      db: handle.db,
      config: {
        reconciliationIntervalMinutes: 15,
        allowPartialInvoiceEligibility: false,
        outboxMaxAttempts: 3,
      },
      adapters: suite,
    });

    const first = await service.run(
      { tenantId },
      {
        now,
        windowEnd: now,
        pageSize: 1,
        leaseDurationMs: 60 * 60 * 1000,
        overlapMs: 0,
        leaseOwner: "m8-a",
      },
    );
    expect(first.pairs).toHaveLength(4);
    const firstFinding = await handle.pool.query<{ category: string; repair_status: string }>(
      `select rf.category, rf.repair_status
       from reconciliation_findings rf
       join reconciliation_runs rr on rr.id = rf.run_id
       where rr.tenant_id = $1 and rr.system_pair = 'commerce_order' and rf.resource_key = $2`,
      [tenantId, remoteOrder.sourceOrderId],
    );
    expect(firstFinding.rows).toEqual([
      { category: "missing_local", repair_status: "auto_repaired" },
    ]);

    const local = await handle.pool.query<{ count: string; outbox: string }>(
      `select
         (select count(*)::text from orders where tenant_id = $1 and source_order_id = $2) as count,
         (select count(*)::text from outbox_messages where tenant_id = $1 and message_type = 'wms.create_order.v1') as outbox`,
      [tenantId, remoteOrder.sourceOrderId],
    );
    expect(local.rows[0]).toEqual({ count: "1", outbox: "1" });

    const second = await service.run(
      { tenantId },
      {
        now: new Date("2026-01-03T02:00:00.000Z"),
        windowEnd: new Date("2026-01-03T02:00:00.000Z"),
        pageSize: 1,
        leaseDurationMs: 60 * 60 * 1000,
        overlapMs: 0,
        leaseOwner: "m8-b",
      },
    );
    expect(second.pairs.every((pair) => pair.status === "completed")).toBe(true);
    const repeated = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from orders where tenant_id = $1 and source_order_id = $2",
      [tenantId, remoteOrder.sourceOrderId],
    );
    expect(repeated.rows[0]?.count).toBe("1");
  });
});
