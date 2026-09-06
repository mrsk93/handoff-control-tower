import type {
  CarrierAdapterV1,
  CarrierLabelRequest,
  ExternalRequestContext,
  ExternalWriteReceipt,
  Shipment,
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

export class DeterministicMockCarrierAdapter implements CarrierAdapterV1 {
  readonly version = "carrier.v1" as const;
  private readonly records = new Map<string, Shipment>();
  private readonly idempotency = new Map<string, ExternalWriteReceipt>();

  constructor(private readonly scenario: MockScenarioController) {}

  createLabel(
    context: ExternalRequestContext,
    request: CarrierLabelRequest,
  ): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("carrier.create_label", () => {
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      const externalShipmentId = deterministicId(
        "carrier-shipment",
        context.tenantId,
        request.shipmentId,
      );
      const trackingNumber = `MOCK-${externalShipmentId.slice(-12).toUpperCase()}`;
      const record: Shipment = {
        tenantId: context.tenantId,
        shipmentId: request.shipmentId,
        orderId: request.orderId,
        externalShipmentId,
        carrierCode: request.carrierCode,
        serviceCode: request.serviceCode,
        trackingNumber,
        trackingUrl: `https://carrier.mock.invalid/track/${trackingNumber}`,
        lines: request.lines.map((line) => ({ ...line })),
        status: "label_created",
      };
      this.records.set(`${context.tenantId}:${request.shipmentId}`, record);
      const result = receipt(externalShipmentId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }

  getShipment(context: ExternalRequestContext, shipmentId: string): Promise<Shipment | null> {
    return this.scenario.execute("carrier.get_shipment", () => {
      requireExternalContext(context);
      const record = this.records.get(`${context.tenantId}:${shipmentId}`);
      if (record) assertTenantContext(context, record.tenantId);
      return copyValue(record ?? null);
    });
  }

  listShipments(
    context: ExternalRequestContext,
    request: Parameters<CarrierAdapterV1["listShipments"]>[1],
  ) {
    return this.scenario.execute("carrier.list_shipments", () => {
      requireExternalContext(context);
      const records = [...this.records.values()]
        .filter((record) => record.tenantId === context.tenantId)
        .sort((left, right) => left.shipmentId.localeCompare(right.shipmentId));
      return page(records, request);
    });
  }

  voidLabel(context: ExternalRequestContext, shipmentId: string): Promise<ExternalWriteReceipt> {
    return this.scenario.execute("carrier.void_label", () => {
      const record = this.records.get(`${context.tenantId}:${shipmentId}`);
      if (!record) throw new Error("carrier shipment reference not found");
      assertTenantContext(context, record.tenantId);
      const key = `${context.tenantId}:${context.idempotencyKey}`;
      const duplicate = this.idempotency.get(key);
      if (duplicate) return copyValue({ ...duplicate, duplicate: true });
      record.status = "voided";
      const result = receipt(record.externalShipmentId ?? shipmentId, context, false);
      this.idempotency.set(key, result);
      return copyValue(result);
    });
  }
}
