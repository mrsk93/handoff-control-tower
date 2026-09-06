import { InvariantViolationError, InvalidQuantityError } from "./errors";
import type {
  CanonicalOrder,
  CanonicalOrderLine,
  FulfillmentActual,
  FulfillmentLine,
} from "./types";

export type Quantity = number & { readonly __quantityBrand: unique symbol };

export type FulfillmentQuantityOptions = {
  allowAllocationOverage?: boolean;
};

export function quantity(value: number, path = "quantity"): Quantity {
  assertNonNegativeInteger(value, path);
  return value as Quantity;
}

export function assertNonNegativeInteger(value: number, path: string): asserts value is number {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidQuantityError(`${path} must be a non-negative integer`, path);
  }
}

export function assertOrderQuantityInvariants(order: CanonicalOrder): void {
  if (new Set(order.lines.map((line) => line.lineId)).size !== order.lines.length) {
    throw new InvariantViolationError("order line IDs must be unique", "order.lines");
  }

  for (const line of order.lines) {
    assertNonNegativeInteger(line.orderedQty, `order.lines.${line.lineId}.orderedQty`);
    assertNonNegativeInteger(line.cancelledQty, `order.lines.${line.lineId}.cancelledQty`);
    if (line.cancelledQty > line.orderedQty) {
      throw new InvariantViolationError(
        "cancelled quantity cannot exceed ordered quantity",
        `order.lines.${line.lineId}.cancelledQty`,
      );
    }
  }
}

export function assertFulfillmentQuantityInvariants(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
  options: FulfillmentQuantityOptions = {},
): void {
  if (order.tenantId !== fulfillment.tenantId) {
    throw new InvariantViolationError("order and fulfillment tenants must match", "tenantId");
  }
  if (order.orderId !== fulfillment.orderId) {
    throw new InvariantViolationError("order and fulfillment IDs must match", "orderId");
  }

  assertOrderQuantityInvariants(order);
  if (new Set(fulfillment.lines.map((line) => line.lineId)).size !== fulfillment.lines.length) {
    throw new InvariantViolationError("fulfillment line IDs must be unique", "fulfillment.lines");
  }

  const orderLines = new Map(order.lines.map((line) => [line.lineId, line]));
  for (const line of fulfillment.lines) {
    const orderLine = orderLines.get(line.lineId);
    if (!orderLine) {
      throw new InvariantViolationError(
        "fulfillment line must reference an order line",
        `fulfillment.lines.${line.lineId}`,
      );
    }

    assertFulfillmentLineQuantities(line);
    const netOrderedQty = orderLine.orderedQty - orderLine.cancelledQty;
    if (!options.allowAllocationOverage && line.allocatedQty > netOrderedQty) {
      throw new InvariantViolationError(
        "allocated quantity cannot exceed non-cancelled ordered quantity",
        `fulfillment.lines.${line.lineId}.allocatedQty`,
      );
    }
    if (line.pickedQty > line.allocatedQty) {
      throw new InvariantViolationError(
        "picked quantity cannot exceed allocated quantity",
        `fulfillment.lines.${line.lineId}.pickedQty`,
      );
    }
    if (line.packedQty > line.pickedQty) {
      throw new InvariantViolationError(
        "packed quantity cannot exceed picked quantity",
        `fulfillment.lines.${line.lineId}.packedQty`,
      );
    }
    if (line.shippedQty > line.packedQty) {
      throw new InvariantViolationError(
        "shipped quantity cannot exceed packed quantity",
        `fulfillment.lines.${line.lineId}.shippedQty`,
      );
    }
  }
}

export function assertFulfillmentLineQuantities(line: FulfillmentLine): void {
  const paths: Array<[number, string]> = [
    [line.allocatedQty, "allocatedQty"],
    [line.pickedQty, "pickedQty"],
    [line.packedQty, "packedQty"],
    [line.shippedQty, "shippedQty"],
    [line.shortQty, "shortQty"],
    [line.damagedQty, "damagedQty"],
  ];
  for (const [value, path] of paths) assertNonNegativeInteger(value, path);
}

export function nonCancelledQuantity(line: CanonicalOrderLine): number {
  assertNonNegativeInteger(line.orderedQty, "orderedQty");
  assertNonNegativeInteger(line.cancelledQty, "cancelledQty");
  if (line.cancelledQty > line.orderedQty) {
    throw new InvariantViolationError(
      "cancelled quantity cannot exceed ordered quantity",
      line.lineId,
    );
  }
  return line.orderedQty - line.cancelledQty;
}

export function openQuantity(
  orderLine: CanonicalOrderLine,
  fulfillmentLine?: FulfillmentLine,
): number {
  const shippedQty = fulfillmentLine?.shippedQty ?? 0;
  assertNonNegativeInteger(shippedQty, `${orderLine.lineId}.shippedQty`);
  const remaining = nonCancelledQuantity(orderLine) - shippedQty;
  if (remaining < 0) {
    throw new InvariantViolationError(
      "shipped quantity cannot exceed non-cancelled quantity",
      orderLine.lineId,
    );
  }
  return remaining;
}

export function totalNonCancelledQuantity(order: CanonicalOrder): number {
  assertOrderQuantityInvariants(order);
  return order.lines.reduce((total, line) => total + nonCancelledQuantity(line), 0);
}

export function totalShippedQuantity(fulfillment: FulfillmentActual): number {
  return fulfillment.lines.reduce((total, line) => total + line.shippedQty, 0);
}
