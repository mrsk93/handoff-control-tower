import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSyncOperationRepository, DEMO_TENANTS, type DatabaseHandle } from "@handoff/db";
import {
  createSyncOperationExecutor,
  RemoteResultUnknownError,
  type SyncOperationHandlers,
} from "@handoff/queue";
import { closeTestDatabase, openPreparedTestDatabase, testDatabaseUrl } from "./helpers";

const now = new Date("2026-01-01T01:00:00.000Z");
const northstarContext = { tenantId: DEMO_TENANTS.northstar };
const northstarCommerce = "31111111-1111-4111-8111-111111111111";

function operationInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: northstarCommerce,
    workflowType: "shopify_order_hydration",
    aggregateType: "order",
    aggregateId: "COM-T019-1001",
    direction: "pull",
    idempotencyKey: "t019-operation-1001",
    commandHash: "hash-t019-1001",
    ...overrides,
  } as Parameters<ReturnType<typeof createSyncOperationRepository>["createOrGet"]>[1];
}

describe.skipIf(!testDatabaseUrl)("sync operation claims", () => {
  let handle: DatabaseHandle | undefined;

  beforeAll(async () => {
    handle = await openPreparedTestDatabase();
  });

  afterAll(async () => closeTestDatabase(handle));

  it("deduplicates equal business commands and rejects a same-key different command", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createSyncOperationRepository(handle.db);
    const first = await repository.createOrGet(northstarContext, operationInput(), now);
    const duplicate = await repository.createOrGet(
      northstarContext,
      operationInput(),
      new Date(now.getTime() + 1),
    );
    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ duplicate: true, operation: { id: first.operation.id } });
    await expect(
      repository.createOrGet(
        northstarContext,
        operationInput({ commandHash: "different-command-hash" }),
        now,
      ),
    ).rejects.toMatchObject({ code: "SYNC_OPERATION_CONFLICT" });
    const claim = await repository.claimNext(northstarContext, "dedupe-worker", now, 30_000);
    if (!claim) throw new Error("deduplicated operation should be claimable");
    await repository.recordSuccess(
      northstarContext,
      claim.id,
      "dedupe-worker",
      claim.leaseToken,
      { result: { accepted: true } },
      now,
    );
  });

  it("allows one concurrent claim, fences a stale worker, and records attempt evidence", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createSyncOperationRepository(handle.db);
    const created = await repository.createOrGet(
      northstarContext,
      operationInput({
        idempotencyKey: "t019-claim-1001",
        commandHash: "hash-t019-claim-1001",
      }),
      now,
    );
    const claims = await Promise.all([
      repository.claimNext(northstarContext, "worker-a", now, 30_000),
      repository.claimNext(northstarContext, "worker-b", now, 30_000),
    ]);
    const claim = claims.find((value) => value !== null);
    expect(claims.filter((value) => value !== null)).toHaveLength(1);
    if (!claim) throw new Error("one worker should claim the operation");
    expect(claim.id).toBe(created.operation.id);

    await handle.pool.query(`update sync_operations set locked_at = $1 where id = $2`, [
      new Date(now.getTime() - 31_000),
      claim.id,
    ]);
    const reclaimed = await repository.claimNext(
      northstarContext,
      "worker-restarted",
      new Date(now.getTime() + 31_000),
      30_000,
    );
    expect(reclaimed).toMatchObject({ id: claim.id, status: "running", attemptCount: 2 });
    if (!reclaimed) throw new Error("stale operation should be reclaimed");
    expect(
      await repository.recordSuccess(
        northstarContext,
        claim.id,
        "worker-a",
        claim.leaseToken,
        { remoteId: "remote-t019-1001", result: { accepted: true } },
        new Date(now.getTime() + 32_000),
      ),
    ).toBeNull();
    expect(
      await repository.recordAttempt(northstarContext, claim.id, {
        attempt: reclaimed.attemptCount,
        outcome: "succeeded",
        requestId: "request-t019-1001",
        startedAt: now,
        completedAt: new Date(now.getTime() + 32_000),
        createdAt: new Date(now.getTime() + 32_000),
      }),
    ).toMatchObject({ operationId: claim.id, attempt: 2, outcome: "succeeded" });
    const completed = await repository.recordSuccess(
      northstarContext,
      reclaimed.id,
      "worker-restarted",
      reclaimed.leaseToken,
      { remoteId: "remote-t019-1001", result: { accepted: true } },
      new Date(now.getTime() + 32_000),
    );
    expect(completed).toMatchObject({ status: "succeeded", remoteId: "remote-t019-1001" });
  });

  it("executes remote I/O outside the claim transaction and blocks unknown recreation", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createSyncOperationRepository(handle.db);
    const executor = createSyncOperationExecutor({
      db: handle.db,
      repository,
      clock: () => now,
      leaseDurationMs: 30_000,
    });
    const executeCreated = await repository.createOrGet(
      northstarContext,
      operationInput({
        idempotencyKey: "t019-execute-1001",
        commandHash: "hash-t019-execute-1001",
      }),
      now,
    );
    let remoteCalls = 0;
    const handlers: SyncOperationHandlers = {
      async execute() {
        remoteCalls += 1;
        const result = await handle?.pool.query<{ value: number }>("select 1 as value");
        expect(result?.rows[0]?.value).toBe(1);
        return {
          remoteId: "remote-t019-execute-1001",
          result: { accepted: true, email: "customer@example.invalid" },
        };
      },
      lookup() {
        return Promise.resolve(null);
      },
    };
    const success = await executor.executeNext(northstarContext, "executor-1", handlers, now);
    expect(success).toMatchObject({ status: "succeeded", remoteId: "remote-t019-execute-1001" });
    expect(remoteCalls).toBe(1);
    await expect(
      repository.findById(northstarContext, executeCreated.operation.id),
    ).resolves.toMatchObject({
      result: { accepted: true, email: "[REDACTED]" },
    });

    const unknownCreated = await repository.createOrGet(
      northstarContext,
      operationInput({
        idempotencyKey: "t019-unknown-1001",
        commandHash: "hash-t019-unknown-1001",
      }),
      now,
    );
    let unsafeCreateCalls = 0;
    const unknown = await executor.executeNext(
      northstarContext,
      "executor-unknown",
      {
        execute() {
          unsafeCreateCalls += 1;
          return Promise.reject(new RemoteResultUnknownError());
        },
        lookup() {
          return Promise.resolve(null);
        },
      },
      now,
    );
    expect(unknown).toMatchObject({ status: "unknown", errorCode: "REMOTE_RESULT_UNKNOWN" });
    expect(unsafeCreateCalls).toBe(1);
    expect(executeCreated.operation.id).not.toBe(unknownCreated.operation.id);
    const unknownRow = await repository.findById(northstarContext, unknownCreated.operation.id);
    expect(unknownRow).toMatchObject({ status: "failed", lastErrorCode: "REMOTE_RESULT_UNKNOWN" });
    expect(
      await executor.executeNext(
        northstarContext,
        "executor-unknown-retry",
        {
          execute: () => Promise.reject(new Error("unsafe recreation must not run")),
          lookup: () => Promise.resolve(null),
        },
        now,
      ),
    ).toMatchObject({ status: "idle" });
    expect(
      await repository.requeueAfterConfirmedAbsence(
        northstarContext,
        unknownCreated.operation.id,
        "provider lookup confirmed the reference is absent",
        now,
      ),
    ).toMatchObject({ status: "retrying" });
  });

  it("recovers a remote success through lookup without issuing a second create", async () => {
    if (!handle) throw new Error("test database was not opened");
    const repository = createSyncOperationRepository(handle.db);
    const executor = createSyncOperationExecutor({ db: handle.db, repository, clock: () => now });
    await repository.createOrGet(
      northstarContext,
      operationInput({
        idempotencyKey: "t019-recover-1001",
        commandHash: "hash-t019-recover-1001",
      }),
      now,
    );
    const recovered = await executor.executeNext(
      northstarContext,
      "executor-recover",
      {
        execute() {
          return Promise.reject(
            new RemoteResultUnknownError("connection dropped after remote success"),
          );
        },
        lookup() {
          return Promise.resolve({
            remoteId: "remote-t019-recover-1001",
            result: { accepted: true },
          });
        },
      },
      now,
    );
    expect(recovered).toMatchObject({ status: "recovered", remoteId: "remote-t019-recover-1001" });
  });
});
