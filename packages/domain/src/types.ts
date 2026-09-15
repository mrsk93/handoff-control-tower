export type OrderReleaseStatus =
  "pending" | "released" | "held" | "cancel_requested" | "cancelled" | "exception";

export type OrderLifecycleStatus =
  | "received"
  | "erp_pending"
  | "erp_created"
  | "fulfillment_pending"
  | "released_to_3pl"
  | "partially_shipped"
  | "shipped"
  | "delivered"
  | "cancel_pending"
  | "cancelled"
  | "blocked"
  | "exception";

export type IntegrationSystem = "COMMERCE" | "ERP" | "WAREHOUSE" | "CARRIER" | "HANDOFF";
export type UnitOfMeasure = "EA" | "KG" | "LB" | "CASE" | "UNKNOWN";

export type Quantity = {
  value: string;
  unit: UnitOfMeasure;
};

export type Money = {
  amountMinor: bigint;
  currency: string;
};

export type Address = {
  name?: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  stateOrProvince?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
  email?: string;
};

export type ExternalRef = {
  system: IntegrationSystem;
  resource: string;
  id: string;
  displayId?: string;
  url?: string;
};

export type ExternalReference = ExternalRef;

export type CanonicalSku = {
  id: string;
  tenantId: string;
  sku: string;
  normalizedSku: string;
  name: string;
  barcode?: string;
  active: boolean;
  requiresShipping: boolean;
  unit: UnitOfMeasure;
  externalRefs: ExternalRef[];
  sourceUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalCustomer = {
  id: string;
  tenantId: string;
  email?: string;
  displayName: string;
  phone?: string;
  billingAddress?: Address;
  shippingAddresses: Address[];
  externalRefs: ExternalRef[];
  createdAt: string;
  updatedAt: string;
};

export type InventoryBalance = {
  id: string;
  tenantId: string;
  skuId: string;
  locationKey: string;
  sourceSystem: "ERP" | "WAREHOUSE" | "COMMERCE";
  onHand?: Quantity;
  committed?: Quantity;
  available?: Quantity;
  inTransit?: Quantity;
  observedAt: string;
  sourceUpdatedAt?: string;
  externalRefs: ExternalRef[];
};

export type FulfillmentStatus =
  | "not_sent"
  | "sent"
  | "accepted"
  | "acknowledged"
  | "picking"
  | "packed"
  | "on_hold"
  | "partially_shipped"
  | "shipped"
  | "delivered"
  | "cancel_requested"
  | "cancelled"
  | "exception";

export type ShipmentStatus =
  | "label_created"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "on_hold"
  | "cancelled"
  | "voided";

export type CanonicalOrderLine = {
  lineId: string;
  sourceLineId: string;
  sku: string;
  orderedQty: number;
  cancelledQty: number;
  title?: string;
  unit?: UnitOfMeasure;
  orderedQuantity?: Quantity;
  unitPrice?: Money;
  discountTotal?: Money;
  taxTotal?: Money;
  externalRefs?: ExternalRef[];
};

export type CanonicalOrder = {
  tenantId: string;
  orderId: string;
  source: "commerce";
  sourceOrderId: string;
  sourceVersion: string;
  orderNumber: string;
  currency: string;
  acceptedAt: string;
  cancelledAt?: string;
  financialStatus?: string;
  customerId?: string;
  customer?: CanonicalCustomer;
  shippingAddress?: Address;
  billingAddress?: Address;
  requestedShippingMethod?: string;
  subtotal?: Money;
  shippingTotal?: Money;
  taxTotal?: Money;
  discountTotal?: Money;
  grandTotal?: Money;
  externalRefs?: ExternalRef[];
  sourceUpdatedAt?: string;
  observedAt?: string;
  sourceSystem?: IntegrationSystem;
  lastAppliedEventId?: string;
  lifecycleStatus?: OrderLifecycleStatus;
  releaseStatus: OrderReleaseStatus;
  lines: CanonicalOrderLine[];
};

export type FulfillmentLine = {
  lineId: string;
  allocatedQty: number;
  pickedQty: number;
  packedQty: number;
  shippedQty: number;
  shortQty: number;
  damagedQty: number;
};

export type FulfillmentActual = {
  tenantId: string;
  orderId: string;
  warehouseOrderId?: string;
  status: FulfillmentStatus;
  lines: FulfillmentLine[];
  version: number;
  quantityEvidence?: "workflow" | "shipment_authoritative";
  sourceVersion?: string;
  occurredAt?: string;
  observedAt?: string;
  lastAppliedEventId?: string;
};

export type ShipmentLine = {
  lineId: string;
  quantity: number;
};

export type Shipment = {
  tenantId: string;
  shipmentId: string;
  orderId: string;
  externalShipmentId?: string;
  carrierCode: string;
  serviceCode: string;
  trackingNumber: string;
  trackingUrl?: string;
  shippedAt?: string;
  deliveredAt?: string;
  sourceVersion?: string;
  occurredAt?: string;
  observedAt?: string;
  lastAppliedEventId?: string;
  lines: ShipmentLine[];
  status: ShipmentStatus;
};

export type ExceptionSeverity = "low" | "medium" | "high" | "critical";

export type ActiveException = {
  code: string;
  severity: ExceptionSeverity;
  resolved: boolean;
  evidenceRefs: string[];
};

export type CommerceFulfillmentReadback = {
  status: "reflected" | "pending" | "missing";
  shippedQtyByLine: Record<string, number>;
};

export type ShortShipmentResolution = "unresolved" | "backorder" | "close_short";

export type InvoiceEligibilityReason = {
  code: string;
  blocking: boolean;
  lineId?: string;
  evidenceRefs: string[];
};

export type InvoiceEligibilityDecision = {
  eligible: boolean;
  scope: "full_order" | "partial_shipment" | "none";
  decisionVersion: number;
  reasons: InvoiceEligibilityReason[];
  computedAt: string;
  idempotencyKey: string;
};

export type InvoiceEligibilityInput = {
  order: CanonicalOrder;
  fulfillment: FulfillmentActual;
  commerceFulfillment: CommerceFulfillmentReadback;
  trackingNumber?: string;
  activeExceptions: ActiveException[];
  partialShipmentEnabled: boolean;
  shortShipmentResolution: ShortShipmentResolution;
  decisionVersion: number;
  computedAt: string;
};
