import { DeterministicMockOutboundAdapter } from "@handoff/adapters";
import {
  acceptCommerceOrder,
  applyWarehouseUpdate,
  cancellationOutcome,
  confirmShipment,
  createInvoiceEligibilityEvent,
  evaluateInvoiceEligibility,
  initialFulfillment,
  reconcileCarrierShipment,
  reconcileCommerceFulfillment,
  transitionOrderRelease,
  type ActiveException,
  type CanonicalOrder,
  type FulfillmentActual,
  type OutboundDelivery,
} from "@handoff/domain";
import { scenarioFixtures } from "./fixtures";
import type {
  ScenarioCampaignResult,
  ScenarioFixture,
  ScenarioRunResult,
  ScenarioRunState,
  ScenarioStep,
} from "./types";

type Runtime = {
  order?: CanonicalOrder;
  fulfillment?: FulfillmentActual;
  shipment?: ScenarioRunState["shipment"];
  eligibility?: ScenarioRunState["eligibility"];
  activeExceptions: ActiveException[];
  pendingWarehouseUpdate?: Extract<ScenarioStep, { kind: "warehouse_update" }>["update"];
  warehouseSourceVersion?: string;
  processedEvents: Set<string>;
  outboxEffects: string[];
  auditActions: string[];
  inboxOutcomes: string[];
  exceptionCodes: string[];
  findingCategories: string[];
  evidence: string[];
  remoteAdapter: DeterministicMockOutboundAdapter;
};

const occurredAt = "2026-01-01T00:00:00.000Z";

