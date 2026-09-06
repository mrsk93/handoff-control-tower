import { describe, expect, it } from "vitest";
import {
  canonicalOrderSchema,
  createInvoiceEligibilityEvent,
  evaluateInvoiceEligibility,
  fulfillmentActualSchema,
  InvalidTransitionError,
  InvariantViolationError,
  transitionFulfillment,
  transitionOrderRelease,
  type CanonicalOrder,
  type FulfillmentActual,
  type FulfillmentLine,
  type InvoiceEligibilityInput,
} from "@handoff/domain";

const occurredAt = "2026-01-01T00:00:00.000Z";

function makeOrder(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    tenantId: "tenant-a",
    orderId: "order-1",
    source: "commerce",
    sourceOrderId: "commerce-order-1",
    sourceVersion: "7",
    orderNumber: "#D1001",
    currency: "USD",
    acceptedAt: occurredAt,
    releaseStatus: "pending",
    lines: [
      {
        lineId: "line-1",
        sourceLineId: "source-line-1",
        sku: "SKU-1",
        orderedQty: 2,
        cancelledQty: 0,
      },
      {
        lineId: "line-2",
        sourceLineId: "source-line-2",
        sku: "SKU-2",
        orderedQty: 1,
        cancelledQty: 0,
      },
    ],
    ...overrides,
  };
}

function makeLine(lineId: string, overrides: Partial<FulfillmentLine> = {}): FulfillmentLine {
  return {
    lineId,
    allocatedQty: 0,
    pickedQty: 0,
    packedQty: 0,
    shippedQty: 0,
    shortQty: 0,
    damagedQty: 0,
    ...overrides,
  };
}

function makeFulfillment(overrides: Partial<FulfillmentActual> = {}): FulfillmentActual {
  return {
    tenantId: "tenant-a",
    orderId: "order-1",
    status: "not_sent",
    lines: [makeLine("line-1"), makeLine("line-2")],
    version: 1,
    ...overrides,
  };
}

function makeInput(overrides: Partial<InvoiceEligibilityInput> = {}): InvoiceEligibilityInput {
  return {
    order: makeOrder({ releaseStatus: "released" }),
    fulfillment: makeFulfillment({
      status: "shipped",
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 2 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 }),
      ],
    }),
    commerceFulfillment: {
      status: "reflected",
      shippedQtyByLine: { "line-1": 2, "line-2": 1 },
    },
    trackingNumber: "SYNTH-TRACK-1",
    activeExceptions: [],
    partialShipmentEnabled: false,
    shortShipmentResolution: "unresolved",
    decisionVersion: 3,
    computedAt: occurredAt,
    ...overrides,
  };
}

