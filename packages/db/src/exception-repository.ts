import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  applyExceptionCommand,
  exceptionTypes,
  type ExceptionAggregate,
  type ExceptionCommand,
  type ExceptionCommandEffect,
  type ExceptionCommandResult,
  type ExceptionSeverity,
  type ExceptionStatus,
} from "@handoff/domain";
import type { Database } from "./client";
import {
  auditEvents,
  exceptionCommands,
  exceptionNotes,
  exceptions,
  orderLines,
  orders,
  outboxMessages,
  processInstances,
} from "./schema";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import type { Transaction } from "./transaction";

export type ExceptionCommandExecution = {
  duplicate: boolean;
  state: ExceptionAggregate;
  effect: ExceptionCommandEffect;
  auditAction: string;
};

function aggregateFromRow(row: typeof exceptions.$inferSelect): ExceptionAggregate {
  const normalizedType =
    row.type === "NON_MONOTONIC_WMS_UPDATE" ? "NON_MONOTONIC_WAREHOUSE_UPDATE" : row.type;
  if (!exceptionTypes.includes(normalizedType as (typeof exceptionTypes)[number])) {
    throw new Error(`unsupported exception type stored in database: ${row.type}`);
  }
  const aggregate: ExceptionAggregate = {
    id: row.id,
    tenantId: row.tenantId,
    type: normalizedType as ExceptionAggregate["type"],
    severity: row.severity as ExceptionSeverity,
    status: row.status as ExceptionStatus,
    version: row.rowVersion,
  };
  if (row.orderId !== null) aggregate.orderId = row.orderId;
  if (row.orderLineId !== null) aggregate.orderLineId = row.orderLineId;
  if (row.assignee !== null) aggregate.assignee = row.assignee;
  if (row.resolutionCode !== null) aggregate.resolutionCode = row.resolutionCode;
  if (row.resolutionReason !== null) aggregate.resolutionReason = row.resolutionReason;
  return aggregate;
}

