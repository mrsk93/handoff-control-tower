import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { StructuredLogger } from "@handoff/observability";

type RequestLike = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ResponseLike = {
  status(code: number): ResponseLike;
  json(body: unknown): void;
};

function header(request: RequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}

function errorCode(exception: unknown): string {
  if (!(exception instanceof HttpException)) return "INTERNAL_ERROR";
  const response = exception.getResponse();
  if (typeof response === "object" && response !== null && "error" in response) {
    const value = response.error;
    if (typeof value === "string" && /^[A-Z0-9_]+$/.test(value)) return value;
  }
  return "REQUEST_FAILED";
}

function safeHealthResponse(exception: unknown): Record<string, unknown> | undefined {
  if (!(exception instanceof HttpException)) return undefined;
  const response = exception.getResponse();
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const value = response as Record<string, unknown>;
  if (value.ready !== false) return undefined;
  const dependencies = value.dependencies;
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    !Object.values(dependencies).every((value) => value === "ok" || value === "failed")
  ) {
    return undefined;
  }
  return {
    error: "DEPENDENCY_UNAVAILABLE",
    ready: false,
    dependencies,
    failed: Array.isArray(value.failed)
      ? value.failed.filter((item): item is string => typeof item === "string")
      : [],
  };
}

@Catch()
export class SafeHttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const correlationId = (header(request, "x-correlation-id") ?? randomUUID()).slice(0, 128);
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    this.logger.error(
      "http.request.failed",
      { correlationId },
      {
        route: request.url ?? "unknown",
        method: request.method ?? "unknown",
        httpStatus: status,
        errorClass: exception instanceof Error ? exception.name : "UnknownError",
      },
    );
    response.status(status).json({
      ...(safeHealthResponse(exception) ?? { error: errorCode(exception) }),
      correlationId,
    });
  }
}
