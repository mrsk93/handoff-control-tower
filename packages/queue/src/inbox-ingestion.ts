import {
  parseMockIngressEvent,
  sha256Hex,
  verifyMockSignature,
  type MockIngressSource,
} from "@handoff/adapters";
import type { AppConfig } from "@handoff/config";
import { createInboxRepository, InboxPayloadConflictError, type Database } from "@handoff/db";
import type { IntegrationEvent } from "@handoff/domain";
import { redactSensitive } from "@handoff/security";

export type IngestionRejectionCode =
  | "BODY_TOO_LARGE"
  | "INVALID_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "INVALID_TENANT"
  | "PAYLOAD_CONFLICT";

export class IngestionRejectedError extends Error {
  readonly code: IngestionRejectionCode;

  constructor(code: IngestionRejectionCode, message: string) {
    super(message);
    this.name = "IngestionRejectedError";
    this.code = code;
  }
}

export type IngestionInput = {
  source: MockIngressSource;
  tenantId: string;
  rawBody: Buffer;
  signatureHeader?: string;
  verified?: {
    connectionId?: string;
    sourceApiVersion?: string;
    signatureVerified: boolean;
    signatureVerifiedAt?: Date;
    payloadRedacted?: unknown;
  };
  now?: Date;
};

export type IngestionResult = {
  messageId: string;
  inboxId: string;
  idempotencyKey: string;
  correlationId: string;
  duplicate: boolean;
  stale: boolean;
  status: "received" | "parked" | "ignored";
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function prerequisiteFor(
  source: MockIngressSource,
  event: IntegrationEvent,
): { type: "order"; key: string } | undefined {
  if (source !== "wms") return undefined;
  const payload = event.payload;
  const payloadOrderSourceId =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).orderSourceId
      : undefined;
  const key =
    typeof payloadOrderSourceId === "string" ? payloadOrderSourceId.trim() : event.sourceEntityId;
  return key.length > 0 ? { type: "order", key } : undefined;
}

export function createInboxIngestionService(dependencies: {
  config: Pick<AppConfig, "ingestMaxBodyBytes" | "mockWebhookSecrets">;
  db: Database;
  clock?: () => Date;
}) {
  const repository = createInboxRepository(dependencies.db);
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async accept(input: IngestionInput): Promise<IngestionResult> {
      if (!isUuid(input.tenantId)) {
        throw new IngestionRejectedError("INVALID_TENANT", "tenant context must be a UUID");
      }
      if (input.rawBody.length > dependencies.config.ingestMaxBodyBytes) {
        throw new IngestionRejectedError("BODY_TOO_LARGE", "inbound body exceeds configured limit");
      }
      const verified = input.verified;
      const signatureVerified =
        verified?.signatureVerified ??
        verifyMockSignature(
          input.rawBody,
          input.signatureHeader,
          dependencies.config.mockWebhookSecrets[input.source],
        );
      if (!signatureVerified) {
        throw new IngestionRejectedError("INVALID_SIGNATURE", "inbound signature is invalid");
      }

      const now = input.now ?? clock();
      let event: IntegrationEvent;
      try {
        event = parseMockIngressEvent(input.rawBody, input.source, {
          tenantId: input.tenantId,
          receivedAt: now.toISOString(),
        });
      } catch {
        throw new IngestionRejectedError("INVALID_PAYLOAD", "inbound payload is invalid");
      }

      const prerequisite = prerequisiteFor(input.source, event);
      let result;
      try {
        result = await repository.ingest(
          { tenantId: input.tenantId },
          event,
          sha256Hex(input.rawBody),
          {
            ...(prerequisite ? { prerequisite } : {}),
            ...(verified?.connectionId ? { connectionId: verified.connectionId } : {}),
            ...(verified?.sourceApiVersion ? { sourceApiVersion: verified.sourceApiVersion } : {}),
            signatureVerified: true,
            signatureVerifiedAt: verified?.signatureVerifiedAt ?? now,
            payloadRedacted: verified?.payloadRedacted ?? redactSensitive(event.payload),
          },
        );
      } catch (error) {
        if (error instanceof InboxPayloadConflictError) {
          throw new IngestionRejectedError("PAYLOAD_CONFLICT", error.message);
        }
        throw error;
      }
      return {
        messageId: result.message.messageId,
        inboxId: result.message.id,
        idempotencyKey: result.message.idempotencyKey,
        correlationId: result.message.correlationId,
        duplicate: result.duplicate,
        stale: result.stale,
        status: result.status,
      };
    },

    repository,
  };
}
