import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  evaluateInvoiceEligibility,
  type CanonicalOrder,
  type FulfillmentActual,
} from "@handoff/domain";
import type { Database } from "./client";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import {
  auditEvents,
  exceptionCommands,
  exceptionNotes,
  exceptions,
  fulfillmentLines,
  fulfillments,
  orderLines,
  orders,
  outboxMessages,
  processInstances,
  reconciliationFindings,
  reconciliationRuns,
  shipmentLines,
  shipments,
} from "./schema";

export type OperatorOrderFilters = {
  cursor?: string;
  limit?: number;
  stage?: string;
  eligible?: boolean;
  query?: string;
};

export type OperatorExceptionFilters = {
  status?: "open" | "resolved" | "dismissed";
  severity?: "low" | "medium" | "high" | "critical";
  type?: string;
  limit?: number;
};

function offset(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error("cursor must be a non-negative integer");
  return parsed;
}

function boundedLimit(value: number | undefined): number {
  return Math.min(100, Math.max(1, value ?? 50));
}

function orderFromRows(
  row: typeof orders.$inferSelect,
  lines: Array<typeof orderLines.$inferSelect>,
): CanonicalOrder {
  const order: CanonicalOrder = {
    tenantId: row.tenantId,
    orderId: row.id,
    source: "commerce",
    sourceOrderId: row.sourceOrderId,
    sourceVersion: row.sourceVersion,
    orderNumber: row.orderNumber,
    currency: row.currency,
    acceptedAt: row.acceptedAt.toISOString(),
    releaseStatus: row.releaseStatus as CanonicalOrder["releaseStatus"],
    lines: lines.map((line) => ({
      lineId: `${row.sourceOrderId}:${line.sourceLineId}`,
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      orderedQty: line.orderedQty,
      cancelledQty: line.cancelledQty,
    })),
  };
  if (row.cancelledAt) order.cancelledAt = row.cancelledAt.toISOString();
  return order;
}

