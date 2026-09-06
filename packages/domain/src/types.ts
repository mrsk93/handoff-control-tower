export type OrderReleaseStatus =
  "pending" | "released" | "held" | "cancel_requested" | "cancelled" | "exception";

export type FulfillmentStatus =
  | "not_sent"
  | "sent"
  | "acknowledged"
  | "picking"
  | "packed"
  | "partially_shipped"
  | "shipped"
  | "cancel_requested"
  | "cancelled"
  | "exception";

export type ShipmentStatus = "label_created" | "shipped" | "in_transit" | "delivered" | "voided";

export type CanonicalOrderLine = {
  lineId: string;
  sourceLineId: string;
  sku: string;
  orderedQty: number;
  cancelledQty: number;
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
