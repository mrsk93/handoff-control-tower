import { describe, expect, it } from "vitest";
import {
  acceptCommerceOrder,
  applyWarehouseUpdate,
  applyShipmentObservation,
  cancellationOutcome,
  classifyFreshness,
  confirmShipment,
  initialFulfillment,
  transitionOrderLifecycle,
  type CanonicalOrder,
  type FulfillmentActual,
  type FulfillmentLine,
} from "@handoff/domain";

const occurredAt = "2026-01-01T00:00:00.000Z";

function makeOrder(): CanonicalOrder {
  return acceptCommerceOrder({
    tenantId: "tenant-a",
    orderId: "order-a",
    sourceOrderId: "COM-A-1",
    sourceVersion: "1",
    orderNumber: "#A-1",
    currency: "usd",
    acceptedAt: occurredAt,
    paymentReleased: true,
    lines: [
      { sourceLineId: "line-1", sku: "SKU-1", quantity: 2 },
      { sourceLineId: "line-2", sku: "SKU-2", quantity: 1 },
    ],
  }).order;
}

function makeLines(overrides: Partial<FulfillmentLine> = {}): FulfillmentLine[] {
  return [
    {
      lineId: "COM-A-1:line-1",
      allocatedQty: 2,
      pickedQty: 2,
      packedQty: 2,
      shippedQty: 0,
      shortQty: 0,
      damagedQty: 0,
      ...overrides,
    },
    {
      lineId: "COM-A-1:line-2",
      allocatedQty: 1,
      pickedQty: 1,
      packedQty: 1,
      shippedQty: 0,
      shortQty: 0,
      damagedQty: 0,
    },
  ];
}

function makeFulfillment(overrides: Partial<FulfillmentActual> = {}): FulfillmentActual {
  return {
    ...initialFulfillment(makeOrder()),
    warehouseOrderId: "WH-A-1",
    status: "picking",
    lines: makeLines(),
    ...overrides,
  };
}

