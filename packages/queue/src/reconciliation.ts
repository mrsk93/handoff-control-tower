import { createHash, randomUUID } from "node:crypto";
import {
  createInboxRepository,
  createOutboxRepository,
  createReconciliationDataRepository,
  createReconciliationRepository,
  type ReconciliationRunRow,
  type TenantContext,
} from "@handoff/db";
import {
  reconcileCarrierShipment,
  reconcileCommerceFulfillment,
  reconcileCommerceOrder,
  reconcileWarehouseFulfillment,
  type CanonicalOrder,
  type CommerceAdapterV1,
  type FulfillmentActual,
  type IntegrationEvent,
  type ReconciliationFinding,
  type Shipment,
  type WarehouseAdapterV1,
  type CarrierAdapterV1,
} from "@handoff/domain";
import type { AppConfig } from "@handoff/config";
import type { Database } from "@handoff/db";
import { createFulfillmentProcessManager } from "./fulfillment-process-manager";

type ReconciliationConfig = Pick<
  AppConfig,
  "reconciliationIntervalMinutes" | "allowPartialInvoiceEligibility" | "outboxMaxAttempts"
>;

type ReconciliationAdapters = {
  commerce: CommerceAdapterV1;
  warehouse: WarehouseAdapterV1;
  carrier: CarrierAdapterV1;
};

type RunOptions = {
  now?: Date;
  windowEnd?: Date;
  overlapMs?: number;
  leaseDurationMs?: number;
  pageSize?: number;
  leaseOwner?: string;
};

export type ReconciliationPairResult = {
  pair: ReconciliationFinding["pair"];
  runId: string;
  status: "completed" | "failed";
  counts: Record<string, unknown>;
  findings: number;
};

