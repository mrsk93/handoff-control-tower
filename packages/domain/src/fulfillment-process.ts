import { InvariantViolationError } from "./errors";
import { assertFulfillmentQuantityInvariants } from "./quantities";
import type {
  CanonicalOrder,
  CanonicalOrderLine,
  FulfillmentActual,
  FulfillmentLine,
  FulfillmentStatus,
  Shipment,
  ShipmentLine,
} from "./types";

export type FulfillmentProcessException = {
  code:
    | "MISSING_SKU_MAPPING"
    | "INVALID_QUANTITY"
    | "NON_MONOTONIC_WMS_UPDATE"
    | "WAREHOUSE_IDENTITY_CONFLICT"
    | "CANCEL_AFTER_SHIPMENT";
  severity: "high" | "critical";
  lineId?: string;
  summary: string;
  evidenceRefs: string[];
};

export type CommerceOrderLineInput = {
  sourceLineId: string;
  sku?: string | null;
  quantity: number;
  cancelledQty?: number;
};

export type CommerceOrderAcceptanceInput = {
  tenantId: string;
  orderId: string;
  sourceOrderId: string;
  sourceVersion: string;
  orderNumber: string;
  currency: string;
  acceptedAt: string;
  paymentReleased?: boolean;
  releaseRequested?: boolean;
  cancelled?: boolean;
  lines: CommerceOrderLineInput[];
};

export type CommerceOrderAcceptanceResult = {
  order: CanonicalOrder;
  shouldRelease: boolean;
  exceptions: FulfillmentProcessException[];
};

export type WarehouseUpdateStatus =
  "acknowledged" | "picking" | "packed" | "shipped" | "short" | "cancelled";

export type WarehouseFulfillmentUpdate = {
  warehouseOrderId: string;
  sourceVersion: string;
  status: WarehouseUpdateStatus;
  lines: FulfillmentLine[];
  correction?: boolean;
};

export type WarehouseUpdateResult =
  | { outcome: "stale"; fulfillment: FulfillmentActual }
  | { outcome: "applied"; fulfillment: FulfillmentActual }
  | {
      outcome: "conflict";
      fulfillment: FulfillmentActual;
      exception: FulfillmentProcessException;
    };

export type ShipmentConfirmationInput = {
  shipmentId: string;
  externalShipmentId?: string;
  carrierCode: string;
  serviceCode: string;
  trackingNumber: string;
  trackingUrl?: string;
  shippedAt?: string;
  lines: ShipmentLine[];
};

export type CancellationRemoteResult = "cancelled" | "already_shipped" | "rejected";

function compareSourceVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function positiveInteger(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvariantViolationError(`${path} must be a non-negative integer`, path);
  }
}

function stableLineId(sourceOrderId: string, sourceLineId: string): string {
  return `${sourceOrderId}:${sourceLineId}`;
}

