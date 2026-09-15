import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import {
  createOutboxRepository,
  DEMO_TENANTS,
  orders,
  syncOperations,
  type DatabaseHandle,
} from "@handoff/db";
import type { OutboundMessage } from "@handoff/domain";

const now = new Date("2026-01-01T00:20:00.000Z");
const northstarContext = { tenantId: DEMO_TENANTS.northstar };

function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    tenantId: DEMO_TENANTS.northstar,
    destination: "mock-wms",
    messageType: "wms.create_order.v1",
    messageVersion: 1,
    payload: { sourceOrderId: "COM-M4-1001" },
    idempotencyKey: "m4-outbox-1001",
    correlationId: "m4-correlation-1001",
    ...overrides,
  };
}

describe.skipIf(!testDatabaseUrl)("transactional outbox", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("commits domain state and its outbound message atomically", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    const message = outboundMessage();
    const result = await repository.inTransaction(
      { tenantId: DEMO_TENANTS.northstar },
      async (transaction, outbox) => {
        await transaction.insert(orders).values({
          id: "81111111-1111-4111-8111-111111111111",
          tenantId: DEMO_TENANTS.northstar,
          source: "commerce",
          sourceOrderId: "COM-M4-1001",
          sourceVersion: "1",
          orderNumber: "#M4-1001",
          currency: "USD",
          acceptedAt: now,
          releaseStatus: "released",
          canonicalHash: "m4-hash-1001",
          createdAt: now,
          updatedAt: now,
        });
        return outbox.append(message);
      },
      now,
    );

    expect(result.duplicate).toBe(false);
    const persisted = await handle.pool.query<{ orders: string; outbox: string }>(
      `select
         (select count(*)::text from orders where source_order_id = 'COM-M4-1001') as orders,
         (select count(*)::text from outbox_messages where idempotency_key = 'm4-outbox-1001') as outbox`,
    );
    expect(persisted.rows[0]).toEqual({ orders: "1", outbox: "1" });

    const duplicate = await repository.inTransaction(
      { tenantId: DEMO_TENANTS.northstar },
      (_transaction, outbox) => outbox.append(message),
      now,
    );
    expect(duplicate).toMatchObject({ duplicate: true, message: { id: result.message.id } });
  });

  it("rolls back domain state and the outbox row together", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    await expect(
      repository.inTransaction(
        { tenantId: DEMO_TENANTS.northstar },
        async (transaction, outbox) => {
          await transaction.insert(orders).values({
            id: "81111111-1111-4111-8111-111111111112",
            tenantId: DEMO_TENANTS.northstar,
            source: "commerce",
            sourceOrderId: "COM-M4-ROLLBACK",
            sourceVersion: "1",
            orderNumber: "#M4-ROLLBACK",
            currency: "USD",
            acceptedAt: now,
            releaseStatus: "released",
            canonicalHash: "m4-hash-rollback",
            createdAt: now,
            updatedAt: now,
          });
          await outbox.append(
            outboundMessage({
              payload: { sourceOrderId: "COM-M4-ROLLBACK" },
              idempotencyKey: "m4-outbox-rollback",
            }),
          );
          throw new Error("simulate state handler failure");
        },
        now,
      ),
    ).rejects.toThrow("simulate state handler failure");

    const rolledBack = await handle.pool.query<{ orders: string; outbox: string }>(
      `select
         (select count(*)::text from orders where source_order_id = 'COM-M4-ROLLBACK') as orders,
         (select count(*)::text from outbox_messages where idempotency_key = 'm4-outbox-rollback') as outbox`,
    );
    expect(rolledBack.rows[0]).toEqual({ orders: "0", outbox: "0" });
  });

  it("claims each ready message once and reclaims an expired lease", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    await repository.inTransaction(
      { tenantId: DEMO_TENANTS.northstar },
      async (_transaction, outbox) => {
        await outbox.append(
          outboundMessage({
            idempotencyKey: "m4-claim-1",
            availableAt: new Date(now.getTime() - 1).toISOString(),
          }),
        );
        await outbox.append(outboundMessage({ idempotencyKey: "m4-claim-2" }));
      },
      now,
    );

    const first = await repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "worker-a",
      now,
      30_000,
    );
    const second = await repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "worker-b",
      now,
      30_000,
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("two claims are required");
    expect(first.id).not.toBe(second.id);
    const reclaimed = await repository.claimNext(
      { tenantId: DEMO_TENANTS.northstar },
      "worker-restarted",
      new Date(now.getTime() + 31_000),
      30_000,
    );
    expect(reclaimed).toMatchObject({ id: first.id, status: "dispatching", attemptCount: 2 });
    expect(
      await repository.recordSent(
        { tenantId: DEMO_TENANTS.northstar },
        first.id,
        "worker-a",
        new Date(now.getTime() + 31_000),
      ),
    ).toBeNull();
  });

  it("rejects a message whose tenant differs from the transaction scope", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    await expect(
      repository.inTransaction(
        { tenantId: DEMO_TENANTS.bluebird },
        (_transaction, outbox) =>
          outbox.append(outboundMessage({ idempotencyKey: "m4-cross-tenant" })),
        now,
      ),
    ).rejects.toThrow("outbox message tenant does not match transaction tenant");
  });

  it("links a durable job to one operation atomically and rejects conflicting publication", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    const operationId = "a1111111-1111-4111-8111-111111111111";
    const conflictingOperationId = "a2222222-2222-4222-8222-222222222222";
    await repository.inTransaction(
      northstarContext,
      async (transaction, outbox) => {
        await transaction.insert(syncOperations).values({
          id: operationId,
          tenantId: DEMO_TENANTS.northstar,
          workflowType: "order_release",
          aggregateType: "order",
          aggregateId: "COM-M4-JOB-1001",
          direction: "push",
          idempotencyKey: "m4-job-operation-1001",
          commandHash: "m4-job-command-1001",
          status: "pending",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
        const result = await outbox.append(
          outboundMessage({
            destination: "internal",
            messageType: "order.release.v1",
            idempotencyKey: "m4-job-publication-1001",
            jobType: "order",
            syncOperationId: operationId,
            workflowType: "order_release",
            aggregateType: "order",
            aggregateId: "COM-M4-JOB-1001",
          }),
        );
        expect(result.duplicate).toBe(false);
      },
      now,
    );
    const persisted = await handle.pool.query<{
      sync_operation_id: string;
      job_type: string;
      workflow_type: string;
      aggregate_id: string;
    }>(
      `select sync_operation_id, job_type, workflow_type, aggregate_id
       from outbox_messages where idempotency_key = 'm4-job-publication-1001'`,
    );
    expect(persisted.rows[0]).toEqual({
      sync_operation_id: operationId,
      job_type: "order",
      workflow_type: "order_release",
      aggregate_id: "COM-M4-JOB-1001",
    });

    await handle.db.insert(syncOperations).values({
      id: conflictingOperationId,
      tenantId: DEMO_TENANTS.northstar,
      workflowType: "order_release",
      aggregateType: "order",
      aggregateId: "COM-M4-JOB-1002",
      direction: "push",
      idempotencyKey: "m4-job-operation-1002",
      commandHash: "m4-job-command-1002",
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      repository.inTransaction(
        northstarContext,
        (_transaction, outbox) =>
          outbox.append(
            outboundMessage({
              destination: "internal",
              messageType: "order.release.v1",
              idempotencyKey: "m4-job-publication-1001",
              jobType: "order",
              syncOperationId: conflictingOperationId,
            }),
          ),
        now,
      ),
    ).rejects.toMatchObject({ code: "OUTBOX_OPERATION_CONFLICT" });
  });

  it("rejects oversized payloads before creating a durable intent", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createOutboxRepository(handle.db);
    await expect(
      repository.inTransaction(
        northstarContext,
        (_transaction, outbox) =>
          outbox.append(
            outboundMessage({
              idempotencyKey: "m4-oversized-payload",
              payload: { data: "x".repeat(256 * 1024) },
            }),
          ),
        now,
      ),
    ).rejects.toThrow("outbox payload exceeds");
  });
});