describe("M2 domain schemas and invariants", () => {
  it("parses canonical aggregates and rejects invalid quantities at the runtime seam", () => {
    const parsed = canonicalOrderSchema.parse(makeOrder());
    expect(parsed.orderId).toBe("order-1");
    expect(
      canonicalOrderSchema.safeParse({
        ...makeOrder(),
        lines: [{ ...makeOrder().lines[0], cancelledQty: 3 }],
      }),
    ).toMatchObject({ success: false });
    expect(
      fulfillmentActualSchema.safeParse({
        ...makeFulfillment(),
        lines: [makeLine("line-1", { pickedQty: -1 })],
      }),
    ).toMatchObject({ success: false });
  });

  it("does not mutate state and emits a deterministic order release event", () => {
    const order = makeOrder();
    const result = transitionOrderRelease(order, {
      type: "release",
      idempotencyKey: "release-1",
      occurredAt,
    });
    expect(order.releaseStatus).toBe("pending");
    expect(result.state.releaseStatus).toBe("released");
    expect(result.events[0]).toMatchObject({
      eventId: "release-1:event",
      eventType: "order.release_changed",
      aggregateId: "order-1",
    });
    expect(() =>
      transitionOrderRelease(result.state, {
        type: "cancel_confirmed",
        idempotencyKey: "invalid-1",
        occurredAt,
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("requires reasons for holds and preserves duplicate command idempotency", () => {
    expect(() =>
      transitionOrderRelease(makeOrder(), {
        type: "hold",
        idempotencyKey: "hold-1",
        occurredAt,
      }),
    ).toThrow(InvariantViolationError);
    const result = transitionOrderRelease(
      makeOrder(),
      { type: "release", idempotencyKey: "release-1", occurredAt },
      { processedCommandKeys: new Set(["release-1"]) },
    );
    expect(result).toMatchObject({ applied: false, duplicate: true, events: [] });
  });
});

describe("M2 fulfillment state machine", () => {
  it("advances the valid send, pick, pack, and ship path", () => {
    const order = makeOrder({ releaseStatus: "released" });
    let fulfillment = makeFulfillment();
    fulfillment = transitionFulfillment(order, fulfillment, {
      type: "send",
      idempotencyKey: "send-1",
      occurredAt,
    }).state;
    fulfillment = transitionFulfillment(order, fulfillment, {
      type: "acknowledge",
      idempotencyKey: "ack-1",
      occurredAt,
    }).state;
    fulfillment = transitionFulfillment(order, fulfillment, {
      type: "start_picking",
      idempotencyKey: "pick-1",
      occurredAt,
    }).state;
    fulfillment = transitionFulfillment(order, fulfillment, {
      type: "pack",
      idempotencyKey: "pack-1",
      occurredAt,
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
      ],
    }).state;
    fulfillment = transitionFulfillment(order, fulfillment, {
      type: "ship",
      idempotencyKey: "ship-1",
      occurredAt,
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 2 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 }),
      ],
    }).state;
    expect(fulfillment.status).toBe("shipped");
    expect(fulfillment.version).toBe(6);
  });

  it("rejects a quantity regression and supports partial completion", () => {
    const order = makeOrder({ releaseStatus: "released" });
    const packed = makeFulfillment({
      status: "packed",
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
      ],
    });
    expect(() =>
      transitionFulfillment(order, packed, {
        type: "ship",
        idempotencyKey: "bad-ship-1",
        occurredAt,
        lines: [
          makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 3 }),
          makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
        ],
      }),
    ).toThrow(InvariantViolationError);
    const partial = transitionFulfillment(order, packed, {
      type: "partially_ship",
      idempotencyKey: "partial-1",
      occurredAt,
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 1 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
      ],
    }).state;
    const complete = transitionFulfillment(order, partial, {
      type: "complete_remaining",
      idempotencyKey: "complete-1",
      occurredAt,
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2, shippedQty: 2 }),
        makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1, shippedQty: 1 }),
      ],
    }).state;
    expect(complete.status).toBe("shipped");
  });

  it("records a short during picking and requires an operator reason to close it", () => {
    const order = makeOrder({ releaseStatus: "released" });
    const picking = makeFulfillment({
      status: "picking",
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 1 }),
        makeLine("line-2", { allocatedQty: 1 }),
      ],
    });
    const exception = transitionFulfillment(order, picking, {
      type: "short_ship",
      idempotencyKey: "short-1",
      occurredAt,
      reason: "Synthetic stock short",
      lines: [
        makeLine("line-1", { allocatedQty: 2, pickedQty: 1, shortQty: 1 }),
        makeLine("line-2", { allocatedQty: 1 }),
      ],
    }).state;
    expect(exception.status).toBe("exception");
    expect(() =>
      transitionFulfillment(order, exception, {
        type: "close_short",
        idempotencyKey: "close-short-bad-1",
        occurredAt,
      }),
    ).toThrow(InvariantViolationError);
    const closed = transitionFulfillment(order, exception, {
      type: "close_short",
      idempotencyKey: "close-short-1",
      occurredAt,
      reason: "Synthetic operator decision",
    }).state;
    expect(closed.status).toBe("partially_shipped");
  });
});

