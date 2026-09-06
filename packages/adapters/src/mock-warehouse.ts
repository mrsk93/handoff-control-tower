import type {
  ExternalRequestContext,
  ExternalWriteReceipt,
  FulfillmentActual,
  WarehouseAdapterV1,
  WarehouseOrderRequest,
} from "@handoff/domain";
import {
  assertTenantContext,
  copyValue,
  deterministicId,
  page,
  requireExternalContext,
} from "./mock-runtime";
import type { MockScenarioController } from "./mock-runtime";

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

export class DeterministicMockWarehouseAdapter implements WarehouseAdapterV1 {
  readonly version = "warehouse.v1" as const;
  private readonly records = new Map<string, FulfillmentActual>();
  private readonly idempotency = new Map<string, ExternalWriteReceipt>();

  constructor(private readonly scenario: MockScenarioController) {}

  createOrder(
    context: ExternalRequestContext,
    request: WarehouseOrderRequest,
  ): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("warehouse.create_order", () => {
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      const externalId = deterministicId("warehouse-order", context.tenantId, request.orderId);
      const record: FulfillmentActual = {
        tenantId: context.tenantId,
        orderId: request.orderId,
        warehouseOrderId: externalId,
        status: "acknowledged",
        version: 1,
        lines: request.lines.map((line) => ({
          lineId: line.lineId,
          allocatedQty: line.quantity,
          pickedQty: 0,
          packedQty: 0,
          shippedQty: 0,
          shortQty: 0,
          damagedQty: 0,
        })),
      };
      this.records.set(`${context.tenantId}:${request.orderId}`, record);
      const result = receipt(externalId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }

  getOrder(context: ExternalRequestContext, orderId: string): Promise<FulfillmentActual | null> {
    return this.scenario.execute("warehouse.get_order", () => {
      requireExternalContext(context);
      const record = this.records.get(`${context.tenantId}:${orderId}`);
      if (record) assertTenantContext(context, record.tenantId);
      return copyValue(record ?? null);
    });
  }

  listOrders(
    context: ExternalRequestContext,
    request: Parameters<WarehouseAdapterV1["listOrders"]>[1],
  ) {
    return this.scenario.execute("warehouse.list_orders", () => {
      requireExternalContext(context);
      const records = [...this.records.values()]
        .filter((record) => record.tenantId === context.tenantId)
        .sort((left, right) =>
          (left.warehouseOrderId ?? "").localeCompare(right.warehouseOrderId ?? ""),
        );
      return page(records, request);
    });
  }

  cancelOrder(context: ExternalRequestContext, orderId: string): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("warehouse.cancel_order", () => {
      const record = this.records.get(`${context.tenantId}:${orderId}`);
      if (!record) throw new Error("warehouse order reference not found");
      assertTenantContext(context, record.tenantId);
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      record.status = "cancelled";
      record.version += 1;
      const result = receipt(record.warehouseOrderId ?? orderId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }
}
