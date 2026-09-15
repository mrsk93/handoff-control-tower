import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
  CanonicalCustomer,
  CanonicalOrder,
  CanonicalOrderLine,
  CanonicalSku,
  Shipment,
  ShipmentLine,
} from "@handoff/domain";
import type { Database } from "./client";
import type { Transaction } from "./transaction";
import { requireTenantContext, type TenantContext } from "./tenant-context";
import { catalogItems, customers, orderLines, orders, shipmentLines, shipments } from "./schema";

export class CanonicalRevisionConflictError extends Error {
  readonly code = "CANONICAL_REVISION_CONFLICT";

  constructor(
    readonly resource: "order" | "shipment",
    readonly sourceId: string,
    readonly existingVersion: string | null,
    readonly incomingVersion: string | null,
  ) {
    super(`${resource} revision conflicts with an existing source version: ${sourceId}`);
    this.name = "CanonicalRevisionConflictError";
  }
}

export class CanonicalScopeError extends Error {
  readonly code = "CANONICAL_SCOPE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CanonicalScopeError";
  }
}

export type CatalogItemSnapshot = Pick<
  CanonicalSku,
  "id" | "sku" | "normalizedSku" | "name" | "active" | "requiresShipping" | "unit"
> & {
  barcode?: string;
  weight?: unknown;
  dimensions?: unknown;
  sourceUpdatedAt?: string;
};

