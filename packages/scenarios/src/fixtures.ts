import type {
  CommerceOrderAcceptanceInput,
  FulfillmentLine,
  Shipment,
  ShipmentConfirmationInput,
  WarehouseFulfillmentUpdate,
} from "@handoff/domain";
import type { ScenarioFixture, ScenarioId, ScenarioStep } from "./types";

const occurredAt = "2026-01-01T00:00:00.000Z";
const tenantId = "tenant-m11-northstar";
const otherTenantId = "tenant-m11-southridge";

export const scenarioIds: readonly ScenarioId[] = [
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
];

function acceptInput(
  suffix: string,
  overrides: Partial<CommerceOrderAcceptanceInput> = {},
): CommerceOrderAcceptanceInput {
  return {
    tenantId,
    orderId: `order-m11-${suffix}`,
    sourceOrderId: `COM-M11-${suffix}`,
    sourceVersion: "1",
    orderNumber: `#M11-${suffix}`,
    currency: "USD",
    acceptedAt: occurredAt,
    paymentReleased: true,
    releaseRequested: true,
    lines: [
      { sourceLineId: "line-1", sku: "SKU-M11-1", quantity: 2 },
      { sourceLineId: "line-2", sku: "SKU-M11-2", quantity: 1 },
    ],
    ...overrides,
  };
}

function line(lineId: string, overrides: Partial<FulfillmentLine> = {}): FulfillmentLine {
  return {
    lineId,
    allocatedQty: 2,
    pickedQty: 2,
    packedQty: 2,
    shippedQty: 0,
    shortQty: 0,
    damagedQty: 0,
    ...overrides,
  };
}

function warehouseUpdate(
  suffix: string,
  sourceVersion: string,
  status: WarehouseFulfillmentUpdate["status"],
  overrides: Partial<WarehouseFulfillmentUpdate> = {},
): WarehouseFulfillmentUpdate {
  return {
    warehouseOrderId: `WH-M11-${suffix}`,
    sourceVersion,
    status,
    lines: [
      line(`COM-M11-${suffix}:line-1`),
      line(`COM-M11-${suffix}:line-2`, { allocatedQty: 1, pickedQty: 1, packedQty: 1 }),
    ],
    ...overrides,
  };
}

function packedUpdate(suffix: string): WarehouseFulfillmentUpdate {
  return warehouseUpdate(suffix, "2", "packed");
}

function partialUpdate(suffix: string, shortQty = 0): WarehouseFulfillmentUpdate {
  return warehouseUpdate(suffix, "3", "shipped", {
    lines: [
      line(`COM-M11-${suffix}:line-1`, { shippedQty: 1 }),
      line(`COM-M11-${suffix}:line-2`, {
        allocatedQty: 1,
        pickedQty: 1,
        packedQty: 1,
        shortQty,
      }),
    ],
  });
}

function fullShipmentInput(suffix: string): ShipmentConfirmationInput {
  return {
    shipmentId: `shipment-m11-${suffix}`,
    externalShipmentId: `carrier-m11-${suffix}`,
    carrierCode: "synthetic-carrier",
    serviceCode: "ground",
    trackingNumber: `SYNTH-M11-${suffix}`,
    trackingUrl: `https://carrier.mock.invalid/track/SYNTH-M11-${suffix}`,
    shippedAt: occurredAt,
    lines: [
      { lineId: `COM-M11-${suffix}:line-1`, quantity: 2 },
      { lineId: `COM-M11-${suffix}:line-2`, quantity: 1 },
    ],
  };
}

function readback(
  suffix: string,
  status: "reflected" | "pending" | "missing" = "reflected",
  shippedQtyByLine: Record<string, number> = {
    [`COM-M11-${suffix}:line-1`]: 2,
    [`COM-M11-${suffix}:line-2`]: 1,
  },
): ScenarioStep {
  return {
    kind: "eligibility",
    readback: { status, shippedQtyByLine },
    trackingNumber: `SYNTH-M11-${suffix}`,
  };
}

function expected(values: Partial<ScenarioFixture["expected"]> = {}): ScenarioFixture["expected"] {
  return {
    exceptionCodes: [],
    outboxEffects: [],
    auditActions: [],
    inboxOutcomes: [],
    findingCategories: [],
    remoteEffectCount: 0,
    ...values,
  };
}

function shipmentFor(suffix: string, trackingNumber: string): Shipment {
  return {
    tenantId,
    shipmentId: `shipment-m11-${suffix}-conflict`,
    externalShipmentId: `carrier-m11-${suffix}-conflict`,
    orderId: `order-m11-${suffix}`,
    carrierCode: "synthetic-carrier",
    serviceCode: "ground",
    trackingNumber,
    lines: [{ lineId: `COM-M11-${suffix}:line-1`, quantity: 1 }],
    status: "shipped",
  };
}

