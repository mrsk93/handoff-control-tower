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
  Optional,
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
import type { MetricsRegistry, StructuredLogger } from "@handoff/observability";
import { FixedWindowRateLimiter } from "@handoff/security";
import {
  enforceRateLimit,
  authenticateOperator,
  authorizeOperator,
  createLocalRateLimiter,
} from "./security";
import {
  APP_CONFIG,
  DATABASE_HANDLE,
  LOGGER,
  METRICS,
  MOCK_ADAPTER_SUITE,
  RATE_LIMITER,
} from "./tokens";

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
  correlationId: string | undefined,
  causationId: string | undefined,
  now: Date,
) {
  const metadata = {
    idempotencyKey: requiredHeader(idempotencyKey, "x-idempotency-key"),
    actorId: requiredHeader(actorId, "x-operator-id"),
    expectedVersion: expectedVersion(input),
    occurredAt: now.toISOString(),
  };
  if (correlationId !== undefined && correlationId.trim().length > 0) {
    Object.assign(metadata, { correlationId: correlationId.trim() });
  }
  if (causationId !== undefined && causationId.trim().length > 0) {
    Object.assign(metadata, { causationId: causationId.trim() });
  }
  return metadata;
}

@Controller("api")
export class OperatorController {
  private readonly repository: ReturnType<typeof createOperatorRepository>;
  private readonly exceptions: ReturnType<typeof createExceptionCommandRepository>;
  private readonly reconciliation: ReturnType<typeof createReconciliationService>;
  private readonly config: AppConfig;
  private readonly limiter: FixedWindowRateLimiter;
  private readonly logger: StructuredLogger | undefined;
  private readonly metrics: MetricsRegistry | undefined;

