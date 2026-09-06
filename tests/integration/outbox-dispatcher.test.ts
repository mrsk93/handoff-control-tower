import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeterministicMockOutboundAdapter } from "@handoff/adapters";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";
import { createOutboxRepository, DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { createOutboxDispatcher } from "@handoff/queue";
import type { OutboundDelivery, OutboundDeliveryAdapter, OutboundMessage } from "@handoff/domain";

const now = new Date("2026-01-01T00:30:00.000Z");
const config = {
  outboxMaxAttempts: 2,
  outboxRetryBaseMs: 10,
  outboxRetryMaxMs: 10_000,
  outboxRetryJitterMs: 0,
};

function outboundMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    tenantId: DEMO_TENANTS.northstar,
    destination: "mock-carrier",
    messageType: "carrier.create_label.v1",
    messageVersion: 1,
    payload: { orderSourceId: "COM-M4-DISPATCH" },
    idempotencyKey: "m4-dispatch-1001",
    correlationId: "m4-dispatch-correlation-1001",
    ...overrides,
  };
}

async function appendMessage(handle: DatabaseHandle, message: OutboundMessage): Promise<void> {
  await createOutboxRepository(handle.db).inTransaction(
    { tenantId: message.tenantId },
    (_transaction, outbox) => outbox.append(message).then(() => undefined),
    now,
  );
}

describe.skipIf(!testDatabaseUrl)("outbox dispatcher", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("dispatches after claim and records the sent state", async () => {
    if (!handle) throw new Error("test database was not opened");
    const message = outboundMessage({ idempotencyKey: "m4-dispatch-sent" });
    await appendMessage(handle, message);
    const adapter = new DeterministicMockOutboundAdapter();
    const dispatcher = createOutboxDispatcher({ db: handle.db, config, adapter });

    const result = await dispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-1",
      now,
    );

    expect(result).toMatchObject({ status: "sent", attemptCount: 1 });
    expect(adapter.effectCount()).toBe(1);
    const row = await handle.pool.query<{ status: string; attempt_count: number }>(
      `select status, attempt_count from outbox_messages where idempotency_key = 'm4-dispatch-sent'`,
    );
    expect(row.rows[0]).toEqual({ status: "sent", attempt_count: 1 });
  });

  it("retries transient adapter failures with deterministic backoff", async () => {
    if (!handle) throw new Error("test database was not opened");
    const message = outboundMessage({ idempotencyKey: "m4-dispatch-retry" });
    await appendMessage(handle, message);
    const adapter = new DeterministicMockOutboundAdapter();
    adapter.failNextDeliveries(1);
    const dispatcher = createOutboxDispatcher({ db: handle.db, config, adapter });

    const failed = await dispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-retry",
      now,
    );
    if (failed.status === "idle") throw new Error("retry attempt should claim a message");
    expect(failed).toMatchObject({ status: "retry_wait", attemptCount: 1 });
    expect(failed.retryAt).toEqual(new Date(now.getTime() + 10));

    const completed = await dispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-restarted",
      new Date(now.getTime() + 10),
    );
    expect(completed).toMatchObject({ status: "sent", attemptCount: 2 });
    expect(adapter.effectCount()).toBe(1);
  });

  it("deduplicates a remote effect after a crash during dispatch", async () => {
    if (!handle) throw new Error("test database was not opened");
    const message = outboundMessage({ idempotencyKey: "m4-dispatch-crash" });
    await appendMessage(handle, message);
    const adapter = new DeterministicMockOutboundAdapter();
    let crashAfterEffect = true;
    const crashAdapter: OutboundDeliveryAdapter = {
      async deliver(delivery: OutboundDelivery): Promise<void> {
        await adapter.deliver(delivery);
        if (crashAfterEffect) {
          crashAfterEffect = false;
          throw new Error("simulated worker crash after remote effect");
        }
      },
    };
    const firstDispatcher = createOutboxDispatcher({
      db: handle.db,
      config,
      adapter: crashAdapter,
    });

    const first = await firstDispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-crash-1",
      now,
    );
    expect(first).toMatchObject({ status: "retry_wait", attemptCount: 1 });

    const restartedDispatcher = createOutboxDispatcher({
      db: handle.db,
      config,
      adapter,
    });
    const second = await restartedDispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-crash-2",
      new Date(now.getTime() + 10),
    );
    expect(second).toMatchObject({ status: "sent", attemptCount: 2 });
    expect(adapter.effectCount()).toBe(1);
  });

  it("dead-letters after the attempt limit and requires a reason to retry", async () => {
    if (!handle) throw new Error("test database was not opened");
    const message = outboundMessage({ idempotencyKey: "m4-dispatch-dead-letter" });
    await appendMessage(handle, message);
    const adapter = new DeterministicMockOutboundAdapter();
    adapter.failNextDeliveries(2);
    const dispatcher = createOutboxDispatcher({ db: handle.db, config, adapter });

    await dispatcher.dispatchNext({ tenantId: DEMO_TENANTS.northstar }, "dispatcher-dead", now);
    const deadLettered = await dispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-dead",
      new Date(now.getTime() + 10),
    );
    if (deadLettered.status === "idle") throw new Error("second attempt should claim a message");
    expect(deadLettered).toMatchObject({ status: "dead_letter", attemptCount: 2 });
    await expect(
      dispatcher.retryDeadLetter(
        { tenantId: DEMO_TENANTS.northstar },
        deadLettered.messageId,
        "   ",
        new Date(now.getTime() + 20),
      ),
    ).rejects.toThrow("manual retry reason is required");

    const retried = await dispatcher.retryDeadLetter(
      { tenantId: DEMO_TENANTS.northstar },
      deadLettered.messageId,
      "operator confirmed the mock endpoint recovered",
      new Date(now.getTime() + 20),
    );
    if (!retried) throw new Error("manual retry should return the dead-lettered message");
    expect(retried.status).toBe("pending");
    expect(retried.lastError).toContain("manual retry");
    const completed = await dispatcher.dispatchNext(
      { tenantId: DEMO_TENANTS.northstar },
      "dispatcher-manual-retry",
      new Date(now.getTime() + 20),
    );
    expect(completed).toMatchObject({ status: "sent", attemptCount: 3 });
  });
});
