import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Optional,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  IngestionRejectedError,
  createInboxIngestionService,
  type IngestionResult,
} from "@handoff/queue";
import { Inject } from "@nestjs/common";
import type { DatabaseHandle } from "@handoff/db";
import type { AppConfig } from "@handoff/config";
import type { MetricsRegistry, StructuredLogger } from "@handoff/observability";
import { FixedWindowRateLimiter } from "@handoff/security";
import { enforceRateLimit, createLocalRateLimiter } from "./security";
import { APP_CONFIG, DATABASE_HANDLE, LOGGER, METRICS, RATE_LIMITER } from "./tokens";

type RawInboundRequest = {
  rawBody?: Buffer;
};

function httpError(error: IngestionRejectedError): HttpException {
  const status =
    error.code === "INVALID_SIGNATURE"
      ? HttpStatus.UNAUTHORIZED
      : error.code === "BODY_TOO_LARGE"
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : HttpStatus.BAD_REQUEST;
  return new HttpException({ error: error.code }, status);
}

@Controller("ingest")
export class IngestionController {
  private readonly ingestion: ReturnType<typeof createInboxIngestionService>;
  private readonly appEnv: AppConfig["appEnv"];

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DATABASE_HANDLE) database: DatabaseHandle,
    @Optional() @Inject(RATE_LIMITER) rateLimiter?: FixedWindowRateLimiter,
    @Optional() @Inject(LOGGER) logger?: StructuredLogger,
    @Optional() @Inject(METRICS) metrics?: MetricsRegistry,
  ) {
    this.appEnv = config.appEnv;
    this.rateLimiter = rateLimiter ?? createLocalRateLimiter(config);
    this.logger = logger;
    this.metrics = metrics;
    this.ingestion = createInboxIngestionService({ config, db: database.db });
  }

  private readonly rateLimiter: FixedWindowRateLimiter;
  private readonly logger: StructuredLogger | undefined;
  private readonly metrics: MetricsRegistry | undefined;

  @Post(":source/events")
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(
    @Param("source") source: string,
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-handoff-signature") signatureHeader: string | undefined,
    @Req() request: RawInboundRequest,
  ): Promise<IngestionResult> {
    if (this.appEnv === "production") {
      throw new HttpException({ error: "MOCK_INGRESS_DISABLED" }, HttpStatus.NOT_FOUND);
    }
    if (source !== "commerce" && source !== "wms" && source !== "carrier") {
      throw new BadRequestException("unknown mock ingress source");
    }
    if (!tenantId) throw new BadRequestException("x-tenant-id is required");
    if (!request.rawBody) throw new BadRequestException("raw request body is required");

    try {
      const now = new Date();
      await enforceRateLimit(this.rateLimiter, `${tenantId}:${source}`, "ingestion", now);
      const result = await this.ingestion.accept({
        source,
        tenantId,
        rawBody: request.rawBody,
        ...(signatureHeader === undefined ? {} : { signatureHeader }),
        now,
      });
      this.metrics?.increment("handoff_inbound_messages_total", {
        system: source,
        status: result.status,
      });
      this.logger?.info(
        "inbox.message.accepted",
        {
          tenantId,
          messageId: result.messageId,
          idempotencyKey: result.idempotencyKey,
          correlationId: result.correlationId,
        },
        {
          sourceSystem: source,
          status: result.status,
          outcome: result.duplicate ? "duplicate" : "accepted",
        },
      );
      return result;
    } catch (error) {
      this.metrics?.increment("handoff_inbound_messages_total", {
        system: source,
        status: "rejected",
      });
      this.logger?.error(
        "inbox.message.rejected",
        { tenantId },
        {
          sourceSystem: source,
          status: "rejected",
          errorClass: error instanceof Error ? error.name : "UnknownError",
        },
      );
      if (error instanceof IngestionRejectedError) throw httpError(error);
      if (error instanceof Error && error.message === "tenant does not exist") {
        throw new BadRequestException("tenant context is unknown");
      }
      throw error;
    }
  }
}