  constructor(
    @Inject(DATABASE_HANDLE) database: DatabaseHandle,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MOCK_ADAPTER_SUITE) adapters: MockAdapterSuite,
    @Optional() @Inject(RATE_LIMITER) limiter?: FixedWindowRateLimiter,
    @Optional() @Inject(LOGGER) logger?: StructuredLogger,
    @Optional() @Inject(METRICS) metrics?: MetricsRegistry,
  ) {
    this.config = config;
    this.limiter = limiter ?? createLocalRateLimiter(config);
    this.logger = logger;
    this.metrics = metrics;
    this.repository = createOperatorRepository(database.db);
    this.exceptions = createExceptionCommandRepository(database.db);
    this.reconciliation = createReconciliationService({
      db: database.db,
      config,
      adapters,
    });
  }

  private principal(
    tenantId: string | undefined,
    operatorId: string | undefined,
    role: string | undefined,
    permission: "read" | "command",
  ) {
    const result = authenticateOperator(this.config, tenantId, operatorId, role);
    authorizeOperator(result, permission);
    this.logger?.info(
      "operator.authorization.granted",
      { tenantId: result.tenantId },
      { role: result.role, permission },
    );
    this.metrics?.increment("handoff_operator_authorizations_total", {
      route: "operator",
      status: "granted",
    });
    return result;
  }

  private async commandAccess(
    tenantId: string | undefined,
    operatorId: string | undefined,
    role: string | undefined,
    ruleName?: "retry" | "reconciliation",
  ) {
    const principal = this.principal(tenantId, operatorId, role, "command");
    const effectiveRule = ruleName ?? "command";
    await enforceRateLimit(
      this.limiter,
      `${principal.tenantId}:${principal.subject}`,
      effectiveRule,
    );
    this.metrics?.increment("handoff_operator_rate_limit_allows_total", {
      route: effectiveRule,
      status: "allowed",
    });
    return principal;
  }

  @Get("overview")
  async overview(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    return this.repository.overview({ tenantId: principal.tenantId });
  }

  @Get("orders")
  orders(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("stage") stage?: string,
    @Query("eligible") eligible?: string,
    @Query("q") query?: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    if (eligible !== undefined && eligible !== "true" && eligible !== "false") {
      throw new BadRequestException({ error: "INVALID_ELIGIBILITY_FILTER" });
    }
    return this.repository.listOrders(
      { tenantId: principal.tenantId },
      {
        ...(cursor === undefined ? {} : { cursor }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(stage === undefined ? {} : { stage }),
        ...(eligible === undefined ? {} : { eligible: eligible === "true" }),
        ...(query === undefined ? {} : { query }),
      },
    );
  }

  @Get("orders/:id")
  async order(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") orderId: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const result = await this.repository.getOrder({ tenantId: principal.tenantId }, orderId);
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
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    return this.repository.listExceptions(
      { tenantId: principal.tenantId },
      {
        ...(status === undefined ? {} : { status }),
        ...(severity === undefined ? {} : { severity }),
        ...(type === undefined ? {} : { type }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      },
    );
  }

  @Get("exceptions/:id")
  async exception(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") exceptionId: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const result = await this.repository.getException(
      { tenantId: principal.tenantId },
      exceptionId,
    );
    if (!result) throw new NotFoundException({ error: "EXCEPTION_NOT_FOUND" });
    return result;
  }

  @Get("outbox/:id")
  async outbox(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") messageId: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const result = await this.repository.getOutbox({ tenantId: principal.tenantId }, messageId);
    if (!result) throw new NotFoundException({ error: "OUTBOX_NOT_FOUND" });
    return {
      message: result,
      attempts: [
        ...result.deliveryReceipts.map((receipt) => ({
          attemptCount: receipt.attemptCount,
          status: "sent",
          remoteReceiptId: receipt.remoteReceiptId,
          duplicate: receipt.duplicate,
        })),
        ...(result.lastError === null
          ? []
          : [
              { attemptCount: result.attemptCount, status: result.status, error: result.lastError },
            ]),
      ],
    };
  }

  @Get("reconciliation-runs")
  reconciliationRuns(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Query("limit") limit?: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException({ error: "INVALID_LIMIT" });
    }
    return this.repository.listReconciliationRuns({ tenantId: principal.tenantId }, parsedLimit);
  }

  @Get("reconciliation-runs/:id")
  async reconciliationRun(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Param("id") runId: string,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = this.principal(tenantId, operatorId, role, "read");
    const result = await this.repository.getReconciliationRun(
      { tenantId: principal.tenantId },
      runId,
    );
    if (!result) throw new NotFoundException({ error: "RECONCILIATION_RUN_NOT_FOUND" });
    return result;
  }

  @Post("reconciliation-runs")
  async runReconciliation(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Body() input: unknown,
    @Headers("x-operator-id") operatorId?: string,
    @Headers("x-operator-role") role?: string,
  ) {
    const principal = await this.commandAccess(tenantId, operatorId, role, "reconciliation");
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
    return this.reconciliation.run(
      { tenantId: principal.tenantId },
      {
        now,
        ...(windowEnd === undefined ? {} : { windowEnd: new Date(windowEnd) }),
        ...(pageSize === undefined ? {} : { pageSize }),
      },
    );
  }

  @Post("exceptions/:id/assign")
  async assign(
    @Headers("x-tenant-id") tenantId: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-operator-id") actorId: string | undefined,
    @Param("id") exceptionId: string,
    @Body() input: unknown,
    @Headers("x-operator-role") role?: string,
    @Headers("x-correlation-id") correlationId?: string,
    @Headers("x-causation-id") causationId?: string,
  ) {
    const value = record(input);
    const now = new Date();
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, correlationId, causationId, now),
      type: "assign",
      assignee: value.assignee === null ? null : requiredText(value, "assignee"),
    };
    await this.commandAccess(tenantId, actorId, role);
    try {
      return await this.exceptions.execute(
        { tenantId: requiredHeader(tenantId, "x-tenant-id") },
        exceptionId,
        command,
      );
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
    @Headers("x-operator-role") role?: string,
    @Headers("x-correlation-id") correlationId?: string,
    @Headers("x-causation-id") causationId?: string,
  ) {
    const value = record(input);
    const now = new Date();
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, correlationId, causationId, now),
      type: "add_note",
      note: requiredText(value, "note"),
    };
    await this.commandAccess(tenantId, actorId, role);
    try {
      return await this.exceptions.execute(
        { tenantId: requiredHeader(tenantId, "x-tenant-id") },
        exceptionId,
        command,
      );
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
    @Headers("x-operator-role") role?: string,
    @Headers("x-correlation-id") correlationId?: string,
    @Headers("x-causation-id") causationId?: string,
  ) {
    const value = record(input);
    const resolution = value.resolution;
    if (resolution !== "backorder" && resolution !== "close_short") {
      throw new BadRequestException({ error: "INVALID_SHORT_RESOLUTION" });
    }
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, correlationId, causationId, new Date()),
      type: "resolve_short",
      resolution,
      reason: requiredText(value, "reason"),
    };
    await this.commandAccess(tenantId, actorId, role);
    try {
      return await this.exceptions.execute(
        { tenantId: requiredHeader(tenantId, "x-tenant-id") },
        exceptionId,
        command,
      );
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
    @Headers("x-operator-role") role?: string,
    @Headers("x-correlation-id") correlationId?: string,
    @Headers("x-causation-id") causationId?: string,
  ) {
    const value = record(input);
    const exceptionId = requiredText(value, "exceptionId");
    const command: ExceptionCommand = {
      ...commandMeta(value, idempotencyKey, actorId, correlationId, causationId, new Date()),
      type: "retry_outbox",
      outboxId,
      reason: requiredText(value, "reason"),
    };
    await this.commandAccess(tenantId, actorId, role, "retry");
    try {
      return await this.exceptions.execute(
        { tenantId: requiredHeader(tenantId, "x-tenant-id") },
        exceptionId,
        command,
      );
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
    @Headers("x-operator-role") role?: string,
  ) {
    const key = requiredHeader(idempotencyKey, "x-idempotency-key");
    const actor = requiredHeader(actorId, "x-operator-id");
    const principal = await this.commandAccess(tenantId, actor, role);
    const result = await this.repository.recomputeEligibility(
      { tenantId: principal.tenantId },
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
