export type TenantContext = {
  tenantId: string;
};

export function requireTenantContext(tenantId: string): TenantContext {
  if (!tenantId || tenantId.trim().length === 0) {
    throw new Error("tenantId is required for tenant-scoped database access");
  }
  return { tenantId: tenantId.trim() };
}
