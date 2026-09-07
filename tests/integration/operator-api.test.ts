import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockAdapterSuite } from "@handoff/adapters";
import { parseConfig } from "@handoff/config";
import { DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import { HttpException, NotFoundException } from "@nestjs/common";
import { OperatorController } from "../../apps/api/src/operator.controller";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

describe.skipIf(!testDatabaseUrl)("operator API seam", () => {
  let handle: DatabaseHandle | undefined;
  let controller: OperatorController;
  const exceptionId = "91111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    await handle.pool.query(
      `insert into exceptions
         (id, tenant_id, order_id, type, severity, status, active_key, machine_summary, evidence, row_version, created_at, updated_at)
       values ($1, $2, $3, 'RECONCILIATION_DRIFT', 'low', 'open', $4, 'Synthetic API drift', '{}', 1, $5, $5)`,
      [
        exceptionId,
        DEMO_TENANTS.northstar,
        "41111111-1111-4111-8111-111111111111",
        "m9:api-drift",
        "2026-01-01T03:00:00.000Z",
      ],
    );
    controller = new OperatorController(
      handle,
      parseConfig({
        APP_ENV: "test",
        DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/handoff_control_tower_test",
        REDIS_URL: "redis://127.0.0.1:56379",
        ADAPTER_MODE: "mock",
        ENABLE_DEMO_SIMULATOR: "false",
      }),
      createMockAdapterSuite(),
    );
  });

  afterAll(async () => closeTestDatabase(handle));

  it("serves the business story and named operator command through one tenant seam", async () => {
    const tenant = DEMO_TENANTS.northstar;
    await expect(controller.overview(tenant, "operator-m9", "viewer")).resolves.toMatchObject({
      counts: { orders: 1, openExceptions: 1 },
    });
    await expect(
      controller.orders(
        tenant,
        undefined,
        "10",
        undefined,
        "false",
        "D1001",
        "operator-m9",
        "viewer",
      ),
    ).resolves.toMatchObject({
      items: [{ orderNumber: "#D1001", releaseStatus: "released" }],
    });
    await expect(
      controller.order(tenant, "41111111-1111-4111-8111-111111111111", "operator-m9", "viewer"),
    ).resolves.toMatchObject({
      order: { number: "#D1001" },
      invoiceEligibility: { eligible: false },
    });
    await expect(
      controller.note(
        tenant,
        "m9-api-note-1",
        "operator-m9",
        exceptionId,
        {
          expectedVersion: 1,
          note: "Synthetic evidence reviewed",
        },
        "operator",
      ),
    ).resolves.toMatchObject({ state: { version: 2 }, effect: { type: "note_added" } });
    await expect(
      controller.exception(tenant, exceptionId, "operator-m9", "viewer"),
    ).resolves.toMatchObject({
      notes: [{ note: "Synthetic evidence reviewed" }],
    });
    await expect(
      controller.reconciliationRuns(tenant, "5", "operator-m9", "viewer"),
    ).resolves.toHaveLength(0);
    await expect(
      controller.order(
        DEMO_TENANTS.bluebird,
        "41111111-1111-4111-8111-111111111111",
        "operator-m9",
        "viewer",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects command requests without an idempotency key", async () => {
    await expect(
      controller.note(
        DEMO_TENANTS.northstar,
        undefined,
        "operator-m9",
        exceptionId,
        {
          expectedVersion: 2,
          note: "missing key",
        },
        "operator",
      ),
    ).rejects.toMatchObject({ response: { error: "X_IDEMPOTENCY_KEY_REQUIRED" } });
  });

  it("requires an authenticated role and prevents viewers from issuing commands", async () => {
    await expect(controller.overview(DEMO_TENANTS.northstar)).rejects.toMatchObject({
      response: { error: "AUTHENTICATION_REQUIRED" },
    });
    await expect(
      controller.note(
        DEMO_TENANTS.northstar,
        "m10-forbidden-command",
        "operator-m10",
        exceptionId,
        { expectedVersion: 2, note: "viewer must not mutate" },
        "viewer",
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 403 &&
        JSON.stringify(error.getResponse()) === JSON.stringify({ error: "FORBIDDEN_ROLE" }),
    );
  });

  it("rate limits bounded reconciliation commands per synthetic operator", async () => {
    if (!handle) throw new Error("test database was not opened");
    const limited = new OperatorController(
      handle,
      parseConfig({
        APP_ENV: "test",
        DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/handoff_control_tower_test",
        REDIS_URL: "redis://127.0.0.1:56379",
        ADAPTER_MODE: "mock",
        ENABLE_DEMO_SIMULATOR: "false",
        RECONCILIATION_RATE_LIMIT_PER_MINUTE: "1",
      }),
      createMockAdapterSuite(),
    );
    await limited.runReconciliation(DEMO_TENANTS.northstar, {}, "operator-m10", "operator");
    await expect(
      limited.runReconciliation(DEMO_TENANTS.northstar, {}, "operator-m10", "operator"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 429 &&
        JSON.stringify(error.getResponse()).includes("RATE_LIMITED"),
    );
  });
});