function appendOnce(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function recordException(runtime: Runtime, code: string): void {
  appendOnce(runtime.exceptionCodes, code);
  if (!runtime.activeExceptions.some((exception) => exception.code === code)) {
    runtime.activeExceptions.push({
      code,
      severity: code === "CROSS_TENANT_ACCESS_DENIED" ? "critical" : "high",
      resolved: false,
      evidenceRefs: [`scenario:${code}`],
    });
  }
}

function recordOutbox(runtime: Runtime, effect: string): void {
  appendOnce(runtime.outboxEffects, effect);
}

function recordAudit(runtime: Runtime, action: string): void {
  appendOnce(runtime.auditActions, action);
}

function snapshot(runtime: Runtime): ScenarioRunState {
  return {
    ...(runtime.order === undefined ? {} : { order: runtime.order }),
    ...(runtime.fulfillment === undefined ? {} : { fulfillment: runtime.fulfillment }),
    ...(runtime.shipment === undefined ? {} : { shipment: runtime.shipment }),
    ...(runtime.eligibility === undefined ? {} : { eligibility: runtime.eligibility }),
    exceptionCodes: [...runtime.exceptionCodes],
    outboxEffects: [...runtime.outboxEffects],
    auditActions: [...runtime.auditActions],
    inboxOutcomes: [...runtime.inboxOutcomes],
    findingCategories: [...runtime.findingCategories],
    remoteEffectCount: runtime.remoteAdapter.effectCount(),
  };
}

function compareExpected(fixture: ScenarioFixture, actual: ScenarioRunState): string[] {
  const mismatches: string[] = [];
  const expected = fixture.expected;
  if (expected.orderStatus !== undefined && actual.order?.releaseStatus !== expected.orderStatus) {
    mismatches.push(
      `orderStatus expected ${expected.orderStatus}, got ${actual.order?.releaseStatus}`,
    );
  }
  if (
    expected.fulfillmentStatus !== undefined &&
    actual.fulfillment?.status !== expected.fulfillmentStatus
  ) {
    mismatches.push(
      `fulfillmentStatus expected ${expected.fulfillmentStatus}, got ${actual.fulfillment?.status}`,
    );
  }
  if (expected.eligibility !== undefined) {
    if (actual.eligibility?.eligible !== expected.eligibility.eligible) {
      mismatches.push(
        `eligibility expected ${String(expected.eligibility.eligible)}, got ${String(actual.eligibility?.eligible)}`,
      );
    }
    if (actual.eligibility?.scope !== expected.eligibility.scope) {
      mismatches.push(
        `eligibility scope expected ${expected.eligibility.scope}, got ${actual.eligibility?.scope}`,
      );
    }
  }
  const arrayChecks: Array<[string, readonly string[], readonly string[]]> = [
    ["exceptionCodes", expected.exceptionCodes, actual.exceptionCodes],
    ["outboxEffects", expected.outboxEffects, actual.outboxEffects],
    ["auditActions", expected.auditActions, actual.auditActions],
    ["inboxOutcomes", expected.inboxOutcomes, actual.inboxOutcomes],
    ["findingCategories", expected.findingCategories, actual.findingCategories],
  ];
  for (const [name, expectedValues, actualValues] of arrayChecks) {
    if (JSON.stringify(expectedValues) !== JSON.stringify(actualValues)) {
      mismatches.push(
        `${name} expected ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actualValues)}`,
      );
    }
  }
  if (actual.remoteEffectCount !== expected.remoteEffectCount) {
    mismatches.push(
      `remoteEffectCount expected ${expected.remoteEffectCount}, got ${actual.remoteEffectCount}`,
    );
  }
  return mismatches;
}

function orderLineQuantities(runtime: Runtime): Record<string, number> {
  if (runtime.shipment !== undefined) {
    return Object.fromEntries(runtime.shipment.lines.map((line) => [line.lineId, line.quantity]));
  }
  return Object.fromEntries(
    (runtime.fulfillment?.lines ?? []).map((line) => [line.lineId, line.shippedQty]),
  );
}

function applyWarehouseEvidence(
  runtime: Runtime,
  update: Extract<ScenarioStep, { kind: "warehouse_update" }>["update"],
): void {
  if (runtime.order === undefined || runtime.fulfillment === undefined) {
    runtime.pendingWarehouseUpdate = update;
    runtime.inboxOutcomes.push("parked");
    recordAudit(runtime, "inbox.parked");
    return;
  }
  const result = applyWarehouseUpdate(
    runtime.order,
    runtime.fulfillment,
    update,
    runtime.warehouseSourceVersion,
  );
  if (result.outcome === "stale") {
    runtime.inboxOutcomes.push("stale");
    recordAudit(runtime, "fulfillment.stale_ignored");
    return;
  }
  if (result.outcome === "conflict") {
    runtime.inboxOutcomes.push("conflict");
    recordException(runtime, result.exception.code);
    recordAudit(runtime, "exception.opened");
    return;
  }
  runtime.fulfillment = result.fulfillment;
  runtime.warehouseSourceVersion = update.sourceVersion;
  runtime.inboxOutcomes.push("applied");
  recordAudit(runtime, "fulfillment.updated");
}

function acceptOrder(
  runtime: Runtime,
  input: Extract<ScenarioStep, { kind: "accept_order" }>["input"],
): void {
  const result = acceptCommerceOrder(input);
  runtime.order = result.order;
  runtime.fulfillment = initialFulfillment(result.order);
  runtime.processedEvents.add("commerce.order.accepted");
  runtime.inboxOutcomes.push("applied");
  recordAudit(runtime, "order.accepted");
  for (const exception of result.exceptions) recordException(runtime, exception.code);
  if (result.shouldRelease) recordOutbox(runtime, "warehouse.create");
  if (runtime.pendingWarehouseUpdate !== undefined) {
    const pending = runtime.pendingWarehouseUpdate;
    delete runtime.pendingWarehouseUpdate;
    runtime.inboxOutcomes.push("applied_after_prerequisite");
    recordAudit(runtime, "inbox.woken");
    applyWarehouseEvidence(runtime, pending);
  }
}

function cancelOrder(
  runtime: Runtime,
  remoteResult: Extract<ScenarioStep, { kind: "cancel" }>["remoteResult"],
): void {
  if (runtime.order === undefined) return;
  if (runtime.order.releaseStatus === "pending" || runtime.order.releaseStatus === "held") {
    runtime.order = transitionOrderRelease(runtime.order, {
      type: "commerce_cancelled",
      idempotencyKey: "scenario-cancel-before-release",
      occurredAt,
    }).state;
    recordAudit(runtime, "order.cancelled");
    return;
  }
  if (runtime.order.releaseStatus !== "released") return;
  runtime.order = transitionOrderRelease(runtime.order, {
    type: "commerce_cancelled",
    idempotencyKey: "scenario-cancel-after-release",
    occurredAt,
  }).state;
  recordOutbox(runtime, "warehouse.cancel");
  recordAudit(runtime, "order.cancel_requested");
  const outcome = cancellationOutcome(remoteResult);
  if (outcome.status === "cancelled") {
    runtime.order = transitionOrderRelease(runtime.order, {
      type: "cancel_confirmed",
      idempotencyKey: "scenario-cancel-confirmed",
      occurredAt,
    }).state;
    recordAudit(runtime, "order.cancelled");
    return;
  }
  recordException(runtime, outcome.exception.code);
  recordAudit(runtime, "exception.opened");
}

function evaluateEligibility(
  runtime: Runtime,
  step: Extract<ScenarioStep, { kind: "eligibility" }>,
): void {
  if (runtime.order === undefined || runtime.fulfillment === undefined) return;
  const input = {
    order: runtime.order,
    fulfillment: runtime.fulfillment,
    commerceFulfillment: step.readback,
    activeExceptions: runtime.activeExceptions,
    partialShipmentEnabled: step.partialShipmentEnabled ?? false,
    shortShipmentResolution: step.shortShipmentResolution ?? "unresolved",
    decisionVersion: 1,
    computedAt: occurredAt,
    ...(step.trackingNumber === undefined ? {} : { trackingNumber: step.trackingNumber }),
  };
  runtime.eligibility = evaluateInvoiceEligibility(input);
  if (runtime.eligibility.eligible) {
    recordOutbox(runtime, "billing.eligibility");
    createInvoiceEligibilityEvent(runtime.order, runtime.eligibility);
  }
  recordAudit(runtime, "invoice.eligibility.computed");
}

async function deliverSyntheticEffect(
  runtime: Runtime,
  effectKey: string,
  attempts: number,
): Promise<void> {
  recordOutbox(runtime, effectKey);
  const message: OutboundDelivery = {
    id: `scenario-${effectKey}`,
    tenantId: "tenant-m11-northstar",
    destination: effectKey,
    messageType: `scenario.${effectKey}.v1`,
    messageVersion: 1,
    payload: { synthetic: true, effectKey },
    idempotencyKey: `scenario:${effectKey}`,
    correlationId: `scenario:${effectKey}`,
    attemptCount: 1,
    availableAt: occurredAt,
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await runtime.remoteAdapter.deliver(message);
  }
}

async function applyStep(runtime: Runtime, step: ScenarioStep): Promise<void> {
  switch (step.kind) {
    case "accept_order":
      acceptOrder(runtime, step.input);
      break;
    case "warehouse_update":
      applyWarehouseEvidence(runtime, step.update);
      break;
    case "shipment":
      if (runtime.order === undefined || runtime.fulfillment === undefined) break;
      runtime.shipment = confirmShipment(runtime.order, runtime.fulfillment, step.input);
      recordOutbox(runtime, "carrier.label");
      recordAudit(runtime, "shipment.recorded");
      break;
    case "eligibility":
      evaluateEligibility(runtime, step);
      break;
    case "cancel":
      cancelOrder(runtime, step.remoteResult);
      break;
    case "duplicate_event":
      if (runtime.processedEvents.has(step.effectKey)) {
        runtime.inboxOutcomes.push("duplicate");
        recordAudit(runtime, "inbox.duplicate");
      } else {
        runtime.processedEvents.add(step.effectKey);
        runtime.inboxOutcomes.push("applied");
        recordOutbox(runtime, step.effectKey);
      }
      break;
    case "remote_effect":
      await deliverSyntheticEffect(runtime, step.effectKey, step.attempts);
      if (step.attempts > 1) {
        recordAudit(
          runtime,
          step.effectKey === "warehouse.create"
            ? "worker.restarted"
            : "carrier.lookup_before_recreate",
        );
      }
      break;
    case "throttle":
      recordOutbox(runtime, step.operation);
      recordAudit(runtime, "commerce.fulfillment.retry");
      break;
    case "reconcile_fulfillment": {
      if (runtime.order === undefined || runtime.fulfillment === undefined) break;
      const finding = reconcileCommerceFulfillment(
        runtime.order.orderId,
        orderLineQuantities(runtime),
        step.remoteStatus,
        step.remoteShippedQtyByLine,
      );
      if (finding === null) break;
      appendOnce(runtime.findingCategories, finding.category);
      if (finding.recommendedAction === "redeliver_commerce_fulfillment") {
        recordOutbox(runtime, "commerce.fulfillment");
        recordAudit(runtime, "reconciliation.repaired");
      }
      break;
    }
    case "tracking_conflict": {
      const finding = reconcileCarrierShipment(step.remote, step.local);
      if (finding === null) break;
      appendOnce(runtime.findingCategories, finding.category);
      if (finding.category === "tracking_mismatch") {
        recordException(runtime, "TRACKING_MISMATCH");
        recordAudit(runtime, "exception.opened");
      }
      break;
    }
    case "cross_tenant_probe":
      if (step.requestedTenantId !== step.orderTenantId) {
        recordException(runtime, "CROSS_TENANT_ACCESS_DENIED");
        recordAudit(runtime, "security.cross_tenant_denied");
      }
      break;
  }
}

function fixtureFor(id: string): ScenarioFixture {
  const fixture = scenarioFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`unknown scenario ${id}`);
  return fixture;
}

