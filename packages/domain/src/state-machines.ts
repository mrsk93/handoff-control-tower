import { InvalidTransitionError, InvariantViolationError } from "./errors";
import type { DomainEvent } from "./events";
import { assertFulfillmentQuantityInvariants, totalNonCancelledQuantity } from "./quantities";
import type {
  CanonicalOrder,
  FulfillmentActual,
  FulfillmentLine,
  FulfillmentStatus,
  OrderLifecycleStatus,
  OrderReleaseStatus,
} from "./types";

type CommandMetadata = {
  idempotencyKey: string;
  occurredAt: string;
  reason?: string;
};

export type OrderReleaseCommand = CommandMetadata &
  (
    | { type: "release" }
    | { type: "hold" }
    | { type: "commerce_cancelled" }
    | { type: "cancel_confirmed" }
    | { type: "cancel_failed" }
  );

export type OrderLifecycleCommand = CommandMetadata &
  (
    | { type: "erp_pending" }
    | { type: "erp_created" }
    | { type: "fulfillment_pending" }
    | { type: "release_to_3pl" }
    | { type: "partial_shipment_observed" }
    | { type: "shipment_observed" }
    | { type: "delivery_observed" }
    | { type: "hold" }
    | { type: "unblock" }
    | { type: "request_cancel" }
    | { type: "cancel_confirmed" }
    | { type: "cancel_failed" }
    | { type: "exception" }
  );

export type FulfillmentCommand = CommandMetadata &
  (
    | { type: "send" }
    | { type: "acknowledge" }
    | { type: "start_picking" }
    | { type: "pack"; lines: FulfillmentLine[] }
    | { type: "ship"; lines: FulfillmentLine[] }
    | { type: "partially_ship"; lines: FulfillmentLine[] }
    | { type: "short_ship"; lines: FulfillmentLine[] }
    | { type: "resume_picking" }
    | { type: "close_short" }
    | { type: "complete_remaining"; lines: FulfillmentLine[] }
  );

export type TransitionResult<T> = {
  state: T;
  events: DomainEvent[];
  applied: boolean;
  duplicate: boolean;
};

export type TransitionOptions = {
  processedCommandKeys?: ReadonlySet<string>;
};

function assertCommandMetadata(command: CommandMetadata): void {
  if (!command.idempotencyKey.trim())
    throw new InvariantViolationError("idempotency key is required");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(command.occurredAt)) {
    throw new InvariantViolationError("occurredAt must be an ISO-8601 UTC instant");
  }
}

function assertReason(command: CommandMetadata, requiredFor: string): void {
  if (!command.reason?.trim()) {
    throw new InvariantViolationError(`reason is required for ${requiredFor}`);
  }
}

function changedEvent(
  command: CommandMetadata,
  eventType: DomainEvent["eventType"],
  tenantId: string,
  aggregateType: DomainEvent["aggregateType"],
  aggregateId: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    eventId: `${command.idempotencyKey}:event`,
    eventType,
    tenantId,
    aggregateType,
    aggregateId,
    occurredAt: command.occurredAt,
    payload,
  };
}

function duplicate<T>(state: T): TransitionResult<T> {
  return { state, events: [], applied: false, duplicate: true };
}

function applied<T>(state: T, event: DomainEvent): TransitionResult<T> {
  return { state, events: [event], applied: true, duplicate: false };
}

function initialLifecycleStatus(order: CanonicalOrder): OrderLifecycleStatus {
  if (order.lifecycleStatus !== undefined) return order.lifecycleStatus;
  if (order.releaseStatus === "cancelled") return "cancelled";
  if (order.releaseStatus === "exception") return "exception";
  if (order.releaseStatus === "held") return "blocked";
  return "received";
}