function hashSnapshot(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function compareVersions(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function asDate(value: string | undefined, fallback: Date): Date {
  return value === undefined ? fallback : new Date(value);
}

function customerFromRow(row: typeof customers.$inferSelect): CanonicalCustomer {
  const customer: CanonicalCustomer = {
    id: row.id,
    tenantId: row.tenantId,
    displayName: row.displayName,
    shippingAddresses: row.shippingAddresses as CanonicalCustomer["shippingAddresses"],
    externalRefs: [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.email !== null) customer.email = row.email;
  if (row.phone !== null) customer.phone = row.phone;
  if (row.billingAddress !== null) {
    customer.billingAddress = row.billingAddress as NonNullable<
      CanonicalCustomer["billingAddress"]
    >;
  }
  return customer;
}

function orderLineFromRow(
  order: typeof orders.$inferSelect,
  line: typeof orderLines.$inferSelect,
): CanonicalOrderLine {
  const result: CanonicalOrderLine = {
    lineId: `${order.sourceOrderId}:${line.sourceLineId}`,
    sourceLineId: line.sourceLineId,
    sku: line.sku,
    orderedQty: line.orderedQty,
    cancelledQty: line.cancelledQty,
  };
  if (line.title !== null) result.title = line.title;
  if (line.unit !== null) result.unit = line.unit as NonNullable<CanonicalOrderLine["unit"]>;
  if (line.orderedQuantity !== null) {
    result.orderedQuantity = line.orderedQuantity as NonNullable<
      CanonicalOrderLine["orderedQuantity"]
    >;
  }
  if (line.unitPriceMinor !== null) {
    result.unitPrice = { amountMinor: line.unitPriceMinor, currency: order.currency };
  }
  if (line.discountTotalMinor !== null) {
    result.discountTotal = { amountMinor: line.discountTotalMinor, currency: order.currency };
  }
  if (line.taxTotalMinor !== null) {
    result.taxTotal = { amountMinor: line.taxTotalMinor, currency: order.currency };
  }
  return result;
}

function orderFromRows(
  row: typeof orders.$inferSelect,
  lines: Array<typeof orderLines.$inferSelect>,
  customer?: typeof customers.$inferSelect,
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
    lines: lines.map((line) => orderLineFromRow(row, line)),
  };
  if (row.cancelledAt) order.cancelledAt = row.cancelledAt.toISOString();
  if (row.customerId) order.customerId = row.customerId;
  if (customer) order.customer = customerFromRow(customer);
  if (row.lifecycleStatus) {
    order.lifecycleStatus = row.lifecycleStatus as NonNullable<CanonicalOrder["lifecycleStatus"]>;
  }
  if (row.financialStatus) order.financialStatus = row.financialStatus;
  if (row.requestedShippingMethod) order.requestedShippingMethod = row.requestedShippingMethod;
  if (row.shippingAddress) {
    order.shippingAddress = row.shippingAddress as NonNullable<CanonicalOrder["shippingAddress"]>;
  }
  if (row.billingAddress) {
    order.billingAddress = row.billingAddress as NonNullable<CanonicalOrder["billingAddress"]>;
  }
  if (row.subtotalMinor !== null)
    order.subtotal = { amountMinor: row.subtotalMinor, currency: row.currency };
  if (row.shippingTotalMinor !== null)
    order.shippingTotal = { amountMinor: row.shippingTotalMinor, currency: row.currency };
  if (row.taxTotalMinor !== null)
    order.taxTotal = { amountMinor: row.taxTotalMinor, currency: row.currency };
  if (row.discountTotalMinor !== null)
    order.discountTotal = { amountMinor: row.discountTotalMinor, currency: row.currency };
  if (row.grandTotalMinor !== null)
    order.grandTotal = { amountMinor: row.grandTotalMinor, currency: row.currency };
  if (row.sourceUpdatedAt) order.sourceUpdatedAt = row.sourceUpdatedAt.toISOString();
  if (row.observedAt) order.observedAt = row.observedAt.toISOString();
  return order;
}

function shipmentLineFromRow(
  line: typeof shipmentLines.$inferSelect,
  orderLine: typeof orderLines.$inferSelect,
): ShipmentLine {
  return { lineId: orderLine.sourceLineId, quantity: line.quantity };
}

async function findOrderRows(
  transaction: Transaction,
  tenantId: string,
  orderId: string,
): Promise<{
  order: typeof orders.$inferSelect;
  lines: Array<typeof orderLines.$inferSelect>;
  customer?: typeof customers.$inferSelect;
} | null> {
  const orderRows = await transaction
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  const order = orderRows[0];
  if (!order) return null;
  const [lines, customerRows] = await Promise.all([
    transaction
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.tenantId, tenantId), eq(orderLines.orderId, order.id)))
      .orderBy(asc(orderLines.sourceLineId)),
    order.customerId
      ? transaction
          .select()
          .from(customers)
          .where(and(eq(customers.tenantId, tenantId), eq(customers.id, order.customerId)))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const result: {
    order: typeof order;
    lines: Array<typeof orderLines.$inferSelect>;
    customer?: typeof customers.$inferSelect;
  } = { order, lines };
  if (customerRows[0]) result.customer = customerRows[0];
  return result;
}

async function saveCustomer(
  transaction: Transaction,
  tenantId: string,
  customer: CanonicalCustomer,
  now: Date,
): Promise<typeof customers.$inferSelect> {
  if (customer.tenantId !== tenantId) {
    throw new CanonicalScopeError("customer tenant does not match the repository context");
  }
  const existingRows = await transaction
    .select()
    .from(customers)
    .where(eq(customers.id, customer.id))
    .limit(1);
  if (existingRows[0] && existingRows[0].tenantId !== tenantId) {
    throw new CanonicalScopeError("customer belongs to another tenant");
  }
  const values = {
    id: customer.id,
    tenantId,
    email: customer.email ?? null,
    displayName: customer.displayName,
    phone: customer.phone ?? null,
    billingAddress: customer.billingAddress ?? null,
    shippingAddresses: customer.shippingAddresses,
    createdAt: existingRows[0]?.createdAt ?? now,
    updatedAt: now,
  };
  const rows = await transaction
    .insert(customers)
    .values(values)
    .onConflictDoUpdate({
      target: customers.id,
      set: {
        email: values.email,
        displayName: values.displayName,
        phone: values.phone,
        billingAddress: values.billingAddress,
        shippingAddresses: values.shippingAddresses,
        updatedAt: now,
      },
    })
    .returning();
  const result =
    rows[0] ??
    (await transaction.select().from(customers).where(eq(customers.id, customer.id)).limit(1))[0];
  if (!result) throw new Error("customer disappeared after persistence");
  return result;
}

async function persistOrderLines(
  transaction: Transaction,
  tenantId: string,
  order: CanonicalOrder,
): Promise<void> {
  for (const line of order.lines) {
    const skuRows = await transaction
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.tenantId, tenantId),
          eq(catalogItems.normalizedSku, line.sku.trim().toLowerCase()),
        ),
      )
      .limit(1);
    const values = {
      id: randomUUID(),
      tenantId,
      orderId: order.orderId,
      sourceLineId: line.sourceLineId,
      lineNumber: null,
      skuId: skuRows[0]?.id ?? null,
      sku: line.sku,
      title: line.title ?? null,
      unit: line.unit ?? null,
      orderedQuantity: line.orderedQuantity ?? null,
      unitPriceMinor: line.unitPrice?.amountMinor ?? null,
      discountTotalMinor: line.discountTotal?.amountMinor ?? null,
      taxTotalMinor: line.taxTotal?.amountMinor ?? null,
      orderedQty: line.orderedQty,
      cancelledQty: line.cancelledQty,
    };
    await transaction
      .insert(orderLines)
      .values(values)
      .onConflictDoUpdate({
        target: [orderLines.orderId, orderLines.sourceLineId],
        set: {
          lineNumber: null,
          skuId: values.skuId,
          sku: values.sku,
          title: values.title,
          unit: values.unit,
          orderedQuantity: values.orderedQuantity,
          unitPriceMinor: values.unitPriceMinor,
          discountTotalMinor: values.discountTotalMinor,
          taxTotalMinor: values.taxTotalMinor,
          orderedQty: values.orderedQty,
          cancelledQty: values.cancelledQty,
        },
      });
  }
}

