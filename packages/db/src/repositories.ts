import { and, asc, eq, inArray, isNotNull, lte, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IntegrationEvent, OutboundDeliveryReceipt, OutboundMessage } from "@handoff/domain";
import type { Database } from "./client";
import {
  connections,
  inboxMessages,
  orders,
  outboxDeliveryReceipts,
  outboxMessages,
  tenants,
} from "./schema";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import type { Transaction } from "./transaction";

export type TenantRepository = ReturnType<typeof createTenantRepository>;

export function createTenantRepository(db: Database) {
  return {
    async getTenant(context: TenantContext) {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db.select().from(tenants).where(eq(tenants.id, scoped.tenantId)).limit(1);
      return rows[0] ?? null;
    },

    async listConnections(context: TenantContext) {
      const scoped = requireTenantContext(context.tenantId);
      return db.select().from(connections).where(eq(connections.tenantId, scoped.tenantId));
    },
  };
}

export function createOrderRepository(db: Database) {
  return {
    async findBySourceOrderId(context: TenantContext, sourceOrderId: string) {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.sourceOrderId, sourceOrderId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
  };
}

export type InboxPrerequisite = {
  type: "order" | "fulfillment" | "shipment";
  key: string;
};

export type InboxIngestOptions = {
  prerequisite?: InboxPrerequisite;
};

export type InboxIngestResult = {
  duplicate: boolean;
  status: "received" | "parked" | "ignored";
  stale: boolean;
  message: typeof inboxMessages.$inferSelect;
};

export type InboxClaim = typeof inboxMessages.$inferSelect;

export type InboxOutcome =
  | { status: "processed" | "ignored"; error?: string }
  | { status: "parked"; prerequisite: InboxPrerequisite; error: string; availableAt: Date };

export type InboxFailure = {
  error: string;
  retryAt: Date;
  maxAttempts: number;
};

function isOlderSourceVersion(incoming: string, known: string): boolean {
  if (/^\d+$/.test(incoming) && /^\d+$/.test(known)) {
    return BigInt(incoming) < BigInt(known);
  }
  return incoming < known;
}

async function prerequisiteExists(
  transaction: Transaction,
  tenantId: string,
  prerequisite: InboxPrerequisite,
): Promise<boolean> {
  const rows =
    prerequisite.type === "order"
      ? await transaction
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.sourceOrderId, prerequisite.key)))
          .limit(1)
      : [];
  return rows.length > 0;
}

