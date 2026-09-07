import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeterministicMockOutboundAdapter } from "@handoff/adapters";
import { createOutboxRepository, DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { createOutboxDispatcher } from "@handoff/queue";
import type { OutboundMessage } from "@handoff/domain";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

describe.skipIf(!testDatabaseUrl)("identifier propagation", () => {
  let handle: DatabaseHandle | undefined;
  const now = new Date("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("persists correlation, causation, idempotency, outbox and synthetic remote receipt together", async () => {
    if (!handle) throw new Error("test database was not opened");
    const message: OutboundMessage = {
      tenantId: DEMO_TENANTS.northstar,
      destination: "mock-commerce",
      messageType: "commerce.fulfillment.v1",
      messageVersion: 1,
      payload: { sourceOrderId: "COM-TRACE-1001" },
      idempotencyKey: "trace-event-1001",
      correlationId: "trace-correlation-1001",
      causationId: "trace-command-1001",
    };
    const outbox = createOutboxRepository(handle.db);
    const appended = await outbox.inTransaction(
      { tenantId: message.tenantId },
      (_transaction, writer) => writer.append(message),
      now,
    );
    const dispatcher = createOutboxDispatcher({
      db: handle.db,
      config: {
        outboxMaxAttempts: 2,
        outboxRetryBaseMs: 10,
        outboxRetryMaxMs: 100,
        outboxRetryJitterMs: 0,
      },
      adapter: new DeterministicMockOutboundAdapter(),
    });

    const dispatch = await dispatcher.dispatchNext(
      { tenantId: message.tenantId },
      "trace-worker",
      now,
    );
    expect(dispatch.status).toBe("sent");
    if (dispatch.status !== "sent") throw new Error("trace delivery was not sent");
    expect(dispatch.remoteReceiptId?.startsWith("mock-receipt-")).toBe(true);
    const appendedMessage = appended.message as { id: string };

    const rows = await handle.pool.query<{
      idempotency_key: string;
      correlation_id: string;
      causation_id: string;
      remote_receipt_id: string;
      outbox_id: string;
    }>(
      `select o.idempotency_key, o.correlation_id, o.causation_id,
              r.remote_receipt_id, r.outbox_id
         from outbox_messages o
         join outbox_delivery_receipts r on r.outbox_id = o.id
        where o.id = $1`,
      [appendedMessage.id],
    );
    expect(rows.rows[0]).toMatchObject({
      idempotency_key: message.idempotencyKey,
      correlation_id: message.correlationId,
      causation_id: message.causationId,
      outbox_id: appendedMessage.id,
    });
    expect(rows.rows[0]?.remote_receipt_id.startsWith("mock-receipt-")).toBe(true);
  });
});
