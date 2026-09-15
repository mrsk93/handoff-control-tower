import type {
  CanonicalCustomer,
  CanonicalOrder,
  CanonicalSku,
  CommerceFulfillmentReadback,
  FulfillmentActual,
  InvoiceEligibilityDecision,
  Shipment,
  ShipmentLine,
} from "./types";

export type ConnectorContext = {
  tenantId: string;
  connectionId: string;
  correlationId: string;
  requestedAt: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type ExternalRequestContext = {
  tenantId: string;
  idempotencyKey: string;
  correlationId: string;
  requestedAt: string;
  connectionId?: string;
  signal?: AbortSignal;
};

export type ExternalPageRequest = {
  cursor?: string;
  limit?: number;
};

export type ExternalPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ConnectorPage<T> = ExternalPage<T> & {
  hasMore: boolean;
};

export type ConnectorRateLimit = {
  remaining?: number;
  resetAt?: string;
};

export type ConnectorResult<T> = {
  value: T;
  requestId?: string;
  rateLimit?: ConnectorRateLimit;
};

export type ConnectorHealth = {
  ok: boolean;
  connectorVersion: string;
  providerVersion?: string;
  checkedAt: string;
};

export type HealthProbeV1 = {
  readonly version: "health.v1";
  check(context: ConnectorContext): Promise<ConnectorResult<ConnectorHealth>>;
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

export type ExternalLookup = {
  resource: string;
  key: string;
  externalId?: string;
};

export type CatalogAdapterV1 = {
  readonly version: "catalog.v1";
  findSku(
    context: ConnectorContext,
    lookup: ExternalLookup,
  ): Promise<ConnectorResult<CanonicalSku | null>>;
  upsertSku(
    context: ConnectorContext,
    input: { sku: CanonicalSku; externalKey: string },
  ): Promise<ConnectorResult<CanonicalSku>>;
};

export type ErpAdapterV1 = {
  readonly version: "erp.v1";
  health: HealthProbeV1;
  findCustomer(
    context: ConnectorContext,
    lookup: ExternalLookup,
  ): Promise<ConnectorResult<CanonicalCustomer | null>>;
  upsertCustomer(
    context: ConnectorContext,
    input: { customer: CanonicalCustomer; externalKey: string },
  ): Promise<ConnectorResult<CanonicalCustomer>>;
  findItem(
    context: ConnectorContext,
    lookup: ExternalLookup,
  ): Promise<ConnectorResult<CanonicalSku | null>>;
  upsertItem(
    context: ConnectorContext,
    input: { sku: CanonicalSku; externalKey: string },
  ): Promise<ConnectorResult<CanonicalSku>>;
  findSalesOrder(
    context: ConnectorContext,
    lookup: ExternalLookup,
  ): Promise<ConnectorResult<CanonicalOrder | null>>;
  createSalesOrder(
    context: ConnectorContext,
    input: { order: CanonicalOrder; externalKey: string },
  ): Promise<ConnectorResult<CanonicalOrder>>;
  findDeliveryNote(
    context: ConnectorContext,
    lookup: ExternalLookup,
  ): Promise<ConnectorResult<Shipment | null>>;
  createDeliveryNote(
    context: ConnectorContext,
    input: { order: CanonicalOrder; shipment: Shipment; externalKey: string },
  ): Promise<ConnectorResult<Shipment>>;
};
