import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOperatorRepository, DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

describe.skipIf(!testDatabaseUrl)("operator read model", () => {
  let handle: DatabaseHandle | undefined;
  let repository: ReturnType<typeof createOperatorRepository>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    repository = createOperatorRepository(handle.db);
    await handle.pool.query(
      `insert into exceptions
         (id, tenant_id, order_id, type, severity, status, active_key, machine_summary, evidence, row_version, created_at, updated_at)
       values ($1, $2, $3, 'RECONCILIATION_DRIFT', 'medium', 'open', $4, 'Synthetic operator finding', '{"source":"mock"}', 1, $5, $5)`,
      [
        "81111111-1111-4111-8111-111111111111",
        DEMO_TENANTS.northstar,
        "41111111-1111-4111-8111-111111111111",
        "m9:operator-finding",
        "2026-01-01T03:00:00.000Z",
      ],
    );
  });

  afterAll(async () => closeTestDatabase(handle));

  it("returns tenant-scoped overview, cursor list, detail, and exception evidence", async () => {
    const context = { tenantId: DEMO_TENANTS.northstar };
    await expect(repository.overview(context)).resolves.toMatchObject({
      tenantId: DEMO_TENANTS.northstar,
      counts: { orders: 1, openExceptions: 1 },
    });
    await expect(repository.listOrders(context, { limit: 1 })).resolves.toMatchObject({
      items: [{ orderNumber: "#D1001", sourceOrderId: "COM-DEMO-1001" }],
    });
    const detail = await repository.getOrder(context, "41111111-1111-4111-8111-111111111111");
    expect(detail).toMatchObject({
      order: { number: "#D1001", releaseStatus: "released" },
      invoiceEligibility: { eligible: false },
    });
    const exceptions = await repository.listExceptions(context, { status: "open" });
    expect(exceptions).toMatchObject([
      { type: "RECONCILIATION_DRIFT", orderNumber: "#D1001", sourceOrderId: "COM-DEMO-1001" },
    ]);
    const exception = await repository.getException(
      context,
      "81111111-1111-4111-8111-111111111111",
    );
    expect(exception).toMatchObject({
      exception: { type: "RECONCILIATION_DRIFT" },
      notes: [],
      commands: [],
    });
  });

  it("does not expose another tenant's order or exception", async () => {
    const context = { tenantId: DEMO_TENANTS.bluebird };
    await expect(
      repository.getOrder(context, "41111111-1111-4111-8111-111111111111"),
    ).resolves.toBeNull();
    await expect(
      repository.getException(context, "81111111-1111-4111-8111-111111111111"),
    ).resolves.toBeNull();
    await expect(repository.listExceptions(context)).resolves.toEqual([]);
  });
});
