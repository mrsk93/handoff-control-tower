import {
  parseMockIngressEvent,
  sha256Hex,
  verifyMockSignature,
  type MockIngressSource,
} from "@handoff/adapters";
import type { AppConfig } from "@handoff/config";
import { createInboxRepository, type Database } from "@handoff/db";
import type { IntegrationEvent } from "@handoff/domain";

export type IngestionRejectionCode =
  "BODY_TOO_LARGE" | "INVALID_SIGNATURE" | "INVALID_PAYLOAD" | "INVALID_TENANT";

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
      if (
        !verifyMockSignature(
          input.rawBody,
          input.signatureHeader,
          dependencies.config.mockWebhookSecrets[input.source],
        )
      ) {
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
      const result = await repository.ingest(
        { tenantId: input.tenantId },
        event,
        sha256Hex(input.rawBody),
        ...(prerequisite ? [{ prerequisite }] : []),
      );
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
