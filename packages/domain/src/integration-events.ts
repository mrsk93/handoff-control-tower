import { SchemaValidationError } from "./errors";

export type IntegrationEvent<TPayload = unknown> = {
  messageId: string;
  eventType: string;
  eventVersion: number;
  tenantId: string;
  sourceSystem: string;
  sourceEntityId: string;
  sourceVersion?: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  payload: TPayload;
};

export type IntegrationEventContext = {
  tenantId: string;
  sourceSystem: string;
  receivedAt: string;
};

function objectRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaValidationError([{ path: "event", message: "must be an object" }]);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SchemaValidationError([{ path: key, message: "must be a non-empty string" }]);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  return requiredString(input, key);
}

function utcInstant(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new SchemaValidationError([{ path: key, message: "must be an ISO-8601 UTC instant" }]);
  }
  return value;
}

function positiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SchemaValidationError([{ path: key, message: "must be a positive integer" }]);
  }
  return value;
}

/**
 * Normalizes a source envelope using tenant and receive-time context supplied by a trusted seam.
 * A request body may repeat tenantId for diagnostics, but it can never override the context.
 */
export function normalizeIntegrationEvent<TPayload = unknown>(
  input: unknown,
  context: IntegrationEventContext,
): IntegrationEvent<TPayload> {
  const value = objectRecord(input);
  const messageId = requiredString(value, "messageId");
  const bodyTenantId = value.tenantId;
  if (bodyTenantId !== undefined && bodyTenantId !== context.tenantId) {
    throw new SchemaValidationError([
      { path: "tenantId", message: "must match the authenticated tenant context" },
    ]);
  }

  const event: IntegrationEvent<TPayload> = {
    messageId,
    eventType: requiredString(value, "eventType"),
    eventVersion: positiveInteger(value, "eventVersion"),
    tenantId: context.tenantId,
    sourceSystem: context.sourceSystem,
    sourceEntityId: requiredString(value, "sourceEntityId"),
    occurredAt: utcInstant(value, "occurredAt"),
    receivedAt: context.receivedAt,
    correlationId: optionalString(value, "correlationId") ?? `${context.sourceSystem}:${messageId}`,
    idempotencyKey:
      optionalString(value, "idempotencyKey") ?? `${context.sourceSystem}:${messageId}`,
    payload: value.payload as TPayload,
  };

  if (!("payload" in value)) {
    throw new SchemaValidationError([{ path: "payload", message: "is required" }]);
  }

  const sourceVersion = optionalString(value, "sourceVersion");
  if (sourceVersion !== undefined) event.sourceVersion = sourceVersion;
  const causationId = optionalString(value, "causationId");
  if (causationId !== undefined) event.causationId = causationId;
  return event;
}