describe("fulfillment process domain seam", () => {
  it("holds an order with missing SKU evidence without inventing a line", () => {
    const result = acceptCommerceOrder({
      tenantId: "tenant-a",
      orderId: "order-a",
      sourceOrderId: "COM-A-1",
      sourceVersion: "1",
      orderNumber: "#A-1",
      currency: "USD",
      acceptedAt: occurredAt,
      lines: [{ sourceLineId: "line-1", quantity: 2 }],
    });

    expect(result.order.releaseStatus).toBe("held");
    expect(result.order.lines).toEqual([]);
    expect(result.exceptions[0]).toMatchObject({ code: "MISSING_SKU_MAPPING" });
  });

  it("applies a newer warehouse snapshot and ignores an older snapshot", () => {
    const order = makeOrder();
    const current = makeFulfillment();
    const applied = applyWarehouseUpdate(
      order,
      current,
      { warehouseOrderId: "WH-A-1", sourceVersion: "2", status: "packed", lines: makeLines() },
      "1",
    );
    expect(applied.outcome).toBe("applied");
    if (applied.outcome !== "applied") throw new Error("expected an applied update");
    expect(applied.fulfillment.status).toBe("packed");
    const stale = applyWarehouseUpdate(
      order,
      applied.fulfillment,
      {
        warehouseOrderId: "WH-A-1",
        sourceVersion: "1",
        status: "picking",
        lines: makeLines({ packedQty: 0, pickedQty: 0 }),
      },
      "2",
    );
    expect(stale).toMatchObject({ outcome: "stale", fulfillment: applied.fulfillment });
  });

  it("turns an unversioned quantity decrease into an explicit conflict", () => {
    const result = applyWarehouseUpdate(
      makeOrder(),
      makeFulfillment(),
      {
        warehouseOrderId: "WH-A-1",
        sourceVersion: "3",
        status: "picking",
        lines: makeLines({ pickedQty: 1 }),
      },
      "2",
    );
    expect(result).toMatchObject({
      outcome: "conflict",
      exception: { code: "NON_MONOTONIC_WAREHOUSE_UPDATE" },
    });
  });

  it("creates shipment evidence only within packed quantities", () => {
    const shipment = confirmShipment(makeOrder(), makeFulfillment(), {
      shipmentId: "shipment-a",
      carrierCode: "mock-carrier",
      serviceCode: "ground",
      trackingNumber: "MOCK-TRACK-A",
      lines: [{ lineId: "COM-A-1:line-1", quantity: 1 }],
    });
    expect(shipment.status).toBe("shipped");
    expect(() =>
      confirmShipment(makeOrder(), makeFulfillment(), {
        shipmentId: "shipment-b",
        carrierCode: "mock-carrier",
        serviceCode: "ground",
        trackingNumber: "MOCK-TRACK-B",
        lines: [{ lineId: "COM-A-1:line-1", quantity: 3 }],
      }),
    ).toThrow("packed quantity");
  });

  it("preserves shipment evidence when cancellation compensation loses", () => {
    expect(cancellationOutcome("cancelled")).toEqual({ status: "cancelled" });
    expect(cancellationOutcome("already_shipped")).toMatchObject({
      status: "conflict",
      exception: { code: "CANCEL_AFTER_SHIPMENT" },
    });
  });

  it("accepts direct shipment evidence without fabricating pick or pack stages", () => {
    const order = makeOrder();
    const initial = initialFulfillment(order);
    const first = applyShipmentObservation(order, initial, {
      shipmentId: "shipment-observation-1",
      eventId: "ship-event-1",
      sourceVersion: "1",
      occurredAt,
      observedAt: "2026-01-01T00:01:00.000Z",
      carrierCode: "sandbox-carrier",
      serviceCode: "ground",
      trackingNumber: "TRACK-1",
      lines: [{ lineId: "COM-A-1:line-1", quantity: 1 }],
    });
    expect(first.outcome).toBe("applied");
    if (first.outcome !== "applied") throw new Error("expected direct shipment evidence to apply");
    expect(first.fulfillment.status).toBe("partially_shipped");
    expect(first.fulfillment.quantityEvidence).toBe("shipment_authoritative");
    expect(first.fulfillment.lines[0]?.packedQty).toBe(0);
    expect(first.order.lifecycleStatus).toBe("partially_shipped");

    const second = applyShipmentObservation(first.order, first.fulfillment, {
      shipmentId: "shipment-observation-2",
      eventId: "ship-event-2",
      sourceVersion: "2",
      occurredAt: "2026-01-01T00:02:00.000Z",
      observedAt: "2026-01-01T00:03:00.000Z",
      carrierCode: "sandbox-carrier",
      serviceCode: "ground",
      trackingNumber: "TRACK-2",
      lines: [
        { lineId: "COM-A-1:line-1", quantity: 1 },
        { lineId: "COM-A-1:line-2", quantity: 1 },
      ],
    });
    expect(second.outcome).toBe("applied");
    if (second.outcome !== "applied") throw new Error("expected second shipment evidence to apply");
    expect(second.fulfillment.status).toBe("shipped");
    expect(second.order.lifecycleStatus).toBe("shipped");
    expect(
      applyShipmentObservation(second.order, second.fulfillment, {
        shipmentId: "shipment-observation-2",
        eventId: "ship-event-2",
        sourceVersion: "2",
        occurredAt: "2026-01-01T00:02:00.000Z",
        observedAt: "2026-01-01T00:03:00.000Z",
        carrierCode: "sandbox-carrier",
        serviceCode: "ground",
        trackingNumber: "TRACK-2",
        lines: [{ lineId: "COM-A-1:line-2", quantity: 1 }],
      }).outcome,
    ).toBe("duplicate");
    expect(
      applyShipmentObservation(second.order, second.fulfillment, {
        shipmentId: "shipment-observation-old",
        eventId: "ship-event-old",
        sourceVersion: "1",
        occurredAt: "2026-01-01T00:01:00.000Z",
        observedAt: "2026-01-01T00:01:30.000Z",
        carrierCode: "sandbox-carrier",
        serviceCode: "ground",
        trackingNumber: "TRACK-old",
        lines: [{ lineId: "COM-A-1:line-2", quantity: 1 }],
      }).outcome,
    ).toBe("stale");
    expect(
      applyShipmentObservation(second.order, second.fulfillment, {
        shipmentId: "shipment-observation-conflict",
        eventId: "ship-event-conflict",
        sourceVersion: "2",
        occurredAt: "2026-01-01T00:02:00.000Z",
        observedAt: "2026-01-01T00:03:00.000Z",
        carrierCode: "sandbox-carrier",
        serviceCode: "ground",
        trackingNumber: "TRACK-conflict",
        lines: [{ lineId: "COM-A-1:line-2", quantity: 1 }],
      }).outcome,
    ).toBe("conflict");
  });

  it("keeps lifecycle transitions explicit and guards cancellation after shipment", () => {
    const order = makeOrder();
    const pending = transitionOrderLifecycle(order, {
      type: "erp_pending",
      idempotencyKey: "life-1",
      occurredAt,
    }).state;
    const created = transitionOrderLifecycle(pending, {
      type: "erp_created",
      idempotencyKey: "life-2",
      occurredAt,
    }).state;
    const ready = transitionOrderLifecycle(created, {
      type: "fulfillment_pending",
      idempotencyKey: "life-3",
      occurredAt,
    }).state;
    const released = transitionOrderLifecycle(ready, {
      type: "release_to_3pl",
      idempotencyKey: "life-4",
      occurredAt,
    }).state;
    const shipped = transitionOrderLifecycle(released, {
      type: "shipment_observed",
      idempotencyKey: "life-5",
      occurredAt,
    }).state;
    const delivered = transitionOrderLifecycle(shipped, {
      type: "delivery_observed",
      idempotencyKey: "life-6",
      occurredAt,
    }).state;
    expect(delivered.lifecycleStatus).toBe("delivered");
    expect(() =>
      transitionOrderLifecycle(shipped, {
        type: "request_cancel",
        idempotencyKey: "life-cancel",
        occurredAt,
      }),
    ).toThrow("Cannot apply request_cancel");
  });

  it("classifies replay, stale, and equal-freshness observations explicitly", () => {
    const current = {
      eventId: "event-2",
      sourceVersion: "2",
      occurredAt,
      observedAt: "2026-01-01T00:02:00.000Z",
    };
    expect(classifyFreshness({ ...current }, current)).toBe("duplicate");
    expect(classifyFreshness({ ...current, eventId: "event-1", sourceVersion: "1" }, current)).toBe(
      "stale",
    );
    expect(classifyFreshness({ ...current, eventId: "event-3" }, current)).toBe("ambiguous");
  });
});
