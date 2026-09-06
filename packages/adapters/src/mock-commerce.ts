import type {
  CanonicalOrder,
  CommerceAdapterV1,
  CommerceFulfillmentUpdate,
  CommerceFulfillmentReadback,
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

type CommerceRecord = {
  externalId: string;
  order: CanonicalOrder;
  fulfillment: CommerceFulfillmentReadback;
};

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

export class DeterministicMockCommerceAdapter implements CommerceAdapterV1 {
  readonly version = "commerce.v1" as const;
  private readonly records = new Map<string, CommerceRecord>();
  private readonly idempotency = new Map<string, ExternalWriteReceipt>();

  constructor(private readonly scenario: MockScenarioController) {}

  upsertOrder(
    context: ExternalRequestContext,
    order: CanonicalOrder,
  ): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("commerce.upsert_order", () => {
      assertTenantContext(context, order.tenantId);
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      const sourceKey = `${context.tenantId}:${order.sourceOrderId}`;
      const existing = this.records.get(sourceKey);
      const externalId =
        existing?.externalId ??
        deterministicId("commerce-order", context.tenantId, order.sourceOrderId);
      this.records.set(sourceKey, {
        externalId,
        order: copyValue(order),
        fulfillment: existing?.fulfillment ?? { status: "pending", shippedQtyByLine: {} },
      });
      const result = receipt(externalId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }

  getOrder(context: ExternalRequestContext, sourceOrderId: string): Promise<CanonicalOrder | null> {
    return this.scenario.execute("commerce.get_order", () => {
      requireExternalContext(context);
      const record = this.records.get(`${context.tenantId}:${sourceOrderId}`);
      if (!record) return null;
      assertTenantContext(context, record.order.tenantId);
      return copyValue(record.order);
    });
  }

  listOrders(
    context: ExternalRequestContext,
    request: Parameters<CommerceAdapterV1["listOrders"]>[1],
  ) {
    return this.scenario.execute("commerce.list_orders", () => {
      requireExternalContext(context);
      const records = [...this.records.values()]
        .filter((record) => record.order.tenantId === context.tenantId)
        .sort((left, right) => left.externalId.localeCompare(right.externalId));
      return page(
        records.map((record) => record.order),
        request,
      );
    });
  }

  publishFulfillment(
    context: ExternalRequestContext,
    update: CommerceFulfillmentUpdate,
  ): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("commerce.publish_fulfillment", () => {
      const record = this.records.get(`${context.tenantId}:${update.sourceOrderId}`);
      if (!record) throw new Error("commerce order reference not found");
      assertTenantContext(context, record.order.tenantId);
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      record.fulfillment = {
        status: "reflected",
        shippedQtyByLine: Object.fromEntries(
          update.lines.map((line) => [line.lineId, line.quantity]),
        ),
      };
      const result = receipt(
        deterministicId("commerce-fulfillment", context.tenantId, update.shipmentId),
        context,
        false,
      );
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }

  getFulfillmentReadback(
    context: ExternalRequestContext,
    sourceOrderId: string,
  ): Promise<CommerceFulfillmentReadback> {
    return this.scenario.execute("commerce.get_fulfillment", () => {
      requireExternalContext(context);
      const record = this.records.get(`${context.tenantId}:${sourceOrderId}`);
      return copyValue(record?.fulfillment ?? { status: "missing", shippedQtyByLine: {} });
    });
  }
}
