import { and, asc, eq, sum } from "drizzle-orm";
import type { CanonicalOrder, FulfillmentActual, Shipment, ShipmentLine } from "@handoff/domain";
import type { Database } from "./client";
import {
  fulfillmentLines,
  fulfillments,
  orderLines,
  orders,
  shipmentLines,
  shipments,
} from "./schema";
import { requireTenantContext, type TenantContext } from "./tenant-context";

function iso(value: Date): string {
  return value.toISOString();
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
    acceptedAt: iso(row.acceptedAt),
    releaseStatus: row.releaseStatus as CanonicalOrder["releaseStatus"],
    lines: lines.map((line) => ({
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

function shipmentFromRows(
  row: typeof shipments.$inferSelect,
  lines: Array<typeof shipmentLines.$inferSelect>,
  orderLineRows: Array<typeof orderLines.$inferSelect>,
): Shipment {
  const lineById = new Map(orderLineRows.map((line) => [line.id, line.sourceLineId]));
  const shipment: Shipment = {
    tenantId: row.tenantId,
    shipmentId: row.sourceShipmentId ?? row.id,
    orderId: row.orderId,
    ...(row.externalShipmentId === null ? {} : { externalShipmentId: row.externalShipmentId }),
    carrierCode: row.carrierCode,
    serviceCode: row.serviceCode,
    trackingNumber: row.trackingNumber,
    ...(row.trackingUrl === null ? {} : { trackingUrl: row.trackingUrl }),
    ...(row.shippedAt === null ? {} : { shippedAt: iso(row.shippedAt) }),
    lines: lines.map((line): ShipmentLine => ({
      lineId: lineById.get(line.orderLineId) ?? line.orderLineId,
      quantity: line.quantity,
    })),
    status: row.status as Shipment["status"],
  };
  return shipment;
}

export function createReconciliationDataRepository(db: Database) {
  async function findOrderById(context: TenantContext, orderId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, orderId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const lines = await db
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, row.id)))
      .orderBy(asc(orderLines.sourceLineId));
    return orderFromRows(row, lines);
  }

  async function findOrder(context: TenantContext, sourceOrderId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.sourceOrderId, sourceOrderId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return findOrderById(context, row.id);
  }

  async function listOrders(context: TenantContext): Promise<CanonicalOrder[]> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.tenantId, scoped.tenantId))
      .orderBy(asc(orders.sourceOrderId));
    const items = await Promise.all(rows.map((row) => findOrderById(context, row.id)));
    return items.filter((item): item is CanonicalOrder => item !== null);
  }

  async function findFulfillment(context: TenantContext, orderId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const order = await findOrderById(context, orderId);
    if (!order) return null;
    const rows = await db
      .select()
      .from(fulfillments)
      .where(and(eq(fulfillments.tenantId, scoped.tenantId), eq(fulfillments.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const lines = await db
      .select()
      .from(fulfillmentLines)
      .where(
        and(
          eq(fulfillmentLines.tenantId, scoped.tenantId),
          eq(fulfillmentLines.fulfillmentId, row.id),
        ),
      )
      .orderBy(asc(fulfillmentLines.orderLineId));
    const orderLineRows = await db
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, orderId)));
    const lineByRowId = new Map(
      orderLineRows.map((line) => [line.id, `${order.sourceOrderId}:${line.sourceLineId}`]),
    );
    const domainLines = lines.map((line) => ({
      lineId: lineByRowId.get(line.orderLineId) ?? line.orderLineId,
      allocatedQty: line.allocatedQty,
      pickedQty: line.pickedQty,
      packedQty: line.packedQty,
      shippedQty: line.shippedQty,
      shortQty: line.shortQty,
      damagedQty: line.damagedQty,
    }));
    const sourceVersion =
      row.sourceVersion && /^\d+$/.test(row.sourceVersion)
        ? Number(row.sourceVersion)
        : row.rowVersion;
    return {
      tenantId: row.tenantId,
      orderId: order.orderId,
      ...(row.warehouseOrderId === null ? {} : { warehouseOrderId: row.warehouseOrderId }),
      status: row.status as FulfillmentActual["status"],
      lines: domainLines,
      version:
        Number.isSafeInteger(sourceVersion) && sourceVersion > 0 ? sourceVersion : row.rowVersion,
    } satisfies FulfillmentActual;
  }

  async function listFulfillments(context: TenantContext): Promise<FulfillmentActual[]> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(fulfillments)
      .where(eq(fulfillments.tenantId, scoped.tenantId))
      .orderBy(asc(fulfillments.orderId));
    const items = await Promise.all(rows.map((row) => findFulfillment(context, row.orderId)));
    return items.filter((item): item is FulfillmentActual => item !== null);
  }

  async function findShipment(context: TenantContext, sourceShipmentId: string) {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.tenantId, scoped.tenantId),
          eq(shipments.sourceShipmentId, sourceShipmentId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const lines = await db
      .select()
      .from(shipmentLines)
      .where(and(eq(shipmentLines.tenantId, scoped.tenantId), eq(shipmentLines.shipmentId, row.id)))
      .orderBy(asc(shipmentLines.orderLineId));
    const orderLineRows = await db
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, row.orderId)));
    return shipmentFromRows(row, lines, orderLineRows);
  }

  async function listShipments(context: TenantContext): Promise<Shipment[]> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(shipments)
      .where(eq(shipments.tenantId, scoped.tenantId))
      .orderBy(asc(shipments.sourceShipmentId));
    const items = await Promise.all(
      rows
        .filter(
          (row): row is typeof row & { sourceShipmentId: string } => row.sourceShipmentId !== null,
        )
        .map((row) => findShipment(context, row.sourceShipmentId)),
    );
    return items.filter((item): item is Shipment => item !== null);
  }

  async function listShipmentsForOrder(
    context: TenantContext,
    orderId: string,
  ): Promise<Shipment[]> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select()
      .from(shipments)
      .where(and(eq(shipments.tenantId, scoped.tenantId), eq(shipments.orderId, orderId)))
      .orderBy(asc(shipments.createdAt));
    const items = await Promise.all(
      rows
        .filter(
          (row): row is typeof row & { sourceShipmentId: string } => row.sourceShipmentId !== null,
        )
        .map((row) => findShipment(context, row.sourceShipmentId)),
    );
    return items.filter((item): item is Shipment => item !== null);
  }

  async function shippedQtyByLine(
    context: TenantContext,
    orderId: string,
  ): Promise<Record<string, number>> {
    const scoped = requireTenantContext(context.tenantId);
    const rows = await db
      .select({
        sourceLineId: orderLines.sourceLineId,
        shippedQty: sum(fulfillmentLines.shippedQty),
      })
      .from(fulfillmentLines)
      .innerJoin(fulfillments, eq(fulfillmentLines.fulfillmentId, fulfillments.id))
      .innerJoin(orderLines, eq(fulfillmentLines.orderLineId, orderLines.id))
      .where(
        and(
          eq(fulfillmentLines.tenantId, scoped.tenantId),
          eq(fulfillments.tenantId, scoped.tenantId),
          eq(fulfillments.orderId, orderId),
          eq(orderLines.tenantId, scoped.tenantId),
        ),
      )
      .groupBy(orderLines.sourceLineId);
    const order = await findOrderById(context, orderId);
    if (!order) return {};
    return Object.fromEntries(
      rows.map((row) => [
        `${order.sourceOrderId}:${row.sourceLineId}`,
        Number(row.shippedQty ?? 0),
      ]),
    );
  }

  return {
    findOrder,
    findOrderById,
    listOrders,
    findFulfillment,
    listFulfillments,
    findShipment,
    listShipments,
    listShipmentsForOrder,
    shippedQtyByLine,
  };
}

export type ReconciliationDataRepository = ReturnType<typeof createReconciliationDataRepository>;
