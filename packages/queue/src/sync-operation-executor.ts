import type { Database, SyncOperationClaim, SyncOperationRepository } from "@handoff/db";
import { createSyncOperationRepository } from "@handoff/db";
import type { TenantContext } from "@handoff/db";
import { redactSensitive } from "@handoff/security";

export class RemoteResultUnknownError extends Error {
  readonly code = "REMOTE_RESULT_UNKNOWN";

  constructor(message = "remote result is unknown; lookup is required before retrying") {
    super(message);
    this.name = "RemoteResultUnknownError";
  }
}

export class SyncOperationExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "SyncOperationExecutionError";
    this.code = options.code ?? "SYNC_OPERATION_EXECUTION_FAILED";
    this.retryable = options.retryable ?? true;
  }
}

export type SyncOperationRemoteResult = {
  result?: unknown;
  remoteId?: string;
};

export type SyncOperationHandlers = {
  execute(claim: SyncOperationClaim): Promise<SyncOperationRemoteResult>;
  lookup(claim: SyncOperationClaim): Promise<SyncOperationRemoteResult | null>;
};

export type SyncOperationExecutionResult =
  | { status: "idle" }
  | {
      status: "succeeded" | "recovered" | "retrying" | "failed" | "unknown" | "lease_lost";
      operationId: string;
      attemptCount: number;
      remoteId?: string;
      errorCode?: string;
    };

export function createSyncOperationExecutor(dependencies: {
  db: Database;
  clock?: () => Date;
  leaseDurationMs?: number;
  repository?: SyncOperationRepository;
}) {
  const repository = dependencies.repository ?? createSyncOperationRepository(dependencies.db);
  const clock = dependencies.clock ?? (() => new Date());
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;

  return {
    repository,

    async executeNext(
      context: TenantContext,
      workerId: string,
      handlers: SyncOperationHandlers,
      now = clock(),
    ): Promise<SyncOperationExecutionResult> {
      const claim = await repository.claimNext(context, workerId, now, leaseDurationMs);
      if (!claim) return { status: "idle" };

      try {
        const result = await handlers.execute(claim);
        const completedAt = clock();
        await repository.recordAttempt(context, claim.id, {
          attempt: claim.attemptCount,
          outcome: "succeeded",
          startedAt: claim.startedAt ?? now,
          completedAt,
          createdAt: completedAt,
        });
        const completed = await repository.recordSuccess(
          context,
          claim.id,
          workerId,
          claim.leaseToken,
          { ...result, result: redactSensitive(result.result) },
          completedAt,
        );
        if (!completed) {
          return {
            status: "lease_lost",
            operationId: claim.id,
            attemptCount: claim.attemptCount,
            ...(result.remoteId ? { remoteId: result.remoteId } : {}),
          };
        }
        return {
          status: "succeeded",
          operationId: completed.id,
          attemptCount: completed.attemptCount,
          ...(completed.remoteId ? { remoteId: completed.remoteId } : {}),
        };
      } catch (error) {
        if (error instanceof RemoteResultUnknownError) {
          let lookup: SyncOperationRemoteResult | null = null;
          try {
            lookup = await handlers.lookup(claim);
          } catch {
            lookup = null;
          }
          if (lookup?.remoteId) {
            const completedAt = clock();
            await repository.recordAttempt(context, claim.id, {
              attempt: claim.attemptCount,
              outcome: "recovered",
              errorCode: error.code,
              errorMessage: error.message,
              startedAt: claim.startedAt ?? now,
              completedAt,
              createdAt: completedAt,
            });
            const recovered = await repository.recordUnknown(
              context,
              claim.id,
              workerId,
              claim.leaseToken,
              error.message,
              completedAt,
            );
            if (recovered) {
              const resolved = await repository.resolveUnknown(
                context,
                claim.id,
                {
                  result: redactSensitive(lookup.result),
                  remoteId: lookup.remoteId,
                },
                completedAt,
              );
              if (resolved) {
                return {
                  status: "recovered",
                  operationId: resolved.id,
                  attemptCount: resolved.attemptCount,
                  ...(resolved.remoteId ? { remoteId: resolved.remoteId } : {}),
                };
              }
            }
            return {
              status: "lease_lost",
              operationId: claim.id,
              attemptCount: claim.attemptCount,
            };
          }
          const completedAt = clock();
          await repository.recordAttempt(context, claim.id, {
            attempt: claim.attemptCount,
            outcome: "unknown",
            errorCode: "REMOTE_RESULT_UNKNOWN",
            errorMessage: "remote result is unknown and lookup did not prove absence",
            startedAt: claim.startedAt ?? now,
            completedAt,
            createdAt: completedAt,
          });
          const unknown = await repository.recordUnknown(
            context,
            claim.id,
            workerId,
            claim.leaseToken,
            "remote result is unknown and lookup did not prove absence",
            completedAt,
          );
          return {
            status: unknown ? "unknown" : "lease_lost",
            operationId: claim.id,
            attemptCount: claim.attemptCount,
            errorCode: "REMOTE_RESULT_UNKNOWN",
          };
        }

        const executionError =
          error instanceof SyncOperationExecutionError
            ? error
            : new SyncOperationExecutionError(
                error instanceof Error ? error.message : "sync operation failed",
              );
        const completedAt = clock();
        await repository.recordAttempt(context, claim.id, {
          attempt: claim.attemptCount,
          outcome: executionError.retryable ? "retryable" : "failed",
          errorCode: executionError.code,
          errorMessage: executionError.message,
          startedAt: claim.startedAt ?? now,
          completedAt,
          createdAt: completedAt,
        });
        const failed = await repository.recordFailure(
          context,
          claim.id,
          workerId,
          claim.leaseToken,
          {
            errorCode: executionError.code,
            errorMessage: executionError.message,
            retryable: executionError.retryable,
            retryAt: completedAt,
          },
          completedAt,
        );
        return {
          status: failed ? (failed.status === "retrying" ? "retrying" : "failed") : "lease_lost",
          operationId: claim.id,
          attemptCount: claim.attemptCount,
          errorCode: executionError.code,
        };
      }
    },
  };
}
