import { describe, expect, it } from "vitest";
import {
  acceptCommerceOrder,
  applyWarehouseUpdate,
  cancellationOutcome,
  confirmShipment,
  initialFulfillment,
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
});