async function findException(
  transaction: Database | Transaction,
  tenantId: string,
  exceptionId: string,
  lock = false,
): Promise<typeof exceptions.$inferSelect | null> {
  const query = transaction
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.tenantId, tenantId), eq(exceptions.id, exceptionId)))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function recomputeBlockingCount(
  transaction: Transaction,
  tenantId: string,
  orderId: string | undefined,
  now: Date,
  forceEligibilityRecompute: boolean,
): Promise<void> {
  if (!orderId) return;
  const rows = await transaction
    .select({ count: sql<string>`count(*)` })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.tenantId, tenantId),
        eq(exceptions.orderId, orderId),
        eq(exceptions.status, "open"),
        inArray(exceptions.severity, ["high", "critical"]),
      ),
    );
  const blockingCount = Number(rows[0]?.count ?? "0");
  await transaction
    .update(processInstances)
    .set({
      blockingExceptionCount: blockingCount,
      ...(forceEligibilityRecompute
        ? {
            invoiceEligible: false,
            currentStep: blockingCount === 0 ? "resolution_pending_recompute" : "exception",
          }
        : {}),
      rowVersion: sql`${processInstances.rowVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(processInstances.tenantId, tenantId), eq(processInstances.orderId, orderId)));
}

async function writeAudit(
  transaction: Transaction,
  tenantId: string,
  command: ExceptionCommand,
  action: string,
  exceptionId: string,
  beforeSummary: Record<string, unknown>,
  afterSummary: Record<string, unknown>,
): Promise<void> {
  await transaction.insert(auditEvents).values({
    id: randomUUID(),
    tenantId,
    actorType: "operator",
    actorId: command.actorId,
    action,
    entityType: "exception",
    entityId: exceptionId,
    correlationId: command.correlationId ?? command.idempotencyKey,
    causationId: command.causationId ?? null,
    beforeSummary,
    afterSummary,
    createdAt: new Date(command.occurredAt),
  });
}

function resultPayload(result: ExceptionCommandResult): Record<string, unknown> {
  return {
    effect: result.effect,
    state: result.state,
    auditAction: result.auditAction,
  };
}

export function createExceptionCommandRepository(db: Database) {
  return {
    async get(context: TenantContext, exceptionId: string): Promise<ExceptionAggregate | null> {
      const scoped = requireTenantContext(context.tenantId);
      const row = await findException(db, scoped.tenantId, exceptionId);
      return row ? aggregateFromRow(row) : null;
    },

    async listNotes(context: TenantContext, exceptionId: string) {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select()
        .from(exceptionNotes)
        .where(
          and(
            eq(exceptionNotes.tenantId, scoped.tenantId),
            eq(exceptionNotes.exceptionId, exceptionId),
          ),
        )
        .orderBy(desc(exceptionNotes.createdAt));
    },

    async execute(
      context: TenantContext,
      exceptionId: string,
      command: ExceptionCommand,
    ): Promise<ExceptionCommandExecution> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const existingCommand = await transaction
          .select()
          .from(exceptionCommands)
          .where(
            and(
              eq(exceptionCommands.tenantId, scoped.tenantId),
              eq(exceptionCommands.idempotencyKey, command.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingCommand[0]) {
          if (existingCommand[0].exceptionId !== exceptionId) {
            throw new Error("idempotency key is already used by another exception");
          }
          const row = await findException(transaction, scoped.tenantId, exceptionId);
          if (!row) throw new Error("exception not found");
          const stored = existingCommand[0].result as {
            effect: ExceptionCommandEffect;
            auditAction: string;
          };
          return {
            duplicate: true,
            state: aggregateFromRow(row),
            effect: stored.effect,
            auditAction: stored.auditAction,
          };
        }

        const row = await findException(transaction, scoped.tenantId, exceptionId, true);
        if (!row) throw new Error("exception not found");
        const before = aggregateFromRow(row);
        const result = applyExceptionCommand(before, command);
        if (!result.applied) return { ...result, duplicate: true };

        const now = new Date(command.occurredAt);
        await transaction
          .update(exceptions)
          .set({
            status: result.state.status,
            assignee: result.state.assignee ?? null,
            resolutionCode: result.state.resolutionCode ?? null,
            resolutionReason: result.state.resolutionReason ?? null,
            resolvedAt: result.state.status === "open" ? null : (row.resolvedAt ?? now),
            rowVersion: result.state.version,
            updatedAt: now,
          })
          .where(
            and(
              eq(exceptions.tenantId, scoped.tenantId),
              eq(exceptions.id, exceptionId),
              eq(exceptions.rowVersion, before.version),
            ),
          );

        if (result.effect.type === "note_added") {
          await transaction.insert(exceptionNotes).values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            exceptionId,
            authorId: command.actorId,
            note: result.effect.note,
            createdAt: now,
          });
        }
        if (result.effect.type === "sku_mapped") {
          if (!before.orderId) throw new Error("SKU mapping exception is missing its order");
          await transaction
            .insert(orderLines)
            .values({
              id: randomUUID(),
              tenantId: scoped.tenantId,
              orderId: before.orderId,
              sourceLineId: result.effect.sourceLineId,
              sku: result.effect.sku,
              orderedQty: result.effect.orderedQty,
              cancelledQty: result.effect.cancelledQty,
            })
            .onConflictDoNothing();
          await transaction
            .update(orders)
            .set({ rowVersion: sql`${orders.rowVersion} + 1`, updatedAt: now })
            .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, before.orderId)));
        }
        if (result.effect.type === "retry_requested") {
          if (command.type !== "retry_outbox") throw new Error("retry effect has no retry command");
          const retried = await transaction
            .update(outboxMessages)
            .set({
              status: "pending",
              availableAt: now,
              lockedAt: null,
              lockedBy: null,
              lastError: `manual retry: ${command.reason}`,
            })
            .where(
              and(
                eq(outboxMessages.tenantId, scoped.tenantId),
                eq(outboxMessages.id, result.effect.outboxId),
                eq(outboxMessages.status, "dead_letter"),
              ),
            )
            .returning({ id: outboxMessages.id });
          if (!retried[0]) throw new Error("dead-letter outbox message was not found");
        }

        const storedResult = resultPayload(result);
        await transaction.insert(exceptionCommands).values({
          id: randomUUID(),
          tenantId: scoped.tenantId,
          exceptionId,
          idempotencyKey: command.idempotencyKey,
          commandType: command.type,
          payload: command,
          result: storedResult,
          actorId: command.actorId,
          correlationId: command.correlationId ?? command.idempotencyKey,
          causationId: command.causationId ?? null,
          createdAt: now,
        });
        await writeAudit(
          transaction,
          scoped.tenantId,
          command,
          result.auditAction,
          exceptionId,
          { status: before.status, version: before.version },
          { status: result.state.status, version: result.state.version, effect: result.effect },
        );
        await recomputeBlockingCount(
          transaction,
          scoped.tenantId,
          before.orderId,
          now,
          before.status !== result.state.status &&
            (before.severity === "high" || before.severity === "critical"),
        );
        return {
          duplicate: false,
          state: result.state,
          effect: result.effect,
          auditAction: result.auditAction,
        };
      });
    },
  };
}

export type ExceptionCommandRepository = ReturnType<typeof createExceptionCommandRepository>;
