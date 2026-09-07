import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type { MockAdapterSuite } from "@handoff/adapters";
import type { AppConfig } from "@handoff/config";
import {
  createExceptionCommandRepository,
  createOperatorRepository,
  type DatabaseHandle,
} from "@handoff/db";
import {
  InvalidExceptionCommandError,
  OptimisticConcurrencyError,
  type ExceptionCommand,
} from "@handoff/domain";
import { createReconciliationService } from "@handoff/queue";
import { APP_CONFIG, DATABASE_HANDLE, MOCK_ADAPTER_SUITE } from "./tokens";

type JsonRecord = Record<string, unknown>;

function record(input: unknown): JsonRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new BadRequestException({ error: "INVALID_REQUEST_BODY" });
  }
  return input as JsonRecord;
}

function requiredHeader(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new BadRequestException({
      error: `${name.toUpperCase().replaceAll("-", "_")}_REQUIRED`,
    });
  }
  return value.trim();
}

function tenantContext(tenantId: string | undefined) {
  return { tenantId: requiredHeader(tenantId, "x-tenant-id") };
}

function expectedVersion(input: JsonRecord): number {
  const value = input.expectedVersion;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException({ error: "EXPECTED_VERSION_REQUIRED" });
  }
  return value;
}

function requiredText(input: JsonRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException({ error: `${key.toUpperCase()}_REQUIRED` });
  }
  return value.trim();
}

function commandError(error: unknown): HttpException {
  if (error instanceof OptimisticConcurrencyError) {
    return new ConflictException({ error: error.code, reason: error.message });
  }
  if (error instanceof InvalidExceptionCommandError) {
    return new BadRequestException({ error: error.code, reason: error.message });
  }
  if (error instanceof Error && error.message === "exception not found") {
    return new NotFoundException({ error: "EXCEPTION_NOT_FOUND" });
  }
  if (error instanceof Error && error.message === "outbox message was not found") {
    return new NotFoundException({ error: "OUTBOX_NOT_FOUND" });
  }
  return new BadRequestException({ error: "COMMAND_REJECTED" });
}

function commandMeta(
  input: JsonRecord,
  idempotencyKey: string | undefined,
  actorId: string | undefined,
  now: Date,
) {
  return {
    idempotencyKey: requiredHeader(idempotencyKey, "x-idempotency-key"),
    actorId: requiredHeader(actorId, "x-operator-id"),
    expectedVersion: expectedVersion(input),
    occurredAt: now.toISOString(),
  };
}

@Controller("api")
export class OperatorController {
  private readonly repository: ReturnType<typeof createOperatorRepository>;
  private readonly exceptions: ReturnType<typeof createExceptionCommandRepository>;
  private readonly reconciliation: ReturnType<typeof createReconciliationService>;