export function createInboxRepository(db: Database) {
  return {
    async ingest(
      context: TenantContext,
      event: IntegrationEvent,
      payloadSha256: string,
      options: InboxIngestOptions = {},
    ): Promise<InboxIngestResult> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const tenantRows = await transaction
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, scoped.tenantId))
          .limit(1);
        if (tenantRows.length === 0) throw new Error("tenant does not exist");

        const receivedAt = new Date(event.receivedAt);
        const sourceVersions = await transaction
          .select({ sourceVersion: inboxMessages.sourceVersion })
          .from(inboxMessages)
          .where(
            and(
              eq(inboxMessages.tenantId, scoped.tenantId),
              eq(inboxMessages.sourceSystem, event.sourceSystem),
              eq(inboxMessages.sourceEntityId, event.sourceEntityId),
            ),
          );
        const stale =
          event.sourceVersion !== undefined &&
          sourceVersions.some(
            (row) =>
              row.sourceVersion !== null &&
              isOlderSourceVersion(event.sourceVersion as string, row.sourceVersion),
          );
        const missingPrerequisite =
          options.prerequisite !== undefined &&
          !(await prerequisiteExists(transaction, scoped.tenantId, options.prerequisite));
        const status = stale ? "ignored" : missingPrerequisite ? "parked" : "received";
        const terminal = status === "ignored";
        const inserted = await transaction
          .insert(inboxMessages)
          .values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            sourceSystem: event.sourceSystem,
            messageId: event.messageId,
            eventType: event.eventType,
            eventVersion: event.eventVersion,
            sourceEntityId: event.sourceEntityId,
            sourceVersion: event.sourceVersion ?? null,
            occurredAt: new Date(event.occurredAt),
            receivedAt,
            correlationId: event.correlationId,
            causationId: event.causationId ?? null,
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
            payloadSha256,
            status,
            attemptCount: 0,
            availableAt: receivedAt,
            lockedAt: null,
            lockedBy: null,
            prerequisiteType: missingPrerequisite ? options.prerequisite?.type : null,
            prerequisiteKey: missingPrerequisite ? options.prerequisite?.key : null,
            processedAt: terminal ? receivedAt : null,
            lastError: stale
              ? "stale source version"
              : missingPrerequisite
                ? `missing prerequisite order:${options.prerequisite?.key}`
                : null,
            createdAt: receivedAt,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted[0]) {
          return { duplicate: false, status, stale, message: inserted[0] };
        }

        const existing = await transaction
          .select()
          .from(inboxMessages)
          .where(
            and(
              eq(inboxMessages.tenantId, scoped.tenantId),
              or(
                and(
                  eq(inboxMessages.sourceSystem, event.sourceSystem),
                  eq(inboxMessages.messageId, event.messageId),
                ),
                eq(inboxMessages.idempotencyKey, event.idempotencyKey),
              ),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new Error("inbox conflict did not return the existing message");
        return {
          duplicate: true,
          status:
            existing[0].status === "parked"
              ? "parked"
              : existing[0].status === "ignored"
                ? "ignored"
                : "received",
          stale: existing[0].status === "ignored",
          message: existing[0],
        };
      });
    },

    async claimNext(
      context: TenantContext,
      workerId: string,
      now: Date,
    ): Promise<InboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(inboxMessages)
          .where(
            and(
              eq(inboxMessages.tenantId, scoped.tenantId),
              eq(inboxMessages.status, "received"),
              lte(inboxMessages.availableAt, now),
            ),
          )
          .orderBy(asc(inboxMessages.availableAt), asc(inboxMessages.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        const candidate = rows[0];
        if (!candidate) return null;
        const updated = await transaction
          .update(inboxMessages)
          .set({
            status: "processing",
            lockedAt: now,
            lockedBy: workerId,
            attemptCount: candidate.attemptCount + 1,
          })
          .where(
            and(
              eq(inboxMessages.id, candidate.id),
              eq(inboxMessages.tenantId, scoped.tenantId),
              eq(inboxMessages.status, "received"),
            ),
          )
          .returning();
        return updated[0] ?? null;
      });
    },

    async recordOutcome(
      context: TenantContext,
      messageId: string,
      workerId: string,
      outcome: InboxOutcome,
    ): Promise<InboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      const now = new Date();
      const updated = await db
        .update(inboxMessages)
        .set({
          status: outcome.status,
          availableAt: outcome.status === "parked" ? outcome.availableAt : now,
          lockedAt: null,
          lockedBy: null,
          processedAt: outcome.status === "processed" || outcome.status === "ignored" ? now : null,
          prerequisiteType: outcome.status === "parked" ? outcome.prerequisite.type : null,
          prerequisiteKey: outcome.status === "parked" ? outcome.prerequisite.key : null,
          lastError: "error" in outcome ? outcome.error : null,
        })
        .where(
          and(
            eq(inboxMessages.id, messageId),
            eq(inboxMessages.tenantId, scoped.tenantId),
            eq(inboxMessages.status, "processing"),
            eq(inboxMessages.lockedBy, workerId),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async recordFailure(
      context: TenantContext,
      messageId: string,
      workerId: string,
      failure: InboxFailure,
    ): Promise<InboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      const current = await db
        .select({ attemptCount: inboxMessages.attemptCount })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.id, messageId),
            eq(inboxMessages.tenantId, scoped.tenantId),
            eq(inboxMessages.status, "processing"),
            eq(inboxMessages.lockedBy, workerId),
          ),
        )
        .limit(1);
      if (!current[0]) return null;
      const deadLetter = current[0].attemptCount >= failure.maxAttempts;
      const updated = await db
        .update(inboxMessages)
        .set({
          status: deadLetter ? "dead_letter" : "received",
          availableAt: failure.retryAt,
          lockedAt: null,
          lockedBy: null,
          lastError: failure.error,
        })
        .where(
          and(
            eq(inboxMessages.id, messageId),
            eq(inboxMessages.tenantId, scoped.tenantId),
            eq(inboxMessages.status, "processing"),
            eq(inboxMessages.lockedBy, workerId),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async listParked(context: TenantContext): Promise<InboxClaim[]> {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select()
        .from(inboxMessages)
        .where(and(eq(inboxMessages.tenantId, scoped.tenantId), eq(inboxMessages.status, "parked")))
        .orderBy(asc(inboxMessages.createdAt));
    },
  };
}

