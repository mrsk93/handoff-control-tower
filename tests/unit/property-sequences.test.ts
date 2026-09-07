import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acceptCommerceOrder,
  applyWarehouseUpdate,
  assertFulfillmentQuantityInvariants,
  evaluateInvoiceEligibility,
  initialFulfillment,
  type CanonicalOrder,
  type FulfillmentLine,
} from "@handoff/domain";

const occurredAt = "2026-01-01T00:00:00.000Z";

function orderFor(quantity: number): CanonicalOrder {
  return acceptCommerceOrder({
    tenantId: "tenant-property",
    orderId: "order-property",
    sourceOrderId: "COM-PROPERTY-1",
    sourceVersion: "1",
    orderNumber: "#PROPERTY-1",
    currency: "USD",
    acceptedAt: occurredAt,
    lines: [{ sourceLineId: "line-1", sku: "SKU-PROPERTY-1", quantity }],
  }).order;
}

function lineFor(order: CanonicalOrder, quantity: number, shipped: number): FulfillmentLine {
  const lineId = order.lines[0]!.lineId;
  return {
    lineId,
    allocatedQty: quantity,
    pickedQty: quantity,
    packedQty: quantity,
    shippedQty: shipped,
    shortQty: 0,
    damagedQty: 0,
  };
}

describe("M11 property-based sequence invariants", () => {
  it("keeps valid quantity chains valid and never emits eligible state for a blocking invariant", () => {
    fc.assert(
      fc.property(
        fc.record({
          ordered: fc.integer({ min: 1, max: 20 }),
          shipped: fc.integer({ min: 0, max: 20 }),
        }),
        ({ ordered, shipped }) => {
          const boundedShipped = Math.min(ordered, shipped);
          const order = orderFor(ordered);
          const fulfillment = {
            ...initialFulfillment(order),
            status: boundedShipped === ordered ? ("shipped" as const) : ("packed" as const),
            lines: [lineFor(order, ordered, boundedShipped)],
          };
          assertFulfillmentQuantityInvariants(order, fulfillment);
          const decision = evaluateInvoiceEligibility({
            order: { ...order, releaseStatus: "released" },
            fulfillment,
            commerceFulfillment: {
              status: "reflected",
              shippedQtyByLine: { [order.lines[0]!.lineId]: boundedShipped },
            },
            ...(boundedShipped > 0 ? { trackingNumber: "SYNTH-PROPERTY-TRACK" } : {}),
            activeExceptions: [],
            partialShipmentEnabled: true,
            shortShipmentResolution: "unresolved",
            decisionVersion: 1,
            computedAt: occurredAt,
          });
          expect(
            decision.reasons.some((reason) => reason.code === "quantity_invariant_violation"),
          ).toBe(false);
          expect(decision.eligible).toBe(boundedShipped > 0);
        },
      ),
      { seed: 20260907, numRuns: 100 },
    );
  });

  it("is stable under duplicated and reordered monotonic warehouse observations", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pickedQty: fc.integer({ min: 0, max: 8 }),
            orderKey: fc.integer(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (observations) => {
          const order = orderFor(8);
          let fulfillment = initialFulfillment(order);
          const effects = new Set<string>();
          const events = observations
            .map((observation, index) => ({
              pickedQty: Math.min(8, observation.pickedQty),
              sourceVersion: String(index + 1),
              orderKey: observation.orderKey,
            }))
            .flatMap((event) => [event, { ...event }])
            .sort((left, right) => left.orderKey - right.orderKey);
          for (const event of events) {
            effects.add("warehouse.update:" + event.sourceVersion);
            const next = applyWarehouseUpdate(
              order,
              fulfillment,
              {
                warehouseOrderId: "WH-PROPERTY-1",
                sourceVersion: event.sourceVersion,
                status: "picking",
                lines: [
                  {
                    ...lineFor(order, 8, 0),
                    pickedQty: event.pickedQty,
                    packedQty: 0,
                  },
                ],
              },
              String(fulfillment.version - 1),
            );
            if (next.outcome === "applied") fulfillment = next.fulfillment;
            assertFulfillmentQuantityInvariants(order, fulfillment);
          }
          expect(fulfillment.lines[0]!.pickedQty).toBeGreaterThanOrEqual(0);
          expect(fulfillment.lines[0]!.pickedQty).toBeLessThanOrEqual(8);
          expect(effects.size).toBeLessThanOrEqual(observations.length);
        },
      ),
      { seed: 20260907, numRuns: 100 },
    );
  });
});
