import { describe, expect, it } from "vitest";
import { createDurableJobRouter } from "@handoff/queue";
import type { OutboundDelivery } from "@handoff/domain";

const delivery: OutboundDelivery = {
  id: "a3333333-3333-4333-8333-333333333333",
  tenantId: "11111111-1111-4111-8111-111111111111",
  destination: "internal",
  messageType: "order.release.v1",
  messageVersion: 1,
  payload: { aggregateId: "COM-T020-1001" },
  idempotencyKey: "t020-router-1001",
  correlationId: "corr-t020-router-1001",
  attemptCount: 1,
};

describe("durable job router", () => {
  it("routes explicit and inferred logical job types to one handler", async () => {
    const seen: string[] = [];
    const router = createDurableJobRouter({
      order: (job) => {
        seen.push(job.id);
        return Promise.resolve({
          remoteReceiptId: "internal-t020-1001",
          idempotencyKey: job.idempotencyKey,
          correlationId: job.correlationId,
          acceptedAt: "2026-01-01T00:20:00.000Z",
          duplicate: false,
        });
      },
    });
    await expect(router.deliver(delivery)).resolves.toMatchObject({
      remoteReceiptId: "internal-t020-1001",
    });
    await expect(router.deliver({ ...delivery, jobType: "order" })).resolves.toBeDefined();
    expect(seen).toEqual([delivery.id, delivery.id]);
  });

  it("fails closed when no logical route is configured", async () => {
    const router = createDurableJobRouter({});
    await expect(router.deliver(delivery)).rejects.toThrow("durable job route is not configured");
    await expect(router.deliver({ ...delivery, messageType: "carrier.label.v1" })).rejects.toThrow(
      "no durable job route",
    );
  });
});