export async function runScenario(id: string, seed?: number): Promise<ScenarioRunResult> {
  const fixture = fixtureFor(id);
  const runtime: Runtime = {
    activeExceptions: [],
    processedEvents: new Set(),
    outboxEffects: [],
    auditActions: [],
    inboxOutcomes: [],
    exceptionCodes: [],
    findingCategories: [],
    evidence: [],
    remoteAdapter: new DeterministicMockOutboundAdapter(),
  };
  for (const step of fixture.inputs) await applyStep(runtime, step);
  const state = snapshot(runtime);
  const mismatches = compareExpected(fixture, state);
  runtime.evidence.push(`seed=${seed ?? fixture.seed}`);
  runtime.evidence.push(`scenario=${fixture.id}`);
  runtime.evidence.push(`injectedFailures=${fixture.injectedFailures.join(",") || "none"}`);
  runtime.evidence.push(...mismatches);
  return {
    id: fixture.id,
    seed: seed ?? fixture.seed,
    passed: mismatches.length === 0,
    state,
    evidence: [...runtime.evidence],
  };
}

export async function runScenarioCampaign(seed = 20260907): Promise<ScenarioCampaignResult> {
  const scenarios: ScenarioRunResult[] = [];
  for (const fixture of scenarioFixtures) scenarios.push(await runScenario(fixture.id, seed));
  return {
    seed,
    scenarioCount: scenarios.length,
    passed: scenarios.every((scenario) => scenario.passed),
    scenarios,
  };
}
