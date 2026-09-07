import { describe, expect, it } from "vitest";
import {
  reconcileCarrierShipment,
  reconcileCommerceFulfillment,
  reconcileCommerceOrder,
  reconcileWarehouseFulfillment,
} from "@handoff/domain";
import type { CanonicalOrder, FulfillmentActual, Shipment } from "@handoff/domain";

const order = (sourceVersion: string): CanonicalOrder => ({
  tenantId: "tenant-a",
  orderId: "order-a",
  source: "commerce",
  sourceOrderId: "COM-1001",
  sourceVersion,
  orderNumber: "#1001",
  currency: "USD",
  acceptedAt: "2026-01-01T00:00:00.000Z",
  releaseStatus: "released",
  lines: [
    {
      lineId: "COM-1001:line-1",
      sourceLineId: "line-1",
      sku: "SKU-1",
      orderedQty: 1,
      cancelledQty: 0,
    },
  ],
});

const fulfillment = (
  version: number,
  status: FulfillmentActual["status"] = "shipped",
): FulfillmentActual => ({
  tenantId: "tenant-a",
  orderId: "order-a",
  warehouseOrderId: "WH-1001",
  status,
  version,
  lines: [
    {
      lineId: "COM-1001:line-1",
      allocatedQty: 1,
      pickedQty: 1,
      packedQty: 1,
      shippedQty: 1,
      shortQty: 0,
      damagedQty: 0,
    },
  ],
});

const shipment = (trackingNumber: string): Shipment => ({
  tenantId: "tenant-a",
  shipmentId: "SHIP-1001",
  orderId: "order-a",
  carrierCode: "mock-carrier",
  serviceCode: "ground",
  trackingNumber,
  lines: [{ lineId: "COM-1001:line-1", quantity: 1 }],
  status: "shipped",
});

describe("reconciliation decision seam", () => {
  it("repairs a missing local commerce order and newer local warehouse evidence", () => {
    expect(reconcileCommerceOrder(order("2"), null)).toMatchObject({
      category: "missing_local",
      recommendedAction: "apply_authoritative_order",
      autoRepairable: true,
    });
    expect(reconcileWarehouseFulfillment(fulfillment(2), fulfillment(1, "picking"))).toMatchObject({
      category: "stale_local",
      recommendedAction: "apply_authoritative_fulfillment",
    });
  });

  it("never auto-repairs quantity or tracking disagreements", () => {
    const localWithDifferentQuantity: FulfillmentActual = {
      ...fulfillment(1),
      lines: [
        {
          lineId: "COM-1001:line-1",
          allocatedQty: 1,
          pickedQty: 1,
          packedQty: 1,
          shippedQty: 0,
          shortQty: 0,
          damagedQty: 0,
        },
      ],
    };
    expect(reconcileWarehouseFulfillment(fulfillment(1), localWithDifferentQuantity)).toMatchObject(
      {
        category: "quantity_mismatch",
        recommendedAction: "review",
        autoRepairable: false,
      },
    );
    expect(
      reconcileCarrierShipment(shipment("TRACK-REMOTE"), shipment("TRACK-LOCAL")),
    ).toMatchObject({
      category: "tracking_mismatch",
      recommendedAction: "review",
      autoRepairable: false,
    });
  });

  it("requests a stable fulfillment redispatch for a missing remote reflection", () => {
    expect(reconcileCommerceFulfillment("order-a", { "line-1": 1 }, "missing", {})).toMatchObject({
      category: "missing_remote",
      recommendedAction: "redispatch_commerce_fulfillment",
      autoRepairable: true,
    });
  });
});
