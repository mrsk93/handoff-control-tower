import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createReconciliationRepository,
  DEMO_TENANTS,
  ReconciliationLeaseBusyError,
  type DatabaseHandle,
} from "@handoff/db";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

describe.skipIf(!testDatabaseUrl)("reconciliation run persistence", () => {
  let handle: DatabaseHandle | undefined;
  let repository: ReturnType<typeof createReconciliationRepository>;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
    repository = createReconciliationRepository(handle.db);
  });

  afterAll(async () => closeTestDatabase(handle));

  it("leases a bounded run, persists pages, and advances an overlapping watermark", async () => {
    if (!handle) throw new Error("test database was not opened");
    const firstNow = new Date("2026-01-01T01:00:00.000Z");
    const firstEnd = new Date("2026-01-01T02:00:00.000Z");
    const first = await repository.start(
      { tenantId: DEMO_TENANTS.northstar },
      {
        pair: "commerce_order",
        resourceType: "order",
        windowEnd: firstEnd,
        overlapMs: 5 * 60 * 1000,
        leaseOwner: "reconciler-a",
        leaseDurationMs: 2 * 60 * 60 * 1000,
        now: firstNow,
      },
    );
    const finding = await repository.persistPage(
      { tenantId: DEMO_TENANTS.northstar },
      first.run.id,
      "reconciler-a",
      "commerce_order:next",
      [
        {
          pair: "commerce_order",
          resourceType: "order",
          resourceKey: "COM-RECON-1",
          category: "missing_local",
          sourceValues: { sourceVersion: "1" },
          evidence: { sourceOrderId: "COM-RECON-1" },
          recommendedAction: "apply_authoritative_order",
          autoRepairable: true,
        },
      ],
      { detected: 1, repaired: 0, manual: 1 },
      firstNow,
    );
    expect(finding).toHaveLength(1);
    expect(
      (
        await repository.markFindingRepaired(
          { tenantId: DEMO_TENANTS.northstar },
          first.run.id,
          finding[0]!.id,
          "auto_repaired",
        )
      )?.repairStatus,
    ).toBe("auto_repaired");
    await expect(
      repository.complete(
        { tenantId: DEMO_TENANTS.northstar },
        first.run.id,
        "reconciler-a",
        firstEnd,
      ),
    ).resolves.toMatchObject({ status: "completed" });

    const second = await repository.start(
      { tenantId: DEMO_TENANTS.northstar },
      {
        pair: "commerce_order",
        resourceType: "order",
        windowEnd: new Date("2026-01-01T03:00:00.000Z"),
        overlapMs: 5 * 60 * 1000,
        leaseOwner: "reconciler-b",
        leaseDurationMs: 60_000,
        now: firstEnd,
      },
    );
    expect(second.windowStart).toEqual(new Date("2026-01-01T01:55:00.000Z"));
    await repository.fail(
      { tenantId: DEMO_TENANTS.northstar },
      second.run.id,
      "reconciler-b",
      "synthetic failure",
      firstEnd,
    );
  });

  it("prevents a second active worker from taking the same tenant pair", async () => {
    const now = new Date("2026-01-02T01:00:00.000Z");
    const run = await repository.start(
      { tenantId: DEMO_TENANTS.bluebird },
      {
        pair: "carrier_shipment",
        resourceType: "shipment",
        windowEnd: new Date("2026-01-02T02:00:00.000Z"),
        overlapMs: 0,
        leaseOwner: "reconciler-a",
        leaseDurationMs: 60_000,
        now,
      },
    );
    await expect(
      repository.start(
        { tenantId: DEMO_TENANTS.bluebird },
        {
          pair: "carrier_shipment",
          resourceType: "shipment",
          windowEnd: new Date("2026-01-02T03:00:00.000Z"),
          overlapMs: 0,
          leaseOwner: "reconciler-b",
          leaseDurationMs: 60_000,
          now,
        },
      ),
    ).rejects.toBeInstanceOf(ReconciliationLeaseBusyError);
    await repository.fail(
      { tenantId: DEMO_TENANTS.bluebird },
      run.run.id,
      "reconciler-a",
      "cleanup",
      now,
    );
  });
});
