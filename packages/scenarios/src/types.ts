import type {
  CanonicalOrder,
  CommerceOrderAcceptanceInput,
  FulfillmentActual,
  FulfillmentStatus,
  InvoiceEligibilityDecision,
  OrderReleaseStatus,
  Shipment,
  ShipmentConfirmationInput,
  WarehouseFulfillmentUpdate,
} from "@handoff/domain";

export const scenarioIds = [
  "S01_HAPPY_FULL_FULFILLMENT",
  "S02_DUPLICATE_COMMERCE_EVENT",
  "S03_ACK_BEFORE_ORDER",
  "S04_MISSING_SKU_HOLDS_RELEASE",
  "S05_SHORT_SHIPMENT_BACKORDER",
  "S06_SHORT_SHIPMENT_CLOSE_SHORT",
  "S07_CANCEL_BEFORE_RELEASE",
  "S08_CANCEL_AFTER_WMS_ACK",
  "S09_CANCEL_AFTER_SHIPMENT",
  "S10_CARRIER_TIMEOUT_AFTER_CREATE",
  "S11_COMMERCE_FULFILLMENT_THROTTLED",
  "S12_MISSED_UPDATE_RECONCILED",
  "S13_TRACKING_CONFLICT",
  "S14_WORKER_CRASH_RECOVERY",
  "S15_CROSS_TENANT_ATTACK",
] as const;

export type ScenarioId = (typeof scenarioIds)[number];

export type ScenarioStep =
  | { kind: "accept_order"; input: CommerceOrderAcceptanceInput }
  | { kind: "warehouse_update"; update: WarehouseFulfillmentUpdate }
  | { kind: "shipment"; input: ShipmentConfirmationInput }
  | {
      kind: "eligibility";
      readback: {
        status: "reflected" | "pending" | "missing";
        shippedQtyByLine: Record<string, number>;
      };
      trackingNumber?: string;
      partialShipmentEnabled?: boolean;
      shortShipmentResolution?: "unresolved" | "backorder" | "close_short";
    }
  | { kind: "cancel"; remoteResult: "cancelled" | "already_shipped" | "rejected" }
  | { kind: "duplicate_event"; effectKey: string }
  | { kind: "remote_effect"; effectKey: string; attempts: number }
  | { kind: "throttle"; operation: "commerce.fulfillment"; retryAfterAttempts: number }
  | {
      kind: "reconcile_fulfillment";
      remoteStatus: "reflected" | "pending" | "missing";
      remoteShippedQtyByLine: Record<string, number>;
    }
  | {
      kind: "tracking_conflict";
      remote: Shipment;
      local: Shipment;
    }
  | { kind: "cross_tenant_probe"; requestedTenantId: string; orderTenantId: string };

export type ScenarioExpected = {
  orderStatus?: OrderReleaseStatus;
  fulfillmentStatus?: FulfillmentStatus;
  eligibility?: { eligible: boolean; scope: InvoiceEligibilityDecision["scope"] };
  exceptionCodes: readonly string[];
  outboxEffects: readonly string[];
  auditActions: readonly string[];
  inboxOutcomes: readonly string[];
  findingCategories: readonly string[];
  remoteEffectCount: number;
};

export type ScenarioFixture = {
  id: ScenarioId;
  title: string;
  goal: string;
  seed: number;
  initialState: "empty" | "accepted" | "released" | "packed";
  inputs: readonly ScenarioStep[];
  injectedFailures: readonly string[];
  expected: ScenarioExpected;
};

export type ScenarioRunState = {
  order?: CanonicalOrder;
  fulfillment?: FulfillmentActual;
  shipment?: Shipment;
  eligibility?: InvoiceEligibilityDecision;
  exceptionCodes: string[];
  outboxEffects: string[];
  auditActions: string[];
  inboxOutcomes: string[];
  findingCategories: string[];
  remoteEffectCount: number;
};

export type ScenarioRunResult = {
  id: ScenarioId;
  seed: number;
  passed: boolean;
  state: ScenarioRunState;
  evidence: readonly string[];
};

export type ScenarioCampaignResult = {
  seed: number;
  scenarioCount: number;
  passed: boolean;
  scenarios: readonly ScenarioRunResult[];
};
