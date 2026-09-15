import { InvariantViolationError } from "./errors";
import { assertFulfillmentQuantityInvariants, totalNonCancelledQuantity } from "./quantities";
import { normalizeSku } from "./value-objects";
import type {
  CanonicalOrder,
  CanonicalOrderLine,
  FulfillmentActual,
  FulfillmentLine,
  FulfillmentStatus,
  Shipment,
  ShipmentLine,
  ShipmentStatus,
} from "./types";

export type FulfillmentProcessException = {
  code:
    | "MISSING_SKU_MAPPING"
    | "INVALID_QUANTITY"
    | "NON_MONOTONIC_WAREHOUSE_UPDATE"
    | "WAREHOUSE_IDENTITY_CONFLICT"
    | "CANCEL_AFTER_SHIPMENT"
    | "COMMERCE_REVISION_CONFLICT";
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
  occurredAt?: string;
  observedAt?: string;
  lastAppliedEventId?: string;
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
  deliveredAt?: string;
  status?: ShipmentStatus;
  sourceVersion?: string;
  occurredAt?: string;
  observedAt?: string;
  lastAppliedEventId?: string;
  lines: ShipmentLine[];
};

export type ShipmentObservationInput = Omit<
  ShipmentConfirmationInput,
  "status" | "sourceVersion" | "occurredAt" | "observedAt"
> & {
  eventId: string;
  occurredAt: string;
  observedAt: string;
  sourceVersion?: string;
  status?: "shipped" | "delivered";
};

export type ShipmentObservationResult =
  | {
      outcome: "applied";
      order: CanonicalOrder;
      fulfillment: FulfillmentActual;
      shipment: Shipment;
    }
  | { outcome: "stale" | "duplicate"; order: CanonicalOrder; fulfillment: FulfillmentActual }
  | {
      outcome: "conflict";
      order: CanonicalOrder;
      fulfillment: FulfillmentActual;
      exception: FulfillmentProcessException;
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
      sku: normalizeSku(line.sku),
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
    lifecycleStatus: input.cancelled ? "cancelled" : exceptions.length > 0 ? "blocked" : "received",
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
        code: "NON_MONOTONIC_WAREHOUSE_UPDATE",
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
    quantityEvidence: "workflow",
    lines: lines.map((line) => ({ ...line })),
    version: current.version + 1,
    ...(update.sourceVersion === undefined ? {} : { sourceVersion: update.sourceVersion }),
    ...(update.occurredAt === undefined ? {} : { occurredAt: update.occurredAt }),
    ...(update.observedAt === undefined ? {} : { observedAt: update.observedAt }),
    ...(update.lastAppliedEventId === undefined
      ? {}
      : { lastAppliedEventId: update.lastAppliedEventId }),
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

function assertUtcInstant(value: string, path: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new InvariantViolationError(`${path} must be an ISO-8601 UTC instant`, path);
  }
}

function observationFreshness(
  current: FulfillmentActual,
  input: ShipmentObservationInput,
): "apply" | "stale" | "duplicate" | "conflict" {
  if (current.lastAppliedEventId === input.eventId) return "duplicate";
  if (current.sourceVersion !== undefined && input.sourceVersion !== undefined) {
    const comparison = compareSourceVersions(input.sourceVersion, current.sourceVersion);
    if (comparison < 0) return "stale";
    if (comparison === 0) return "conflict";
    return "apply";
  }
  if (current.observedAt !== undefined) {
    if (input.observedAt < current.observedAt) return "stale";
    if (input.observedAt === current.observedAt) return "conflict";
  }
  return "apply";
}

/**
 * Applies shipment evidence directly. Provider APIs may report shipped or
 * delivered without exposing pick/pack stages; this path records only the
 * authoritative shipment quantities and never fabricates those stages.
 */
