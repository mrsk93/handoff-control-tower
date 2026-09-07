import { HttpException, HttpStatus } from "@nestjs/common";
import type { AppConfig } from "@handoff/config";
import {
  AccessDeniedError,
  assertRateLimit,
  authenticateSyntheticPrincipal,
  FixedWindowRateLimiter,
  InMemoryRateLimitStore,
  type OperatorPermission,
  type OperatorPrincipal,
  type RateLimitDecision,
  type RateLimitStore,
} from "@handoff/security";

export function rateLimitRules(config: Pick<AppConfig, "rateLimits">) {
  return {
    ingestion: { limit: config.rateLimits.ingestionPerMinute, windowMs: 60_000 },
    command: { limit: config.rateLimits.commandPerMinute, windowMs: 60_000 },
    retry: { limit: config.rateLimits.retryPerMinute, windowMs: 60_000 },
    reconciliation: { limit: config.rateLimits.reconciliationPerMinute, windowMs: 60_000 },
  } as const;
}

export function createLocalRateLimiter(
  config: Pick<AppConfig, "rateLimits">,
): FixedWindowRateLimiter {
  return new FixedWindowRateLimiter(new InMemoryRateLimitStore(), rateLimitRules(config));
}

export function authenticateOperator(
  config: Pick<AppConfig, "appEnv">,
  tenantId: string | undefined,
  operatorId: string | undefined,
  role: string | undefined,
): OperatorPrincipal {
  try {
    return authenticateSyntheticPrincipal({
      tenantId,
      subject: operatorId,
      role,
      appEnv: config.appEnv,
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new HttpException({ error: error.code }, HttpStatus.FORBIDDEN);
    }
    const code = error instanceof Error && "code" in error ? error.code : "AUTHENTICATION_REQUIRED";
    throw new HttpException({ error: code }, HttpStatus.UNAUTHORIZED);
  }
}

export function authorizeOperator(
  principal: OperatorPrincipal,
  permission: OperatorPermission,
): void {
  try {
    principal.authorize(permission);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new HttpException({ error: error.code }, HttpStatus.FORBIDDEN);
    }
    throw error;
  }
}

export async function enforceRateLimit(
  limiter: Pick<FixedWindowRateLimiter, "consume">,
  key: string,
  ruleName: string,
  now = new Date(),
): Promise<RateLimitDecision> {
  const decision = await limiter.consume(key, ruleName, now);
  try {
    assertRateLimit(decision);
  } catch (error) {
    const retryAfterMs =
      error instanceof Error && "decision" in error
        ? (error as { decision: RateLimitDecision }).decision.retryAfterMs
        : 1_000;
    throw new HttpException({ error: "RATE_LIMITED", retryAfterMs }, HttpStatus.TOO_MANY_REQUESTS);
  }
  return decision;
}

export function rateLimitStoreOrLocal(
  store: RateLimitStore | undefined,
  config: Pick<AppConfig, "rateLimits">,
): FixedWindowRateLimiter {
  return new FixedWindowRateLimiter(store ?? new InMemoryRateLimitStore(), rateLimitRules(config));
}