export type ReconciliationRunResult = {
  tenantId: string;
  pairs: ReconciliationPairResult[];
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function externalContext(tenantId: string, key: string, now: Date) {
  return {
    tenantId,
    idempotencyKey: key,
    correlationId: key,
    requestedAt: now.toISOString(),
  };
}

function missingRemoteFinding(
  pair: ReconciliationFinding["pair"],
  resourceType: ReconciliationFinding["resourceType"],
  resourceKey: string,
  sourceValues: Record<string, unknown>,
  evidence: Record<string, unknown>,
): ReconciliationFinding {
  return {
    pair,
    resourceType,
    resourceKey,
    category: "missing_remote",
    sourceValues,
    evidence,
    recommendedAction: "review",
    autoRepairable: false,
  };
}

async function readAllPages<T>(
  readPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  onPage: (cursor: string | null) => Promise<void>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await readPage(cursor);
    items.push(...page.items);
    await onPage(page.nextCursor);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

function orderPayload(order: CanonicalOrder): Record<string, unknown> {
  return {
    sourceOrderId: order.sourceOrderId,
    sourceVersion: order.sourceVersion,
    orderNumber: order.orderNumber,
    currency: order.currency,
    paymentReleased: order.releaseStatus !== "held",
    releaseRequested: order.releaseStatus !== "held",
    cancelled: order.releaseStatus === "cancelled",
    lines: order.lines.map((line) => ({
      sourceLineId: line.sourceLineId,
      sku: line.sku,
      quantity: line.orderedQty,
      cancelledQty: line.cancelledQty,
    })),
  };
}

function warehouseStatus(status: FulfillmentActual["status"]): string {
  if (status === "exception") return "short";
  if (status === "not_sent" || status === "sent") return "acknowledged";
  return status;
}

function warehousePayload(
  order: CanonicalOrder,
  fulfillment: FulfillmentActual,
): Record<string, unknown> {
  return {
    orderSourceId: order.sourceOrderId,
    warehouseOrderId: fulfillment.warehouseOrderId ?? order.sourceOrderId,
    status: warehouseStatus(fulfillment.status),
    lines: fulfillment.lines,
  };
}

function shipmentPayload(order: CanonicalOrder, shipment: Shipment): Record<string, unknown> {
  return {
    sourceOrderId: order.sourceOrderId,
    shipmentId: shipment.shipmentId,
    ...(shipment.externalShipmentId === undefined
      ? {}
      : { externalShipmentId: shipment.externalShipmentId }),
    carrierCode: shipment.carrierCode,
    serviceCode: shipment.serviceCode,
    trackingNumber: shipment.trackingNumber,
    ...(shipment.trackingUrl === undefined ? {} : { trackingUrl: shipment.trackingUrl }),
    ...(shipment.shippedAt === undefined ? {} : { shippedAt: shipment.shippedAt }),
    lines: shipment.lines,
  };
}

function event(
  sourceSystem: string,
  eventType: string,
  sourceEntityId: string,
  sourceVersion: string | undefined,
  payload: Record<string, unknown>,
  runId: string,
  now: Date,
): IntegrationEvent<Record<string, unknown>> {
  const key = `reconciliation:${sourceSystem}:${sourceEntityId}:${sourceVersion ?? "none"}`;
  return {
    messageId: `${key}:${eventType}`,
    eventType,
    eventVersion: 1,
    tenantId: "replaced-by-context",
    sourceSystem,
    sourceEntityId,
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    occurredAt: now.toISOString(),
    receivedAt: now.toISOString(),
    correlationId: `reconciliation:${runId}`,
    causationId: runId,
    idempotencyKey: key,
    payload,
  };
}

export function createReconciliationService(dependencies: {
  db: Database;
  config: ReconciliationConfig;
  adapters: ReconciliationAdapters;
  clock?: () => Date;
}) {
  const runs = createReconciliationRepository(dependencies.db);
  const data = createReconciliationDataRepository(dependencies.db);
  const inbox = createInboxRepository(dependencies.db);
  const outbox = createOutboxRepository(dependencies.db);
  const process = createFulfillmentProcessManager({
    db: dependencies.db,
    config: dependencies.config,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  const clock = dependencies.clock ?? (() => new Date());

  async function applyInboundRepair(
    context: TenantContext,
    run: ReconciliationRunRow,
    sourceSystem: string,
    eventType: string,
    sourceEntityId: string,
    sourceVersion: string | undefined,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    const inbound = event(
      sourceSystem,
      eventType,
      sourceEntityId,
      sourceVersion,
      payload,
      run.id,
      now,
    );
    const result = await inbox.ingest(
      context,
      { ...inbound, tenantId: context.tenantId },
      sha256(payload),
    );
    if (result.message.status === "processed" || result.message.status === "ignored") return true;
    const processed = await process.processNext(context.tenantId, `reconciliation:${run.id}`, now);
    return processed.status === "processed" || processed.status === "ignored";
  }

  async function repair(
    context: TenantContext,
    run: ReconciliationRunRow,
    finding: ReconciliationFinding,
    remote: CanonicalOrder | FulfillmentActual | Shipment | undefined,
    now: Date,
  ): Promise<boolean> {
    if (
      finding.recommendedAction === "apply_authoritative_order" &&
      remote &&
      "sourceOrderId" in remote
    ) {
      return applyInboundRepair(
        context,
        run,
        "mock-commerce",
        "commerce.order.accepted.v1",
        remote.sourceOrderId,
        remote.sourceVersion,
        orderPayload(remote),
        now,
      );
    }
    if (
      finding.recommendedAction === "apply_authoritative_fulfillment" &&
      remote &&
      "warehouseOrderId" in remote
    ) {
      const order = await data.findOrderById(context, remote.orderId);
      if (!order) return false;
      return applyInboundRepair(
        context,
        run,
        "mock-warehouse",
        "wms.fulfillment.updated.v1",
        order.sourceOrderId,
        String(remote.version),
        warehousePayload(order, remote),
        now,
      );
    }
    if (
      finding.recommendedAction === "apply_authoritative_shipment" &&
      remote &&
      "shipmentId" in remote
    ) {
      const order = await data.findOrderById(context, remote.orderId);
      if (!order) return false;
      return applyInboundRepair(
        context,
        run,
        "mock-carrier",
        "carrier.shipment.confirmed.v1",
        remote.shipmentId,
        undefined,
        shipmentPayload(order, remote),
        now,
      );
    }
    if (finding.recommendedAction === "redispatch_commerce_fulfillment") {
      const order = await data.findOrderById(context, finding.resourceKey);
      if (!order) return false;
      const shipments = await data.listShipmentsForOrder(context, order.orderId);
      const shipment = shipments[0];
      if (!shipment) return false;
      const idempotencyKey = `commerce-reconciliation:${order.orderId}`;
      await outbox.inTransaction(
        context,
        (_transaction, writer) =>
          writer.append({
            tenantId: context.tenantId,
            destination: "mock-commerce",
            messageType: "commerce.publish_fulfillment.v1",
            messageVersion: 1,
            payload: {
              sourceOrderId: order.sourceOrderId,
              shipmentId: shipment.shipmentId,
              trackingNumber: shipment.trackingNumber,
              lines: shipment.lines,
            },
            idempotencyKey,
            correlationId: `reconciliation:${run.id}`,
            causationId: run.id,
          }),
        now,
      );
      return true;
    }
    return false;
  }

  async function persistAndRepair(
    context: TenantContext,
    run: ReconciliationRunRow,
    leaseOwner: string,
    findings: Array<{
      finding: ReconciliationFinding;
      remote?: CanonicalOrder | FulfillmentActual | Shipment;
    }>,
    now: Date,
  ): Promise<number> {
    const rows = await runs.persistPage(
      context,
      run.id,
      leaseOwner,
      null,
      findings.map((item) => item.finding),
      {
        detected: findings.length,
        manual: findings.filter((item) => !item.finding.autoRepairable).length,
      },
      now,
    );
    let repaired = 0;
    for (const row of rows) {
      const source = findings.find(
        (item) =>
          item.finding.resourceKey === row.resourceKey && item.finding.category === row.category,
      );
      if (!source?.finding.autoRepairable) continue;
      const success = await repair(context, run, source.finding, source.remote, now);
      await runs.markFindingRepaired(
        context,
        run.id,
        row.id,
        success ? "auto_repaired" : "manual_required",
      );
      if (success) repaired += 1;
    }
    if (repaired > 0) {
      await runs.persistPage(context, run.id, leaseOwner, null, [], { repaired }, now);
    }
    return repaired;
  }

  async function runPair(
    context: TenantContext,
    pair: ReconciliationFinding["pair"],
    options: Required<
      Pick<
        RunOptions,
        "now" | "windowEnd" | "overlapMs" | "leaseDurationMs" | "pageSize" | "leaseOwner"
      >
    >,
  ): Promise<ReconciliationPairResult> {
    const resourceType =
      pair === "commerce_order"
        ? "order"
        : pair === "warehouse_fulfillment"
          ? "fulfillment"
          : pair === "carrier_shipment"
            ? "shipment"
            : "commerce_fulfillment";
    const started = await runs.start(context, {
      pair,
      resourceType,
      windowEnd: options.windowEnd,
      overlapMs: options.overlapMs,
      leaseOwner: options.leaseOwner,
      leaseDurationMs: options.leaseDurationMs,
      now: options.now,
    });
    try {
      let findings: Array<{
        finding: ReconciliationFinding;
        remote?: CanonicalOrder | FulfillmentActual | Shipment;
      }> = [];
      if (pair === "commerce_order") {
        const local = await data.listOrders(context);
        const localByKey = new Map(local.map((item) => [item.sourceOrderId, item]));
        const remote = await readAllPages(
          (cursor) =>
            dependencies.adapters.commerce.listOrders(
              externalContext(
                context.tenantId,
                `reconciliation:${started.run.id}:commerce`,
                options.now,
              ),
              cursor === undefined
                ? { limit: options.pageSize }
                : { cursor, limit: options.pageSize },
            ),
          (cursor) =>
            runs
              .persistPage(
                context,
                started.run.id,
                options.leaseOwner,
                `commerce_order:${cursor ?? "done"}`,
                [],
                {},
                options.now,
              )
              .then(() => undefined),
        );
        const remoteKeys = new Set(remote.map((item) => item.sourceOrderId));
        findings = remote.flatMap((item) => {
          const result = reconcileCommerceOrder(item, localByKey.get(item.sourceOrderId) ?? null);
          return result ? [{ finding: result, remote: item }] : [];
        });
        findings.push(
          ...local
            .filter((item) => !remoteKeys.has(item.sourceOrderId))
            .map((item) => ({
              finding: missingRemoteFinding(
                pair,
                "order",
                item.sourceOrderId,
                { localSourceVersion: item.sourceVersion },
                { sourceOrderId: item.sourceOrderId },
              ),
            })),
        );
      } else if (pair === "warehouse_fulfillment") {
        const local = await data.listFulfillments(context);
        const localByKey = new Map(local.map((item) => [item.orderId, item]));
        const remote = await readAllPages(
          (cursor) =>
            dependencies.adapters.warehouse.listOrders(
              externalContext(
                context.tenantId,
                `reconciliation:${started.run.id}:warehouse`,
                options.now,
              ),
              cursor === undefined
                ? { limit: options.pageSize }
                : { cursor, limit: options.pageSize },
            ),
          (cursor) =>
            runs
              .persistPage(
                context,
                started.run.id,
                options.leaseOwner,
                `warehouse_fulfillment:${cursor ?? "done"}`,
                [],
                {},
                options.now,
              )
              .then(() => undefined),
        );
        const remoteKeys = new Set(remote.map((item) => item.orderId));
        findings = remote.flatMap((item) => {
          const result = reconcileWarehouseFulfillment(item, localByKey.get(item.orderId) ?? null);
          return result ? [{ finding: result, remote: item }] : [];
        });
        findings.push(
          ...local
            .filter((item) => !remoteKeys.has(item.orderId))
            .map((item) => ({
              finding: missingRemoteFinding(
                pair,
                "fulfillment",
                item.orderId,
                { localVersion: item.version },
                { orderId: item.orderId },
              ),
            })),
        );
      } else if (pair === "carrier_shipment") {
        const local = await data.listShipments(context);
        const localByKey = new Map(local.map((item) => [item.shipmentId, item]));
        const remote = await readAllPages(
          (cursor) =>
            dependencies.adapters.carrier.listShipments(
              externalContext(
                context.tenantId,
                `reconciliation:${started.run.id}:carrier`,
                options.now,
              ),
              cursor === undefined
                ? { limit: options.pageSize }
                : { cursor, limit: options.pageSize },
            ),
          (cursor) =>
            runs
              .persistPage(
                context,
                started.run.id,
                options.leaseOwner,
                `carrier_shipment:${cursor ?? "done"}`,
                [],
                {},
                options.now,
              )
              .then(() => undefined),
        );
        const remoteKeys = new Set(remote.map((item) => item.shipmentId));
        findings = remote.flatMap((item) => {
          const result = reconcileCarrierShipment(item, localByKey.get(item.shipmentId) ?? null);
          return result ? [{ finding: result, remote: item }] : [];
        });
        findings.push(
          ...local
            .filter((item) => !remoteKeys.has(item.shipmentId))
            .map((item) => ({
              finding: missingRemoteFinding(
                pair,
                "shipment",
                item.shipmentId,
                { localTrackingNumber: item.trackingNumber },
                { orderId: item.orderId },
              ),
            })),
        );
      } else {
        const localOrders = await data.listOrders(context);
        const remoteReadbacks = await Promise.all(
          localOrders.map(async (order) => ({
            order,
            readback: await dependencies.adapters.commerce.getFulfillmentReadback(
              externalContext(
                context.tenantId,
                `reconciliation:${started.run.id}:readback:${order.orderId}`,
                options.now,
              ),
              order.sourceOrderId,
            ),
            shipped: await data.shippedQtyByLine(context, order.orderId),
          })),
        );
        findings = remoteReadbacks.flatMap(({ order, readback, shipped }) => {
          if (readback.status === "missing" && !Object.values(shipped).some((value) => value > 0)) {
            return [];
          }
          const result = reconcileCommerceFulfillment(
            order.orderId,
            shipped,
            readback.status,
            readback.shippedQtyByLine,
          );
          return result ? [{ finding: result }] : [];
        });
      }
      await persistAndRepair(context, started.run, options.leaseOwner, findings, options.now);
      const completed = await runs.complete(
        context,
        started.run.id,
        options.leaseOwner,
        options.now,
      );
      const completedCounts = completed?.counts;
      const counts =
        typeof completedCounts === "object" &&
        completedCounts !== null &&
        !Array.isArray(completedCounts)
          ? (completedCounts as Record<string, unknown>)
          : {};
      return {
        pair,
        runId: started.run.id,
        status: completed ? "completed" : "failed",
        counts,
        findings: findings.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "reconciliation failed";
      await runs.fail(context, started.run.id, options.leaseOwner, message, options.now);
      return {
        pair,
        runId: started.run.id,
        status: "failed",
        counts: { error: message },
        findings: 0,
      };
    }
  }

  return {
    async run(context: TenantContext, input: RunOptions = {}): Promise<ReconciliationRunResult> {
      const now = input.now ?? clock();
      const options = {
        now,
        windowEnd: input.windowEnd ?? now,
        overlapMs: input.overlapMs ?? 5 * 60 * 1000,
        leaseDurationMs:
          input.leaseDurationMs ??
          Math.max(60_000, dependencies.config.reconciliationIntervalMinutes * 60_000),
        pageSize: input.pageSize ?? 50,
        leaseOwner: input.leaseOwner ?? `reconciliation:${randomUUID()}`,
      };
      if (options.pageSize < 1 || options.pageSize > 100)
        throw new Error("reconciliation page size is invalid");
      const pairs: ReconciliationFinding["pair"][] = [
        "commerce_order",
        "warehouse_fulfillment",
        "carrier_shipment",
        "shipment_commerce_fulfillment",
      ];
      const results: ReconciliationPairResult[] = [];
      for (const pair of pairs) results.push(await runPair(context, pair, options));
      return { tenantId: context.tenantId, pairs: results };
    },
  };
}

export type ReconciliationService = ReturnType<typeof createReconciliationService>;
