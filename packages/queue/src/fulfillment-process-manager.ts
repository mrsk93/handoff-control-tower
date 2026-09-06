import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AppConfig } from "@handoff/config";
import {
  createOutboxRepository,
  createInboxRepository,
  type Database,
  type InboxClaim,
  type InboxPrerequisite,
  type OutboxWriter,
  type Transaction,
} from "@handoff/db";
import {
  acceptCommerceOrder,
  applyWarehouseUpdate,
  cancellationOutcome,
  confirmShipment,
  compareSourceVersions,
  evaluateInvoiceEligibility,
  initialFulfillment,
  type CanonicalOrder,
  type CommerceFulfillmentReadback,
  type FulfillmentActual,
  type FulfillmentLine,
  type Shipment,
  type ShipmentConfirmationInput,
} from "@handoff/domain";
import {
  auditEvents,
  exceptions,
  fulfillmentLines,
  fulfillments,
  inboxMessages,
  orderLines,
  orders,
  processInstances,
  shipments,
  shipmentLines,
} from "@handoff/db";

type ProcessManagerConfig = Pick<AppConfig, "allowPartialInvoiceEligibility" | "outboxMaxAttempts">;

export type ProcessManagerResult =
  | { status: "idle" }
  | { status: "processed" | "ignored" | "parked" | "conflict" | "retry"; messageId: string };

type Aggregate = {
  order: CanonicalOrder;
  orderRow: typeof orders.$inferSelect;
  orderLineRows: Array<typeof orderLines.$inferSelect>;
  fulfillment: FulfillmentActual;
  fulfillmentRow: typeof fulfillments.$inferSelect | null;
  processRow: typeof processInstances.$inferSelect | null;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sourceVersion(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : typeof value === "number" && Number.isInteger(value)
      ? String(value)
      : fallback;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function iso(value: Date): string {
  return value.toISOString();
}

function orderFromRows(
  row: typeof orders.$inferSelect,
  lineRows: Array<typeof orderLines.$inferSelect>,
): CanonicalOrder {
  const order: CanonicalOrder = {
    tenantId: row.tenantId,
    orderId: row.id,
    source: "commerce",
    sourceOrderId: row.sourceOrderId,
    sourceVersion: row.sourceVersion,
    orderNumber: row.orderNumber,
    currency: row.currency,
    acceptedAt: iso(row.acceptedAt),
    releaseStatus: row.releaseStatus as CanonicalOrder["releaseStatus"],
    lines: lineRows.map((line) => ({
      lineId: `${row.sourceOrderId}:${line.sourceLineId}`,
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      orderedQty: line.orderedQty,
      cancelledQty: line.cancelledQty,
    })),
  };
  if (row.cancelledAt) order.cancelledAt = iso(row.cancelledAt);
  return order;
}

function fulfillmentFromRows(
  row: typeof fulfillments.$inferSelect | null,
  lineRows: Array<typeof fulfillmentLines.$inferSelect>,
  order: CanonicalOrder,
  orderLineRows: Array<typeof orderLines.$inferSelect>,
): FulfillmentActual {
  if (!row) return initialFulfillment(order);
  const sourceLineById = new Map(orderLineRows.map((line) => [line.id, line.sourceLineId]));
  return {
    tenantId: row.tenantId,
    orderId: row.orderId,
    ...(row.warehouseOrderId === null ? {} : { warehouseOrderId: row.warehouseOrderId }),
    status: row.status as FulfillmentActual["status"],
    version: row.rowVersion,
    lines: lineRows.map((line) => ({
      lineId: `${order.sourceOrderId}:${sourceLineById.get(line.orderLineId) ?? line.orderLineId}`,
      allocatedQty: line.allocatedQty,
      pickedQty: line.pickedQty,
      packedQty: line.packedQty,
      shippedQty: line.shippedQty,
      shortQty: line.shortQty,
      damagedQty: line.damagedQty,
    })),
  };
}

async function loadAggregate(
  transaction: Transaction,
  tenantId: string,
  sourceOrderId: string,
): Promise<Aggregate | null> {
  const orderRows = await transaction
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.sourceOrderId, sourceOrderId)))
    .limit(1);
  const orderRow = orderRows[0];
  if (!orderRow) return null;
  const lineRows = await transaction
    .select()
    .from(orderLines)
    .where(and(eq(orderLines.tenantId, tenantId), eq(orderLines.orderId, orderRow.id)))
    .orderBy(asc(orderLines.sourceLineId));
  const fulfillmentRows = await transaction
    .select()
    .from(fulfillments)
    .where(and(eq(fulfillments.tenantId, tenantId), eq(fulfillments.orderId, orderRow.id)))
    .limit(1);
  const fulfillmentRow = fulfillmentRows[0] ?? null;
  const fulfillmentLineRows = fulfillmentRow
    ? await transaction
        .select()
        .from(fulfillmentLines)
        .where(
          and(
            eq(fulfillmentLines.tenantId, tenantId),
            eq(fulfillmentLines.fulfillmentId, fulfillmentRow.id),
          ),
        )
    : [];
  const processRows = await transaction
    .select()
    .from(processInstances)
    .where(and(eq(processInstances.tenantId, tenantId), eq(processInstances.orderId, orderRow.id)))
    .limit(1);
  const order = orderFromRows(orderRow, lineRows);
  return {
    order,
    orderRow,
    orderLineRows: lineRows,
    fulfillment: fulfillmentFromRows(fulfillmentRow, fulfillmentLineRows, order, lineRows),
    fulfillmentRow,
    processRow: processRows[0] ?? null,
  };
}

