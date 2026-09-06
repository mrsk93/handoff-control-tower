import { describe, expect, it } from "vitest";
import {
  InvalidExceptionCommandError,
  OptimisticConcurrencyError,
  applyExceptionCommand,
  type ExceptionAggregate,
  type ExceptionCommand,
} from "@handoff/domain";

const occurredAt = "2026-01-01T00:00:00.000Z";

function makeException(overrides: Partial<ExceptionAggregate> = {}): ExceptionAggregate {
  return {
    id: "exception-1",
    tenantId: "tenant-a",
    orderId: "order-1",
    type: "SHORT_SHIPMENT",
    severity: "high",
    status: "open",
    version: 1,
    ...overrides,
  };
}

function command<T extends ExceptionCommand["type"]>(
  type: T,
  fields: Omit<
    Extract<ExceptionCommand, { type: T }>,
    "type" | "occurredAt" | "idempotencyKey" | "expectedVersion" | "actorId"
  > = {} as never,
): Extract<ExceptionCommand, { type: T }> {
  return {
    type,
    idempotencyKey: `command:${type}`,
    expectedVersion: 1,
    occurredAt,
    actorId: "operator-1",
    ...fields,
  } as Extract<ExceptionCommand, { type: T }>;
}

describe("exception command domain seam", () => {
  it("resolves a short shipment only through its named command", () => {
    const result = applyExceptionCommand(
      makeException(),
      command("resolve_short", {
        resolution: "close_short",
        reason: "Synthetic operator decision",
      }),
    );
    expect(result.state).toMatchObject({
      status: "resolved",
      resolutionCode: "close_short",
      resolutionReason: "Synthetic operator decision",
      version: 2,
    });
  });

  it("maps a missing SKU through a named mapping command", () => {
    const result = applyExceptionCommand(
      makeException({ type: "MISSING_SKU_MAPPING" }),
      command("map_sku", {
        sourceLineId: "line-1",
        sku: "SKU-MAPPED",
        orderedQty: 2,
        reason: "Synthetic catalog mapping",
      }),
    );
    expect(result).toMatchObject({
      state: { status: "resolved", resolutionCode: "map_sku" },
      effect: { type: "sku_mapped", sourceLineId: "line-1", sku: "SKU-MAPPED" },
    });
  });

  it("rejects generic resolution and resolution of the wrong exception type", () => {
    expect(() =>
      applyExceptionCommand(makeException(), {
        ...command("dismiss", { reason: "no" }),
        type: "resolve",
      } as never),
    ).toThrow(InvalidExceptionCommandError);
    expect(() =>
      applyExceptionCommand(
        makeException({ type: "TRACKING_MISMATCH" }),
        command("resolve_short", { resolution: "backorder", reason: "wrong type" }),
      ),
    ).toThrow("only valid for SHORT_SHIPMENT");
  });

  it("enforces optimistic concurrency before applying a command", () => {
    expect(() =>
      applyExceptionCommand(
        makeException({ version: 2 }),
        command("resolve_short", { resolution: "backorder", reason: "stale command" }),
      ),
    ).toThrow(OptimisticConcurrencyError);
  });

  it("makes command replay a no-op with a stable result", () => {
    const result = applyExceptionCommand(
      makeException(),
      command("assign", { assignee: "operator-2" }),
      new Set(["command:assign"]),
    );
    expect(result).toMatchObject({ duplicate: true, applied: false, state: makeException() });
  });

  it("allows notes and low-severity dismissal, but never high-severity dismissal", () => {
    const note = applyExceptionCommand(makeException(), command("add_note", { note: "evidence" }));
    expect(note).toMatchObject({
      effect: { type: "note_added", note: "evidence" },
      state: { version: 2 },
    });
    const dismissed = applyExceptionCommand(
      makeException({ severity: "low" }),
      command("dismiss", { reason: "informational only" }),
    );
    expect(dismissed.state.status).toBe("dismissed");
    expect(() =>
      applyExceptionCommand(makeException(), command("dismiss", { reason: "unsafe" })),
    ).toThrow("only low-severity");
  });
});