export type OutboxAppendResult = {
  duplicate: boolean;
  message: typeof outboxMessages.$inferSelect;
};

export type OutboxWriter = {
  append(message: OutboundMessage): Promise<OutboxAppendResult>;
};

export type OutboxFailure = {
  error: string;
  retryAt: Date;
  maxAttempts: number;
};

export type OutboxClaim = typeof outboxMessages.$inferSelect;

export type OutboxDeliveryReceipt = typeof outboxDeliveryReceipts.$inferSelect;

async function assertTenantExists(transaction: Transaction, tenantId: string): Promise<void> {
  const rows = await transaction
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (rows.length === 0) throw new Error("tenant does not exist");
}

function createOutboxWriter(
  transaction: Transaction,
  context: TenantContext,
  transactionNow: Date,
): OutboxWriter {
  return {
    async append(message: OutboundMessage): Promise<OutboxAppendResult> {
      if (message.tenantId !== context.tenantId) {
        throw new Error("outbox message tenant does not match transaction tenant");
      }
      if (message.messageVersion < 1) {
        throw new Error("outbox messageVersion must be positive");
      }
      const createdAt = transactionNow;
      const inserted = await transaction
        .insert(outboxMessages)
        .values({
          id: randomUUID(),
          tenantId: context.tenantId,
          destination: message.destination,
          messageType: message.messageType,
          messageVersion: message.messageVersion,
          payload: message.payload,
          idempotencyKey: message.idempotencyKey,
          correlationId: message.correlationId,
          causationId: message.causationId ?? null,
          status: "pending",
          availableAt: message.availableAt ? new Date(message.availableAt) : createdAt,
          lockedAt: null,
          lockedBy: null,
          attemptCount: 0,
          lastError: null,
          sentAt: null,
          createdAt,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted[0]) return { duplicate: false, message: inserted[0] };

      const existing = await transaction
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.tenantId, context.tenantId),
            eq(outboxMessages.destination, message.destination),
            eq(outboxMessages.idempotencyKey, message.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing[0]) throw new Error("outbox conflict did not return the existing message");
      return { duplicate: true, message: existing[0] };
    },
  };
}

