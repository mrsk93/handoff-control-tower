import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_TENANTS, createExceptionCommandRepository, type DatabaseHandle } from "@handoff/db";
import { OptimisticConcurrencyError, type ExceptionCommand } from "@handoff/domain";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const northstar = DEMO_TENANTS.northstar;
const bluebird = DEMO_TENANTS.bluebird;
const northstarOrder = "41111111-1111-4111-8111-111111111111";
const now = "2026-01-01T02:00:00.000Z";

describe.skipIf(!testDatabaseUrl)("exception commands", () => {
  let handle: DatabaseHandle | undefined;
  let repository: ReturnType<typeof createExceptionCommandRepository>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    repository = createExceptionCommandRepository(handle.db);
    await handle.pool.query(
      `insert into process_instances
         (id, tenant_id, order_id, current_step, last_applied_event_version, blocking_exception_count, invoice_eligible, decision_version, row_version, created_at, updated_at)
       values ($1, $2, $3, 'exception', null, 1, false, 0, 1, $4, $4)
       on conflict (tenant_id, order_id) do nothing`,
      ["51111111-1111-4111-8111-111111111111", northstar, northstarOrder, now],
    );
  });

  afterAll(async () => closeTestDatabase(handle));

  async function seedException(id: string, type: string, severity: string): Promise<void> {
    if (!handle) throw new Error("test database was not opened");
    await handle.pool.query(
      `insert into exceptions
         (id, tenant_id, order_id, type, severity, status, active_key, machine_summary, evidence, row_version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'open', $6, $7, '{}'::jsonb, 1, $8, $8)`,
      [id, northstar, northstarOrder, type, severity, `m7:${id}`, `${type} fixture`, now],
    );
  }

  function command<T extends ExceptionCommand["type"]>(
    type: T,
    expectedVersion: number,
    fields: Omit<
      Extract<ExceptionCommand, { type: T }>,
      "type" | "occurredAt" | "actorId" | "expectedVersion" | "idempotencyKey"
    >,
    idempotencyKey: string,
  ): Extract<ExceptionCommand, { type: T }> {
    return {
      type,
      expectedVersion,
      occurredAt: now,
      actorId: "operator-m7",
      idempotencyKey,
      ...fields,
    } as Extract<ExceptionCommand, { type: T }>;
  }

  it("applies assignment, notes, SKU mapping, and replay idempotently", async () => {
    if (!handle) throw new Error("test database was not opened");
    const exceptionId = "61111111-1111-4111-8111-111111111111";
    await seedException(exceptionId, "MISSING_SKU_MAPPING", "high");
    const context = { tenantId: northstar };

    const assigned = await repository.execute(
      context,
      exceptionId,
      command("assign", 1, { assignee: "operator-two" }, "m7-assign-1"),
    );
    expect(assigned).toMatchObject({
      duplicate: false,
      state: { assignee: "operator-two", version: 2 },
    });
    const replay = await repository.execute(
      context,
      exceptionId,
      command("assign", 1, { assignee: "operator-two" }, "m7-assign-1"),
    );
    expect(replay).toMatchObject({ duplicate: true, state: { version: 2 } });

    const noted = await repository.execute(
      context,
      exceptionId,
      command("add_note", 2, { note: "Synthetic catalog evidence" }, "m7-note-1"),
    );
    expect(noted.effect).toEqual({ type: "note_added", note: "Synthetic catalog evidence" });

    const mapped = await repository.execute(
      context,
      exceptionId,
      command(
        "map_sku",
        3,
        {
          sourceLineId: "m7-line-1",
          sku: "SKU-M7-MAPPED",
          orderedQty: 2,
          reason: "Synthetic mapping decision",
        },
        "m7-map-1",
      ),
    );
    expect(mapped).toMatchObject({
      state: { status: "resolved", version: 4 },
      effect: { type: "sku_mapped" },
    });
    const notes = await repository.listNotes(context, exceptionId);
    expect(notes).toHaveLength(1);

    const persisted = await handle.pool.query<{ lines: string; audits: string }>(
      `select
         (select count(*)::text from order_lines where order_id = $1 and source_line_id = 'm7-line-1') as lines,
         (select count(*)::text from audit_events where tenant_id = $2 and entity_id = $3 and action like 'exception.command.%') as audits`,
      [northstarOrder, northstar, exceptionId],
    );
    expect(persisted.rows[0]).toEqual({ lines: "1", audits: "3" });
  });

  it("allows one concurrent short-shipment winner and returns one version conflict", async () => {
    const exceptionId = "62222222-2222-4222-8222-222222222222";
    await seedException(exceptionId, "SHORT_SHIPMENT", "high");
    const results = await Promise.allSettled([
      repository.execute(
        { tenantId: northstar },
        exceptionId,
        command(
          "resolve_short",
          1,
          { resolution: "close_short", reason: "Close synthetic short" },
          "m7-short-a",
        ),
      ),
      repository.execute(
        { tenantId: northstar },
        exceptionId,
        command(
          "resolve_short",
          1,
          { resolution: "backorder", reason: "Backorder synthetic short" },
          "m7-short-b",
        ),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      OptimisticConcurrencyError,
    );
    if (!handle) throw new Error("test database was not opened");
    const persisted = await handle.pool.query<{
      status: string;
      row_version: number;
      commands: string;
    }>(
      `select
         e.status,
         e.row_version,
         (select count(*)::text from exception_commands c where c.exception_id = e.id) as commands
       from exceptions e where e.id = $1 and e.tenant_id = $2`,
      [exceptionId, northstar],
    );
    expect(persisted.rows[0]).toMatchObject({ status: "resolved", row_version: 2, commands: "1" });
  });

  it("keeps retry and tenant scope explicit", async () => {
    if (!handle) throw new Error("test database was not opened");
    const exceptionId = "63333333-3333-4333-8333-333333333333";
    const outboxId = "73333333-3333-4333-8333-333333333333";
    await seedException(exceptionId, "OUTBOX_DEAD_LETTER", "high");
    await handle.pool.query(
      `insert into outbox_messages
         (id, tenant_id, destination, message_type, message_version, payload, idempotency_key, correlation_id, status, available_at, attempt_count, created_at)
       values ($1, $2, 'mock-wms', 'wms.create_order.v1', 1, '{}'::jsonb, $3, $4, 'dead_letter', $5, 3, $5)`,
      [outboxId, northstar, "m7-dead-letter-1", "m7-correlation-1", now],
    );
    const retried = await repository.execute(
      { tenantId: northstar },
      exceptionId,
      command("retry_outbox", 1, { outboxId, reason: "Synthetic operator retry" }, "m7-retry-1"),
    );
    expect(retried.effect).toEqual({ type: "retry_requested", outboxId });
    const outbox = await handle.pool.query<{ status: string }>(
      "select status from outbox_messages where id = $1",
      [outboxId],
    );
    expect(outbox.rows[0]?.status).toBe("pending");
    expect(await repository.get({ tenantId: bluebird }, exceptionId)).toBeNull();
    await expect(
      repository.execute(
        { tenantId: bluebird },
        exceptionId,
        command("retry_outbox", 1, { outboxId, reason: "cross tenant" }, "m7-cross-tenant"),
      ),
    ).rejects.toThrow("exception not found");
  });
});