export function transitionOrderLifecycle(
  order: CanonicalOrder,
  command: OrderLifecycleCommand,
  options: TransitionOptions = {},
): TransitionResult<CanonicalOrder> {
  assertCommandMetadata(command);
  if (options.processedCommandKeys?.has(command.idempotencyKey)) return duplicate(order);

  const previousStatus = initialLifecycleStatus(order);
  if (command.type === "hold" || command.type === "cancel_failed" || command.type === "exception") {
    assertReason(command, command.type);
  }

  let currentStatus: OrderLifecycleStatus;
  switch (`${previousStatus}:${command.type}`) {
    case "received:erp_pending":
      currentStatus = "erp_pending";
      break;
    case "erp_pending:erp_created":
      currentStatus = "erp_created";
      break;
    case "erp_created:fulfillment_pending":
      currentStatus = "fulfillment_pending";
      break;
    case "fulfillment_pending:release_to_3pl":
      currentStatus = "released_to_3pl";
      break;
    case "released_to_3pl:partial_shipment_observed":
    case "partially_shipped:partial_shipment_observed":
      currentStatus = "partially_shipped";
      break;
    case "released_to_3pl:shipment_observed":
    case "partially_shipped:shipment_observed":
      currentStatus = "shipped";
      break;
    case "shipped:delivery_observed":
      currentStatus = "delivered";
      break;
    case "received:hold":
    case "erp_pending:hold":
    case "erp_created:hold":
    case "fulfillment_pending:hold":
    case "released_to_3pl:hold":
    case "partially_shipped:hold":
      currentStatus = "blocked";
      break;
    case "blocked:unblock":
      currentStatus = "received";
      break;
    case "received:request_cancel":
    case "erp_pending:request_cancel":
    case "erp_created:request_cancel":
    case "fulfillment_pending:request_cancel":
    case "released_to_3pl:request_cancel":
      currentStatus = "cancel_pending";
      break;
    case "cancel_pending:cancel_confirmed":
      currentStatus = "cancelled";
      break;
    case "cancel_pending:cancel_failed":
      currentStatus = "exception";
      break;
    case "released_to_3pl:exception":
    case "partially_shipped:exception":
    case "cancel_pending:exception":
      currentStatus = "exception";
      break;
    default:
      throw new InvalidTransitionError("order.lifecycle", previousStatus, command.type);
  }

  const state: CanonicalOrder = { ...order, lifecycleStatus: currentStatus };
  if (currentStatus === "cancelled" && state.cancelledAt === undefined) {
    state.cancelledAt = command.occurredAt;
  }
  const event = changedEvent(
    command,
    "order.lifecycle_changed",
    order.tenantId,
    "order",
    order.orderId,
    {
      previousStatus,
      currentStatus,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  );
  return applied(state, event);
}

export function transitionOrderRelease(
  order: CanonicalOrder,
  command: OrderReleaseCommand,
  options: TransitionOptions = {},
): TransitionResult<CanonicalOrder> {
  assertCommandMetadata(command);
  if (options.processedCommandKeys?.has(command.idempotencyKey)) return duplicate(order);

  const previousStatus = order.releaseStatus;
  let currentStatus: OrderReleaseStatus;
  if (command.type === "hold" || command.type === "cancel_failed") {
    assertReason(command, command.type);
  }
  switch (`${previousStatus}:${command.type}`) {
    case "pending:release":
    case "held:release":
      currentStatus = "released";
      break;
    case "pending:hold":
      currentStatus = "held";
      break;
    case "pending:commerce_cancelled":
    case "held:commerce_cancelled":
      currentStatus = "cancelled";
      break;
    case "released:commerce_cancelled":
      currentStatus = "cancel_requested";
      break;
    case "cancel_requested:cancel_confirmed":
      currentStatus = "cancelled";
      break;
    case "cancel_requested:cancel_failed":
      currentStatus = "exception";
      break;
    default:
      throw new InvalidTransitionError("order", previousStatus, command.type);
  }

  const state: CanonicalOrder = { ...order, releaseStatus: currentStatus };
  if (currentStatus === "cancelled" && state.cancelledAt === undefined) {
    state.cancelledAt = command.occurredAt;
  }
  const event = changedEvent(
    command,
    "order.release_changed",
    order.tenantId,
    "order",
    order.orderId,
    {
      previousStatus,
      currentStatus,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  );
  return applied(state, event);
}

function replaceLines(fulfillment: FulfillmentActual, lines: FulfillmentLine[]): FulfillmentActual {
  const next: FulfillmentActual = { ...fulfillment, lines: lines.map((line) => ({ ...line })) };
  return { ...next, version: fulfillment.version + 1 };
}

function total(lines: FulfillmentLine[], key: keyof FulfillmentLine): number {
  return lines.reduce((sum, line) => sum + (typeof line[key] === "number" ? line[key] : 0), 0);
}

function assertLineProgression(order: CanonicalOrder, fulfillment: FulfillmentActual): void {
  assertFulfillmentQuantityInvariants(order, fulfillment);
}

function assertAllPacked(fulfillment: FulfillmentActual): void {
  if (
    fulfillment.lines.length === 0 ||
    fulfillment.lines.some((line) => line.packedQty !== line.allocatedQty)
  ) {
    throw new InvariantViolationError(
      "all allocated quantities must be packed before packed state",
    );
  }
}

function assertFullShipment(fulfillment: FulfillmentActual): void {
  if (
    total(fulfillment.lines, "shippedQty") === 0 ||
    fulfillment.lines.some((line) => line.shippedQty !== line.packedQty)
  ) {
    throw new InvariantViolationError("all packed quantities must be shipped before shipped state");
  }
}

function assertPartialShipment(fulfillment: FulfillmentActual): void {
  const shipped = total(fulfillment.lines, "shippedQty");
  const packed = total(fulfillment.lines, "packedQty");
  if (shipped <= 0 || shipped >= packed) {
    throw new InvariantViolationError(
      "partial shipment must ship a non-zero subset of packed quantity",
    );
  }
}

function assertClosableShipment(order: CanonicalOrder, fulfillment: FulfillmentActual): void {
  const packed = total(fulfillment.lines, "packedQty");
  const shipped = total(fulfillment.lines, "shippedQty");
  const shortOrDamaged =
    total(fulfillment.lines, "shortQty") + total(fulfillment.lines, "damagedQty");
  const remainingPacked = packed - shipped;
  if (
    remainingPacked < 0 ||
    (remainingPacked > 0 && shortOrDamaged === 0) ||
    (packed > 0 && shortOrDamaged < remainingPacked)
  ) {
    throw new InvariantViolationError(
      "remaining shipment requires shipped, short, or damaged evidence",
    );
  }
  if (shipped > totalNonCancelledQuantity(order)) {
    throw new InvariantViolationError("shipped quantity cannot exceed the order quantity");
  }
}

export function transitionFulfillment(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
  command: FulfillmentCommand,
  options: TransitionOptions = {},
): TransitionResult<FulfillmentActual> {
  assertCommandMetadata(command);
  if (options.processedCommandKeys?.has(command.idempotencyKey)) return duplicate(fulfillment);
  if (order.releaseStatus === "cancelled") {
    throw new InvalidTransitionError("fulfillment", fulfillment.status, command.type);
  }
  assertLineProgression(order, fulfillment);

  const previousStatus = fulfillment.status;
  let state = fulfillment;
  switch (command.type) {
    case "send":
      if (previousStatus !== "not_sent")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      state = { ...fulfillment, status: "sent", version: fulfillment.version + 1 };
      break;
    case "acknowledge":
      if (previousStatus !== "sent")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      state = { ...fulfillment, status: "acknowledged", version: fulfillment.version + 1 };
      break;
    case "start_picking":
      if (previousStatus !== "acknowledged")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      state = { ...fulfillment, status: "picking", version: fulfillment.version + 1 };
      break;
    case "pack": {
      if (previousStatus !== "picking")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      const candidate = replaceLines(fulfillment, command.lines);
      assertLineProgression(order, candidate);
      assertAllPacked(candidate);
      state = { ...candidate, status: "packed" };
      break;
    }
    case "ship": {
      if (previousStatus !== "packed")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      const candidate = replaceLines(fulfillment, command.lines);
      assertLineProgression(order, candidate);
      assertFullShipment(candidate);
      state = { ...candidate, status: "shipped" };
      break;
    }
    case "partially_ship": {
      if (previousStatus !== "packed")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      const candidate = replaceLines(fulfillment, command.lines);
      assertLineProgression(order, candidate);
      assertPartialShipment(candidate);
      state = { ...candidate, status: "partially_shipped" };
      break;
    }
    case "short_ship": {
      if (previousStatus !== "picking")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      assertReason(command, command.type);
      const candidate = replaceLines(fulfillment, command.lines);
      assertLineProgression(order, candidate);
      if (total(candidate.lines, "shortQty") + total(candidate.lines, "damagedQty") === 0) {
        throw new InvariantViolationError("short_ship requires short or damaged evidence");
      }
      state = { ...candidate, status: "exception" };
      break;
    }
    case "resume_picking":
      if (previousStatus !== "exception")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      state = { ...fulfillment, status: "picking", version: fulfillment.version + 1 };
      break;
    case "close_short":
      if (previousStatus !== "exception")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      assertReason(command, command.type);
      assertClosableShipment(order, fulfillment);
      state = { ...fulfillment, status: "partially_shipped", version: fulfillment.version + 1 };
      break;
    case "complete_remaining": {
      if (previousStatus !== "partially_shipped")
        throw new InvalidTransitionError("fulfillment", previousStatus, command.type);
      const candidate = replaceLines(fulfillment, command.lines);
      assertLineProgression(order, candidate);
      assertClosableShipment(order, candidate);
      state = { ...candidate, status: "shipped" };
      break;
    }
    default:
      throw new InvariantViolationError("unsupported fulfillment command");
  }

  const event = changedEvent(
    command,
    "fulfillment.status_changed",
    fulfillment.tenantId,
    "fulfillment",
    fulfillment.orderId,
    {
      previousStatus,
      currentStatus: state.status,
      version: state.version,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  );
  return applied(state, event);
}

export function isTerminalFulfillmentStatus(status: FulfillmentStatus): boolean {
  return status === "shipped" || status === "delivered" || status === "cancelled";
}

export function isTerminalOrderLifecycleStatus(status: OrderLifecycleStatus): boolean {
  return status === "delivered" || status === "cancelled";
}
