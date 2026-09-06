import { assertFulfillmentQuantityInvariants } from "./quantities";
import type {
  ActiveException,
  CanonicalOrder,
  FulfillmentActual,
  InvoiceEligibilityDecision,
  InvoiceEligibilityInput,
  InvoiceEligibilityReason,
} from "./types";

function reason(
  code: string,
  blocking: boolean,
  evidenceRefs: string[],
  lineId?: string,
): InvoiceEligibilityReason {
  return {
    code,
    blocking,
    evidenceRefs,
    ...(lineId === undefined ? {} : { lineId }),
  };
}

function unresolvedBlockingExceptions(exceptions: ActiveException[]): InvoiceEligibilityReason[] {
  return exceptions
    .filter(
      (exception) =>
        !exception.resolved && (exception.severity === "high" || exception.severity === "critical"),
    )
    .map((exception) =>
      reason(`blocking_exception:${exception.code}`, true, exception.evidenceRefs),
    );
}

function lineMap<T extends { lineId: string }>(lines: T[]): Map<string, T> {
  return new Map(lines.map((line) => [line.lineId, line]));
}

function quantityEvidenceReasons(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
): InvoiceEligibilityReason[] {
  try {
    assertFulfillmentQuantityInvariants(order, fulfillment);
    return [];
  } catch (error) {
    return [
      reason("quantity_invariant_violation", true, [
        error instanceof Error ? error.message : "unknown",
      ]),
    ];
  }
}

function orderQuantities(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
): {
  ordered: number;
  shipped: number;
  open: number;
  short: number;
} {
  const fulfillmentLines = lineMap(fulfillment.lines);
  return order.lines.reduce(
    (totals, orderLine) => {
      const fulfillmentLine = fulfillmentLines.get(orderLine.lineId);
      const netOrdered = orderLine.orderedQty - orderLine.cancelledQty;
      const shipped = fulfillmentLine?.shippedQty ?? 0;
      const short = (fulfillmentLine?.shortQty ?? 0) + (fulfillmentLine?.damagedQty ?? 0);
      return {
        ordered: totals.ordered + netOrdered,
        shipped: totals.shipped + shipped,
        open: totals.open + netOrdered - shipped,
        short: totals.short + short,
      };
    },
    { ordered: 0, shipped: 0, open: 0, short: 0 },
  );
}

function commerceMismatchReasons(input: InvoiceEligibilityInput): InvoiceEligibilityReason[] {
  const fulfillmentLines = lineMap(input.fulfillment.lines);
  return input.order.lines.flatMap((orderLine) => {
    const expected = fulfillmentLines.get(orderLine.lineId)?.shippedQty ?? 0;
    const actual = input.commerceFulfillment.shippedQtyByLine[orderLine.lineId] ?? 0;
    return expected === actual
      ? []
      : [
          reason(
            "commerce_quantity_mismatch",
            true,
            ["commerce-readback", "canonical-fulfillment"],
            orderLine.lineId,
          ),
        ];
  });
}

function invalidReadbackReasons(input: InvoiceEligibilityInput): InvoiceEligibilityReason[] {
  return Object.entries(input.commerceFulfillment.shippedQtyByLine).flatMap(
    ([lineId, shippedQty]) => {
      if (Number.isInteger(shippedQty) && shippedQty >= 0) return [];
      return [reason("invalid_commerce_quantity", true, ["commerce-readback"], lineId)];
    },
  );
}

export function evaluateInvoiceEligibility(
  input: InvoiceEligibilityInput,
): InvoiceEligibilityDecision {
  const reasons: InvoiceEligibilityReason[] = [];
  const quantities = orderQuantities(input.order, input.fulfillment);
  const invariantReasons = quantityEvidenceReasons(input.order, input.fulfillment);
  reasons.push(...invariantReasons);
  reasons.push(...unresolvedBlockingExceptions(input.activeExceptions));
  reasons.push(...invalidReadbackReasons(input));

  if (input.order.releaseStatus === "cancelled")
    reasons.push(reason("order_cancelled", true, [input.order.orderId]));
  if (input.commerceFulfillment.status !== "reflected") {
    reasons.push(
      reason("commerce_fulfillment_not_reflected", true, [input.commerceFulfillment.status]),
    );
  }
  reasons.push(...commerceMismatchReasons(input));

  if (quantities.shipped > 0 && !input.trackingNumber?.trim()) {
    reasons.push(reason("tracking_reference_missing", true, [input.order.orderId]));
  }
  if (input.fulfillment.lines.some((line) => line.shippedQty > line.packedQty)) {
    const exceedsOrder = input.order.lines.some((orderLine) => {
      const fulfillmentLine = input.fulfillment.lines.find(
        (line) => line.lineId === orderLine.lineId,
      );
      return (fulfillmentLine?.shippedQty ?? 0) > orderLine.orderedQty - orderLine.cancelledQty;
    });
    if (exceedsOrder)
      reasons.push(reason("shipped_quantity_exceeds_order", true, [input.order.orderId]));
  }

  if (quantities.short > 0 && input.shortShipmentResolution === "unresolved") {
    reasons.push(reason("short_shipment_unresolved", true, [input.order.orderId]));
  }

  let eligible = reasons.every((item) => !item.blocking);
  let scope: InvoiceEligibilityDecision["scope"] = "none";
  if (eligible && quantities.shipped > 0) {
    const shortClosed =
      quantities.open > 0 &&
      input.shortShipmentResolution === "close_short" &&
      quantities.short >= quantities.open;
    if (quantities.open === 0 || shortClosed) {
      scope = "full_order";
    } else if (input.partialShipmentEnabled) {
      scope = "partial_shipment";
    } else {
      reasons.push(reason("partial_shipment_not_enabled", true, [input.order.orderId]));
      eligible = false;
    }
  } else if (eligible) {
    reasons.push(reason("no_confirmed_shipped_quantity", true, [input.order.orderId]));
    eligible = false;
  }

  const finalScope = eligible ? scope : "none";
  return {
    eligible,
    scope: finalScope,
    decisionVersion: input.decisionVersion,
    reasons,
    computedAt: input.computedAt,
    idempotencyKey: `invoice-eligibility:${input.order.tenantId}:${input.order.orderId}:${input.decisionVersion}:${finalScope}`,
  };
}
