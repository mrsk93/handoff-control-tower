import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { connections, orders, tenants } from "./schema";
import { requireTenantContext, type TenantContext } from "./tenant-context";

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