describe("invoice eligibility truth table", () => {
  const cases: Array<{
    name: string;
    mutate?: (input: InvoiceEligibilityInput) => void;
    eligible: boolean;
    scope: "full_order" | "partial_shipment" | "none";
  }> = [
    { name: "full shipment", eligible: true, scope: "full_order" },
    {
      name: "full shipment with low exception",
      mutate: (input) => {
        input.activeExceptions = [
          { code: "note", severity: "low", resolved: false, evidenceRefs: ["e1"] },
        ];
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "full shipment with resolved high exception",
      mutate: (input) => {
        input.activeExceptions = [
          { code: "resolved", severity: "high", resolved: true, evidenceRefs: ["e2"] },
        ];
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "unresolved high exception",
      mutate: (input) => {
        input.activeExceptions = [
          { code: "conflict", severity: "high", resolved: false, evidenceRefs: ["e3"] },
        ];
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "unresolved critical exception",
      mutate: (input) => {
        input.activeExceptions = [
          { code: "critical", severity: "critical", resolved: false, evidenceRefs: ["e4"] },
        ];
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "missing tracking",
      mutate: (input) => {
        delete input.trackingNumber;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "commerce readback pending",
      mutate: (input) => {
        input.commerceFulfillment.status = "pending";
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "commerce readback missing",
      mutate: (input) => {
        input.commerceFulfillment.status = "missing";
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "commerce quantity mismatch",
      mutate: (input) => {
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "cancelled order",
      mutate: (input) => {
        input.order.releaseStatus = "cancelled";
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "no shipped quantity",
      mutate: (input) => {
        input.fulfillment.lines = [
          makeLine("line-1", { allocatedQty: 2, pickedQty: 2, packedQty: 2 }),
          makeLine("line-2", { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
        ];
        input.commerceFulfillment.shippedQtyByLine = { "line-1": 0, "line-2": 0 };
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "partial disabled",
      mutate: (input) => {
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "partial enabled",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "partial_shipment",
    },
    {
      name: "partial enabled with backorder",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.shortShipmentResolution = "backorder";
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "partial_shipment",
    },
    {
      name: "partial disabled with backorder",
      mutate: (input) => {
        input.shortShipmentResolution = "backorder";
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "short unresolved",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "short closed",
      mutate: (input) => {
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.shortShipmentResolution = "close_short";
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "short closed with partial enabled",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.shortShipmentResolution = "close_short";
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "invalid shipped quantity",
      mutate: (input) => {
        input.fulfillment.lines[0]!.shippedQty = 3;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "invalid commerce quantity",
      mutate: (input) => {
        input.commerceFulfillment.shippedQtyByLine["line-1"] = -1;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "zero decision version still evaluates",
      mutate: (input) => {
        input.decisionVersion = 0;
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "medium exception is non-blocking",
      mutate: (input) => {
        input.activeExceptions = [
          { code: "warning", severity: "medium", resolved: false, evidenceRefs: ["e5"] },
        ];
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "partial with missing tracking",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        delete input.trackingNumber;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "partial with quantity mismatch",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 1;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "partial with unresolved short",
      mutate: (input) => {
        input.partialShipmentEnabled = true;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.shortQty = 1;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: false,
      scope: "none",
    },
    {
      name: "full shipment with cancelled line",
      mutate: (input) => {
        input.order.lines[1]!.cancelledQty = 1;
        input.fulfillment.lines[1]!.allocatedQty = 0;
        input.fulfillment.lines[1]!.pickedQty = 0;
        input.fulfillment.lines[1]!.packedQty = 0;
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "full_order",
    },
    {
      name: "full shipment with damaged closed short",
      mutate: (input) => {
        input.fulfillment.lines[1]!.shippedQty = 0;
        input.fulfillment.lines[1]!.damagedQty = 1;
        input.shortShipmentResolution = "close_short";
        input.commerceFulfillment.shippedQtyByLine["line-2"] = 0;
      },
      eligible: true,
      scope: "full_order",
    },
  ];

  it.each(cases)("$name", ({ mutate, eligible, scope }) => {
    const input = makeInput();
    mutate?.(input);
    const decision = evaluateInvoiceEligibility(input);
    expect(decision.eligible).toBe(eligible);
    expect(decision.scope).toBe(scope);
    expect(decision.idempotencyKey).toContain(
      `invoice-eligibility:${input.order.tenantId}:${input.order.orderId}`,
    );
    expect(decision.reasons.every((item) => item.evidenceRefs.length > 0)).toBe(true);
    expect(createInvoiceEligibilityEvent(input.order, decision)).toMatchObject({
      eventId: decision.idempotencyKey,
      eventType: "invoice.eligibility_determined",
      aggregateId: input.order.orderId,
    });
  });
});
