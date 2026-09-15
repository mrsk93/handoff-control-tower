import { and, asc, eq, isNull, lte, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { syncOperations, syncAttempts, tenants } from "./schema";
import type { Database } from "./client";
import { requireTenantContext, type TenantContext } from "./tenant-context";

export type SyncOperation = typeof syncOperations.$inferSelect;
export type SyncAttempt = typeof syncAttempts.$inferSelect;

export type SyncOperationInput = {
  id?: string;
  connectionId?: string;
  workflowType: string;
  aggregateType: string;
  aggregateId: string;
  direction: string;
  idempotencyKey: string;
  commandHash: string;
  createdAt?: Date;
};

export type SyncOperationCreateResult = {
  duplicate: boolean;
  operation: SyncOperation;
};

export type SyncOperationClaim = SyncOperation & {
  leaseToken: string;
};

export type SyncOperationFailure = {
  errorCode: string;
  errorMessage: string;
  retryAt?: Date;
  retryable?: boolean;
};

export class SyncOperationConflictError extends Error {
  readonly code = "SYNC_OPERATION_CONFLICT";

  constructor(
    readonly idempotencyKey: string,
    readonly existingCommandHash: string | null,
    readonly incomingCommandHash: string,
  ) {
    super("operation idempotency key was already used for a different command");
    this.name = "SyncOperationConflictError";
  }
}

export class SyncOperationLeaseLostError extends Error {
  readonly code = "SYNC_OPERATION_LEASE_LOST";

  constructor() {
    super("sync operation lease is no longer owned by this worker");
    this.name = "SyncOperationLeaseLostError";
  }
}

const unknownRemoteCode = "REMOTE_RESULT_UNKNOWN";

function ensureNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} is required`);
  return normalized;
}

export function createSyncOperationRepository(db: Database) {
  return {
    async createOrGet(
      context: TenantContext,
      input: SyncOperationInput,
      now = new Date(),
    ): Promise<SyncOperationCreateResult> {
      const scoped = requireTenantContext(context.tenantId);
      const commandHash = ensureNonEmpty(input.commandHash, "commandHash");
      const idempotencyKey = ensureNonEmpty(input.idempotencyKey, "idempotencyKey");
      return db.transaction(async (transaction) => {
        const tenant = await transaction
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, scoped.tenantId))
          .limit(1);
        if (!tenant[0]) throw new Error("tenant does not exist");
        const inserted = await transaction
          .insert(syncOperations)
          .values({
            id: input.id ?? randomUUID(),
            tenantId: scoped.tenantId,
            connectionId: input.connectionId ?? null,
            workflowType: ensureNonEmpty(input.workflowType, "workflowType"),
            aggregateType: ensureNonEmpty(input.aggregateType, "aggregateType"),
            aggregateId: ensureNonEmpty(input.aggregateId, "aggregateId"),
            direction: ensureNonEmpty(input.direction, "direction"),
            idempotencyKey,
            commandHash,
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            startedAt: null,
            completedAt: null,
            result: null,
            remoteId: null,
            lockedAt: null,
            lockedBy: null,
            leaseToken: null,
            createdAt: input.createdAt ?? now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) return { duplicate: false, operation: inserted[0] };

        const existing = await transaction
          .select()
          .from(syncOperations)
          .where(
            and(
              eq(syncOperations.tenantId, scoped.tenantId),
              eq(syncOperations.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (!existing[0]) throw new Error("operation conflict did not return the existing row");
        if (existing[0].commandHash !== commandHash) {
          throw new SyncOperationConflictError(
            idempotencyKey,
            existing[0].commandHash,
            commandHash,
          );
        }
        return { duplicate: true, operation: existing[0] };
      });
    },

    async findById(context: TenantContext, operationId: string): Promise<SyncOperation | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select()
        .from(syncOperations)
        .where(
          and(eq(syncOperations.tenantId, scoped.tenantId), eq(syncOperations.id, operationId)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async claimNext(
      context: TenantContext,
      workerId: string,
      now: Date,
      leaseDurationMs: number,
    ): Promise<SyncOperationClaim | null> {
      const scoped = requireTenantContext(context.tenantId);
      const normalizedWorkerId = ensureNonEmpty(workerId, "workerId");
      if (leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");
      return db.transaction(async (transaction) => {
        const staleLeaseAt = new Date(now.getTime() - leaseDurationMs);
        const rows = await transaction
          .select()
          .from(syncOperations)
          .where(
            and(
              eq(syncOperations.tenantId, scoped.tenantId),
              or(
                and(
                  eq(syncOperations.status, "pending"),
                  or(isNull(syncOperations.nextAttemptAt), lte(syncOperations.nextAttemptAt, now)),
                ),
                and(
                  eq(syncOperations.status, "retrying"),
                  or(isNull(syncOperations.nextAttemptAt), lte(syncOperations.nextAttemptAt, now)),
                ),
                and(
                  eq(syncOperations.status, "running"),
                  isNull(syncOperations.leaseToken),
                  lt(syncOperations.lockedAt, staleLeaseAt),
                ),
                and(
                  eq(syncOperations.status, "running"),
                  lt(syncOperations.lockedAt, staleLeaseAt),
                ),
              ),
            ),
          )
          .orderBy(asc(syncOperations.nextAttemptAt), asc(syncOperations.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        const candidate = rows[0];
        if (!candidate) return null;
        const leaseToken = randomUUID();
        const updated = await transaction
          .update(syncOperations)
          .set({
            status: "running",
            attemptCount: candidate.attemptCount + 1,
            nextAttemptAt: null,
            startedAt: now,
            completedAt: null,
            lockedAt: now,
            lockedBy: normalizedWorkerId,
            leaseToken,
            updatedAt: now,
          })
          .where(
            and(
              eq(syncOperations.id, candidate.id),
              eq(syncOperations.tenantId, scoped.tenantId),
              eq(syncOperations.status, candidate.status),
            ),
          )
          .returning();
        const operation = updated[0];
        if (!operation || operation.leaseToken === null) return null;
        return operation as SyncOperationClaim;
      });
    },

    async recordSuccess(
      context: TenantContext,
      operationId: string,
      workerId: string,
      leaseToken: string,
      input: { result?: unknown; remoteId?: string },
      now = new Date(),
    ): Promise<SyncOperation | null> {
      const scoped = requireTenantContext(context.tenantId);
      const updated = await db
        .update(syncOperations)
        .set({
          status: "succeeded",
          completedAt: now,
          updatedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          result: input.result ?? null,
          remoteId: input.remoteId ?? null,
          lockedAt: null,
          lockedBy: null,
          leaseToken: null,
        })
        .where(
          and(
            eq(syncOperations.id, operationId),
            eq(syncOperations.tenantId, scoped.tenantId),
            eq(syncOperations.status, "running"),
            eq(syncOperations.lockedBy, workerId),
            eq(syncOperations.leaseToken, leaseToken),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async recordFailure(
      context: TenantContext,
      operationId: string,
      workerId: string,
      leaseToken: string,
      failure: SyncOperationFailure,
      now = new Date(),
    ): Promise<SyncOperation | null> {
      const scoped = requireTenantContext(context.tenantId);
      const retryable = failure.retryable ?? true;
      const updated = await db
        .update(syncOperations)
        .set({
          status: retryable ? "retrying" : "failed",
          nextAttemptAt: retryable ? (failure.retryAt ?? now) : null,
          lastErrorCode: ensureNonEmpty(failure.errorCode, "errorCode"),
          lastErrorMessage: ensureNonEmpty(failure.errorMessage, "errorMessage"),
          updatedAt: now,
          lockedAt: null,
          lockedBy: null,
          leaseToken: null,
        })
        .where(
          and(
            eq(syncOperations.id, operationId),
            eq(syncOperations.tenantId, scoped.tenantId),
            eq(syncOperations.status, "running"),
            eq(syncOperations.lockedBy, workerId),
            eq(syncOperations.leaseToken, leaseToken),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async recordUnknown(
      context: TenantContext,
      operationId: string,
      workerId: string,
      leaseToken: string,
      message: string,
      now = new Date(),
    ): Promise<SyncOperation | null> {
      return this.recordFailure(
        context,
        operationId,
        workerId,
        leaseToken,
        {
          errorCode: unknownRemoteCode,
          errorMessage: message,
          retryable: false,
        },
        now,
      );
    },

    async resolveUnknown(
      context: TenantContext,
      operationId: string,
      input: { result?: unknown; remoteId: string },
      now = new Date(),
    ): Promise<SyncOperation | null> {
      const scoped = requireTenantContext(context.tenantId);
      const updated = await db
        .update(syncOperations)
        .set({
          status: "succeeded",
          completedAt: now,
          updatedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          result: input.result ?? null,
          remoteId: ensureNonEmpty(input.remoteId, "remoteId"),
        })
        .where(
          and(
            eq(syncOperations.id, operationId),
            eq(syncOperations.tenantId, scoped.tenantId),
            eq(syncOperations.status, "failed"),
            eq(syncOperations.lastErrorCode, unknownRemoteCode),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async requeueAfterConfirmedAbsence(
      context: TenantContext,
      operationId: string,
      reason: string,
      nextAttemptAt = new Date(),
    ): Promise<SyncOperation | null> {
      const scoped = requireTenantContext(context.tenantId);
      const updated = await db
        .update(syncOperations)
        .set({
          status: "retrying",
          nextAttemptAt,
          lastErrorCode: "REMOTE_LOOKUP_ABSENT",
          lastErrorMessage: ensureNonEmpty(reason, "reason"),
          updatedAt: nextAttemptAt,
        })
        .where(
          and(
            eq(syncOperations.id, operationId),
            eq(syncOperations.tenantId, scoped.tenantId),
            eq(syncOperations.status, "failed"),
            eq(syncOperations.lastErrorCode, unknownRemoteCode),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },

    async recordAttempt(
      context: TenantContext,
      operationId: string,
      attempt: Omit<typeof syncAttempts.$inferInsert, "id" | "tenantId" | "operationId">,
    ): Promise<SyncAttempt> {
      const scoped = requireTenantContext(context.tenantId);
      const inserted = await db
        .insert(syncAttempts)
        .values({ id: randomUUID(), tenantId: scoped.tenantId, operationId, ...attempt })
        .returning();
      if (!inserted[0]) throw new Error("sync attempt was not persisted");
      return inserted[0];
    },
  };
}

export type SyncOperationRepository = ReturnType<typeof createSyncOperationRepository>;