export function createCanonicalRepository(db: Database) {
  async function findOrder(
    context: TenantContext,
    orderId: string,
  ): Promise<CanonicalOrder | null> {
    const scoped = requireTenantContext(context.tenantId);
    return db.transaction(async (transaction) => {
      const rows = await findOrderRows(transaction, scoped.tenantId, orderId);
      return rows ? orderFromRows(rows.order, rows.lines, rows.customer) : null;
    });
  }

  return {
    async upsertCatalogItem(
      context: TenantContext,
      item: CatalogItemSnapshot,
      now = new Date(),
    ): Promise<typeof catalogItems.$inferSelect> {
      const scoped = requireTenantContext(context.tenantId);
      const existing = await db
        .select()
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.tenantId, scoped.tenantId),
            eq(catalogItems.normalizedSku, item.normalizedSku),
          ),
        )
        .limit(1);
      if (existing[0] && existing[0].id !== item.id) {
        throw new CanonicalScopeError("normalized SKU is already bound to another catalog item");
      }
      const values = {
        id: item.id,
        tenantId: scoped.tenantId,
        sku: item.sku,
        normalizedSku: item.normalizedSku,
        name: item.name,
        barcode: item.barcode ?? null,
        active: item.active,
        requiresShipping: item.requiresShipping,
        unit: item.unit,
        weight: item.weight ?? null,
        dimensions: item.dimensions ?? null,
        sourceUpdatedAt: item.sourceUpdatedAt ? new Date(item.sourceUpdatedAt) : null,
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
      };
      const rows = await db
        .insert(catalogItems)
        .values(values)
        .onConflictDoUpdate({
          target: [catalogItems.tenantId, catalogItems.normalizedSku],
          set: {
            sku: values.sku,
            name: values.name,
            barcode: values.barcode,
            active: values.active,
            requiresShipping: values.requiresShipping,
            unit: values.unit,
            weight: values.weight,
            dimensions: values.dimensions,
            sourceUpdatedAt: values.sourceUpdatedAt,
            updatedAt: now,
          },
        })
        .returning();
      const result =
        rows[0] ??
        (await db.select().from(catalogItems).where(eq(catalogItems.id, item.id)).limit(1))[0];
      if (!result) throw new Error("catalog item disappeared after persistence");
      return result;
    },

    async upsertCustomer(
      context: TenantContext,
      customer: CanonicalCustomer,
      now = new Date(),
    ): Promise<typeof customers.$inferSelect> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction((transaction) =>
        saveCustomer(transaction, scoped.tenantId, customer, now),
      );
    },

    async upsertOrder(
      context: TenantContext,
      order: CanonicalOrder,
      now = new Date(),
    ): Promise<{ created: boolean; changed: boolean; stale: boolean; order: CanonicalOrder }> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        const existingRows = await transaction
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, scoped.tenantId),
              eq(orders.sourceOrderId, order.sourceOrderId),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        const canonicalHash = hashSnapshot(order);
        if (existing) {
          if (existing.id !== order.orderId) {
            throw new CanonicalRevisionConflictError(
              "order",
              order.sourceOrderId,
              existing.sourceVersion,
              order.sourceVersion,
            );
          }
          const comparison = compareVersions(order.sourceVersion, existing.sourceVersion);
          if (comparison < 0) {
            const rows = await findOrderRows(transaction, scoped.tenantId, existing.id);
            if (!rows) throw new Error("existing order disappeared during revision check");
            return {
              created: false,
              changed: false,
              stale: true,
              order: orderFromRows(rows.order, rows.lines, rows.customer),
            };
          }
          if (comparison === 0) {
            if (existing.canonicalHash !== canonicalHash) {
              throw new CanonicalRevisionConflictError(
                "order",
                order.sourceOrderId,
                existing.sourceVersion,
                order.sourceVersion,
              );
            }
            const rows = await findOrderRows(transaction, scoped.tenantId, existing.id);
            if (!rows) throw new Error("existing order disappeared during no-op check");
            return {
              created: false,
              changed: false,
              stale: false,
              order: orderFromRows(rows.order, rows.lines, rows.customer),
            };
          }
        }

        if (order.tenantId !== scoped.tenantId) {
          throw new CanonicalScopeError("order tenant does not match the repository context");
        }
        let customerId = order.customerId ?? existing?.customerId ?? null;
        if (order.customer) {
          const customer = await saveCustomer(transaction, scoped.tenantId, order.customer, now);
          customerId = customer.id;
        } else if (customerId) {
          const customerRows = await transaction
            .select({ tenantId: customers.tenantId })
            .from(customers)
            .where(eq(customers.id, customerId))
            .limit(1);
          if (!customerRows[0] || customerRows[0].tenantId !== scoped.tenantId) {
            throw new CanonicalScopeError("customer belongs to another tenant");
          }
        }

        const values = {
          id: order.orderId,
          tenantId: scoped.tenantId,
          source: order.source,
          sourceOrderId: order.sourceOrderId,
          sourceVersion: order.sourceVersion,
          orderNumber: order.orderNumber,
          currency: order.currency,
          customerId,
          lifecycleStatus: order.lifecycleStatus ?? null,
          financialStatus: order.financialStatus ?? null,
          requestedShippingMethod: order.requestedShippingMethod ?? null,
          shippingAddress: order.shippingAddress ?? null,
          billingAddress: order.billingAddress ?? null,
          subtotalMinor: order.subtotal?.amountMinor ?? null,
          shippingTotalMinor: order.shippingTotal?.amountMinor ?? null,
          taxTotalMinor: order.taxTotal?.amountMinor ?? null,
          discountTotalMinor: order.discountTotal?.amountMinor ?? null,
          grandTotalMinor: order.grandTotal?.amountMinor ?? null,
          sourceUpdatedAt: order.sourceUpdatedAt ? new Date(order.sourceUpdatedAt) : null,
          observedAt: order.observedAt ? new Date(order.observedAt) : now,
          acceptedAt: new Date(order.acceptedAt),
          cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
          releaseStatus: order.releaseStatus,
          canonicalHash,
          rowVersion: existing ? existing.rowVersion + 1 : 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) {
          await transaction
            .update(orders)
            .set({
              sourceVersion: values.sourceVersion,
              customerId: values.customerId,
              lifecycleStatus: values.lifecycleStatus,
              financialStatus: values.financialStatus,
              requestedShippingMethod: values.requestedShippingMethod,
              shippingAddress: values.shippingAddress,
              billingAddress: values.billingAddress,
              subtotalMinor: values.subtotalMinor,
              shippingTotalMinor: values.shippingTotalMinor,
              taxTotalMinor: values.taxTotalMinor,
              discountTotalMinor: values.discountTotalMinor,
              grandTotalMinor: values.grandTotalMinor,
              sourceUpdatedAt: values.sourceUpdatedAt,
              observedAt: values.observedAt,
              cancelledAt: values.cancelledAt,
              releaseStatus: values.releaseStatus,
              canonicalHash: values.canonicalHash,
              rowVersion: sql`${orders.rowVersion} + 1`,
              updatedAt: now,
            })
            .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, existing.id)));
        } else {
          await transaction.insert(orders).values(values);
        }
        await persistOrderLines(transaction, scoped.tenantId, order);
        const rows = await findOrderRows(transaction, scoped.tenantId, order.orderId);
        if (!rows) throw new Error("order disappeared after persistence");
        return {
          created: !existing,
          changed: true,
          stale: false,
          order: orderFromRows(rows.order, rows.lines, rows.customer),
        };
      });
    },

    findOrder,

    async upsertShipmentEvidence(
      context: TenantContext,
      shipment: Shipment,
      now = new Date(),
    ): Promise<{ created: boolean; changed: boolean; stale: boolean; shipment: Shipment }> {
      const scoped = requireTenantContext(context.tenantId);
      return db.transaction(async (transaction) => {
        if (shipment.tenantId !== scoped.tenantId) {
          throw new CanonicalScopeError("shipment tenant does not match the repository context");
        }
        const orderRows = await transaction
          .select()
          .from(orders)
          .where(and(eq(orders.tenantId, scoped.tenantId), eq(orders.id, shipment.orderId)))
          .limit(1);
        const order = orderRows[0];
        if (!order)
          throw new CanonicalScopeError("shipment order belongs to another tenant or is missing");
        const orderLineRows = await transaction
          .select()
          .from(orderLines)
          .where(and(eq(orderLines.tenantId, scoped.tenantId), eq(orderLines.orderId, order.id)));
        const lineBySourceId = new Map(orderLineRows.map((line) => [line.sourceLineId, line]));
        for (const line of shipment.lines) {
          if (!lineBySourceId.has(line.lineId))
            throw new CanonicalScopeError(`shipment line is not on order: ${line.lineId}`);
        }
        const observedAt = asDate(shipment.observedAt, now);
        const sourceUpdatedAt = asDate(shipment.occurredAt, observedAt);
        const existingRows = await transaction
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, scoped.tenantId),
              eq(shipments.sourceShipmentId, shipment.shipmentId),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        if (existing) {
          if (existing.observedAt && observedAt < existing.observedAt) {
            return {
              created: false,
              changed: false,
              stale: true,
              shipment: await hydrateShipment(
                transaction,
                scoped.tenantId,
                existing,
                orderLineRows,
              ),
            };
          }
          if (existing.observedAt?.getTime() === observedAt.getTime()) {
            const existingLines = await transaction
              .select()
              .from(shipmentLines)
              .where(
                and(
                  eq(shipmentLines.tenantId, scoped.tenantId),
                  eq(shipmentLines.shipmentId, existing.id),
                ),
              );
            if (shipmentMatches(existing, existingLines, shipment, lineBySourceId)) {
              return {
                created: false,
                changed: false,
                stale: false,
                shipment: await hydrateShipment(
                  transaction,
                  scoped.tenantId,
                  existing,
                  orderLineRows,
                ),
              };
            }
            throw new CanonicalRevisionConflictError(
              "shipment",
              shipment.shipmentId,
              existing.sourceUpdatedAt?.toISOString() ?? null,
              shipment.sourceVersion ?? null,
            );
          }
          await transaction
            .update(shipments)
            .set({
              externalShipmentId: shipment.externalShipmentId ?? null,
              carrierCode: shipment.carrierCode,
              serviceCode: shipment.serviceCode,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: shipment.trackingUrl ?? null,
              shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : null,
              deliveredAt: shipment.deliveredAt ? new Date(shipment.deliveredAt) : null,
              sourceUpdatedAt,
              observedAt,
              status: shipment.status,
              updatedAt: now,
            })
            .where(and(eq(shipments.tenantId, scoped.tenantId), eq(shipments.id, existing.id)));
          await persistShipmentLines(
            transaction,
            scoped.tenantId,
            existing.id,
            shipment,
            lineBySourceId,
          );
          const rows = await transaction
            .select()
            .from(shipments)
            .where(eq(shipments.id, existing.id))
            .limit(1);
          if (!rows[0]) throw new Error("shipment disappeared after update");
          return {
            created: false,
            changed: true,
            stale: false,
            shipment: await hydrateShipment(transaction, scoped.tenantId, rows[0], orderLineRows),
          };
        }
        const insertedRows = await transaction
          .insert(shipments)
          .values({
            id: randomUUID(),
            tenantId: scoped.tenantId,
            orderId: order.id,
            fulfillmentId: null,
            provider: "wms",
            sourceShipmentId: shipment.shipmentId,
            externalShipmentId: shipment.externalShipmentId ?? null,
            carrierCode: shipment.carrierCode,
            serviceCode: shipment.serviceCode,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl ?? null,
            shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : null,
            deliveredAt: shipment.deliveredAt ? new Date(shipment.deliveredAt) : null,
            sourceUpdatedAt,
            observedAt,
            status: shipment.status,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const inserted = insertedRows[0];
        if (!inserted) throw new Error("shipment insert did not return a row");
        await persistShipmentLines(
          transaction,
          scoped.tenantId,
          inserted.id,
          shipment,
          lineBySourceId,
        );
        return {
          created: true,
          changed: true,
          stale: false,
          shipment: await hydrateShipment(transaction, scoped.tenantId, inserted, orderLineRows),
        };
      });
    },
  };
}