export function acceptCommerceOrder(
  input: CommerceOrderAcceptanceInput,
): CommerceOrderAcceptanceResult {
  const exceptions: FulfillmentProcessException[] = [];
  const lines: CanonicalOrderLine[] = [];
  const seenSourceLineIds = new Set<string>();

  for (const line of input.lines) {
    if (seenSourceLineIds.has(line.sourceLineId)) {
      exceptions.push({
        code: "INVALID_QUANTITY",
        severity: "high",
        summary: `duplicate commerce line ${line.sourceLineId}`,
        evidenceRefs: [line.sourceLineId],
      });
      continue;
    }
    seenSourceLineIds.add(line.sourceLineId);

    if (!line.sku?.trim()) {
      exceptions.push({
        code: "MISSING_SKU_MAPPING",
        severity: "high",
        lineId: stableLineId(input.sourceOrderId, line.sourceLineId),
        summary: `commerce line ${line.sourceLineId} has no SKU mapping`,
        evidenceRefs: [input.sourceOrderId, line.sourceLineId],
      });
      continue;
    }
    const cancelledQty = line.cancelledQty ?? 0;
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 0 ||
      !Number.isInteger(cancelledQty) ||
      cancelledQty < 0 ||
      cancelledQty > line.quantity
    ) {
      exceptions.push({
        code: "INVALID_QUANTITY",
        severity: "high",
        lineId: stableLineId(input.sourceOrderId, line.sourceLineId),
        summary: `commerce line ${line.sourceLineId} has invalid quantities`,
        evidenceRefs: [input.sourceOrderId, line.sourceLineId],
      });
      continue;
    }
    lines.push({
      lineId: stableLineId(input.sourceOrderId, line.sourceLineId),
      sourceLineId: line.sourceLineId,
      sku: line.sku.trim(),
      orderedQty: line.quantity,
      cancelledQty,
    });
  }

  const order: CanonicalOrder = {
    tenantId: input.tenantId,
    orderId: input.orderId,
    source: "commerce",
    sourceOrderId: input.sourceOrderId,
    sourceVersion: input.sourceVersion,
    orderNumber: input.orderNumber,
    currency: input.currency.toUpperCase(),
    acceptedAt: input.acceptedAt,
    releaseStatus: input.cancelled ? "cancelled" : "pending",
    lines,
  };
  if (input.cancelled) order.cancelledAt = input.acceptedAt;

  const shouldRelease =
    !input.cancelled &&
    input.releaseRequested !== false &&
    input.paymentReleased !== false &&
    lines.length > 0 &&
    exceptions.length === 0;
  if (shouldRelease) order.releaseStatus = "released";
  else if (!input.cancelled && exceptions.length > 0) order.releaseStatus = "held";

  return { order, shouldRelease, exceptions };
}

export function initialFulfillment(order: CanonicalOrder): FulfillmentActual {
  return {
    tenantId: order.tenantId,
    orderId: order.orderId,
    status: "not_sent",
    lines: order.lines.map((line) => ({
      lineId: line.lineId,
      allocatedQty: 0,
      pickedQty: 0,
      packedQty: 0,
      shippedQty: 0,
      shortQty: 0,
      damagedQty: 0,
    })),
    version: 1,
  };
}

function mergedLines(current: FulfillmentActual, incoming: FulfillmentLine[]): FulfillmentLine[] {
  const incomingById = new Map(incoming.map((line) => [line.lineId, line]));
  return current.lines.map((line) => incomingById.get(line.lineId) ?? line);
}

function hasQuantityRegression(
  current: FulfillmentActual,
  candidateLines: FulfillmentLine[],
): FulfillmentLine | undefined {
  const currentById = new Map(current.lines.map((line) => [line.lineId, line]));
  return candidateLines.find((candidate) => {
    const previous = currentById.get(candidate.lineId);
    if (!previous) return false;
    return (
      candidate.allocatedQty < previous.allocatedQty ||
      candidate.pickedQty < previous.pickedQty ||
      candidate.packedQty < previous.packedQty ||
      candidate.shippedQty < previous.shippedQty ||
      candidate.shortQty < previous.shortQty ||
      candidate.damagedQty < previous.damagedQty
    );
  });
}

function statusForWarehouseUpdate(
  status: WarehouseUpdateStatus,
  lines: FulfillmentLine[],
): FulfillmentStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "short") return "exception";
  if (status === "shipped") {
    return lines.length > 0 && lines.every((line) => line.shippedQty === line.packedQty)
      ? "shipped"
      : "partially_shipped";
  }
  if (status === "packed") {
    return lines.length > 0 && lines.every((line) => line.packedQty === line.allocatedQty)
      ? "packed"
      : "picking";
  }
  return status;
}

