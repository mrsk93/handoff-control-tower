import { createHash } from "node:crypto";
import type { ExternalPage, ExternalPageRequest, ExternalRequestContext } from "@handoff/domain";

export type MockOperation =
  | "commerce.upsert_order"
  | "commerce.get_order"
  | "commerce.list_orders"
  | "commerce.publish_fulfillment"
  | "commerce.get_fulfillment"
  | "warehouse.create_order"
  | "warehouse.get_order"
  | "warehouse.list_orders"
  | "warehouse.cancel_order"
  | "carrier.create_label"
  | "carrier.get_shipment"
  | "carrier.list_shipments"
  | "carrier.void_label"
  | "billing.publish_eligibility"
  | "billing.get_eligibility"
  | "billing.list_eligibility";

export const mockOperations: readonly MockOperation[] = [
  "commerce.upsert_order",
  "commerce.get_order",
  "commerce.list_orders",
  "commerce.publish_fulfillment",
  "commerce.get_fulfillment",
  "warehouse.create_order",
  "warehouse.get_order",
  "warehouse.list_orders",
  "warehouse.cancel_order",
  "carrier.create_label",
  "carrier.get_shipment",
  "carrier.list_shipments",
  "carrier.void_label",
  "billing.publish_eligibility",
  "billing.get_eligibility",
  "billing.list_eligibility",
];

export type MockScenario = {
  seed: number;
  failureRate: number;
  delayMs: number;
  failures?: Partial<Record<MockOperation, number>>;
  delays?: Partial<Record<MockOperation, number>>;
};

export type MockScenarioSnapshot = MockScenario;

const DEFAULT_SCENARIO: MockScenario = {
  seed: 1,
  failureRate: 0,
  delayMs: 0,
};

export class MockAdapterError extends Error {
  readonly code = "MOCK_ADAPTER_FAILURE";

  constructor(
    readonly operation: MockOperation,
    readonly scenarioSeed: number,
  ) {
    super(`deterministic mock failure for ${operation} (seed ${scenarioSeed})`);
    this.name = "MockAdapterError";
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateScenario(scenario: MockScenario): MockScenario {
  if (!Number.isInteger(scenario.seed) || scenario.seed < 0) {
    throw new Error("scenario seed must be a non-negative integer");
  }
  if (
    !Number.isFinite(scenario.failureRate) ||
    scenario.failureRate < 0 ||
    scenario.failureRate > 1
  ) {
    throw new Error("scenario failureRate must be between 0 and 1");
  }
  if (!Number.isInteger(scenario.delayMs) || scenario.delayMs < 0) {
    throw new Error("scenario delayMs must be a non-negative integer");
  }
  for (const [operation, count] of Object.entries(scenario.failures ?? {})) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`scenario failures for ${operation} must be a non-negative integer`);
    }
  }
  for (const [operation, delay] of Object.entries(scenario.delays ?? {})) {
    if (!Number.isInteger(delay) || delay < 0) {
      throw new Error(`scenario delay for ${operation} must be a non-negative integer`);
    }
  }
  return copy(scenario);
}

function deterministicFraction(seed: number, operation: MockOperation, attempt: number): number {
  const digest = createHash("sha256").update(`${seed}:${operation}:${attempt}`).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MockScenarioController {
  private scenario: MockScenario;
  private readonly callCounts = new Map<MockOperation, number>();

  constructor(initial: Partial<MockScenario> = {}) {
    this.scenario = validateScenario({ ...DEFAULT_SCENARIO, ...initial });
  }

  snapshot(): MockScenarioSnapshot {
    return copy(this.scenario);
  }

  setScenario(next: MockScenario): MockScenarioSnapshot {
    this.scenario = validateScenario(next);
    this.callCounts.clear();
    return this.snapshot();
  }

  reset(): MockScenarioSnapshot {
    this.scenario = copy(DEFAULT_SCENARIO);
    this.callCounts.clear();
    return this.snapshot();
  }

  async execute<T>(operation: MockOperation, action: () => T | Promise<T>): Promise<T> {
    const attempt = (this.callCounts.get(operation) ?? 0) + 1;
    this.callCounts.set(operation, attempt);
    const scenario = this.scenario;
    const operationDelay = scenario.delays?.[operation] ?? scenario.delayMs;
    await delay(operationDelay);

    const failuresRemaining = scenario.failures?.[operation] ?? 0;
    const explicitFailure = attempt <= failuresRemaining;
    const seededFailure =
      deterministicFraction(scenario.seed, operation, attempt) < scenario.failureRate;
    if (explicitFailure || seededFailure) throw new MockAdapterError(operation, scenario.seed);
    return action();
  }
}

export function requireExternalContext(context: ExternalRequestContext): void {
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${key} is required for external adapter calls`);
    }
  }
}

export function assertTenantContext(context: ExternalRequestContext, tenantId: string): void {
  requireExternalContext(context);
  if (context.tenantId !== tenantId) throw new Error("external adapter tenant scope mismatch");
}

export function deterministicId(system: string, tenantId: string, reference: string): string {
  const digest = createHash("sha256").update(`${system}:${tenantId}:${reference}`).digest("hex");
  return `${system}-${digest.slice(0, 20)}`;
}

export function page<T>(items: T[], request: ExternalPageRequest): ExternalPage<T> {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("page limit must be an integer between 1 and 100");
  }
  const offset = request.cursor === undefined ? 0 : Number(request.cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) {
    throw new Error("page cursor must be a valid offset");
  }
  const selected = items.slice(offset, offset + limit).map(copy);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

export function copyValue<T>(value: T): T {
  return copy(value);
}
