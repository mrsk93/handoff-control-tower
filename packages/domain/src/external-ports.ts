import type {
  CanonicalOrder,
  CommerceFulfillmentReadback,
  FulfillmentActual,
  InvoiceEligibilityDecision,
  Shipment,
  ShipmentLine,
} from "./types";

export type ExternalRequestContext = {
  tenantId: string;
  idempotencyKey: string;
  correlationId: string;
  requestedAt: string;
};

export type ExternalPageRequest = {
  cursor?: string;
  limit?: number;
};

export type ExternalPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ExternalWriteReceipt = {
  externalId: string;
  idempotencyKey: string;
  acceptedAt: string;
  duplicate: boolean;
};

export type CommerceFulfillmentUpdate = {
  sourceOrderId: string;
  shipmentId: string;
  trackingNumber: string;
  lines: ShipmentLine[];
};

export type CommerceAdapterV1 = {
  readonly version: "commerce.v1";
  upsertOrder(
    context: ExternalRequestContext,
    order: CanonicalOrder,
  ): Promise<ExternalWriteReceipt>;
  getOrder(context: ExternalRequestContext, sourceOrderId: string): Promise<CanonicalOrder | null>;
  listOrders(
    context: ExternalRequestContext,
    page: ExternalPageRequest,
  ): Promise<ExternalPage<CanonicalOrder>>;
  publishFulfillment(
    context: ExternalRequestContext,
    update: CommerceFulfillmentUpdate,
  ): Promise<ExternalWriteReceipt>;
  getFulfillmentReadback(
    context: ExternalRequestContext,
    sourceOrderId: string,
  ): Promise<CommerceFulfillmentReadback>;
};

export type WarehouseOrderRequest = {
  orderId: string;
  sourceOrderId: string;
  lines: Array<{ lineId: string; sku: string; quantity: number }>;
};

export type WarehouseAdapterV1 = {
  readonly version: "warehouse.v1";
  createOrder(
    context: ExternalRequestContext,
    request: WarehouseOrderRequest,
  ): Promise<ExternalWriteReceipt>;
  getOrder(context: ExternalRequestContext, orderId: string): Promise<FulfillmentActual | null>;
  listOrders(
    context: ExternalRequestContext,
    page: ExternalPageRequest,
  ): Promise<ExternalPage<FulfillmentActual>>;
  cancelOrder(context: ExternalRequestContext, orderId: string): Promise<ExternalWriteReceipt>;
};

export type CarrierLabelRequest = {
  orderId: string;
  shipmentId: string;
  carrierCode: string;
  serviceCode: string;
  lines: ShipmentLine[];
};

export type CarrierAdapterV1 = {
  readonly version: "carrier.v1";
  createLabel(
    context: ExternalRequestContext,
    request: CarrierLabelRequest,
  ): Promise<ExternalWriteReceipt>;
  getShipment(context: ExternalRequestContext, shipmentId: string): Promise<Shipment | null>;
  listShipments(
    context: ExternalRequestContext,
    page: ExternalPageRequest,
  ): Promise<ExternalPage<Shipment>>;
  voidLabel(context: ExternalRequestContext, shipmentId: string): Promise<ExternalWriteReceipt>;
};

export type BillingEligibilityEvent = {
  orderId: string;
  decision: InvoiceEligibilityDecision;
};

export type BillingAdapterV1 = {
  readonly version: "billing.v1";
  publishEligibility(
    context: ExternalRequestContext,
    event: BillingEligibilityEvent,
  ): Promise<ExternalWriteReceipt>;
  getEligibility(
    context: ExternalRequestContext,
    orderId: string,
  ): Promise<BillingEligibilityEvent | null>;
  listEligibilityEvents(
    context: ExternalRequestContext,
    page: ExternalPageRequest,
  ): Promise<ExternalPage<BillingEligibilityEvent>>;
};