export const scenarioFixtures: readonly ScenarioFixture[] = [
  {
    id: "S01_HAPPY_FULL_FULFILLMENT",
    title: "Happy path full fulfillment",
    goal: "Accept a released order, record warehouse and carrier evidence, and publish guarded readiness.",
    seed: 20260101,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S01") },
      {
        kind: "warehouse_update",
        update: warehouseUpdate("S01", "2", "shipped", {
          lines: [
            line("COM-M11-S01:line-1", { shippedQty: 2 }),
            line("COM-M11-S01:line-2", {
              allocatedQty: 1,
              pickedQty: 1,
              packedQty: 1,
              shippedQty: 1,
            }),
          ],
        }),
      },
      { kind: "shipment", input: fullShipmentInput("S01") },
      { kind: "remote_effect", effectKey: "carrier.label", attempts: 1 },
      { kind: "remote_effect", effectKey: "commerce.fulfillment", attempts: 1 },
      readback("S01"),
      { kind: "remote_effect", effectKey: "billing.eligibility", attempts: 1 },
    ],
    injectedFailures: [],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "shipped",
      eligibility: { eligible: true, scope: "full_order" },
      outboxEffects: [
        "warehouse.create",
        "carrier.label",
        "commerce.fulfillment",
        "billing.eligibility",
      ],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "shipment.recorded",
        "invoice.eligibility.computed",
      ],
      inboxOutcomes: ["applied", "applied"],
      remoteEffectCount: 3,
    }),
  },
  {
    id: "S02_DUPLICATE_COMMERCE_EVENT",
    title: "Duplicate commerce event",
    goal: "Consume a duplicate accepted-order event without creating a second materially identical effect.",
    seed: 20260102,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S02") },
      { kind: "duplicate_event", effectKey: "commerce.order.accepted" },
      { kind: "duplicate_event", effectKey: "commerce.order.accepted" },
    ],
    injectedFailures: ["duplicate delivery"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "not_sent",
      outboxEffects: ["warehouse.create"],
      auditActions: ["order.accepted", "inbox.duplicate"],
      inboxOutcomes: ["applied", "duplicate", "duplicate"],
    }),
  },
  {
    id: "S03_ACK_BEFORE_ORDER",
    title: "Warehouse acknowledgment before order",
    goal: "Park an early acknowledgment and apply it after its order prerequisite arrives.",
    seed: 20260103,
    initialState: "empty",
    inputs: [
      { kind: "warehouse_update", update: warehouseUpdate("S03", "1", "acknowledged") },
      { kind: "accept_order", input: acceptInput("S03") },
    ],
    injectedFailures: ["out-of-order delivery"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "acknowledged",
      outboxEffects: ["warehouse.create"],
      auditActions: ["inbox.parked", "order.accepted", "inbox.woken", "fulfillment.updated"],
      inboxOutcomes: ["parked", "applied", "applied_after_prerequisite", "applied"],
    }),
  },
  {
    id: "S04_MISSING_SKU_HOLDS_RELEASE",
    title: "Missing SKU holds release",
    goal: "Keep the accepted order visible while refusing release without a SKU mapping.",
    seed: 20260104,
    initialState: "empty",
    inputs: [
      {
        kind: "accept_order",
        input: acceptInput("S04", { lines: [{ sourceLineId: "line-1", quantity: 2 }] }),
      },
    ],
    injectedFailures: ["missing SKU"],
    expected: expected({
      orderStatus: "held",
      fulfillmentStatus: "not_sent",
      exceptionCodes: ["MISSING_SKU_MAPPING"],
      auditActions: ["order.accepted"],
      inboxOutcomes: ["applied"],
    }),
  },
  {
    id: "S05_SHORT_SHIPMENT_BACKORDER",
    title: "Short shipment with backorder",
    goal: "Preserve shipped and short quantities and allow partial readiness only when policy enables it.",
    seed: 20260105,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S05") },
      { kind: "warehouse_update", update: partialUpdate("S05", 1) },
      {
        kind: "eligibility",
        readback: {
          status: "reflected",
          shippedQtyByLine: {
            "COM-M11-S05:line-1": 1,
            "COM-M11-S05:line-2": 0,
          },
        },
        trackingNumber: "SYNTH-M11-S05",
        partialShipmentEnabled: true,
        shortShipmentResolution: "backorder",
      },
    ],
    injectedFailures: ["warehouse short"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "partially_shipped",
      eligibility: { eligible: true, scope: "partial_shipment" },
      outboxEffects: ["warehouse.create", "billing.eligibility"],
      auditActions: ["order.accepted", "fulfillment.updated", "invoice.eligibility.computed"],
      inboxOutcomes: ["applied", "applied"],
    }),
  },
  {
    id: "S06_SHORT_SHIPMENT_CLOSE_SHORT",
    title: "Short shipment closed by operator",
    goal: "Close a fully evidenced short shipment and permit full-order readiness without erasing the short evidence.",
    seed: 20260106,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S06") },
      {
        kind: "warehouse_update",
        update: warehouseUpdate("S06", "3", "shipped", {
          lines: [
            line("COM-M11-S06:line-1", { shippedQty: 2 }),
            line("COM-M11-S06:line-2", {
              allocatedQty: 1,
              pickedQty: 1,
              packedQty: 1,
              shortQty: 1,
            }),
          ],
        }),
      },
      {
        kind: "eligibility",
        readback: {
          status: "reflected",
          shippedQtyByLine: {
            "COM-M11-S06:line-1": 2,
            "COM-M11-S06:line-2": 0,
          },
        },
        trackingNumber: "SYNTH-M11-S06",
        shortShipmentResolution: "close_short",
      },
    ],
    injectedFailures: ["short operator resolution"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "partially_shipped",
      eligibility: { eligible: true, scope: "full_order" },
      outboxEffects: ["warehouse.create", "billing.eligibility"],
      auditActions: ["order.accepted", "fulfillment.updated", "invoice.eligibility.computed"],
      inboxOutcomes: ["applied", "applied"],
    }),
  },
  {
    id: "S07_CANCEL_BEFORE_RELEASE",
    title: "Cancellation before release",
    goal: "Cancel a pending order without creating a warehouse command.",
    seed: 20260107,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S07", { releaseRequested: false }) },
      { kind: "cancel", remoteResult: "cancelled" },
    ],
    injectedFailures: [],
    expected: expected({
      orderStatus: "cancelled",
      fulfillmentStatus: "not_sent",
      auditActions: ["order.accepted", "order.cancelled"],
      inboxOutcomes: ["applied"],
    }),
  },
  {
    id: "S08_CANCEL_AFTER_WMS_ACK",
    title: "Cancellation after warehouse acknowledgment",
    goal: "Request and confirm cancellation after release while retaining warehouse acknowledgment evidence.",
    seed: 20260108,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S08") },
      { kind: "warehouse_update", update: warehouseUpdate("S08", "2", "acknowledged") },
      { kind: "cancel", remoteResult: "cancelled" },
    ],
    injectedFailures: [],
    expected: expected({
      orderStatus: "cancelled",
      fulfillmentStatus: "acknowledged",
      outboxEffects: ["warehouse.create", "warehouse.cancel"],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "order.cancel_requested",
        "order.cancelled",
      ],
      inboxOutcomes: ["applied", "applied"],
    }),
  },
  {
    id: "S09_CANCEL_AFTER_SHIPMENT",
    title: "Cancellation after shipment",
    goal: "Surface a high-severity conflict instead of attempting an impossible rollback.",
    seed: 20260109,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S09") },
      { kind: "warehouse_update", update: packedUpdate("S09") },
      { kind: "shipment", input: fullShipmentInput("S09") },
      { kind: "cancel", remoteResult: "already_shipped" },
    ],
    injectedFailures: ["cancel after shipment"],
    expected: expected({
      orderStatus: "cancel_requested",
      fulfillmentStatus: "packed",
      exceptionCodes: ["CANCEL_AFTER_SHIPMENT"],
      outboxEffects: ["warehouse.create", "carrier.label", "warehouse.cancel"],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "shipment.recorded",
        "order.cancel_requested",
        "exception.opened",
      ],
      inboxOutcomes: ["applied", "applied"],
    }),
  },
  {
    id: "S10_CARRIER_TIMEOUT_AFTER_CREATE",
    title: "Carrier timeout after create",
    goal: "Replay a timed-out label request with a stable idempotency key and one remote mock effect.",
    seed: 20260110,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S10") },
      { kind: "warehouse_update", update: packedUpdate("S10") },
      { kind: "shipment", input: fullShipmentInput("S10") },
      { kind: "remote_effect", effectKey: "carrier.label", attempts: 2 },
    ],
    injectedFailures: ["carrier timeout after remote create"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "packed",
      outboxEffects: ["warehouse.create", "carrier.label"],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "shipment.recorded",
        "carrier.lookup_before_recreate",
      ],
      inboxOutcomes: ["applied", "applied"],
      remoteEffectCount: 1,
    }),
  },
  {
    id: "S11_COMMERCE_FULFILLMENT_THROTTLED",
    title: "Commerce fulfillment throttled",
    goal: "Bound retries after a synthetic commerce throttle and finish without duplicate readiness effects.",
    seed: 20260111,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S11") },
      {
        kind: "warehouse_update",
        update: warehouseUpdate("S11", "2", "shipped", {
          lines: [
            line("COM-M11-S11:line-1", { shippedQty: 2 }),
            line("COM-M11-S11:line-2", {
              allocatedQty: 1,
              pickedQty: 1,
              packedQty: 1,
              shippedQty: 1,
            }),
          ],
        }),
      },
      { kind: "shipment", input: fullShipmentInput("S11") },
      { kind: "throttle", operation: "commerce.fulfillment", retryAfterAttempts: 2 },
      readback("S11"),
    ],
    injectedFailures: ["commerce fulfillment 429"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "shipped",
      eligibility: { eligible: true, scope: "full_order" },
      outboxEffects: [
        "warehouse.create",
        "carrier.label",
        "commerce.fulfillment",
        "billing.eligibility",
      ],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "shipment.recorded",
        "commerce.fulfillment.retry",
        "invoice.eligibility.computed",
      ],
      inboxOutcomes: ["applied", "applied"],
    }),
  },
  {
    id: "S12_MISSED_UPDATE_RECONCILED",
    title: "Missed commerce update reconciled",
    goal: "Detect a missing commerce reflection and schedule a bounded repair from local shipment evidence.",
    seed: 20260112,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S12") },
      { kind: "warehouse_update", update: packedUpdate("S12") },
      { kind: "shipment", input: fullShipmentInput("S12") },
      { kind: "reconcile_fulfillment", remoteStatus: "missing", remoteShippedQtyByLine: {} },
    ],
    injectedFailures: ["commerce update lost"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "packed",
      outboxEffects: ["warehouse.create", "carrier.label", "commerce.fulfillment"],
      auditActions: [
        "order.accepted",
        "fulfillment.updated",
        "shipment.recorded",
        "reconciliation.repaired",
      ],
      inboxOutcomes: ["applied", "applied"],
      findingCategories: ["missing_remote"],
    }),
  },
  {
    id: "S13_TRACKING_CONFLICT",
    title: "Tracking conflict",
    goal: "Keep both tracking values as evidence and require an explicit operator decision.",
    seed: 20260113,
    initialState: "empty",
    inputs: [
      { kind: "accept_order", input: acceptInput("S13") },
      {
        kind: "tracking_conflict",
        remote: shipmentFor("S13", "SYNTH-REMOTE-TRACK"),
        local: shipmentFor("S13", "SYNTH-LOCAL-TRACK"),
      },
    ],
    injectedFailures: ["tracking disagreement"],
    expected: expected({
      orderStatus: "released",
      fulfillmentStatus: "not_sent",
      exceptionCodes: ["TRACKING_MISMATCH"],
      outboxEffects: ["warehouse.create"],
      auditActions: ["order.accepted", "exception.opened"],
      inboxOutcomes: ["applied"],
      findingCategories: ["tracking_mismatch"],
    }),
  },
  {
    id: "S14_WORKER_CRASH_RECOVERY",
    title: "Worker crash recovery",
    goal: "Replay a claimed outbound message after a worker crash without a second synthetic remote effect.",
    seed: 20260114,
    initialState: "empty",
    inputs: [{ kind: "remote_effect", effectKey: "warehouse.create", attempts: 2 }],
    injectedFailures: ["worker crash after commit"],
    expected: expected({
      outboxEffects: ["warehouse.create"],
      auditActions: ["worker.restarted"],
      remoteEffectCount: 1,
    }),
  },
  {
    id: "S15_CROSS_TENANT_ATTACK",
    title: "Cross-tenant order probe",
    goal: "Deny an order lookup attempted through another tenant context and leave the target state unchanged.",
    seed: 20260115,
    initialState: "empty",
    inputs: [
      {
        kind: "cross_tenant_probe",
        requestedTenantId: otherTenantId,
        orderTenantId: tenantId,
      },
    ],
    injectedFailures: ["cross-tenant read probe"],
    expected: expected({
      exceptionCodes: ["CROSS_TENANT_ACCESS_DENIED"],
      auditActions: ["security.cross_tenant_denied"],
    }),
  },
];
