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
  observedAt: string;
  lastAppliedEventId?: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey: string;
  payload: TPayload;
};

export type IntegrationEventContext = {
  tenantId: string;
  sourceSystem: string;
  receivedAt: string;
  observedAt?: string;
};

export type FreshnessDecision = "new" | "stale" | "duplicate" | "ambiguous";

export type FreshnessObservation = {
  eventId: string;
  occurredAt: string;
  observedAt: string;
  sourceVersion?: string;
};

export type FreshnessState = FreshnessObservation;

function compareVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Classifies replay, reordering, and equal-freshness observations explicitly. */
export function classifyFreshness(
  incoming: FreshnessObservation,
  current?: FreshnessState,
): FreshnessDecision {
  if (current === undefined) return "new";
  if (incoming.eventId === current.eventId) return "duplicate";
  if (incoming.sourceVersion !== undefined && current.sourceVersion !== undefined) {
    const comparison = compareVersions(incoming.sourceVersion, current.sourceVersion);
    if (comparison < 0) return "stale";
    if (comparison === 0) return "ambiguous";
    return "new";
  }
  if (incoming.observedAt < current.observedAt) return "stale";
  if (incoming.observedAt === current.observedAt) return "ambiguous";
  return "new";
}

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
  const observedAt = context.observedAt ?? context.receivedAt;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt) ||
    Number.isNaN(Date.parse(observedAt))
  ) {
    throw new SchemaValidationError([
      { path: "observedAt", message: "must be an ISO-8601 UTC instant" },
    ]);
  }
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
    observedAt,
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
