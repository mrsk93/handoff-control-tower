import { and, asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ReconciliationFinding, ReconciliationPair } from "@handoff/domain";
import type { Database } from "./client";
import {
  reconciliationFindings,
  reconciliationLeases,
  reconciliationRuns,
  reconciliationWatermarks,
} from "./schema";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import type { Transaction } from "./transaction";

export class ReconciliationLeaseBusyError extends Error {
  readonly code = "RECONCILIATION_LEASE_BUSY" as const;

  constructor(
    readonly tenantId: string,
    readonly systemPair: string,
    readonly resourceType: string,
  ) {
    super(`reconciliation lease is held for ${systemPair}/${resourceType}`);
    this.name = "ReconciliationLeaseBusyError";
  }
}

export type ReconciliationRunRow = typeof reconciliationRuns.$inferSelect;
export type ReconciliationFindingRow = typeof reconciliationFindings.$inferSelect;

export type ReconciliationStart = {
  pair: ReconciliationPair;
  resourceType: string;
  windowEnd: Date;
  overlapMs: number;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
};

export type ReconciliationStartResult = {
  run: ReconciliationRunRow;
  windowStart: Date;
  windowEnd: Date;
  watermark: Date | null;
};

export type ReconciliationPageCounts = {
  detected?: number;
  repaired?: number;
  manual?: number;
  ignored?: number;
};

function mergeCounts(current: unknown, next: ReconciliationPageCounts): ReconciliationPageCounts {
  const existing =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const output: ReconciliationPageCounts = {};
  for (const key of ["detected", "repaired", "manual", "ignored"] as const) {
    const before = typeof existing[key] === "number" ? existing[key] : 0;
    const increment = next[key] ?? 0;
    output[key] = before + increment;
  }
  return output;
}

async function assertLease(
  transaction: Transaction,
  input: { tenantId: string; runId: string; leaseOwner: string; now: Date },
): Promise<ReconciliationRunRow> {
  const rows = await transaction
    .select()
    .from(reconciliationRuns)
    .where(
      and(
        eq(reconciliationRuns.tenantId, input.tenantId),
        eq(reconciliationRuns.id, input.runId),
        eq(reconciliationRuns.status, "running"),
      ),
    )
    .limit(1);
  const run = rows[0];
  if (!run) throw new Error("reconciliation run is not active");
  const leases = await transaction
    .select()
    .from(reconciliationLeases)
    .where(
      and(
        eq(reconciliationLeases.tenantId, input.tenantId),
        eq(reconciliationLeases.systemPair, run.systemPair),
        eq(reconciliationLeases.resourceType, run.resourceType),
      ),
    )
    .limit(1);
  const lease = leases[0];
  if (!lease || lease.lockedBy !== input.leaseOwner || lease.lockedUntil < input.now) {
    throw new Error("reconciliation lease is not owned by this run");
  }
  return run;
}