async function writeAudit(
  transaction: Transaction,
  input: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    correlationId: string;
    causationId?: string;
    beforeSummary?: Record<string, unknown>;
    afterSummary?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await transaction.insert(auditEvents).values({
    id: randomUUID(),
    tenantId: input.tenantId,
    actorType: "process_manager",
    actorId: null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    beforeSummary: input.beforeSummary ?? null,
    afterSummary: input.afterSummary ?? null,
    createdAt: input.now,
  });
}

async function openException(
  transaction: Transaction,
  input: {
    tenantId: string;
    orderId: string;
    orderLineId?: string;
    type: string;
    severity: string;
    activeKey: string;
    summary: string;
    evidence: Record<string, unknown>;
    correlationId: string;
    causationId: string;
    now: Date;
  },
): Promise<void> {
  const persistedType =
    input.type === "NON_MONOTONIC_WAREHOUSE_UPDATE" ? "NON_MONOTONIC_WMS_UPDATE" : input.type;
  await transaction
    .insert(exceptions)
    .values({
      id: randomUUID(),
      tenantId: input.tenantId,
      orderId: input.orderId,
      processInstanceId: null,
      orderLineId: input.orderLineId ?? null,
      shipmentId: null,
      type: persistedType,
      severity: input.severity,
      status: "open",
      activeKey: input.activeKey,
      machineSummary: input.summary,
      operatorDetails: null,
      evidence: input.evidence,
      assignee: null,
      resolutionCode: null,
      resolutionReason: null,
      resolvedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing();
  await writeAudit(transaction, {
    tenantId: input.tenantId,
    action: "exception.opened",
    entityType: "order",
    entityId: input.orderId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    afterSummary: { type: persistedType, severity: input.severity, evidence: input.evidence },
    now: input.now,
  });
}

async function upsertProcess(
  transaction: Transaction,
  input: {
    tenantId: string;
    orderId: string;
    currentStep: string;
    blockingExceptionCount?: number;
    invoiceEligible?: boolean;
    decisionVersion?: number;
    now: Date;
  },
): Promise<void> {
  await transaction
    .insert(processInstances)
    .values({
      id: randomUUID(),
      tenantId: input.tenantId,
      orderId: input.orderId,
      currentStep: input.currentStep,
      lastAppliedEventVersion: null,
      blockingExceptionCount: input.blockingExceptionCount ?? 0,
      invoiceEligible: input.invoiceEligible ?? false,
      decisionVersion: input.decisionVersion ?? 0,
      rowVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [processInstances.tenantId, processInstances.orderId],
      set: {
        currentStep: input.currentStep,
        ...(input.blockingExceptionCount === undefined
          ? {}
          : { blockingExceptionCount: input.blockingExceptionCount }),
        ...(input.invoiceEligible === undefined ? {} : { invoiceEligible: input.invoiceEligible }),
        ...(input.decisionVersion === undefined ? {} : { decisionVersion: input.decisionVersion }),
        rowVersion: sql`${processInstances.rowVersion} + 1`,
        updatedAt: input.now,
      },
    });
}

function shipmentLinePayload(line: FulfillmentLine): Record<string, unknown> {
  return {
    lineId: line.lineId,
    quantity: line.packedQty,
  };
}

function parseFulfillmentLines(value: unknown, sourceOrderId: string): FulfillmentLine[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const line = record(item);
    const rawId = optionalString(line.lineId) ?? optionalString(line.sourceLineId);
    const lineId = requiredString(rawId, `lines[${index}].lineId`);
    return {
      lineId: lineId.includes(":") ? lineId : `${sourceOrderId}:${lineId}`,
      allocatedQty: nonNegativeInteger(line.allocatedQty),
      pickedQty: nonNegativeInteger(line.pickedQty),
      packedQty: nonNegativeInteger(line.packedQty),
      shippedQty: nonNegativeInteger(line.shippedQty),
      shortQty: nonNegativeInteger(line.shortQty),
      damagedQty: nonNegativeInteger(line.damagedQty),
    };
  });
}

