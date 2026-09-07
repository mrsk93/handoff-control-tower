import type { AppConfig } from "@handoff/config";
import { createOutboxRepository, type Database, type OutboxClaim } from "@handoff/db";
import type {
  OutboundDelivery,
  OutboundDeliveryAdapter,
  OutboundDeliveryReceipt,
} from "@handoff/domain";
import type { TenantContext } from "@handoff/db";
import type { MetricsRegistry, StructuredLogger } from "@handoff/observability";

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
      remoteReceiptId?: string;
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
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
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
  const logger = dependencies.logger;
  const metrics = dependencies.metrics;

  return {
    async dispatchNext(
      context: TenantContext,
      workerId: string,
      now = clock(),
    ): Promise<OutboxDispatchResult> {
      const claim = await repository.claimNext(context, workerId, now, leaseDurationMs);
      if (!claim) return { status: "idle" };

      try {
        const receipt = await dependencies.adapter.deliver(toDelivery(claim));
        let persistedReceipt: OutboundDeliveryReceipt | undefined;
        if (receipt !== undefined) {
          persistedReceipt = receipt;
          await repository.recordReceipt(context, claim.id, workerId, receipt, now);
        }
        metrics?.increment("handoff_outbox_deliveries_total", {
          destination: claim.destination,
          status: "sent",
        });
        logger?.info(
          "outbox.delivery.sent",
          {
            tenantId: claim.tenantId,
            idempotencyKey: claim.idempotencyKey,
            correlationId: claim.correlationId,
            ...(claim.causationId === null ? {} : { causationId: claim.causationId }),
            outboxId: claim.id,
            ...(persistedReceipt === undefined
              ? {}
              : { remoteReceiptId: persistedReceipt.remoteReceiptId }),
          },
          {
            destination: claim.destination,
            messageType: claim.messageType,
            status: "sent",
            attemptCount: claim.attemptCount,
            ...(persistedReceipt === undefined
              ? {}
              : { remoteDuplicate: persistedReceipt.duplicate }),
          },
        );
        const sent = await repository.recordSent(context, claim.id, workerId, now);
        if (!sent) {
          return {
            status: "lease_lost",
            messageId: claim.id,
            attemptCount: claim.attemptCount,
            ...(persistedReceipt === undefined
              ? {}
              : { remoteReceiptId: persistedReceipt.remoteReceiptId }),
          };
        }
        return {
          status: "sent",
          messageId: sent.id,
          attemptCount: sent.attemptCount,
          ...(persistedReceipt === undefined
            ? {}
            : { remoteReceiptId: persistedReceipt.remoteReceiptId }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "outbox delivery failed";
        metrics?.increment("handoff_outbox_deliveries_total", {
          destination: claim.destination,
          status: "failed",
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
        logger?.error(
          "outbox.delivery.failed",
          {
            tenantId: claim.tenantId,
            idempotencyKey: claim.idempotencyKey,
            correlationId: claim.correlationId,
            ...(claim.causationId === null ? {} : { causationId: claim.causationId }),
            outboxId: claim.id,
          },
          {
            destination: claim.destination,
            messageType: claim.messageType,
            status: "failed",
            attemptCount: claim.attemptCount,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          },
        );
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
