import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import {
  auditEvents,
  createOrderRepository,
  createTenantRepository,
  DEMO_TENANTS,
  inTransaction,
  orders,
  outboxMessages,
  type DatabaseHandle,
} from "@handoff/db";

describe.skipIf(!testDatabaseUrl)("tenant-scoped persistence", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("returns only the tenant requested by the caller", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createTenantRepository(handle.db);
    const northstar = await repository.getTenant({ tenantId: DEMO_TENANTS.northstar });
    const bluebird = await repository.getTenant({ tenantId: DEMO_TENANTS.bluebird });
    expect(northstar?.slug).toBe("northstar-demo");
    expect(bluebird?.slug).toBe("bluebird-demo");
    expect(northstar?.id).not.toBe(bluebird?.id);
  });

  it("does not allow an order probe to cross tenant scope", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOrderRepository(handle.db);
    const ownOrder = await repository.findBySourceOrderId(
      { tenantId: DEMO_TENANTS.northstar },
      "COM-DEMO-1001",
    );
    const foreignOrder = await repository.findBySourceOrderId(
      { tenantId: DEMO_TENANTS.bluebird },
      "COM-DEMO-1001",
    );
    expect(ownOrder?.tenantId).toBe(DEMO_TENANTS.northstar);
    expect(foreignOrder).toBeNull();
  });

  it("rolls back state changes as one transaction", async () => {
    if (!handle) throw new Error("test database was not opened");
    const before = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events",
    );
    await expect(
      inTransaction(handle.db, async (transaction) => {
        await transaction.insert(auditEvents).values({
          id: "51111111-1111-4111-8111-111111111111",
          tenantId: DEMO_TENANTS.northstar,
          actorType: "test",
          action: "transaction_probe",
          entityType: "test",
          entityId: "transaction-probe",
          createdAt: new Date(),
        });
        await transaction.insert(orders).values({
          id: "61111111-1111-4111-8111-111111111111",
          tenantId: DEMO_TENANTS.northstar,
          source: "commerce",
          sourceOrderId: "COM-ROLLBACK-1001",
          sourceVersion: "1",
          orderNumber: "#ROLLBACK-1001",
          currency: "USD",
          acceptedAt: new Date(),
          releaseStatus: "pending",
          canonicalHash: "rollback-hash",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await transaction.insert(outboxMessages).values({
          id: "71111111-1111-4111-8111-111111111111",
          tenantId: DEMO_TENANTS.northstar,
          destination: "mock-wms",
          messageType: "wms.create_order.v1",
          messageVersion: 1,
          payload: { sourceOrderId: "COM-ROLLBACK-1001" },
          idempotencyKey: "rollback-outbox-1001",
          correlationId: "rollback-correlation-1001",
          availableAt: new Date(),
          createdAt: new Date(),
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    const after = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const rolledBackState = await handle.pool.query(
      "select (select count(*) from orders where source_order_id = 'COM-ROLLBACK-1001') as orders, (select count(*) from outbox_messages where idempotency_key = 'rollback-outbox-1001') as outbox",
    );
    expect(rolledBackState.rows[0]).toEqual({ orders: "0", outbox: "0" });
  });
});
