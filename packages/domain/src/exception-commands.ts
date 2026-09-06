import { InvalidExceptionCommandError, OptimisticConcurrencyError } from "./errors";
import type { ExceptionSeverity, ShortShipmentResolution } from "./types";

export const exceptionTypes = [
  "MISSING_SKU_MAPPING",
  "WAREHOUSE_IDENTITY_CONFLICT",
  "INVALID_QUANTITY",
  "NON_MONOTONIC_WMS_UPDATE",
  "SHORT_SHIPMENT",
  "CANCEL_AFTER_RELEASE",
  "CANCEL_AFTER_SHIPMENT",
  "FULFILLMENT_SYNC_FAILED",
  "TRACKING_MISMATCH",
  "RECONCILIATION_DRIFT",
  "OUTBOX_DEAD_LETTER",
  "PARKED_EVENT_EXPIRED",
] as const;

export type ExceptionType = (typeof exceptionTypes)[number];
export type ExceptionStatus = "open" | "resolved" | "dismissed";

export type ExceptionAggregate = {
  id: string;
  tenantId: string;
  orderId?: string;
  orderLineId?: string;
  type: ExceptionType;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  assignee?: string;
  resolutionCode?: string;
  resolutionReason?: string;
  version: number;
};

export type ExceptionCommandMetadata = {
  idempotencyKey: string;
  expectedVersion: number;
  occurredAt: string;
  actorId: string;
  correlationId?: string;
  causationId?: string;
};

export type ExceptionCommand = ExceptionCommandMetadata &
  (
    | { type: "assign"; assignee: string | null }
    | { type: "add_note"; note: string }
    | {
        type: "map_sku";
        sourceLineId: string;
        sku: string;
        orderedQty: number;
        cancelledQty?: number;
        reason: string;
      }
    | {
        type: "resolve_short";
        resolution: Exclude<ShortShipmentResolution, "unresolved">;
        reason: string;
      }
    | { type: "retry_outbox"; outboxId: string; reason: string }
    | { type: "accept_authoritative_value"; field: string; value: unknown; reason: string }
    | { type: "dismiss"; reason: string }
  );

export type ExceptionCommandEffect =
  | { type: "state_changed" }
  | { type: "note_added"; note: string }
  | {
      type: "sku_mapped";
      sourceLineId: string;
      sku: string;
      orderedQty: number;
      cancelledQty: number;
    }
  | { type: "retry_requested"; outboxId: string }
  | { type: "authoritative_value_accepted"; field: string; value: unknown };

export type ExceptionCommandResult = {
  state: ExceptionAggregate;
  effect: ExceptionCommandEffect;
  applied: boolean;
  duplicate: boolean;
  auditAction: string;
};

function requiredText(value: string, name: string): void {
  if (value.trim().length === 0) throw new InvalidExceptionCommandError(`${name} is required`);
}

function assertMetadata(command: ExceptionCommand): void {
  requiredText(command.idempotencyKey, "idempotencyKey");
  requiredText(command.actorId, "actorId");
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
    throw new InvalidExceptionCommandError("expectedVersion must be a positive integer");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(command.occurredAt)) {
    throw new InvalidExceptionCommandError("occurredAt must be an ISO-8601 UTC instant");
  }
}

function bumped(exception: ExceptionAggregate): ExceptionAggregate {
  return { ...exception, version: exception.version + 1 };
}

