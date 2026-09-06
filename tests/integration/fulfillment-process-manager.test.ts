import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockSignature } from "@handoff/adapters";
import { DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { createFulfillmentProcessManager, createInboxIngestionService } from "@handoff/queue";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const tenantId = DEMO_TENANTS.northstar;
const secrets = {
  commerce: "local-commerce-secret",
  wms: "local-wms-secret",
  carrier: "local-carrier-secret",
};
const baseTime = new Date("2026-01-01T01:00:00.000Z");

function body(
  source: "commerce" | "wms" | "carrier",
  messageId: string,
  eventType: string,
  sourceEntityId: string,
  payload: Record<string, unknown>,
  sourceVersion?: string,
): { source: "commerce" | "wms" | "carrier"; rawBody: Buffer; signatureHeader: string } {
  const rawBody = Buffer.from(
    JSON.stringify({
      messageId,
      eventType,
      eventVersion: 1,
      sourceEntityId,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
      occurredAt: baseTime.toISOString(),
      correlationId: `corr:${messageId}`,
      idempotencyKey: `key:${messageId}`,
      payload,
    }),
  );
  return {
    source,
    rawBody,
    signatureHeader: createMockSignature(rawBody, secrets[source]),
  };
}

describe.skipIf(!testDatabaseUrl)("fulfillment process manager", () => {
  let handle: DatabaseHandle | undefined;
  let accept: ReturnType<typeof createInboxIngestionService>;
  let process: ReturnType<typeof createFulfillmentProcessManager>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    accept = createInboxIngestionService({
      config: {
        ingestMaxBodyBytes: 1_048_576,
        mockWebhookSecrets: secrets,
      },
      db: handle.db,
    });
    process = createFulfillmentProcessManager({
      db: handle.db,
      config: { allowPartialInvoiceEligibility: false, outboxMaxAttempts: 3 },
    });
  });

  afterAll(async () => closeTestDatabase(handle));

  async function ingestAndProcess(input: ReturnType<typeof body>, workerId: string): Promise<void> {
    if (!handle) throw new Error("test database was not opened");
    await accept.accept({ tenantId, ...input, now: baseTime });
    const result = await process.processNext(tenantId, workerId, baseTime);
    expect(result.status).toMatch(/processed|ignored|conflict|parked/);
  }

  it("completes order release, warehouse actuals, shipment sync, and guarded billing readiness", async () => {
    if (!handle) throw new Error("test database was not opened");
    await ingestAndProcess(
      body("commerce", "m6-order-1", "commerce.order.accepted.v1", "COM-M6-1001", {
        sourceOrderId: "COM-M6-1001",
        orderNumber: "#M6-1001",
        currency: "USD",
        paymentReleased: true,
        lines: [
          { sourceLineId: "line-1", sku: "SKU-1", quantity: 2 },
          { sourceLineId: "line-2", sku: "SKU-2", quantity: 1 },
        ],
      }),
      "m6-order-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-ack-1",
        "wms.order.acknowledged.v1",
        "COM-M6-1001",
        {
          orderSourceId: "COM-M6-1001",
          warehouseOrderId: "WH-M6-1001",
          status: "acknowledged",
          lines: [
            { lineId: "line-1", allocatedQty: 2 },
            { lineId: "line-2", allocatedQty: 1 },
          ],
        },
        "1",
      ),
      "m6-wms-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-picking-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-1001",
        {
          orderSourceId: "COM-M6-1001",
          warehouseOrderId: "WH-M6-1001",
          status: "picking",
          lines: [
            { lineId: "line-1", allocatedQty: 2, pickedQty: 2 },
            { lineId: "line-2", allocatedQty: 1, pickedQty: 1 },
          ],
        },
        "2",
      ),
      "m6-wms-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-packed-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-1001",
        {
          orderSourceId: "COM-M6-1001",
          warehouseOrderId: "WH-M6-1001",
          status: "packed",
          lines: [
            { lineId: "line-1", allocatedQty: 2, pickedQty: 2, packedQty: 2 },
            { lineId: "line-2", allocatedQty: 1, pickedQty: 1, packedQty: 1 },
          ],
        },
        "3",
      ),
      "m6-wms-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-shipped-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-1001",
        {
          orderSourceId: "COM-M6-1001",
          warehouseOrderId: "WH-M6-1001",
          status: "shipped",
          lines: [
            { lineId: "line-1", allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 2 },
            { lineId: "line-2", allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 },
          ],
        },
        "4",
      ),
      "m6-wms-worker",
    );
    await ingestAndProcess(
      body("carrier", "m6-carrier-1", "carrier.shipment.confirmed.v1", "COM-M6-1001", {
        sourceOrderId: "COM-M6-1001",
        shipmentId: "SHIP-M6-1001",
        carrierCode: "mock-carrier",
        serviceCode: "ground",
        trackingNumber: "MOCK-TRACK-M6-1001",
        lines: [
          { lineId: "line-1", quantity: 2 },
          { lineId: "line-2", quantity: 1 },
        ],
      }),
      "m6-carrier-worker",
    );
    await ingestAndProcess(
      body("commerce", "m6-readback-1", "commerce.fulfillment.readback.v1", "COM-M6-1001", {
        sourceOrderId: "COM-M6-1001",
        status: "reflected",
        shippedQtyByLine: { "COM-M6-1001:line-1": 2, "COM-M6-1001:line-2": 1 },
      }),
      "m6-commerce-worker",
    );

    const result = await handle.pool.query<{
      release_status: string;
      fulfillment_status: string;
      shipped_qty: string;
      shipments: string;
      invoice_eligible: boolean;
      billing_messages: string;
    }>(
      `select
         o.release_status,
         f.status as fulfillment_status,
         (select coalesce(sum(fl.shipped_qty), 0)::text from fulfillment_lines fl where fl.fulfillment_id = f.id) as shipped_qty,
         (select count(*)::text from shipments s where s.order_id = o.id) as shipments,
         p.invoice_eligible,
         (select count(*)::text from outbox_messages om where om.message_type = 'billing.eligibility.v1' and om.tenant_id = o.tenant_id) as billing_messages
       from orders o
       join fulfillments f on f.order_id = o.id
       join process_instances p on p.order_id = o.id
       where o.tenant_id = $1 and o.source_order_id = 'COM-M6-1001'`,
      [tenantId],
    );
    expect(result.rows[0]).toMatchObject({
      release_status: "released",
      fulfillment_status: "shipped",
      shipped_qty: "3",
      shipments: "1",
      invoice_eligible: true,
      billing_messages: "1",
    });
  });

  it("wakes an out-of-order warehouse message after the order commits", async () => {
    if (!handle) throw new Error("test database was not opened");
    const parked = body(
      "wms",
      "m6-parked-1",
      "wms.order.acknowledged.v1",
      "COM-M6-PARKED",
      {
        orderSourceId: "COM-M6-PARKED",
        warehouseOrderId: "WH-M6-PARKED",
        status: "acknowledged",
      },
      "1",
    );
    const parkedResult = await accept.accept({ tenantId, ...parked, now: baseTime });
    expect(parkedResult.status).toBe("parked");
    expect((await process.processNext(tenantId, "m6-parked-worker", baseTime)).status).toBe("idle");

    await ingestAndProcess(
      body("commerce", "m6-parked-order-1", "commerce.order.accepted.v1", "COM-M6-PARKED", {
        sourceOrderId: "COM-M6-PARKED",
        orderNumber: "#M6-PARKED",
        currency: "USD",
        lines: [{ sourceLineId: "line-1", sku: "SKU-PARKED", quantity: 1 }],
      }),
      "m6-parked-order-worker",
    );
    expect((await process.processNext(tenantId, "m6-parked-worker", baseTime)).status).toBe(
      "processed",
    );
    const count = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from inbox_messages where tenant_id = $1 and message_id = 'm6-parked-1' and status = 'processed'`,
      [tenantId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("preserves a partial shipment and keeps eligibility blocked when policy disallows partials", async () => {
    if (!handle) throw new Error("test database was not opened");
    await ingestAndProcess(
      body("commerce", "m6-partial-order-1", "commerce.order.accepted.v1", "COM-M6-PARTIAL", {
        sourceOrderId: "COM-M6-PARTIAL",
        orderNumber: "#M6-PARTIAL",
        currency: "USD",
        lines: [
          { sourceLineId: "line-1", sku: "SKU-P1", quantity: 2 },
          { sourceLineId: "line-2", sku: "SKU-P2", quantity: 1 },
        ],
      }),
      "m6-partial-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-partial-ack-1",
        "wms.order.acknowledged.v1",
        "COM-M6-PARTIAL",
        {
          orderSourceId: "COM-M6-PARTIAL",
          warehouseOrderId: "WH-M6-PARTIAL",
          status: "acknowledged",
          lines: [
            { lineId: "line-1", allocatedQty: 2 },
            { lineId: "line-2", allocatedQty: 1 },
          ],
        },
        "1",
      ),
      "m6-partial-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-partial-packed-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-PARTIAL",
        {
          orderSourceId: "COM-M6-PARTIAL",
          warehouseOrderId: "WH-M6-PARTIAL",
          status: "packed",
          lines: [
            { lineId: "line-1", allocatedQty: 2, pickedQty: 2, packedQty: 2 },
            { lineId: "line-2", allocatedQty: 1, pickedQty: 1, packedQty: 1 },
          ],
        },
        "2",
      ),
      "m6-partial-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-partial-ship-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-PARTIAL",
        {
          orderSourceId: "COM-M6-PARTIAL",
          warehouseOrderId: "WH-M6-PARTIAL",
          status: "shipped",
          lines: [
            { lineId: "line-1", allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 1 },
            { lineId: "line-2", allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 0 },
          ],
        },
        "3",
      ),
      "m6-partial-worker",
    );
    await ingestAndProcess(
      body("carrier", "m6-partial-carrier-1", "carrier.shipment.confirmed.v1", "COM-M6-PARTIAL", {
        sourceOrderId: "COM-M6-PARTIAL",
        shipmentId: "SHIP-M6-PARTIAL",
        carrierCode: "mock-carrier",
        serviceCode: "ground",
        trackingNumber: "MOCK-TRACK-M6-PARTIAL",
        lines: [{ lineId: "line-1", quantity: 1 }],
      }),
      "m6-partial-worker",
    );
    await ingestAndProcess(
      body(
        "commerce",
        "m6-partial-readback-1",
        "commerce.fulfillment.readback.v1",
        "COM-M6-PARTIAL",
        {
          sourceOrderId: "COM-M6-PARTIAL",
          status: "reflected",
          shippedQtyByLine: { "COM-M6-PARTIAL:line-1": 1, "COM-M6-PARTIAL:line-2": 0 },
        },
      ),
      "m6-partial-worker",
    );

    const result = await handle.pool.query<{
      status: string;
      invoice_eligible: boolean;
      shipped_qty: string;
    }>(
      `select
         f.status,
         p.invoice_eligible,
         (select coalesce(sum(fl.shipped_qty), 0)::text from fulfillment_lines fl where fl.fulfillment_id = f.id) as shipped_qty
       from orders o
       join fulfillments f on f.order_id = o.id
       join process_instances p on p.order_id = o.id
       where o.tenant_id = $1 and o.source_order_id = 'COM-M6-PARTIAL'`,
      [tenantId],
    );
    expect(result.rows[0]).toEqual({
      status: "partially_shipped",
      invoice_eligible: false,
      shipped_qty: "1",
    });
  });

  it("keeps shipment evidence and opens a conflict for cancellation after shipment", async () => {
    if (!handle) throw new Error("test database was not opened");
    await ingestAndProcess(
      body("commerce", "m6-cancel-order-1", "commerce.order.accepted.v1", "COM-M6-CANCEL", {
        sourceOrderId: "COM-M6-CANCEL",
        orderNumber: "#M6-CANCEL",
        currency: "USD",
        lines: [{ sourceLineId: "line-1", sku: "SKU-CANCEL", quantity: 1 }],
      }),
      "m6-cancel-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-cancel-ack-1",
        "wms.order.acknowledged.v1",
        "COM-M6-CANCEL",
        {
          orderSourceId: "COM-M6-CANCEL",
          warehouseOrderId: "WH-M6-CANCEL",
          status: "acknowledged",
          lines: [{ lineId: "line-1", allocatedQty: 1 }],
        },
        "1",
      ),
      "m6-cancel-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-cancel-ship-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-CANCEL",
        {
          orderSourceId: "COM-M6-CANCEL",
          warehouseOrderId: "WH-M6-CANCEL",
          status: "shipped",
          lines: [{ lineId: "line-1", allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 }],
        },
        "2",
      ),
      "m6-cancel-worker",
    );
    await ingestAndProcess(
      body("commerce", "m6-cancel-request-1", "commerce.order.cancelled.v1", "COM-M6-CANCEL", {
        sourceOrderId: "COM-M6-CANCEL",
      }),
      "m6-cancel-worker",
    );
    await ingestAndProcess(
      body(
        "wms",
        "m6-cancel-result-1",
        "wms.fulfillment.updated.v1",
        "COM-M6-CANCEL",
        {
          orderSourceId: "COM-M6-CANCEL",
          warehouseOrderId: "WH-M6-CANCEL",
          status: "cancelled",
          lines: [{ lineId: "line-1", allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 }],
        },
        "3",
      ),
      "m6-cancel-worker",
    );
    const result = await handle.pool.query<{
      status: string;
      shipped_qty: string;
      exception_count: string;
    }>(
      `select
         f.status,
         (select coalesce(sum(fl.shipped_qty), 0)::text from fulfillment_lines fl where fl.fulfillment_id = f.id) as shipped_qty,
         (select count(*)::text from exceptions e where e.order_id = o.id and e.status = 'open') as exception_count
       from orders o join fulfillments f on f.order_id = o.id
       where o.tenant_id = $1 and o.source_order_id = 'COM-M6-CANCEL'`,
      [tenantId],
    );
    expect(result.rows[0]).toEqual({ status: "shipped", shipped_qty: "1", exception_count: "1" });
  });
});