function parseShipmentInput(value: unknown, sourceOrderId: string): ShipmentConfirmationInput {
  const shipment = record(value);
  const externalShipmentId = optionalString(shipment.externalShipmentId);
  const trackingUrl = optionalString(shipment.trackingUrl);
  const shippedAt = optionalString(shipment.shippedAt);
  const lines = Array.isArray(shipment.lines)
    ? shipment.lines.map((item, index) => {
        const line = record(item);
        const rawId = requiredString(
          optionalString(line.lineId) ?? optionalString(line.sourceLineId),
          `shipment.lines[${index}].lineId`,
        );
        return {
          lineId: rawId.includes(":") ? rawId : `${sourceOrderId}:${rawId}`,
          quantity: nonNegativeInteger(line.quantity),
        };
      })
    : [];
  return {
    shipmentId: requiredString(shipment.shipmentId, "shipmentId"),
    ...(externalShipmentId === undefined ? {} : { externalShipmentId }),
    carrierCode: requiredString(shipment.carrierCode, "carrierCode"),
    serviceCode: requiredString(shipment.serviceCode, "serviceCode"),
    trackingNumber: requiredString(shipment.trackingNumber, "trackingNumber"),
    ...(trackingUrl === undefined ? {} : { trackingUrl }),
    ...(shippedAt === undefined ? {} : { shippedAt }),
    lines,
  };
}

async function persistFulfillment(
  transaction: Transaction,
  aggregate: Aggregate,
  next: FulfillmentActual,
  sourceVersion: string,
  now: Date,
): Promise<void> {
  const row = aggregate.fulfillmentRow;
  if (!row) throw new Error("fulfillment row is required before applying warehouse state");
  await transaction
    .update(fulfillments)
    .set({
      warehouseOrderId: next.warehouseOrderId ?? null,
      status: next.status,
      sourceVersion,
      rowVersion: row.rowVersion + 1,
      updatedAt: now,
    })
    .where(and(eq(fulfillments.id, row.id), eq(fulfillments.tenantId, row.tenantId)));

  const orderLineByDomainId = new Map(
    aggregate.orderLineRows.map((line) => [
      `${aggregate.order.sourceOrderId}:${line.sourceLineId}`,
      line.id,
    ]),
  );
  const existingLines = await transaction
    .select()
    .from(fulfillmentLines)
    .where(
      and(eq(fulfillmentLines.tenantId, row.tenantId), eq(fulfillmentLines.fulfillmentId, row.id)),
    );
  const existingByOrderLineId = new Map(existingLines.map((line) => [line.orderLineId, line]));
  for (const line of next.lines) {
    const orderLineId = orderLineByDomainId.get(line.lineId);
    if (!orderLineId) continue;
    const existing = existingByOrderLineId.get(orderLineId);
    if (existing) {
      await transaction
        .update(fulfillmentLines)
        .set({
          allocatedQty: line.allocatedQty,
          pickedQty: line.pickedQty,
          packedQty: line.packedQty,
          shippedQty: line.shippedQty,
          shortQty: line.shortQty,
          damagedQty: line.damagedQty,
        })
        .where(
          and(eq(fulfillmentLines.id, existing.id), eq(fulfillmentLines.tenantId, row.tenantId)),
        );
    } else {
      await transaction.insert(fulfillmentLines).values({
        id: randomUUID(),
        tenantId: row.tenantId,
        fulfillmentId: row.id,
        orderLineId,
        allocatedQty: line.allocatedQty,
        pickedQty: line.pickedQty,
        packedQty: line.packedQty,
        shippedQty: line.shippedQty,
        shortQty: line.shortQty,
        damagedQty: line.damagedQty,
      });
    }
  }
}

async function wakeParked(
  transaction: Transaction,
  tenantId: string,
  prerequisite: InboxPrerequisite,
  now: Date,
): Promise<void> {
  await transaction
    .update(inboxMessages)
    .set({
      status: "received",
      availableAt: now,
      prerequisiteType: null,
      prerequisiteKey: null,
      lastError: null,
      lockedAt: null,
      lockedBy: null,
    })
    .where(
      and(
        eq(inboxMessages.tenantId, tenantId),
        eq(inboxMessages.status, "parked"),
        eq(inboxMessages.prerequisiteType, prerequisite.type),
        eq(inboxMessages.prerequisiteKey, prerequisite.key),
      ),
    );
}