export function createReconciliationRepository(db: Database) {
  return {
    async start(
      context: TenantContext,
      input: ReconciliationStart,
    ): Promise<ReconciliationStartResult> {
      const scoped = requireTenantContext(context.tenantId);
      if (input.overlapMs < 0 || input.leaseDurationMs <= 0) {
        throw new Error("reconciliation overlap and lease duration are invalid");
      }
      if (input.windowEnd < input.now)
        throw new Error("reconciliation window end cannot be in the past");
      return db.transaction(async (transaction) => {
        const existingLease = await transaction
          .select()
          .from(reconciliationLeases)
          .where(
            and(
              eq(reconciliationLeases.tenantId, scoped.tenantId),
              eq(reconciliationLeases.systemPair, input.pair),
              eq(reconciliationLeases.resourceType, input.resourceType),
            ),
          )
          .limit(1)
          .for("update");
        const lease = existingLease[0];
        if (lease && lease.lockedUntil > input.now && lease.lockedBy !== input.leaseOwner) {
          throw new ReconciliationLeaseBusyError(scoped.tenantId, input.pair, input.resourceType);
        }
        const watermarkRows = await transaction
          .select()
          .from(reconciliationWatermarks)
          .where(
            and(
              eq(reconciliationWatermarks.tenantId, scoped.tenantId),
              eq(reconciliationWatermarks.systemPair, input.pair),
              eq(reconciliationWatermarks.resourceType, input.resourceType),
            ),
          )
          .limit(1);
        const watermark = watermarkRows[0]?.lastWindowEnd ?? null;
        const watermarkBase = watermark
          ? watermark.getTime()
          : input.now.getTime() - 24 * 60 * 60 * 1000;
        const proposedStart = new Date(watermarkBase - input.overlapMs);
        const leaseValues = {
          tenantId: scoped.tenantId,
          systemPair: input.pair,
          resourceType: input.resourceType,
          lockedBy: input.leaseOwner,
          lockedUntil: new Date(input.now.getTime() + input.leaseDurationMs),
          updatedAt: input.now,
        };
        await transaction
          .insert(reconciliationLeases)
          .values(leaseValues)
          .onConflictDoUpdate({
            target: [
              reconciliationLeases.tenantId,
              reconciliationLeases.systemPair,
              reconciliationLeases.resourceType,
            ],
            set: {
              lockedBy: leaseValues.lockedBy,
              lockedUntil: leaseValues.lockedUntil,
              updatedAt: leaseValues.updatedAt,
            },
          });
        const inserted = await transaction
          .insert(reconciliationRuns)
          .values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            systemPair: input.pair,
            resourceType: input.resourceType,
            windowStart: proposedStart,
            windowEnd: input.windowEnd,
            status: "running",
            pageCursor: null,
            counts: { detected: 0, repaired: 0, manual: 0, ignored: 0 },
            createdAt: input.now,
            completedAt: null,
          })
          .returning();
        const run = inserted[0];
        if (!run) throw new Error("reconciliation run was not created");
        return {
          run,
          windowStart: proposedStart,
          windowEnd: input.windowEnd,
          watermark,
        };
      });
    },

    async persistPage(
      context: TenantContext,
      runId: string,
      leaseOwner: string,
      pageCursor: string | null,
      findings: ReconciliationFinding[],
      counts: ReconciliationPageCounts,
      now: Date,
    ): Promise<ReconciliationFindingRow[]> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const run = await assertLease(transaction, {
          tenantId: scoped.tenantId,
          runId,
          leaseOwner,
          now,
        });
        const rows: ReconciliationFindingRow[] = [];
        for (const item of findings) {
          const inserted = await transaction
            .insert(reconciliationFindings)
            .values({
              id: randomUUID(),
              tenantId: scoped.tenantId,
              runId,
              category: item.category,
              resourceType: item.resourceType,
              resourceKey: item.resourceKey,
              sourceValues: item.sourceValues,
              recommendedAction: item.recommendedAction,
              repairStatus: item.autoRepairable ? "repairable" : "manual_required",
              evidence: item.evidence,
              createdAt: now,
            })
            .onConflictDoNothing()
            .returning();
          if (inserted[0]) rows.push(inserted[0]);
        }
        await transaction
          .update(reconciliationRuns)
          .set({
            pageCursor,
            counts: mergeCounts(run.counts, counts),
          })
          .where(
            and(eq(reconciliationRuns.id, runId), eq(reconciliationRuns.tenantId, scoped.tenantId)),
          );
        return rows;
      });
    },

    async markFindingRepaired(
      context: TenantContext,
      runId: string,
      findingId: string,
      status: "auto_repaired" | "manual_required" | "ignored",
    ): Promise<ReconciliationFindingRow | null> {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .update(reconciliationFindings)
        .set({ repairStatus: status })
        .where(
          and(
            eq(reconciliationFindings.tenantId, scoped.tenantId),
            eq(reconciliationFindings.runId, runId),
            eq(reconciliationFindings.id, findingId),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async complete(
      context: TenantContext,
      runId: string,
      leaseOwner: string,
      now: Date,
    ): Promise<ReconciliationRunRow | null> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const run = await assertLease(transaction, {
          tenantId: scoped.tenantId,
          runId,
          leaseOwner,
          now,
        });
        const completed = await transaction
          .update(reconciliationRuns)
          .set({ status: "completed", completedAt: now, pageCursor: null })
          .where(
            and(
              eq(reconciliationRuns.id, run.id),
              eq(reconciliationRuns.tenantId, scoped.tenantId),
            ),
          )
          .returning();
        await transaction
          .update(reconciliationWatermarks)
          .set({ lastWindowEnd: run.windowEnd, updatedAt: now })
          .where(
            and(
              eq(reconciliationWatermarks.tenantId, scoped.tenantId),
              eq(reconciliationWatermarks.systemPair, run.systemPair),
              eq(reconciliationWatermarks.resourceType, run.resourceType),
            ),
          );
        if (run.systemPair && run.resourceType) {
          await transaction
            .insert(reconciliationWatermarks)
            .values({
              tenantId: scoped.tenantId,
              systemPair: run.systemPair,
              resourceType: run.resourceType,
              lastWindowEnd: run.windowEnd,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
        await transaction
          .delete(reconciliationLeases)
          .where(
            and(
              eq(reconciliationLeases.tenantId, scoped.tenantId),
              eq(reconciliationLeases.systemPair, run.systemPair),
              eq(reconciliationLeases.resourceType, run.resourceType),
              eq(reconciliationLeases.lockedBy, leaseOwner),
            ),
          );
        return completed[0] ?? null;
      });
    },

    async fail(
      context: TenantContext,
      runId: string,
      leaseOwner: string,
      error: string,
      now: Date,
    ): Promise<void> {
      const scoped = requireTenantContext(context.tenantId);
      await db.transaction(async (transaction) => {
        const run = await assertLease(transaction, {
          tenantId: scoped.tenantId,
          runId,
          leaseOwner,
          now,
        });
        await transaction
          .update(reconciliationRuns)
          .set({ status: "failed", counts: { error } })
          .where(
            and(
              eq(reconciliationRuns.id, run.id),
              eq(reconciliationRuns.tenantId, scoped.tenantId),
            ),
          );
        await transaction
          .delete(reconciliationLeases)
          .where(
            and(
              eq(reconciliationLeases.tenantId, scoped.tenantId),
              eq(reconciliationLeases.systemPair, run.systemPair),
              eq(reconciliationLeases.resourceType, run.resourceType),
              eq(reconciliationLeases.lockedBy, leaseOwner),
            ),
          );
      });
    },

    async listRuns(context: TenantContext, limit = 50): Promise<ReconciliationRunRow[]> {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.tenantId, scoped.tenantId))
        .orderBy(desc(reconciliationRuns.createdAt))
        .limit(Math.min(100, Math.max(1, limit)));
    },

    async getRun(
      context: TenantContext,
      runId: string,
    ): Promise<{ run: ReconciliationRunRow; findings: ReconciliationFindingRow[] } | null> {
      const scoped = requireTenantContext(context.tenantId);
      const runs = await db
        .select()
        .from(reconciliationRuns)
        .where(
          and(eq(reconciliationRuns.tenantId, scoped.tenantId), eq(reconciliationRuns.id, runId)),
        )
        .limit(1);
      const run = runs[0];
      if (!run) return null;
      const findings = await db
        .select()
        .from(reconciliationFindings)
        .where(
          and(
            eq(reconciliationFindings.tenantId, scoped.tenantId),
            eq(reconciliationFindings.runId, runId),
          ),
        )
        .orderBy(asc(reconciliationFindings.createdAt));
      return { run, findings };
    },
  };
}

export type ReconciliationRepository = ReturnType<typeof createReconciliationRepository>;