export function applyShipmentObservation(
  order: CanonicalOrder,
  current: FulfillmentActual,
  input: ShipmentObservationInput,
): ShipmentObservationResult {
  if (!input.eventId.trim()) {
    throw new InvariantViolationError("shipment observation eventId is required");
  }
  assertUtcInstant(input.occurredAt, "shipment.occurredAt");
  assertUtcInstant(input.observedAt, "shipment.observedAt");
  const freshness = observationFreshness(current, input);
  if (freshness === "stale" || freshness === "duplicate") {
    return { outcome: freshness, order, fulfillment: current };
  }
  if (freshness === "conflict") {
    return {
      outcome: "conflict",
      order,
      fulfillment: current,
      exception: {
        code: "COMMERCE_REVISION_CONFLICT",
        severity: "high",
        summary: "shipment observations have equal freshness but different event identity",
        evidenceRefs: [input.shipmentId, input.eventId, input.sourceVersion ?? input.observedAt],
      },
    };
  }
  if (order.releaseStatus === "cancelled" || order.lifecycleStatus === "cancelled") {
    return {
      outcome: "conflict",
      order,
      fulfillment: current,
      exception: {
        code: "CANCEL_AFTER_SHIPMENT",
        severity: "high",
        summary: "shipment evidence arrived after cancellation was confirmed",
        evidenceRefs: [input.shipmentId, input.eventId],
      },
    };
  }

  const orderLines = new Map(order.lines.map((line) => [line.lineId, line]));
  const currentLines = new Map(current.lines.map((line) => [line.lineId, line]));
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.lineId)) {
      return {
        outcome: "conflict",
        order,
        fulfillment: current,
        exception: {
          code: "INVALID_QUANTITY",
          severity: "high",
          lineId: line.lineId,
          summary: "shipment observation contains duplicate line evidence",
          evidenceRefs: [input.shipmentId, line.lineId],
        },
      };
    }
    seen.add(line.lineId);
    positiveInteger(line.quantity, `shipment.lines.${line.lineId}.quantity`);
    const orderLine = orderLines.get(line.lineId);
    const currentLine = currentLines.get(line.lineId);
    if (orderLine === undefined || currentLine === undefined) {
      return {
        outcome: "conflict",
        order,
        fulfillment: current,
        exception: {
          code: "INVALID_QUANTITY",
          severity: "high",
          lineId: line.lineId,
          summary: "shipment observation references an unknown order line",
          evidenceRefs: [input.shipmentId, line.lineId],
        },
      };
    }
    const max = orderLine.orderedQty - orderLine.cancelledQty;
    if (currentLine.shippedQty + line.quantity > max) {
      return {
        outcome: "conflict",
        order,
        fulfillment: current,
        exception: {
          code: "INVALID_QUANTITY",
          severity: "high",
          lineId: line.lineId,
          summary: "shipment observation exceeds non-cancelled order quantity",
          evidenceRefs: [input.shipmentId, line.lineId],
        },
      };
    }
  }
  if (input.lines.length === 0) {
    throw new InvariantViolationError("shipment observation must contain a positive quantity");
  }

  const nextLines = current.lines.map((line) => {
    const observed = input.lines.find((candidate) => candidate.lineId === line.lineId);
    return observed === undefined
      ? { ...line }
      : { ...line, shippedQty: line.shippedQty + observed.quantity };
  });
  const totalOrdered = totalNonCancelledQuantity(order);
  const totalShipped = nextLines.reduce((sum, line) => sum + line.shippedQty, 0);
  if (input.status === "delivered" && totalShipped < totalOrdered) {
    return {
      outcome: "conflict",
      order,
      fulfillment: current,
      exception: {
        code: "INVALID_QUANTITY",
        severity: "high",
        summary: "delivered evidence cannot precede complete shipment quantity",
        evidenceRefs: [input.shipmentId, input.eventId],
      },
    };
  }
  const status: FulfillmentStatus = totalShipped >= totalOrdered ? "shipped" : "partially_shipped";
  const nextFulfillment: FulfillmentActual = {
    ...current,
    status: input.status === "delivered" ? "delivered" : status,
    quantityEvidence: "shipment_authoritative",
    lines: nextLines,
    version: current.version + 1,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    lastAppliedEventId: input.eventId,
  };
  const shipment: Shipment = {
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
    ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    occurredAt: input.occurredAt,
    observedAt: input.observedAt,
    lastAppliedEventId: input.eventId,
    lines: input.lines.map((line) => ({ ...line })),
    status: input.status ?? "shipped",
  };
  const lifecycleStatus: CanonicalOrder["lifecycleStatus"] =
    input.status === "delivered"
      ? "delivered"
      : order.lifecycleStatus === "delivered" || order.lifecycleStatus === "shipped"
        ? order.lifecycleStatus
        : status;
  const nextOrder: CanonicalOrder = { ...order, lifecycleStatus };
  return { outcome: "applied", order: nextOrder, fulfillment: nextFulfillment, shipment };
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
