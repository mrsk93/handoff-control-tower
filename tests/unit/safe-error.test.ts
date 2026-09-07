import { describe, expect, it } from "vitest";
import { BadRequestException, HttpException } from "@nestjs/common";
import { SafeHttpExceptionFilter } from "../../apps/api/src/safe-error.filter";
import { StructuredLogger } from "@handoff/observability";

describe("safe HTTP error seam", () => {
  it("returns only a safe code and correlation ID while logging no exception details", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    let responseBody: unknown;
    let responseStatus = 0;
    const filter = new SafeHttpExceptionFilter(logger);
    const request = {
      method: "POST",
      url: "/api/orders/order-1",
      headers: { "x-correlation-id": "corr-safe-1" },
    };
    const response = {
      status(code: number) {
        responseStatus = code;
        return response;
      },
      json(body: unknown) {
        responseBody = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as never;

    filter.catch(
      new HttpException({ error: "COMMAND_REJECTED", reason: "secret payload" }, 400),
      host,
    );

    expect(responseStatus).toBe(400);
    expect(responseBody).toEqual({ error: "COMMAND_REJECTED", correlationId: "corr-safe-1" });
    expect(JSON.stringify(lines)).not.toContain("secret payload");
    expect(() => new BadRequestException()).not.toThrow();
  });

  it("preserves only dependency status fields for readiness failures", () => {
    let responseBody: unknown;
    const filter = new SafeHttpExceptionFilter(new StructuredLogger(() => undefined));
    const response = {
      status() {
        return response;
      },
      json(body: unknown) {
        responseBody = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: "GET", url: "/health/ready", headers: {} }),
        getResponse: () => response,
      }),
    } as never;
    filter.catch(
      new HttpException(
        {
          ready: false,
          dependencies: { postgres: "ok", redis: "failed" },
          failed: ["redis"],
          secret: "not retained",
        },
        503,
      ),
      host,
    );
    expect(responseBody).toMatchObject({
      error: "DEPENDENCY_UNAVAILABLE",
      ready: false,
      dependencies: { postgres: "ok", redis: "failed" },
      failed: ["redis"],
    });
    expect(JSON.stringify(responseBody)).not.toContain("not retained");
  });
});