export function createOutboxRepository(db: Database) {
  return {
    async inTransaction<T>(
      context: TenantContext,
      operation: (transaction: Transaction, outbox: OutboxWriter) => Promise<T>,
      now = new Date(),
    ): Promise<T> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        await assertTenantExists(transaction, scoped.tenantId);
        return operation(transaction, createOutboxWriter(transaction, scoped, now));
      });
    },

    async claimNext(
      context: TenantContext,
      workerId: string,
      now: Date,
      leaseDurationMs: number,
    ): Promise<OutboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      if (leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");
      return db.transaction(async (transaction) => {
        const staleLeaseAt = new Date(now.getTime() - leaseDurationMs);
        const rows = await transaction
          .select()
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.tenantId, scoped.tenantId),
              or(
                and(
                  inArray(outboxMessages.status, ["pending", "retry_wait"]),
                  lte(outboxMessages.availableAt, now),
                ),
                and(
                  eq(outboxMessages.status, "dispatching"),
                  isNotNull(outboxMessages.lockedAt),
                  lt(outboxMessages.lockedAt, staleLeaseAt),
                ),
              ),
            ),
          )
          .orderBy(asc(outboxMessages.availableAt), asc(outboxMessages.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        const candidate = rows[0];
        if (!candidate) return null;
        const updated = await transaction
          .update(outboxMessages)
          .set({
            status: "dispatching",
            lockedAt: now,
            lockedBy: workerId,
            attemptCount: candidate.attemptCount + 1,
          })
          .where(
            and(
              eq(outboxMessages.id, candidate.id),
              eq(outboxMessages.tenantId, scoped.tenantId),
              eq(outboxMessages.status, candidate.status),
            ),
          )
          .returning();
        return updated[0] ?? null;
      });
    },

    async recordSent(
      context: TenantContext,
      messageId: string,
      workerId: string,
      sentAt = new Date(),
    ): Promise<OutboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      const updated = await db
        .update(outboxMessages)
        .set({
          status: "sent",
          sentAt,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        })
        .where(
          and(
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.tenantId, scoped.tenantId),
            eq(outboxMessages.status, "dispatching"),
            eq(outboxMessages.lockedBy, workerId),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async recordReceipt(
      context: TenantContext,
      messageId: string,
      workerId: string,
      receipt: OutboundDeliveryReceipt,
      createdAt = new Date(),
    ): Promise<OutboxDeliveryReceipt | null> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.id, messageId),
              eq(outboxMessages.tenantId, scoped.tenantId),
              eq(outboxMessages.status, "dispatching"),
              eq(outboxMessages.lockedBy, workerId),
            ),
          )
          .limit(1);
        const message = rows[0];
        if (!message || message.idempotencyKey !== receipt.idempotencyKey) return null;
        const inserted = await transaction
          .insert(outboxDeliveryReceipts)
          .values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            outboxId: message.id,
            attemptCount: message.attemptCount,
            remoteReceiptId: receipt.remoteReceiptId,
            idempotencyKey: receipt.idempotencyKey,
            correlationId: receipt.correlationId,
            causationId: receipt.causationId ?? null,
            acceptedAt: new Date(receipt.acceptedAt),
            duplicate: receipt.duplicate,
            createdAt,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) return inserted[0];
        const existing = await transaction
          .select()
          .from(outboxDeliveryReceipts)
          .where(
            and(
              eq(outboxDeliveryReceipts.tenantId, scoped.tenantId),
              eq(outboxDeliveryReceipts.outboxId, message.id),
              eq(outboxDeliveryReceipts.attemptCount, message.attemptCount),
            ),
          )
          .limit(1);
        return existing[0] ?? null;
      });
    },

    async recordFailure(
      context: TenantContext,
      messageId: string,
      workerId: string,
      failure: OutboxFailure,
    ): Promise<OutboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      const current = await db
        .select({ attemptCount: outboxMessages.attemptCount })
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.tenantId, scoped.tenantId),
            eq(outboxMessages.status, "dispatching"),
            eq(outboxMessages.lockedBy, workerId),
          ),
        )
        .limit(1);
      if (!current[0]) return null;
      const deadLetter = current[0].attemptCount >= failure.maxAttempts;
      const updated = await db
        .update(outboxMessages)
        .set({
          status: deadLetter ? "dead_letter" : "retry_wait",
          availableAt: failure.retryAt,
          lockedAt: null,
          lockedBy: null,
          lastError: failure.error,
        })
        .where(
          and(
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.tenantId, scoped.tenantId),
            eq(outboxMessages.status, "dispatching"),
            eq(outboxMessages.lockedBy, workerId),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async retryDeadLetter(
      context: TenantContext,
      messageId: string,
      reason: string,
      availableAt = new Date(),
    ): Promise<OutboxClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      if (reason.trim().length === 0) throw new Error("manual retry reason is required");
      const updated = await db
        .update(outboxMessages)
        .set({
          status: "pending",
          availableAt,
          lockedAt: null,
          lockedBy: null,
          lastError: `manual retry: ${reason.trim()}`,
        })
        .where(
          and(
            eq(outboxMessages.id, messageId),
            eq(outboxMessages.tenantId, scoped.tenantId),
            eq(outboxMessages.status, "dead_letter"),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },
  };
}