  constructor(
    @Inject(DATABASE_HANDLE) database: DatabaseHandle,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MOCK_ADAPTER_SUITE) adapters: MockAdapterSuite,
  ) {
    this.repository = createOperatorRepository(database.db);
    this.exceptions = createExceptionCommandRepository(database.db);
    this.reconciliation = createReconciliationService({
      db: database.db,
      config,
      adapters,
    });
  }

  @Get("overview")
  overview(@Headers("x-tenant-id") tenantId: string | undefined) {
    return this.repository.overview(tenantContext(tenantId));
  }

  @Get("orders")
  orders(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("stage") stage?: string,
    @Query("eligible") eligible?: string,
    @Query("q") query?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    if (eligible !== undefined && eligible !== "true" && eligible !== "false") {
      throw new BadRequestException({ error: "INVALID_ELIGIBILITY_FILTER" });
    }
    return this.repository.listOrders(tenantContext(tenantId), {
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(stage === undefined ? {} : { stage }),
      ...(eligible === undefined ? {} : { eligible: eligible === "true" }),
      ...(query === undefined ? {} : { query }),
    });
  }

  @Get("orders/:id")
  async order(@Headers("x-tenant-id") tenantId: string | undefined, @Param("id") orderId: string) {
    const result = await this.repository.getOrder(tenantContext(tenantId), orderId);
    if (!result) throw new NotFoundException({ error: "ORDER_NOT_FOUND" });
    return result;
  }

  @Get("exceptions")
  exceptionsList(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Query("status") status?: "open" | "resolved" | "dismissed",
    @Query("severity") severity?: "low" | "medium" | "high" | "critical",
    @Query("type") type?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    return this.repository.listExceptions(tenantContext(tenantId), {
      ...(status === undefined ? {} : { status }),
      ...(severity === undefined ? {} : { severity }),
      ...(type === undefined ? {} : { type }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
  }

  @Get("exceptions/:id")
  async exception(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") exceptionId: string,
  ) {
    const result = await this.repository.getException(tenantContext(tenantId), exceptionId);
    if (!result) throw new NotFoundException({ error: "EXCEPTION_NOT_FOUND" });
    return result;
  }

  @Get("outbox/:id")
  async outbox(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") messageId: string,
  ) {
    const result = await this.repository.getOutbox(tenantContext(tenantId), messageId);
    if (!result) throw new NotFoundException({ error: "OUTBOX_NOT_FOUND" });
    return {
      message: result,
      attempts: [
        { attemptCount: result.attemptCount, status: result.status, error: result.lastError },
      ],
    };
  }

  @Get("reconciliation-runs")
  reconciliationRuns(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    return this.repository.listReconciliationRuns(tenantContext(tenantId), parsedLimit);
  }

  @Get("reconciliation-runs/:id")
  async reconciliationRun(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") runId: string,
  ) {
    const result = await this.repository.getReconciliationRun(tenantContext(tenantId), runId);
    if (!result) throw new NotFoundException({ error: "RECONCILIATION_RUN_NOT_FOUND" });
    return result;
  }

  @Post("reconciliation-runs")
  async runReconciliation(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Body() input: unknown,
  ) {
    const value = record(input);
    const now = new Date();
    const windowEnd = value.windowEnd;
    if (
      windowEnd !== undefined &&
      (typeof windowEnd !== "string" || Number.isNaN(Date.parse(windowEnd)))
    ) {
      throw new BadRequestException({ error: "INVALID_WINDOW_END" });
    }
    const pageSize = value.pageSize;
    if (
      pageSize !== undefined &&
      (typeof pageSize !== "number" ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100)
    ) {
      throw new BadRequestException({ error: "INVALID_PAGE_SIZE" });
    }
    return this.reconciliation.run(tenantContext(tenantId), {
      now,
      ...(windowEnd === undefined ? {} : { windowEnd: new Date(windowEnd) }),
      ...(pageSize === undefined ? {} : { pageSize }),
    });
  }

  @Post("exceptions/:id/assign")
  async assign(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") exceptionId: string,
    @Body() input: unknown,
  ) {
    const value = record(input);
    const now = new Date();
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, now),
      type: "assign",
      assignee: value.assignee === null ? null : requiredText(value, "assignee"),
    };
    try {
      return await this.exceptions.execute(tenantContext(tenantId), exceptionId, command);
    } catch (error) {
      throw commandError(error);
    }
  }

  @Post("exceptions/:id/notes")
  async note(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") exceptionId: string,
    @Body() input: unknown,
  ) {
    const value = record(input);
    const now = new Date();
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, now),
      type: "add_note",
      note: requiredText(value, "note"),
    };
    try {
      return await this.exceptions.execute(tenantContext(tenantId), exceptionId, command);
    } catch (error) {
      throw commandError(error);
    }
  }

  @Post("exceptions/:id/resolve-short")
  async resolveShort(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") exceptionId: string,
    @Body() input: unknown,
  ) {
    const value = record(input);
    const resolution = value.resolution;
    if (resolution !== "backorder" && resolution !== "close_short") {
      throw new BadRequestException({ error: "INVALID_SHORT_RESOLUTION" });
    }
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, new Date()),
      type: "resolve_short",
      resolution,
      reason: requiredText(value, "reason"),
    };
    try {
      return await this.exceptions.execute(tenantContext(tenantId), exceptionId, command);
    } catch (error) {
      throw commandError(error);
    }
  }

  @Post("outbox/:id/retry")
  async retryOutbox(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") outboxId: string,
    @Body() input: unknown,
  ) {
    const value = record(input);
    const exceptionId = requiredText(value, "exceptionId");
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, new Date()),
      type: "retry_outbox",
      outboxId,
      reason: requiredText(value, "reason"),
    };
    try {
      return await this.exceptions.execute(tenantContext(tenantId), exceptionId, command);
    } catch (error) {
      throw commandError(error);
    }
  }

  @Post("orders/:id/recompute-eligibility")
  async recomputeEligibility(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") orderId: string,
  ) {
    const context = tenantContext(tenantId);
    const key = requiredHeader(idempotencyKey, "x-idempotency-key");
    const actor = requiredHeader(actorId, "x-operator-id");
    const result = await this.repository.recomputeEligibility(
      context,
      orderId,
      actor,
      key,
      new Date(),
      false,
    );
    if (!result) throw new NotFoundException({ error: "ORDER_NOT_FOUND" });
    return result;
  }
}
