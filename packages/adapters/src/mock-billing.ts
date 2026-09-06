import type {
  BillingAdapterV1,
  BillingEligibilityEvent,
  ExternalRequestContext,
  ExternalWriteReceipt,
} from "@handoff/domain";
import {
  assertTenantContext,
  copyValue,
  deterministicId,
  page,
  requireExternalContext,
} from "./mock-runtime";
import type { MockScenarioController } from "./mock-runtime";

type StoredEligibility = BillingEligibilityEvent & { tenantId: string; externalId: string };

function receipt(
  externalId: string,
  context: ExternalRequestContext,
  duplicate: boolean,
): ExternalWriteReceipt {
  return {
    externalId,
    idempotencyKey: context.idempotencyKey,
    acceptedAt: context.requestedAt,
    duplicate,
  };
}

export class DeterministicMockBillingAdapter implements BillingAdapterV1 {
  readonly version = "billing.v1" as const;
  private readonly records = new Map<string, StoredEligibility>();
  private readonly idempotency = new Map<string, ExternalWriteReceipt>();

  constructor(private readonly scenario: MockScenarioController) {}

  publishEligibility(
    context: ExternalRequestContext,
    event: BillingEligibilityEvent,
  ): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("billing.publish_eligibility", () => {
      requireExternalContext(context);
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      const externalId = deterministicId(
        "billing-eligibility",
        context.tenantId,
        `${event.orderId}:${event.decision.idempotencyKey}`,
      );
      this.records.set(`${context.tenantId}:${event.orderId}:${event.decision.idempotencyKey}`, {
        ...copyValue(event),
        tenantId: context.tenantId,
        externalId,
      });
      const result = receipt(externalId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }

  getEligibility(
    context: ExternalRequestContext,
    orderId: string,
  ): Promise<BillingEligibilityEvent | null> {
    return this.scenario.execute("billing.get_eligibility", () => {
      requireExternalContext(context);
      const records = [...this.records.values()]
        .filter((record) => record.tenantId === context.tenantId && record.orderId === orderId)
        .sort((left, right) => right.decision.decisionVersion - left.decision.decisionVersion);
      const record = records[0];
      if (!record) return null;
      assertTenantContext(context, record.tenantId);
      return copyValue({ orderId: record.orderId, decision: record.decision });
    });
  }

  listEligibilityEvents(
    context: ExternalRequestContext,
    request: Parameters<BillingAdapterV1["listEligibilityEvents"]>[1],
  ) {
    return this.scenario.execute("billing.list_eligibility", () => {
      requireExternalContext(context);
      const records = [...this.records.values()]
        .filter((record) => record.tenantId === context.tenantId)
        .sort((left, right) => left.externalId.localeCompare(right.externalId));
      return page(
        records.map((record) => ({ orderId: record.orderId, decision: record.decision })),
        request,
      );
    });
  }
}
