import type { AppConfig } from "@handoff/config";
import { createOutboxRepository, type Database, type OutboxClaim } from "@handoff/db";
import type { OutboundDelivery, OutboundDeliveryAdapter } from "@handoff/domain";
import type { TenantContext } from "@handoff/db";

export type OutboxRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export function calculateOutboxRetryAt(
  now: Date,
  attemptCount: number,
  policy: OutboxRetryPolicy,
  random = 0.5,
): Date {
  if (attemptCount < 1) throw new Error("attemptCount must be positive");
  if (policy.baseDelayMs <= 0 || policy.maxDelayMs <= 0 || policy.jitterMs < 0) {
    throw new Error("retry policy values are invalid");
  }
  const boundedRandom = Math.min(1, Math.max(0, random));
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1),
  );
  const jitter = Math.round((boundedRandom * 2 - 1) * policy.jitterMs);
  return new Date(now.getTime() + Math.max(0, exponential + jitter));
}

export type OutboxDispatchResult =
  | { status: "idle" }
  | {
      status: "sent" | "retry_wait" | "dead_letter" | "lease_lost";
      messageId: string;
      attemptCount: number;
      retryAt?: Date;
      error?: string;
    };

type DispatcherConfig = Pick<
  AppConfig,
  "outboxMaxAttempts" | "outboxRetryBaseMs" | "outboxRetryMaxMs" | "outboxRetryJitterMs"
>;

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("outbox payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function toDelivery(claim: OutboxClaim): OutboundDelivery {
  const delivery: OutboundDelivery = {
    id: claim.id,
    tenantId: claim.tenantId,
    destination: claim.destination,
    messageType: claim.messageType,
    messageVersion: claim.messageVersion,
    payload: jsonObject(claim.payload),
    idempotencyKey: claim.idempotencyKey,
    correlationId: claim.correlationId,
    attemptCount: claim.attemptCount,
    availableAt: claim.availableAt.toISOString(),
  };
  if (claim.causationId !== null) delivery.causationId = claim.causationId;
  return delivery;
}

export function createOutboxDispatcher(dependencies: {
  db: Database;
  config: DispatcherConfig;
  adapter: OutboundDeliveryAdapter;
  clock?: () => Date;
  random?: () => number;
  leaseDurationMs?: number;
}) {
  const repository = createOutboxRepository(dependencies.db);
  const clock = dependencies.clock ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;
  const retryPolicy = {
    baseDelayMs: dependencies.config.outboxRetryBaseMs,
    maxDelayMs: dependencies.config.outboxRetryMaxMs,
    jitterMs: dependencies.config.outboxRetryJitterMs,
  };

  return {
    async dispatchNext(
      context: TenantContext,
      workerId: string,
      now = clock(),
    ): Promise<OutboxDispatchResult> {
      const claim = await repository.claimNext(context, workerId, now, leaseDurationMs);
      if (!claim) return { status: "idle" };

      try {
        await dependencies.adapter.deliver(toDelivery(claim));
      } catch (error) {
        const message = error instanceof Error ? error.message : "outbox delivery failed";
        const retryAt = calculateOutboxRetryAt(now, claim.attemptCount, retryPolicy, random());
        const updated = await repository.recordFailure(context, claim.id, workerId, {
          error: message,
          retryAt,
          maxAttempts: dependencies.config.outboxMaxAttempts,
        });
        if (!updated) {
          return {
            status: "lease_lost",
            messageId: claim.id,
            attemptCount: claim.attemptCount,
            error: message,
          };
        }
        return {
          status: updated.status === "dead_letter" ? "dead_letter" : "retry_wait",
          messageId: updated.id,
          attemptCount: updated.attemptCount,
          retryAt: updated.availableAt,
          error: message,
        };
      }

      const sent = await repository.recordSent(context, claim.id, workerId, now);
      if (!sent) {
        return {
          status: "lease_lost",
          messageId: claim.id,
          attemptCount: claim.attemptCount,
        };
      }
      return { status: "sent", messageId: sent.id, attemptCount: sent.attemptCount };
    },

    retryDeadLetter(
      context: TenantContext,
      messageId: string,
      reason: string,
      availableAt = clock(),
    ) {
      return repository.retryDeadLetter(context, messageId, reason, availableAt);
    },
  };
}