async function persistShipmentLines(
  transaction: Transaction,
  tenantId: string,
  shipmentId: string,
  shipment: Shipment,
  lineBySourceId: Map<string, typeof orderLines.$inferSelect>,
): Promise<void> {
  for (const line of shipment.lines) {
    const orderLine = lineBySourceId.get(line.lineId);
    if (!orderLine) throw new CanonicalScopeError(`shipment line is not on order: ${line.lineId}`);
    await transaction
      .insert(shipmentLines)
      .values({
        id: randomUUID(),
        tenantId,
        shipmentId,
        orderLineId: orderLine.id,
        quantity: line.quantity,
      })
      .onConflictDoUpdate({
        target: [shipmentLines.shipmentId, shipmentLines.orderLineId],
        set: { quantity: line.quantity },
      });
  }
}

async function hydrateShipment(
  transaction: Transaction,
  tenantId: string,
  row: typeof shipments.$inferSelect,
  orderLineRows: Array<typeof orderLines.$inferSelect>,
): Promise<Shipment> {
  const lines = await transaction
    .select()
    .from(shipmentLines)
    .where(and(eq(shipmentLines.tenantId, tenantId), eq(shipmentLines.shipmentId, row.id)));
  const lineById = new Map(orderLineRows.map((line) => [line.id, line]));
  const result: Shipment = {
    tenantId: row.tenantId,
    shipmentId: row.sourceShipmentId ?? row.id,
    orderId: row.orderId,
    carrierCode: row.carrierCode,
    serviceCode: row.serviceCode,
    trackingNumber: row.trackingNumber,
    lines: lines.map((line) => shipmentLineFromRow(line, lineById.get(line.orderLineId)!)),
    status: row.status as Shipment["status"],
  };
  if (row.externalShipmentId) result.externalShipmentId = row.externalShipmentId;
  if (row.trackingUrl) result.trackingUrl = row.trackingUrl;
  if (row.shippedAt) result.shippedAt = row.shippedAt.toISOString();
  if (row.deliveredAt) result.deliveredAt = row.deliveredAt.toISOString();
  if (row.sourceUpdatedAt) result.occurredAt = row.sourceUpdatedAt.toISOString();
  if (row.observedAt) result.observedAt = row.observedAt.toISOString();
  return result;
}

function shipmentMatches(
  row: typeof shipments.$inferSelect,
  lines: Array<typeof shipmentLines.$inferSelect>,
  incoming: Shipment,
  lineBySourceId: Map<string, typeof orderLines.$inferSelect>,
): boolean {
  if (
    row.externalShipmentId !== (incoming.externalShipmentId ?? null) ||
    row.carrierCode !== incoming.carrierCode ||
    row.serviceCode !== incoming.serviceCode ||
    row.trackingNumber !== incoming.trackingNumber ||
    row.trackingUrl !== (incoming.trackingUrl ?? null) ||
    row.status !== incoming.status ||
    lines.length !== incoming.lines.length
  )
    return false;
  return incoming.lines.every((line) => {
    const orderLine = lineBySourceId.get(line.lineId);
    return lines.some(
      (stored) => stored.orderLineId === orderLine?.id && stored.quantity === line.quantity,
    );
  });
}
