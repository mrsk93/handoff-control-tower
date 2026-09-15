import { SchemaValidationError } from "./errors";
import { assertFulfillmentLineQuantities, assertOrderQuantityInvariants } from "./quantities";
import type {
  Address,
  CanonicalCustomer,
  CanonicalOrder,
  CanonicalOrderLine,
  CanonicalSku,
  ExternalRef,
  FulfillmentActual,
  FulfillmentLine,
  Money,
  Quantity,
  Shipment,
  ShipmentLine,
} from "./types";
import { normalizeSku } from "./value-objects";

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
const integrationSystems = ["COMMERCE", "ERP", "WAREHOUSE", "CARRIER", "HANDOFF"] as const;
const quantityUnits = ["EA", "KG", "LB", "CASE", "UNKNOWN"] as const;

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

function optionalInstant(input: Record<string, unknown>, key: string): string | undefined {
  return input[key] === undefined ? undefined : instant(input, key);
}

function parseMoneyObject(input: unknown, path: string): Money {
  const value = record(input, path);
  const amountMinor = requiredString(value, "amountMinor", `${path}.amountMinor`);
  if (!/^-?\d+$/.test(amountMinor)) {
    throw new SchemaValidationError([
      { path: `${path}.amountMinor`, message: "must be an integer string" },
    ]);
  }
  const currency = requiredString(value, "currency", `${path}.currency`).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new SchemaValidationError([
      { path: `${path}.currency`, message: "must be a three-letter currency code" },
    ]);
  }
  return { amountMinor: BigInt(amountMinor), currency };
}

function parseAddressValue(input: unknown, path: string): Address {
  const value = record(input, path);
  const countryCode = requiredString(value, "countryCode", `${path}.countryCode`).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new SchemaValidationError([
      { path: `${path}.countryCode`, message: "must be a two-letter country code" },
    ]);
  }
  const address: Address = {
    address1: requiredString(value, "address1", `${path}.address1`),
    city: requiredString(value, "city", `${path}.city`),
    postalCode: requiredString(value, "postalCode", `${path}.postalCode`),
    countryCode,
  };
  for (const key of ["name", "company", "address2", "stateOrProvince", "phone", "email"] as const) {
    const parsed = optionalString(value, key);
    if (parsed !== undefined) address[key] = parsed;
  }
  return address;
}

function parseExternalRefValue(input: unknown, path: string): ExternalRef {
  const value = record(input, path);
  const externalRef: ExternalRef = {
    system: enumValue(value, "system", integrationSystems),
    resource: requiredString(value, "resource", `${path}.resource`),
    id: requiredString(value, "id", `${path}.id`),
  };
  const displayId = optionalString(value, "displayId");
  const url = optionalString(value, "url");
  if (displayId !== undefined) externalRef.displayId = displayId;
  if (url !== undefined) {
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("protocol");
    } catch {
      throw new SchemaValidationError([{ path: `${path}.url`, message: "must be an HTTP(S) URL" }]);
    }
    externalRef.url = url;
  }
  return externalRef;
}

function parseExternalRefs(input: Record<string, unknown>, key: string): ExternalRef[] {
  return array(input, key).map((item, index) => parseExternalRefValue(item, `${key}[${index}]`));
}

function parseQuantityValue(input: unknown, path: string): Quantity {
  const value = record(input, path);
  const raw = requiredString(value, "value", `${path}.value`);
  const unit = enumValue(value, "unit", quantityUnits);
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new SchemaValidationError([
      { path: `${path}.value`, message: "must be an exact decimal string" },
    ]);
  }
  if (unit === "EA" && !/^\d+$/.test(raw)) {
    throw new SchemaValidationError([
      { path: `${path}.value`, message: "must be an integer when unit is EA" },
    ]);
  }
  return { value: raw, unit };
}

function parseBoolean(input: Record<string, unknown>, key: string, path = key): boolean {
  const value = input[key];
  if (typeof value !== "boolean") {
    throw new SchemaValidationError([{ path, message: "must be a boolean" }]);
  }
  return value;
}

function parseCanonicalCustomerObject(input: unknown, path: string): CanonicalCustomer {
  const value = record(input, path);
  const addresses = array(value, "shippingAddresses").map((item, index) =>
    parseAddressValue(item, `${path}.shippingAddresses[${index}]`),
  );
  const customer: CanonicalCustomer = {
    id: requiredString(value, "id", `${path}.id`),
    tenantId: requiredString(value, "tenantId", `${path}.tenantId`),
    displayName: requiredString(value, "displayName", `${path}.displayName`),
    shippingAddresses: addresses,
    externalRefs: parseExternalRefs(value, "externalRefs"),
    createdAt: instant(value, "createdAt"),
    updatedAt: instant(value, "updatedAt"),
  };
  for (const key of ["email", "phone"] as const) {
    const parsed = optionalString(value, key);
    if (parsed !== undefined) customer[key] = parsed;
  }
  if (value.billingAddress !== undefined)
    customer.billingAddress = parseAddressValue(value.billingAddress, `${path}.billingAddress`);
  return customer;
}