export function applyExceptionCommand(
  exception: ExceptionAggregate,
  command: ExceptionCommand,
  processedCommandKeys: ReadonlySet<string> = new Set(),
): ExceptionCommandResult {
  assertMetadata(command);
  if (processedCommandKeys.has(command.idempotencyKey)) {
    return {
      state: exception,
      effect: { type: "state_changed" },
      applied: false,
      duplicate: true,
      auditAction: `exception.command.${command.type}.duplicate`,
    };
  }
  if (command.expectedVersion !== exception.version) {
    throw new OptimisticConcurrencyError(
      `expected exception version ${command.expectedVersion}, current version is ${exception.version}`,
    );
  }
  if (exception.status !== "open" && command.type !== "add_note") {
    throw new InvalidExceptionCommandError("only open exceptions accept this command");
  }

  let state = exception;
  let effect: ExceptionCommandEffect = { type: "state_changed" };
  switch (command.type) {
    case "assign":
      if (command.assignee !== null) requiredText(command.assignee, "assignee");
      state = bumped(
        command.assignee === null
          ? (() => {
              const next = { ...exception };
              delete next.assignee;
              return next;
            })()
          : { ...exception, assignee: command.assignee.trim() },
      );
      break;
    case "add_note":
      requiredText(command.note, "note");
      if (command.note.length > 4_000) throw new InvalidExceptionCommandError("note is too long");
      state = bumped(exception);
      effect = { type: "note_added", note: command.note.trim() };
      break;
    case "map_sku":
      if (exception.type !== "MISSING_SKU_MAPPING") {
        throw new InvalidExceptionCommandError("map_sku is only valid for MISSING_SKU_MAPPING");
      }
      requiredText(command.sourceLineId, "sourceLineId");
      requiredText(command.sku, "sku");
      requiredText(command.reason, "reason");
      if (!Number.isInteger(command.orderedQty) || command.orderedQty < 0) {
        throw new InvalidExceptionCommandError("orderedQty must be a non-negative integer");
      }
      if (
        command.cancelledQty !== undefined &&
        (!Number.isInteger(command.cancelledQty) ||
          command.cancelledQty < 0 ||
          command.cancelledQty > command.orderedQty)
      ) {
        throw new InvalidExceptionCommandError("cancelledQty must be between zero and orderedQty");
      }
      state = bumped({
        ...exception,
        status: "resolved",
        resolutionCode: "map_sku",
        resolutionReason: command.reason.trim(),
      });
      effect = {
        type: "sku_mapped",
        sourceLineId: command.sourceLineId.trim(),
        sku: command.sku.trim(),
        orderedQty: command.orderedQty,
        cancelledQty: command.cancelledQty ?? 0,
      };
      break;
    case "resolve_short":
      if (exception.type !== "SHORT_SHIPMENT") {
        throw new InvalidExceptionCommandError("resolve_short is only valid for SHORT_SHIPMENT");
      }
      requiredText(command.reason, "reason");
      state = bumped({
        ...exception,
        status: "resolved",
        resolutionCode: command.resolution,
        resolutionReason: command.reason.trim(),
      });
      break;
    case "retry_outbox":
      if (exception.type !== "OUTBOX_DEAD_LETTER") {
        throw new InvalidExceptionCommandError("retry_outbox is only valid for OUTBOX_DEAD_LETTER");
      }
      requiredText(command.outboxId, "outboxId");
      requiredText(command.reason, "reason");
      state = bumped(exception);
      effect = { type: "retry_requested", outboxId: command.outboxId };
      break;
    case "accept_authoritative_value":
      if (
        exception.type !== "WAREHOUSE_IDENTITY_CONFLICT" &&
        exception.type !== "TRACKING_MISMATCH"
      ) {
        throw new InvalidExceptionCommandError(
          "accept_authoritative_value is only valid for identity or tracking conflicts",
        );
      }
      requiredText(command.field, "field");
      requiredText(command.reason, "reason");
      state = bumped({
        ...exception,
        status: "resolved",
        resolutionCode: "accept_authoritative_value",
        resolutionReason: command.reason.trim(),
      });
      effect = {
        type: "authoritative_value_accepted",
        field: command.field.trim(),
        value: command.value,
      };
      break;
    case "dismiss":
      if (exception.severity !== "low") {
        throw new InvalidExceptionCommandError("only low-severity exceptions may be dismissed");
      }
      requiredText(command.reason, "reason");
      state = bumped({
        ...exception,
        status: "dismissed",
        resolutionCode: "dismissed",
        resolutionReason: command.reason.trim(),
      });
      break;
    default:
      throw new InvalidExceptionCommandError("unsupported exception command");
  }
  return {
    state,
    effect,
    applied: true,
    duplicate: false,
    auditAction: `exception.command.${command.type}`,
  };
}
