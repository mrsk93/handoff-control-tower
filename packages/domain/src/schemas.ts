import { SchemaValidationError } from "./errors";
import { assertFulfillmentLineQuantities, assertOrderQuantityInvariants } from "./quantities";
import type {
  CanonicalOrder,
  CanonicalOrderLine,
  FulfillmentActual,
  FulfillmentLine,
  Shipment,
  ShipmentLine,
} from "./types";

type RuntimeSchema<T> = {
  parse(input: unknown): T;
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: SchemaValidationError };
};

const orderStatuses = [
  "pending",
  "released",
  "held",
  "cancel_requested",
  "cancelled",
  "exception",
] as const;
const fulfillmentStatuses = [
  "not_sent",
  "sent",
  "acknowledged",
  "picking",
  "packed",
  "partially_shipped",
  "shipped",
  "cancel_requested",
  "cancelled",
  "exception",
] as const;
const shipmentStatuses = ["label_created", "shipped", "in_transit", "delivered", "voided"] as const;

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaValidationError([{ path, message: "must be an object" }]);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, path = key): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchemaValidationError([{ path, message: "must be a non-empty string" }]);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  return requiredString(input, key);
}

function integer(input: Record<string, unknown>, key: string, path = key): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SchemaValidationError([{ path, message: "must be a non-negative integer" }]);
  }
  return value;
}

function positiveInteger(input: Record<string, unknown>, key: string, path = key): number {
  const value = integer(input, key, path);
  if (value < 1) throw new SchemaValidationError([{ path, message: "must be a positive integer" }]);
  return value;
}

function enumValue<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = requiredString(input, key);
  if (!values.includes(value as T)) {
    throw new SchemaValidationError([
      { path: key, message: `must be one of ${values.join(", ")}` },
    ]);
  }
  return value as T;
}

function instant(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new SchemaValidationError([{ path: key, message: "must be an ISO-8601 UTC instant" }]);
  }
  return value;
}

function array(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value))
    throw new SchemaValidationError([{ path: key, message: "must be an array" }]);
  return value;
}

function parseOrderLine(input: unknown, index: number): CanonicalOrderLine {
  const value = record(input, `lines[${index}]`);
  return {
    lineId: requiredString(value, "lineId", `lines[${index}].lineId`),
    sourceLineId: requiredString(value, "sourceLineId", `lines[${index}].sourceLineId`),
    sku: requiredString(value, "sku", `lines[${index}].sku`),
    orderedQty: integer(value, "orderedQty", `lines[${index}].orderedQty`),
    cancelledQty: integer(value, "cancelledQty", `lines[${index}].cancelledQty`),
  };
}

function parseFulfillmentLine(input: unknown, index: number): FulfillmentLine {
  const value = record(input, `lines[${index}]`);
  return {
    lineId: requiredString(value, "lineId", `lines[${index}].lineId`),
    allocatedQty: integer(value, "allocatedQty", `lines[${index}].allocatedQty`),
    pickedQty: integer(value, "pickedQty", `lines[${index}].pickedQty`),
    packedQty: integer(value, "packedQty", `lines[${index}].packedQty`),
    shippedQty: integer(value, "shippedQty", `lines[${index}].shippedQty`),
    shortQty: integer(value, "shortQty", `lines[${index}].shortQty`),
    damagedQty: integer(value, "damagedQty", `lines[${index}].damagedQty`),
  };
}

function parseShipmentLine(input: unknown, index: number): ShipmentLine {
  const value = record(input, `lines[${index}]`);
  return {
    lineId: requiredString(value, "lineId", `lines[${index}].lineId`),
    quantity: positiveInteger(value, "quantity", `lines[${index}].quantity`),
  };
}

function assertUniqueLineIds(lines: Array<{ lineId: string }>, path: string): void {
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length) {
    throw new SchemaValidationError([{ path, message: "lineId values must be unique" }]);
  }
}

function schema<T>(parser: (input: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(input) {
      try {
        return { success: true, data: parser(input) };
      } catch (error) {
        if (error instanceof SchemaValidationError) return { success: false, error };
        throw error;
      }
    },
  };
}

export const canonicalOrderSchema = schema<CanonicalOrder>((input) => {
  const value = record(input, "order");
  const lines = array(value, "lines").map(parseOrderLine);
  assertUniqueLineIds(lines, "lines");
  const currency = requiredString(value, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new SchemaValidationError([
      { path: "currency", message: "must be a three-letter currency code" },
    ]);
  }
  const order: CanonicalOrder = {
    tenantId: requiredString(value, "tenantId"),
    orderId: requiredString(value, "orderId"),
    source: enumValue(value, "source", ["commerce"]),
    sourceOrderId: requiredString(value, "sourceOrderId"),
    sourceVersion: requiredString(value, "sourceVersion"),
    orderNumber: requiredString(value, "orderNumber"),
    currency,
    acceptedAt: instant(value, "acceptedAt"),
    releaseStatus: enumValue(value, "releaseStatus", orderStatuses),
    lines,
  };
  const cancelledAt = value.cancelledAt === undefined ? undefined : instant(value, "cancelledAt");
  if (cancelledAt !== undefined) order.cancelledAt = cancelledAt;
  try {
    assertOrderQuantityInvariants(order);
  } catch (error) {
    throw new SchemaValidationError([
      {
        path: "lines",
        message: error instanceof Error ? error.message : "invalid order quantities",
      },
    ]);
  }
  return order;
});

export const fulfillmentActualSchema = schema<FulfillmentActual>((input) => {
  const value = record(input, "fulfillment");
  const lines = array(value, "lines").map(parseFulfillmentLine);
  assertUniqueLineIds(lines, "lines");
  for (const line of lines) assertFulfillmentLineQuantities(line);
  const fulfillment: FulfillmentActual = {
    tenantId: requiredString(value, "tenantId"),
    orderId: requiredString(value, "orderId"),
    status: enumValue(value, "status", fulfillmentStatuses),
    lines,
    version: positiveInteger(value, "version"),
  };
  const warehouseOrderId = optionalString(value, "warehouseOrderId");
  if (warehouseOrderId !== undefined) fulfillment.warehouseOrderId = warehouseOrderId;
  return fulfillment;
});

export const shipmentSchema = schema<Shipment>((input) => {
  const value = record(input, "shipment");
  const lines = array(value, "lines").map(parseShipmentLine);
  assertUniqueLineIds(lines, "lines");
  const shipment: Shipment = {
    tenantId: requiredString(value, "tenantId"),
    shipmentId: requiredString(value, "shipmentId"),
    orderId: requiredString(value, "orderId"),
    carrierCode: requiredString(value, "carrierCode"),
    serviceCode: requiredString(value, "serviceCode"),
    trackingNumber: requiredString(value, "trackingNumber"),
    lines,
    status: enumValue(value, "status", shipmentStatuses),
  };
  for (const [key, parser] of [
    ["externalShipmentId", optionalString(value, "externalShipmentId")],
    ["trackingUrl", optionalString(value, "trackingUrl")],
    ["shippedAt", value.shippedAt === undefined ? undefined : instant(value, "shippedAt")],
  ] as const) {
    if (parser !== undefined) shipment[key] = parser;
  }
  return shipment;
});

export const parseCanonicalOrder = (input: unknown): CanonicalOrder =>
  canonicalOrderSchema.parse(input);
export const parseFulfillmentActual = (input: unknown): FulfillmentActual =>
  fulfillmentActualSchema.parse(input);
export const parseShipment = (input: unknown): Shipment => shipmentSchema.parse(input);