export function createOperatorRepository(db: Database) {
  async function findOrderRow(context: TenantContext, orderId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, orderId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function orderDetail(context: TenantContext, orderId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const orderRow = await findOrderRow(context, orderId);
    if (!orderRow) return null;
    const [lineRows, fulfillmentRows, shipmentRows, processRows, exceptionRows, auditRows] =
      await Promise.all([
        db
          .select()
          .from(orderLines)
          .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, orderId))),
        db
          .select()
          .from(fulfillments)
          .where(
            and(eq(fulfillments.tenantId, scoped.tenantId), eq(fulfillments.orderId, orderId)),
          ),
        db
          .select()
          .from(shipments)
          .where(and(eq(shipments.tenantId, scoped.tenantId), eq(shipments.orderId, orderId))),
        db
          .select()
          .from(processInstances)
          .where(
            and(
              eq(processInstances.tenantId, scoped.tenantId),
              eq(processInstances.orderId, orderId),
            ),
          ),
        db
          .select()
          .from(exceptions)
          .where(and(eq(exceptions.tenantId, scoped.tenantId), eq(exceptions.orderId, orderId))),
        db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, scoped.tenantId), eq(auditEvents.entityId, orderId))),
      ]);
    const fulfillmentRow = fulfillmentRows[0] ?? null;
    const fulfillment = fulfillmentRow
      ? {
          id: fulfillmentRow.id,
          status: fulfillmentRow.status,
          version: Number(fulfillmentRow.sourceVersion ?? fulfillmentRow.rowVersion),
          lines: await db
            .select()
            .from(fulfillmentLines)
            .where(
              and(
                eq(fulfillmentLines.tenantId, scoped.tenantId),
                eq(fulfillmentLines.fulfillmentId, fulfillmentRow.id),
              ),
            ),
        }
      : null;
    const detailShipments = await Promise.all(
      shipmentRows.map(async (shipment) => ({
        ...shipment,
        lines: await db
          .select()
          .from(shipmentLines)
          .where(
            and(
              eq(shipmentLines.tenantId, scoped.tenantId),
              eq(shipmentLines.shipmentId, shipment.id),
            ),
          ),
      })),
    );
    const process = processRows[0] ?? null;
    const blockingExceptions = exceptionRows.filter(
      (exception) =>
        exception.status === "open" && ["high", "critical"].includes(exception.severity),
    );
    const reasons = blockingExceptions.map((exception) => ({
      code: exception.type,
      blocking: true,
      evidenceRefs: [exception.id],
    }));
    if (process && !process.invoiceEligible && reasons.length === 0) {
      reasons.push({
        code: "POLICY_RECOMPUTE_REQUIRED",
        blocking: true,
        evidenceRefs: [process.id],
      });
    }
    return {
      order: {
        id: orderRow.id,
        number: orderRow.orderNumber,
        sourceOrderId: orderRow.sourceOrderId,
        releaseStatus: orderRow.releaseStatus,
        currency: orderRow.currency,
      },
      lines: lineRows,
      fulfillment,
      shipments: detailShipments,
      invoiceEligibility: {
        eligible: process?.invoiceEligible ?? false,
        scope: process?.invoiceEligible ? "full_order" : "none",
        reasons,
      },
      exceptions: exceptionRows,
      timeline: auditRows.sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      ),
      links: { correlationId: auditRows.at(-1)?.correlationId ?? null },
    };
  }

  return {
    async overview(context: TenantContext) {
      const scoped = requireTenantContext(context.tenantId);
      const [ordersCount, openExceptions, pendingOutbox, drift, eligible] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(eq(orders.tenantId, scoped.tenantId)),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(exceptions)
          .where(and(eq(exceptions.tenantId, scoped.tenantId), eq(exceptions.status, "open"))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.tenantId, scoped.tenantId),
              inArray(outboxMessages.status, ["pending", "retry_wait", "dead_letter"]),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(reconciliationFindings)
          .where(
            and(
              eq(reconciliationFindings.tenantId, scoped.tenantId),
              inArray(reconciliationFindings.repairStatus, ["repairable", "manual_required"]),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(processInstances)
          .where(
            and(
              eq(processInstances.tenantId, scoped.tenantId),
              eq(processInstances.invoiceEligible, true),
            ),
          ),
      ]);
      return {
        tenantId: scoped.tenantId,
        counts: {
          orders: ordersCount[0]?.count ?? 0,
          openExceptions: openExceptions[0]?.count ?? 0,
          pendingOutbox: pendingOutbox[0]?.count ?? 0,
          reconciliationDrift: drift[0]?.count ?? 0,
          invoiceEligible: eligible[0]?.count ?? 0,
        },
      };
    },

    async listOrders(context: TenantContext, filters: OperatorOrderFilters = {}) {
      const scoped = requireTenantContext(context.tenantId);
      const conditions = [eq(orders.tenantId, scoped.tenantId)];
      if (filters.stage) conditions.push(eq(orders.releaseStatus, filters.stage));
      if (filters.query) {
        const query = `%${filters.query.trim()}%`;
        conditions.push(
          sql`(${orders.orderNumber} ilike ${query} or ${orders.sourceOrderId} ilike ${query})`,
        );
      }
      if (filters.eligible !== undefined)
        conditions.push(eq(processInstances.invoiceEligible, filters.eligible));
      const limit = boundedLimit(filters.limit);
      const rows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          sourceOrderId: orders.sourceOrderId,
          releaseStatus: orders.releaseStatus,
          updatedAt: orders.updatedAt,
          fulfillmentStatus: fulfillments.status,
          invoiceEligible: processInstances.invoiceEligible,
          blockingExceptionCount: processInstances.blockingExceptionCount,
        })
        .from(orders)
        .leftJoin(
          fulfillments,
          and(eq(fulfillments.tenantId, orders.tenantId), eq(fulfillments.orderId, orders.id)),
        )
        .leftJoin(
          processInstances,
          and(
            eq(processInstances.tenantId, orders.tenantId),
            eq(processInstances.orderId, orders.id),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(orders.updatedAt), asc(orders.id))
        .limit(limit)
        .offset(offset(filters.cursor));
      return {
        items: rows,
        nextCursor: rows.length === limit ? String(offset(filters.cursor) + rows.length) : null,
      };
    },

    async getOrder(context: TenantContext, orderId: string) {
      return orderDetail(context, orderId);
    },

    async listExceptions(context: TenantContext, filters: OperatorExceptionFilters = {}) {
      const scoped = requireTenantContext(context.tenantId);
      const conditions = [eq(exceptions.tenantId, scoped.tenantId)];
      if (filters.status) conditions.push(eq(exceptions.status, filters.status));
      if (filters.severity) conditions.push(eq(exceptions.severity, filters.severity));
      if (filters.type) conditions.push(eq(exceptions.type, filters.type));
      const rows = await db
        .select({
          exception: exceptions,
          orderNumber: orders.orderNumber,
          sourceOrderId: orders.sourceOrderId,
        })
        .from(exceptions)
        .leftJoin(
          orders,
          and(eq(orders.tenantId, exceptions.tenantId), eq(orders.id, exceptions.orderId)),
        )
        .where(and(...conditions))
        .orderBy(asc(exceptions.status), desc(exceptions.createdAt))
        .limit(boundedLimit(filters.limit));
      return rows.map((row) => ({
        ...row.exception,
        orderNumber: row.orderNumber,
        sourceOrderId: row.sourceOrderId,
      }));
    },

    async getException(context: TenantContext, exceptionId: string) {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select()
        .from(exceptions)
        .where(and(eq(exceptions.tenantId, scoped.tenantId), eq(exceptions.id, exceptionId)))
        .limit(1);
      const exception = rows[0];
      if (!exception) return null;
      const [notes, commands, timeline] = await Promise.all([
        db
          .select()
          .from(exceptionNotes)
          .where(
            and(
              eq(exceptionNotes.tenantId, scoped.tenantId),
              eq(exceptionNotes.exceptionId, exceptionId),
            ),
          )
          .orderBy(asc(exceptionNotes.createdAt)),
        db
          .select()
          .from(exceptionCommands)
          .where(
            and(
              eq(exceptionCommands.tenantId, scoped.tenantId),
              eq(exceptionCommands.exceptionId, exceptionId),
            ),
          )
          .orderBy(asc(exceptionCommands.createdAt)),
        db
          .select()
          .from(auditEvents)
          .where(
            and(eq(auditEvents.tenantId, scoped.tenantId), eq(auditEvents.entityId, exceptionId)),
          )
          .orderBy(asc(auditEvents.createdAt)),
      ]);
      return { exception, notes, commands, timeline };
    },

    async getOutbox(context: TenantContext, messageId: string) {
      const scoped = requireTenantContext(context.tenantId);
      const rows = await db
        .select()
        .from(outboxMessages)
        .where(and(eq(outboxMessages.tenantId, scoped.tenantId), eq(outboxMessages.id, messageId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listReconciliationRuns(context: TenantContext, limit = 50) {
      const scoped = requireTenantContext(context.tenantId);
      return db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.tenantId, scoped.tenantId))
        .orderBy(desc(reconciliationRuns.createdAt))
        .limit(boundedLimit(limit));
    },

    async getReconciliationRun(context: TenantContext, runId: string) {
      const scoped = requireTenantContext(context.tenantId);
      const runRows = await db
        .select()
        .from(reconciliationRuns)
        .where(
          and(eq(reconciliationRuns.tenantId, scoped.tenantId), eq(reconciliationRuns.id, runId)),
        )
        .limit(1);
      const run = runRows[0];
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

    async recomputeEligibility(
      context: TenantContext,
      orderId: string,
      actorId: string,
      idempotencyKey: string,
      now: Date,
      allowPartial: boolean,
    ) {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const orderRows = await transaction
          .select()
          .from(orders)
          .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, orderId)))
          .limit(1);
        const orderRow = orderRows[0];
        if (!orderRow) return null;
        const lines = await transaction
          .select()
          .from(orderLines)
          .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, orderId)));
        const order = orderFromRows(orderRow, lines);
        const fulfillmentRows = await transaction
          .select()
          .from(fulfillments)
          .where(and(eq(fulfillments.tenantId, scoped.tenantId), eq(fulfillments.orderId, orderId)))
          .limit(1);
        const fulfillmentRow = fulfillmentRows[0];
        if (!fulfillmentRow) return null;
        const actualRows = await transaction
          .select()
          .from(fulfillmentLines)
          .where(
            and(
              eq(fulfillmentLines.tenantId, scoped.tenantId),
              eq(fulfillmentLines.fulfillmentId, fulfillmentRow.id),
            ),
          );
        const lineById = new Map(
          lines.map((line) => [line.id, `${order.sourceOrderId}:${line.sourceLineId}`]),
        );
        const fulfillment: FulfillmentActual = {
          tenantId: scoped.tenantId,
          orderId,
          ...(fulfillmentRow.warehouseOrderId === null
            ? {}
            : { warehouseOrderId: fulfillmentRow.warehouseOrderId }),
          status: fulfillmentRow.status as FulfillmentActual["status"],
          version: Number(fulfillmentRow.sourceVersion ?? fulfillmentRow.rowVersion),
          lines: actualRows.map((line) => ({
            lineId: lineById.get(line.orderLineId) ?? line.orderLineId,
            allocatedQty: line.allocatedQty,
            pickedQty: line.pickedQty,
            packedQty: line.packedQty,
            shippedQty: line.shippedQty,
            shortQty: line.shortQty,
            damagedQty: line.damagedQty,
          })),
        };
        const exceptionRows = await transaction
          .select()
          .from(exceptions)
          .where(and(eq(exceptions.tenantId, scoped.tenantId), eq(exceptions.orderId, orderId)));
        const shippedQtyByLine = Object.fromEntries(
          fulfillment.lines.map((line) => [line.lineId, line.shippedQty]),
        );
        const decision = evaluateInvoiceEligibility({
          order,
          fulfillment,
          commerceFulfillment: { status: "missing", shippedQtyByLine: {} },
          activeExceptions: exceptionRows
            .filter((exception) => exception.status === "open")
            .map((exception) => ({
              code: exception.type,
              severity: exception.severity as "low" | "medium" | "high" | "critical",
              resolved: false,
              evidenceRefs: [exception.id],
            })),
          partialShipmentEnabled: allowPartial,
          shortShipmentResolution: "unresolved",
          decisionVersion: 1,
          computedAt: now.toISOString(),
        });
        const processRows = await transaction
          .select()
          .from(processInstances)
          .where(
            and(
              eq(processInstances.tenantId, scoped.tenantId),
              eq(processInstances.orderId, orderId),
            ),
          )
          .limit(1);
        const processRow = processRows[0];
        if (!processRow) return null;
        await transaction
          .update(processInstances)
          .set({
            invoiceEligible: decision.eligible,
            currentStep: decision.eligible ? "invoice_eligible" : "invoice_blocked",
            decisionVersion: processRow.decisionVersion + 1,
            rowVersion: processRow.rowVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(processInstances.tenantId, scoped.tenantId),
              eq(processInstances.id, processRow.id),
            ),
          );
        if (decision.eligible) {
          await transaction
            .insert(outboxMessages)
            .values({
              id: randomUUID(),
              tenantId: scoped.tenantId,
              destination: "mock-billing",
              messageType: "billing.eligibility.v1",
              messageVersion: 1,
              payload: { orderId, decision },
              idempotencyKey: `billing-eligibility:${scoped.tenantId}:${orderId}:operator:${idempotencyKey}`,
              correlationId: idempotencyKey,
              causationId: null,
              status: "pending",
              availableAt: now,
              lockedAt: null,
              lockedBy: null,
              attemptCount: 0,
              lastError: null,
              sentAt: null,
              createdAt: now,
            })
            .onConflictDoNothing();
        }
        await transaction.insert(auditEvents).values({
          id: randomUUID(),
          tenantId: scoped.tenantId,
          actorType: "operator",
          actorId,
          action: "order.eligibility_recomputed",
          entityType: "order",
          entityId: orderId,
          correlationId: idempotencyKey,
          causationId: null,
          beforeSummary: { invoiceEligible: processRow.invoiceEligible },
          afterSummary: { invoiceEligible: decision.eligible, reasons: decision.reasons },
          createdAt: now,
        });
        return { decision, source: "policy" as const, shippedQtyByLine };
      });
    },
  };
}

export type OperatorRepository = ReturnType<typeof createOperatorRepository>;
