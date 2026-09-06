import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
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
import { APP_CONFIG, DATABASE_HANDLE } from "./tokens";

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
  ) {
    this.appEnv = config.appEnv;
    this.ingestion = createInboxIngestionService({ config, db: database.db });
  }

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
      return await this.ingestion.accept({
        source,
        tenantId,
        rawBody: request.rawBody,
        ...(signatureHeader === undefined ? {} : { signatureHeader }),
      });
    } catch (error) {
      if (error instanceof IngestionRejectedError) throw httpError(error);
      if (error instanceof Error && error.message === "tenant does not exist") {
        throw new BadRequestException("tenant context is unknown");
      }
      throw error;
    }
  }
}