export function applyWarehouseUpdate(
  order: CanonicalOrder,
  current: FulfillmentActual,
  update: WarehouseFulfillmentUpdate,
  knownSourceVersion?: string,
): WarehouseUpdateResult {
  if (
    knownSourceVersion !== undefined &&
    compareSourceVersions(update.sourceVersion, knownSourceVersion) < 0
  ) {
    return { outcome: "stale", fulfillment: current };
  }
  if (
    current.warehouseOrderId !== undefined &&
    current.warehouseOrderId !== update.warehouseOrderId
  ) {
    return {
      outcome: "conflict",
      fulfillment: current,
      exception: {
        code: "WAREHOUSE_IDENTITY_CONFLICT",
        severity: "critical",
        summary: "warehouse update references a different warehouse order",
        evidenceRefs: [current.warehouseOrderId, update.warehouseOrderId],
      },
    };
  }

  const lines = mergedLines(current, update.lines);
  const regression = hasQuantityRegression(current, lines);
  if (regression && !update.correction) {
    return {
      outcome: "conflict",
      fulfillment: current,
      exception: {
        code: "NON_MONOTONIC_WMS_UPDATE",
        severity: "high",
        lineId: regression.lineId,
        summary: "warehouse quantities decreased without an explicit correction",
        evidenceRefs: [update.warehouseOrderId, update.sourceVersion, regression.lineId],
      },
    };
  }

  const candidate: FulfillmentActual = {
    ...current,
    warehouseOrderId: update.warehouseOrderId,
    status: statusForWarehouseUpdate(update.status, lines),
    lines: lines.map((line) => ({ ...line })),
    version: current.version + 1,
  };
  try {
    assertFulfillmentQuantityInvariants(order, candidate);
  } catch (error) {
    return {
      outcome: "conflict",
      fulfillment: current,
      exception: {
        code: "INVALID_QUANTITY",
        severity: "high",
        summary: error instanceof Error ? error.message : "invalid warehouse quantities",
        evidenceRefs: [update.warehouseOrderId, update.sourceVersion],
      },
    };
  }
  return { outcome: "applied", fulfillment: candidate };
}

export function confirmShipment(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
  input: ShipmentConfirmationInput,
): Shipment {
  const packedByLine = new Map(fulfillment.lines.map((line) => [line.lineId, line.packedQty]));
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.lineId))
      throw new InvariantViolationError("shipment line IDs must be unique");
    seen.add(line.lineId);
    positiveInteger(line.quantity, `shipment.lines.${line.lineId}.quantity`);
    if (!packedByLine.has(line.lineId)) {
      throw new InvariantViolationError("shipment line must reference a fulfillment line");
    }
    if (line.quantity > (packedByLine.get(line.lineId) ?? 0)) {
      throw new InvariantViolationError("shipment quantity cannot exceed packed quantity");
    }
  }
  const totalShipped = input.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (totalShipped === 0)
    throw new InvariantViolationError("shipment must contain a positive quantity");
  return {
    tenantId: order.tenantId,
    shipmentId: input.shipmentId,
    orderId: order.orderId,
    ...(input.externalShipmentId === undefined
      ? {}
      : { externalShipmentId: input.externalShipmentId }),
    carrierCode: input.carrierCode,
    serviceCode: input.serviceCode,
    trackingNumber: input.trackingNumber,
    ...(input.trackingUrl === undefined ? {} : { trackingUrl: input.trackingUrl }),
    ...(input.shippedAt === undefined ? {} : { shippedAt: input.shippedAt }),
    lines: input.lines.map((line) => ({ ...line })),
    status: "shipped",
  };
}

export function cancellationOutcome(
  result: CancellationRemoteResult,
): { status: "cancelled" } | { status: "conflict"; exception: FulfillmentProcessException } {
  if (result === "cancelled") return { status: "cancelled" };
  return {
    status: "conflict",
    exception: {
      code: "CANCEL_AFTER_SHIPMENT",
      severity: "high",
      summary:
        result === "already_shipped"
          ? "warehouse reports shipment evidence after cancellation request"
          : "warehouse rejected cancellation after release",
      evidenceRefs: [result],
    },
  };
}

export { compareSourceVersions };