async function persistShipment(
  transaction: Transaction,
  aggregate: Aggregate,
  shipment: Shipment,
  correlationId: string,
  causationId: string,
  now: Date,
  outbox: OutboxWriter,
): Promise<void> {
  const inserted = await transaction
    .insert(shipments)
    .values({
      id: randomUUID(),
      tenantId: aggregate.orderRow.tenantId,
      orderId: aggregate.orderRow.id,
      sourceShipmentId: shipment.shipmentId,
      externalShipmentId: shipment.externalShipmentId ?? null,
      carrierCode: shipment.carrierCode,
      serviceCode: shipment.serviceCode,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl ?? null,
      shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : null,
      status: shipment.status,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const shipmentRow =
    inserted[0] ??
    (
      await transaction
        .select()
        .from(shipments)
        .where(
          and(
            eq(shipments.tenantId, aggregate.orderRow.tenantId),
            eq(shipments.sourceShipmentId, shipment.shipmentId),
          ),
        )
        .limit(1)
    )[0];
  if (!shipmentRow) throw new Error("shipment insert did not return a row");
  for (const line of shipment.lines) {
    const orderLine = aggregate.orderLineRows.find(
      (candidate) => `${aggregate.order.sourceOrderId}:${candidate.sourceLineId}` === line.lineId,
    );
    if (!orderLine) continue;
    await transaction
      .insert(shipmentLines)
      .values({
        id: randomUUID(),
        tenantId: aggregate.orderRow.tenantId,
        shipmentId: shipmentRow.id,
        orderLineId: orderLine.id,
        quantity: line.quantity,
      })
      .onConflictDoNothing();
  }
  await outbox.append({
    tenantId: aggregate.orderRow.tenantId,
    destination: "mock-commerce",
    messageType: "commerce.publish_fulfillment.v1",
    messageVersion: 1,
    payload: {
      orderId: aggregate.order.orderId,
      sourceOrderId: aggregate.order.sourceOrderId,
      shipmentId: shipment.shipmentId,
      trackingNumber: shipment.trackingNumber,
      lines: shipment.lines,
    },
    idempotencyKey: `commerce-fulfillment:${aggregate.order.orderId}:${shipment.shipmentId}`,
    correlationId,
    causationId,
  });
  await writeAudit(transaction, {
    tenantId: aggregate.orderRow.tenantId,
    action: "shipment.recorded",
    entityType: "shipment",
    entityId: shipmentRow.id,
    correlationId,
    causationId,
    afterSummary: { shipmentId: shipment.shipmentId, trackingNumber: shipment.trackingNumber },
    now,
  });
}

async function activeExceptions(
  transaction: Transaction,
  tenantId: string,
  orderId: string,
): Promise<
  Array<{
    code: string;
    severity: "low" | "medium" | "high" | "critical";
    resolved: boolean;
    evidenceRefs: string[];
  }>
> {
  const rows = await transaction
    .select()
    .from(exceptions)
    .where(
      and(
        eq(exceptions.tenantId, tenantId),
        eq(exceptions.orderId, orderId),
        eq(exceptions.status, "open"),
      ),
    );
  return rows.map((row) => ({
    code: row.type,
    severity: row.severity as "low" | "medium" | "high" | "critical",
    resolved: false,
    evidenceRefs: [row.id],
  }));
}

function orderSourceId(payload: Record<string, unknown>, fallback: string): string {
  return (
    optionalString(payload.sourceOrderId) ??
    optionalString(payload.orderSourceId) ??
    optionalString(payload.orderId) ??
    fallback
  );
}

function parseReadback(payload: Record<string, unknown>): CommerceFulfillmentReadback {
  const raw = record(payload.commerceFulfillment ?? payload);
  const status = raw.status;
  if (status !== "reflected" && status !== "pending" && status !== "missing") {
    throw new Error("commerce fulfillment readback status is invalid");
  }
  const rawQuantities = record(raw.shippedQtyByLine);
  const shippedQtyByLine: Record<string, number> = {};
  for (const [lineId, value] of Object.entries(rawQuantities)) {
    shippedQtyByLine[lineId] = nonNegativeInteger(value);
  }
  return { status, shippedQtyByLine };
}

export function createFulfillmentProcessManager(dependencies: {
  db: Database;
  config: ProcessManagerConfig;
  clock?: () => Date;
}) {
  const inbox = createInboxRepository(dependencies.db);
  const outboxRepository = createOutboxRepository(dependencies.db);
  const clock = dependencies.clock ?? (() => new Date());

  async function processClaim(
    claim: InboxClaim,
    workerId: string,
    now: Date,
  ): Promise<ProcessManagerResult> {
    const context = { tenantId: claim.tenantId };
    let finalStatus: "processed" | "ignored" | "parked" | "conflict" = "processed";
    let parkedPrerequisite: InboxPrerequisite | undefined;
    await outboxRepository.inTransaction(
      context,
      async (transaction, outbox) => {
        if (claim.status !== "processing" || claim.lockedBy !== workerId) {
          throw new Error("inbox claim is not owned by this worker");
        }
        const payload = record(claim.payload);
        const aggregate = await loadAggregate(
          transaction,
          claim.tenantId,
          orderSourceId(payload, claim.sourceEntityId),
        );
        if (
          claim.eventType === "commerce.order.accepted.v1" ||
          claim.eventType === "commerce.order.created.v1"
        ) {
          const sourceOrderId = orderSourceId(payload, claim.sourceEntityId);
          const existing = aggregate;
          const acceptance = acceptCommerceOrder({
            tenantId: claim.tenantId,
            orderId: existing?.order.orderId ?? randomUUID(),
            sourceOrderId,
            sourceVersion: sourceVersion(
              payload.sourceVersion,
              claim.sourceVersion ?? String(claim.eventVersion),
            ),
            orderNumber: requiredString(payload.orderNumber ?? sourceOrderId, "orderNumber"),
            currency: requiredString(payload.currency ?? "USD", "currency"),
            acceptedAt: iso(claim.occurredAt),
            paymentReleased: payload.paymentReleased === false ? false : true,
            releaseRequested: payload.releaseRequested === false ? false : true,
            cancelled: payload.cancelled === true,
            lines: Array.isArray(payload.lines)
              ? payload.lines.map((item) => {
                  const line = record(item);
                  const sku = optionalString(line.sku);
                  return {
                    sourceLineId: requiredString(line.sourceLineId ?? line.lineId, "sourceLineId"),
                    ...(sku === undefined ? {} : { sku }),
                    quantity: nonNegativeInteger(line.quantity),
                    cancelledQty: nonNegativeInteger(line.cancelledQty),
                  };
                })
              : [],
          });
          const incomingVersion = acceptance.order.sourceVersion;
          if (
            existing &&
            claim.sourceVersion !== null &&
            compareSourceVersions(claim.sourceVersion, existing.order.sourceVersion) < 0
          ) {
            finalStatus = "ignored";
          } else if (existing && existing.order.sourceVersion === incomingVersion) {
            finalStatus = "ignored";
          } else {
            let orderRow = existing?.orderRow;
            const nowDate = now;
            if (!orderRow) {
              const inserted = await transaction
                .insert(orders)
                .values({
                  id: acceptance.order.orderId,
                  tenantId: claim.tenantId,
                  source: "commerce",
                  sourceOrderId,
                  sourceVersion: incomingVersion,
                  orderNumber: acceptance.order.orderNumber,
                  currency: acceptance.order.currency,
                  acceptedAt: new Date(acceptance.order.acceptedAt),
                  cancelledAt: acceptance.order.cancelledAt
                    ? new Date(acceptance.order.cancelledAt)
                    : null,
                  releaseStatus: acceptance.order.releaseStatus,
                  canonicalHash: canonicalHash(payload),
                  rowVersion: 1,
                  createdAt: nowDate,
                  updatedAt: nowDate,
                })
                .returning();
              const insertedOrder = inserted[0];
              if (!insertedOrder) throw new Error("accepted order insert did not return a row");
              orderRow = insertedOrder;
            } else {
              const updated = await transaction
                .update(orders)
                .set({
                  sourceVersion: incomingVersion,
                  orderNumber: acceptance.order.orderNumber,
                  currency: acceptance.order.currency,
                  cancelledAt: acceptance.order.cancelledAt
                    ? new Date(acceptance.order.cancelledAt)
                    : orderRow.cancelledAt,
                  releaseStatus: acceptance.order.releaseStatus,
                  canonicalHash: canonicalHash(payload),
                  rowVersion: orderRow.rowVersion + 1,
                  updatedAt: nowDate,
                })
                .where(and(eq(orders.id, orderRow.id), eq(orders.tenantId, claim.tenantId)))
                .returning();
              orderRow = updated[0] ?? orderRow;
            }
            if (!orderRow) throw new Error("accepted order row is unavailable");
            for (const line of acceptance.order.lines) {
              await transaction
                .insert(orderLines)
                .values({
                  id: randomUUID(),
                  tenantId: claim.tenantId,
                  orderId: orderRow.id,
                  sourceLineId: line.sourceLineId,
                  sku: line.sku,
                  orderedQty: line.orderedQty,
                  cancelledQty: line.cancelledQty,
                })
                .onConflictDoNothing();
            }
            const refreshed = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
            if (!refreshed) throw new Error("accepted order was not persisted");
            if (!refreshed.fulfillmentRow) {
              const fulfillment = initialFulfillment(refreshed.order);
              const fulfillmentInserted = await transaction
                .insert(fulfillments)
                .values({
                  id: randomUUID(),
                  tenantId: claim.tenantId,
                  orderId: orderRow.id,
                  warehouseOrderId: null,
                  status: fulfillment.status,
                  sourceVersion: null,
                  rowVersion: 1,
                  createdAt: nowDate,
                  updatedAt: nowDate,
                })
                .returning();
              const fulfillmentRow = fulfillmentInserted[0];
              if (!fulfillmentRow) throw new Error("fulfillment row was not created");
              const refreshedLines = await transaction
                .select()
                .from(orderLines)
                .where(
                  and(eq(orderLines.tenantId, claim.tenantId), eq(orderLines.orderId, orderRow.id)),
                );
              for (const line of fulfillment.lines) {
                const orderLine = refreshedLines.find(
                  (candidate) =>
                    candidate.sourceLineId === line.lineId.split(":").slice(1).join(":"),
                );
                if (!orderLine) continue;
                await transaction.insert(fulfillmentLines).values({
                  id: randomUUID(),
                  tenantId: claim.tenantId,
                  fulfillmentId: fulfillmentRow.id,
                  orderLineId: orderLine.id,
                  allocatedQty: 0,
                  pickedQty: 0,
                  packedQty: 0,
                  shippedQty: 0,
                  shortQty: 0,
                  damagedQty: 0,
                });
              }
            }
            const saved = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
            if (!saved) throw new Error("accepted order aggregate could not be loaded");
            if (acceptance.exceptions.length > 0) {
              for (const exception of acceptance.exceptions) {
                await openException(transaction, {
                  tenantId: claim.tenantId,
                  orderId: saved.orderRow.id,
                  type: exception.code,
                  severity: exception.severity,
                  activeKey: `${exception.code}:${saved.orderRow.id}:${exception.lineId ?? "order"}`,
                  summary: exception.summary,
                  evidence: {
                    evidenceRefs: exception.evidenceRefs,
                    sourceVersion: incomingVersion,
                  },
                  correlationId: claim.correlationId,
                  causationId: claim.messageId,
                  now: nowDate,
                });
              }
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: saved.orderRow.id,
                currentStep: "held",
                blockingExceptionCount: acceptance.exceptions.length,
                now: nowDate,
              });
            } else if (acceptance.shouldRelease) {
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: saved.orderRow.id,
                currentStep: "release_requested",
                now: nowDate,
              });
              await outbox.append({
                tenantId: claim.tenantId,
                destination: "mock-wms",
                messageType: "wms.create_order.v1",
                messageVersion: 1,
                payload: {
                  orderId: saved.order.orderId,
                  sourceOrderId: saved.order.sourceOrderId,
                  lines: saved.order.lines.map((line) => ({
                    lineId: line.lineId,
                    sku: line.sku,
                    quantity: line.orderedQty - line.cancelledQty,
                  })),
                },
                idempotencyKey: `wms-create:${saved.order.orderId}:${incomingVersion}`,
                correlationId: claim.correlationId,
                causationId: claim.messageId,
              });
            } else {
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: saved.orderRow.id,
                currentStep: acceptance.order.releaseStatus,
                now: nowDate,
              });
            }
            await writeAudit(transaction, {
              tenantId: claim.tenantId,
              action: "commerce.order.accepted",
              entityType: "order",
              entityId: saved.orderRow.id,
              correlationId: claim.correlationId,
              causationId: claim.messageId,
              afterSummary: {
                sourceVersion: incomingVersion,
                releaseStatus: acceptance.order.releaseStatus,
              },
              now: nowDate,
            });
            await wakeParked(
              transaction,
              claim.tenantId,
              { type: "order", key: sourceOrderId },
              nowDate,
            );
          }
        } else if (
          claim.eventType === "wms.order.acknowledged.v1" ||
          claim.eventType === "wms.fulfillment.updated.v1" ||
          claim.eventType === "wms.fulfillment.progress.v1"
        ) {
          const sourceOrderId = orderSourceId(payload, claim.sourceEntityId);
          const current = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
          if (!current) {
            finalStatus = "parked";
            parkedPrerequisite = { type: "order", key: sourceOrderId };
          } else {
            const updateStatus =
              payload.status === "short" ||
              payload.status === "cancelled" ||
              payload.status === "packed" ||
              payload.status === "shipped" ||
              payload.status === "picking" ||
              payload.status === "acknowledged"
                ? payload.status
                : claim.eventType.includes("acknowledged")
                  ? "acknowledged"
                  : "picking";
            const updateLines = parseFulfillmentLines(payload.lines, sourceOrderId);
            const update = {
              warehouseOrderId: requiredString(
                payload.warehouseOrderId ?? current.fulfillment.warehouseOrderId,
                "warehouseOrderId",
              ),
              sourceVersion: sourceVersion(
                payload.sourceVersion,
                claim.sourceVersion ?? String(claim.eventVersion),
              ),
              status: updateStatus,
              lines: updateLines.length > 0 ? updateLines : current.fulfillment.lines,
              correction: payload.correction === true,
            } as const;
            const cancellationConflict =
              update.status === "cancelled" &&
              (current.fulfillment.status === "shipped" ||
                current.fulfillment.status === "partially_shipped")
                ? cancellationOutcome("already_shipped")
                : null;
            const applied =
              cancellationConflict?.status === "conflict"
                ? {
                    outcome: "conflict" as const,
                    fulfillment: current.fulfillment,
                    exception: cancellationConflict.exception,
                  }
                : applyWarehouseUpdate(
                    current.order,
                    current.fulfillment,
                    update,
                    current.fulfillmentRow?.sourceVersion ?? undefined,
                  );
            if (applied.outcome === "stale") {
              finalStatus = "ignored";
            } else if (applied.outcome === "conflict") {
              finalStatus = "conflict";
              await openException(transaction, {
                tenantId: claim.tenantId,
                orderId: current.orderRow.id,
                type: applied.exception.code,
                severity: applied.exception.severity,
                activeKey: `${applied.exception.code}:${current.orderRow.id}:${applied.exception.lineId ?? "order"}`,
                summary: applied.exception.summary,
                evidence: {
                  evidenceRefs: applied.exception.evidenceRefs,
                  sourceVersion: update.sourceVersion,
                },
                correlationId: claim.correlationId,
                causationId: claim.messageId,
                now,
              });
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: current.orderRow.id,
                currentStep: "exception",
                blockingExceptionCount: 1,
                now,
              });
            } else {
              await persistFulfillment(
                transaction,
                current,
                applied.fulfillment,
                update.sourceVersion,
                now,
              );
              const nextStep = applied.fulfillment.status;
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: current.orderRow.id,
                currentStep: nextStep,
                now,
              });
              await writeAudit(transaction, {
                tenantId: claim.tenantId,
                action: "warehouse.fulfillment.applied",
                entityType: "fulfillment",
                entityId: current.fulfillmentRow?.id ?? current.orderRow.id,
                correlationId: claim.correlationId,
                causationId: claim.messageId,
                beforeSummary: {
                  status: current.fulfillment.status,
                  version: current.fulfillment.version,
                },
                afterSummary: {
                  status: applied.fulfillment.status,
                  version: applied.fulfillment.version,
                  sourceVersion: update.sourceVersion,
                },
                now,
              });
              if (
                applied.fulfillment.status === "cancelled" &&
                current.order.releaseStatus === "cancel_requested"
              ) {
                await transaction
                  .update(orders)
                  .set({
                    releaseStatus: "cancelled",
                    cancelledAt: now,
                    updatedAt: now,
                    rowVersion: current.orderRow.rowVersion + 1,
                  })
                  .where(
                    and(eq(orders.id, current.orderRow.id), eq(orders.tenantId, claim.tenantId)),
                  );
              }
              if (
                applied.fulfillment.status === "packed" ||
                applied.fulfillment.status === "shipped" ||
                applied.fulfillment.status === "partially_shipped"
              ) {
                const shipmentId = `${current.order.orderId}:shipment:1`;
                await outbox.append({
                  tenantId: claim.tenantId,
                  destination: "mock-carrier",
                  messageType: "carrier.create_label.v1",
                  messageVersion: 1,
                  payload: {
                    orderId: current.order.orderId,
                    sourceOrderId: current.order.sourceOrderId,
                    shipmentId,
                    carrierCode: optionalString(payload.carrierCode) ?? "mock-carrier",
                    serviceCode: optionalString(payload.serviceCode) ?? "ground",
                    lines: applied.fulfillment.lines
                      .filter((line) => line.packedQty > 0)
                      .map(shipmentLinePayload),
                  },
                  idempotencyKey: `carrier-label:${current.order.orderId}:${shipmentId}`,
                  correlationId: claim.correlationId,
                  causationId: claim.messageId,
                });
                await wakeParked(
                  transaction,
                  claim.tenantId,
                  { type: "fulfillment", key: sourceOrderId },
                  now,
                );
              }
            }
          }
        } else if (
          claim.eventType === "carrier.shipment.confirmed.v1" ||
          claim.eventType === "carrier.shipment.created.v1"
        ) {
          const sourceOrderId = orderSourceId(payload, claim.sourceEntityId);
          const current = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
          if (!current) {
            finalStatus = "parked";
            parkedPrerequisite = { type: "order", key: sourceOrderId };
          } else {
            try {
              const shipment = confirmShipment(
                current.order,
                current.fulfillment,
                parseShipmentInput(payload.shipment ?? payload, sourceOrderId),
              );
              await persistShipment(
                transaction,
                current,
                shipment,
                claim.correlationId,
                claim.messageId,
                now,
                outbox,
              );
              await upsertProcess(transaction, {
                tenantId: claim.tenantId,
                orderId: current.orderRow.id,
                currentStep: "shipment_recorded",
                now,
              });
              await wakeParked(
                transaction,
                claim.tenantId,
                { type: "shipment", key: shipment.shipmentId },
                now,
              );
            } catch (error) {
              finalStatus = "conflict";
              await openException(transaction, {
                tenantId: claim.tenantId,
                orderId: current.orderRow.id,
                type: "INVALID_QUANTITY",
                severity: "high",
                activeKey: `INVALID_QUANTITY:${current.orderRow.id}:shipment`,
                summary: error instanceof Error ? error.message : "invalid shipment evidence",
                evidence: { source: "carrier", messageId: claim.messageId },
                correlationId: claim.correlationId,
                causationId: claim.messageId,
                now,
              });
            }
          }
        } else if (claim.eventType === "commerce.fulfillment.readback.v1") {
          const sourceOrderId = orderSourceId(payload, claim.sourceEntityId);
          const current = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
          if (!current) {
            finalStatus = "parked";
            parkedPrerequisite = { type: "order", key: sourceOrderId };
          } else {
            const readback = parseReadback(payload);
            const latestShipment = (
              await transaction
                .select()
                .from(shipments)
                .where(
                  and(
                    eq(shipments.tenantId, claim.tenantId),
                    eq(shipments.orderId, current.orderRow.id),
                  ),
                )
                .orderBy(desc(shipments.createdAt))
                .limit(1)
            )[0];
            const process = current.processRow;
            const eligibilityInput = {
              order: current.order,
              fulfillment: current.fulfillment,
              commerceFulfillment: readback,
              activeExceptions: await activeExceptions(
                transaction,
                claim.tenantId,
                current.orderRow.id,
              ),
              partialShipmentEnabled: dependencies.config.allowPartialInvoiceEligibility,
              shortShipmentResolution: "unresolved" as const,
              decisionVersion: (process?.decisionVersion ?? 0) + 1,
              computedAt: iso(now),
              ...(latestShipment?.trackingNumber === undefined
                ? {}
                : { trackingNumber: latestShipment.trackingNumber }),
            };
            const decision = evaluateInvoiceEligibility(eligibilityInput);
            await upsertProcess(transaction, {
              tenantId: claim.tenantId,
              orderId: current.orderRow.id,
              currentStep: decision.eligible ? "invoice_ready" : "invoice_blocked",
              invoiceEligible: decision.eligible,
              decisionVersion: decision.decisionVersion,
              now,
            });
            if (decision.eligible) {
              await outbox.append({
                tenantId: claim.tenantId,
                destination: "mock-billing",
                messageType: "billing.eligibility.v1",
                messageVersion: 1,
                payload: { orderId: current.order.orderId, decision },
                idempotencyKey: decision.idempotencyKey,
                correlationId: claim.correlationId,
                causationId: claim.messageId,
              });
            }
            await writeAudit(transaction, {
              tenantId: claim.tenantId,
              action: "invoice.eligibility.evaluated",
              entityType: "order",
              entityId: current.orderRow.id,
              correlationId: claim.correlationId,
              causationId: claim.messageId,
              afterSummary: {
                eligible: decision.eligible,
                scope: decision.scope,
                decisionVersion: decision.decisionVersion,
              },
              now,
            });
          }
        } else if (claim.eventType === "commerce.order.cancelled.v1") {
          const sourceOrderId = orderSourceId(payload, claim.sourceEntityId);
          const current = await loadAggregate(transaction, claim.tenantId, sourceOrderId);
          if (!current) {
            finalStatus = "parked";
            parkedPrerequisite = { type: "order", key: sourceOrderId };
          } else if (
            current.order.releaseStatus === "cancelled" ||
            current.order.releaseStatus === "cancel_requested"
          ) {
            finalStatus = "ignored";
          } else if (current.order.releaseStatus === "released") {
            await transaction
              .update(orders)
              .set({
                releaseStatus: "cancel_requested",
                updatedAt: now,
                rowVersion: current.orderRow.rowVersion + 1,
              })
              .where(and(eq(orders.id, current.orderRow.id), eq(orders.tenantId, claim.tenantId)));
            if (current.fulfillment.warehouseOrderId) {
              await outbox.append({
                tenantId: claim.tenantId,
                destination: "mock-wms",
                messageType: "wms.cancel_order.v1",
                messageVersion: 1,
                payload: {
                  orderId: current.order.orderId,
                  warehouseOrderId: current.fulfillment.warehouseOrderId,
                  sourceOrderId,
                },
                idempotencyKey: `wms-cancel:${current.order.orderId}:${claim.messageId}`,
                correlationId: claim.correlationId,
                causationId: claim.messageId,
              });
            }
            await upsertProcess(transaction, {
              tenantId: claim.tenantId,
              orderId: current.orderRow.id,
              currentStep: "cancel_requested",
              now,
            });
            await writeAudit(transaction, {
              tenantId: claim.tenantId,
              action: "order.cancellation.requested",
              entityType: "order",
              entityId: current.orderRow.id,
              correlationId: claim.correlationId,
              causationId: claim.messageId,
              beforeSummary: { releaseStatus: current.order.releaseStatus },
              afterSummary: { releaseStatus: "cancel_requested" },
              now,
            });
          } else {
            await transaction
              .update(orders)
              .set({
                releaseStatus: "cancelled",
                cancelledAt: now,
                updatedAt: now,
                rowVersion: current.orderRow.rowVersion + 1,
              })
              .where(and(eq(orders.id, current.orderRow.id), eq(orders.tenantId, claim.tenantId)));
            await upsertProcess(transaction, {
              tenantId: claim.tenantId,
              orderId: current.orderRow.id,
              currentStep: "cancelled",
              now,
            });
          }
        } else {
          finalStatus = "ignored";
        }

        await transaction
          .update(inboxMessages)
          .set({
            status:
              finalStatus === "parked"
                ? "parked"
                : finalStatus === "ignored"
                  ? "ignored"
                  : "processed",
            availableAt: finalStatus === "parked" ? now : now,
            prerequisiteType: parkedPrerequisite?.type ?? null,
            prerequisiteKey: parkedPrerequisite?.key ?? null,
            processedAt: finalStatus === "parked" ? null : now,
            lastError:
              finalStatus === "parked"
                ? `missing prerequisite ${parkedPrerequisite?.type}:${parkedPrerequisite?.key}`
                : null,
            lockedAt: null,
            lockedBy: null,
          })
          .where(
            and(
              eq(inboxMessages.id, claim.id),
              eq(inboxMessages.tenantId, claim.tenantId),
              eq(inboxMessages.status, "processing"),
              eq(inboxMessages.lockedBy, workerId),
            ),
          );
      },
      now,
    );
    return { status: finalStatus, messageId: claim.id };
  }

  return {
    async processNext(
      tenantId: string,
      workerId: string,
      now = clock(),
    ): Promise<ProcessManagerResult> {
      const claim = await inbox.claimNext({ tenantId }, workerId, now);
      if (!claim) return { status: "idle" };
      try {
        return await processClaim(claim, workerId, now);
      } catch (error) {
        await inbox.recordFailure({ tenantId }, claim.id, workerId, {
          error: error instanceof Error ? error.message : "process manager failure",
          retryAt: new Date(now.getTime() + 1_000),
          maxAttempts: dependencies.config.outboxMaxAttempts,
        });
        return { status: "retry", messageId: claim.id };
      }
    },
  };
}