function parseCanonicalSkuObject(input: unknown, path: string): CanonicalSku {
  const value = record(input, path);
  const sku = requiredString(value, "sku", `${path}.sku`);
  let normalizedSku: string;
  try {
    normalizedSku = normalizeSku(sku, `${path}.sku`);
  } catch (error) {
    throw new SchemaValidationError([
      { path: `${path}.sku`, message: error instanceof Error ? error.message : "invalid SKU" },
    ]);
  }
  const suppliedNormalizedSku = optionalString(value, "normalizedSku");
  if (suppliedNormalizedSku !== undefined && suppliedNormalizedSku !== normalizedSku) {
    throw new SchemaValidationError([
      { path: `${path}.normalizedSku`, message: "must match the normalized sku value" },
    ]);
  }
  const item: CanonicalSku = {
    id: requiredString(value, "id", `${path}.id`),
    tenantId: requiredString(value, "tenantId", `${path}.tenantId`),
    sku,
    normalizedSku,
    name: requiredString(value, "name", `${path}.name`),
    active: parseBoolean(value, "active", `${path}.active`),
    requiresShipping: parseBoolean(value, "requiresShipping", `${path}.requiresShipping`),
    unit: enumValue(value, "unit", quantityUnits),
    externalRefs: parseExternalRefs(value, "externalRefs"),
    createdAt: instant(value, "createdAt"),
    updatedAt: instant(value, "updatedAt"),
  };
  for (const key of ["barcode", "sourceUpdatedAt"] as const) {
    const parsed =
      key === "sourceUpdatedAt" ? optionalInstant(value, key) : optionalString(value, key);
    if (parsed !== undefined) item[key] = parsed;
  }
  return item;
}

function parseOrderLine(input: unknown, index: number): CanonicalOrderLine {
  const value = record(input, `lines[${index}]`);
  const sku = requiredString(value, "sku", `lines[${index}].sku`);
  let normalizedSku: string;
  try {
    normalizedSku = normalizeSku(sku, `lines[${index}].sku`);
  } catch (error) {
    throw new SchemaValidationError([
      {
        path: `lines[${index}].sku`,
        message: error instanceof Error ? error.message : "invalid SKU",
      },
    ]);
  }
  const line: CanonicalOrderLine = {
    lineId: requiredString(value, "lineId", `lines[${index}].lineId`),
    sourceLineId: requiredString(value, "sourceLineId", `lines[${index}].sourceLineId`),
    sku: normalizedSku,
    orderedQty: integer(value, "orderedQty", `lines[${index}].orderedQty`),
    cancelledQty: integer(value, "cancelledQty", `lines[${index}].cancelledQty`),
  };
  for (const key of ["title"] as const) {
    const parsed = optionalString(value, key);
    if (parsed !== undefined) line[key] = parsed;
  }
  const unit = value.unit === undefined ? undefined : enumValue(value, "unit", quantityUnits);
  if (unit !== undefined) line.unit = unit;
  if (value.orderedQuantity !== undefined)
    line.orderedQuantity = parseQuantityValue(
      value.orderedQuantity,
      `lines[${index}].orderedQuantity`,
    );
  for (const key of ["unitPrice", "discountTotal", "taxTotal"] as const) {
    if (value[key] !== undefined)
      line[key] = parseMoneyObject(value[key], `lines[${index}].${key}`);
  }
  if (value.externalRefs !== undefined)
    line.externalRefs = parseExternalRefs(value, "externalRefs");
  return line;
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
  for (const key of [
    "financialStatus",
    "customerId",
    "requestedShippingMethod",
    "lastAppliedEventId",
  ] as const) {
    const parsed = optionalString(value, key);
    if (parsed !== undefined) order[key] = parsed;
  }
  if (value.customer !== undefined)
    order.customer = parseCanonicalCustomerObject(value.customer, "customer");
  if (value.shippingAddress !== undefined)
    order.shippingAddress = parseAddressValue(value.shippingAddress, "shippingAddress");
  if (value.billingAddress !== undefined)
    order.billingAddress = parseAddressValue(value.billingAddress, "billingAddress");
  for (const key of [
    "subtotal",
    "shippingTotal",
    "taxTotal",
    "discountTotal",
    "grandTotal",
  ] as const) {
    if (value[key] !== undefined) order[key] = parseMoneyObject(value[key], key);
  }
  if (value.externalRefs !== undefined)
    order.externalRefs = parseExternalRefs(value, "externalRefs");
  for (const key of ["sourceUpdatedAt", "observedAt"] as const) {
    const parsed = optionalInstant(value, key);
    if (parsed !== undefined) order[key] = parsed;
  }
  if (value.sourceSystem !== undefined)
    order.sourceSystem = enumValue(value, "sourceSystem", integrationSystems);
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

export const moneySchema = schema<Money>((input) => parseMoneyObject(input, "money"));
export const addressSchema = schema<Address>((input) => parseAddressValue(input, "address"));
export const externalRefSchema = schema<ExternalRef>((input) =>
  parseExternalRefValue(input, "externalRef"),
);
export const quantitySchema = schema<Quantity>((input) => parseQuantityValue(input, "quantity"));
export const canonicalCustomerSchema = schema<CanonicalCustomer>((input) =>
  parseCanonicalCustomerObject(input, "customer"),
);
export const canonicalSkuSchema = schema<CanonicalSku>((input) =>
  parseCanonicalSkuObject(input, "sku"),
);

export const parseCanonicalOrder = (input: unknown): CanonicalOrder =>
  canonicalOrderSchema.parse(input);
export const parseMoneyValue = (input: unknown): Money => moneySchema.parse(input);
export const parseAddress = (input: unknown): Address => addressSchema.parse(input);
export const parseExternalRef = (input: unknown): ExternalRef => externalRefSchema.parse(input);
export const parseQuantity = (input: unknown): Quantity => quantitySchema.parse(input);
export const parseCanonicalCustomer = (input: unknown): CanonicalCustomer =>
  canonicalCustomerSchema.parse(input);
export const parseCanonicalSku = (input: unknown): CanonicalSku => canonicalSkuSchema.parse(input);
export const parseFulfillmentActual = (input: unknown): FulfillmentActual =>
  fulfillmentActualSchema.parse(input);
export const parseShipment = (input: unknown): Shipment => shipmentSchema.parse(input);
