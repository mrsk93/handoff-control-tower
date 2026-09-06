import { describe, expect, it } from "vitest";
import { createMockAdapterSuite, deterministicId, type MockScenario } from "@handoff/adapters";
import type {
  BillingEligibilityEvent,
  CanonicalOrder,
  CarrierLabelRequest,
  ExternalPage,
  ExternalRequestContext,
  ExternalWriteReceipt,
  FulfillmentActual,
  WarehouseOrderRequest,
} from "@handoff/domain";

const northstar = "00000000-0000-4000-8000-000000000001";
const southridge = "00000000-0000-4000-8000-000000000002";

function context(tenantId: string, idempotencyKey: string): ExternalRequestContext {
  return {
    tenantId,
    idempotencyKey,
    correlationId: `contract:${idempotencyKey}`,
    requestedAt: "2026-01-01T00:00:00.000Z",
  };
}

const order: CanonicalOrder = {
  tenantId: northstar,
  orderId: "order-1",
  source: "commerce",
  sourceOrderId: "source-order-1",
  sourceVersion: "1",
  orderNumber: "ORD-1",
  currency: "USD",
  acceptedAt: "2026-01-01T00:00:00.000Z",
  releaseStatus: "released",
  lines: [
    {
      lineId: "line-1",
      sourceLineId: "source-line-1",
      sku: "SKU-1",
      orderedQty: 2,
      cancelledQty: 0,
    },
  ],
};

const fulfillment: FulfillmentActual = {
  tenantId: northstar,
  orderId: "order-1",
  warehouseOrderId: "warehouse-1",
  status: "acknowledged",
  version: 1,
  lines: [
    {
      lineId: "line-1",
      allocatedQty: 2,
      pickedQty: 0,
      packedQty: 0,
      shippedQty: 0,
      shortQty: 0,
      damagedQty: 0,
    },
  ],
};

const carrierRequest: CarrierLabelRequest = {
  orderId: "order-1",
  shipmentId: "shipment-1",
  carrierCode: "synthetic-carrier",
  serviceCode: "ground",
  lines: [{ lineId: "line-1", quantity: 1 }],
};

const warehouseRequest: WarehouseOrderRequest = {
  orderId: "order-1",
  sourceOrderId: "source-order-1",
  lines: [{ lineId: "line-1", sku: "SKU-1", quantity: 2 }],
};

const eligibility: BillingEligibilityEvent = {
  orderId: "order-1",
  decision: {
    eligible: true,
    scope: "partial_shipment",
    decisionVersion: 1,
    reasons: [],
    computedAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: "eligibility:order-1:1",
  },
};

async function expectPagedCollection<T>(input: {
  create: () => Promise<ExternalWriteReceipt>;
  get: () => Promise<T | null>;
  list: (request: { limit: number; cursor?: string }) => Promise<ExternalPage<T>>;
  expected: T;
}) {
  const first = await input.create();
  const duplicate = await input.create();
  expect(first.duplicate).toBe(false);
  expect(duplicate).toMatchObject({
    duplicate: true,
    externalId: first.externalId,
    idempotencyKey: first.idempotencyKey,
  });
  expect(await input.get()).toEqual(input.expected);
  const firstPage = await input.list({ limit: 1 });
  expect(firstPage.items).toEqual([input.expected]);
  expect(firstPage.nextCursor).toBeNull();
}

describe("shared synthetic adapter contract", () => {
  it.each(["commerce", "warehouse", "carrier", "billing"] as const)(
    "supports idempotent writes, reference lookup, and pagination for %s",
    async (kind) => {
      const suite = createMockAdapterSuite();
      if (kind === "commerce") {
        const callContext = context(northstar, "commerce-write-1");
        await expectPagedCollection({
          create: () => suite.commerce.upsertOrder(callContext, order),
          get: () =>
            suite.commerce.getOrder(context(northstar, "commerce-read-1"), order.sourceOrderId),
          list: (request) =>
            suite.commerce.listOrders(context(northstar, "commerce-list-1"), request),
          expected: order,
        });
      }
      if (kind === "warehouse") {
        const callContext = context(northstar, "warehouse-write-1");
        await expectPagedCollection({
          create: () => suite.warehouse.createOrder(callContext, warehouseRequest),
          get: () =>
            suite.warehouse.getOrder(context(northstar, "warehouse-read-1"), fulfillment.orderId),
          list: (request) =>
            suite.warehouse.listOrders(context(northstar, "warehouse-list-1"), request),
          expected: {
            ...fulfillment,
            warehouseOrderId: deterministicId(
              "warehouse-order",
              northstar,
              warehouseRequest.orderId,
            ),
          },
        });
      }
      if (kind === "carrier") {
        const callContext = context(northstar, "carrier-write-1");
        const receipt = await suite.carrier.createLabel(callContext, carrierRequest);
        const duplicate = await suite.carrier.createLabel(callContext, carrierRequest);
        expect(duplicate).toMatchObject({ duplicate: true, externalId: receipt.externalId });
        const created = await suite.carrier.getShipment(
          context(northstar, "carrier-read-1"),
          carrierRequest.shipmentId,
        );
        expect(created).toMatchObject({
          tenantId: northstar,
          shipmentId: carrierRequest.shipmentId,
          status: "label_created",
        });
        const pageResult = await suite.carrier.listShipments(context(northstar, "carrier-list-1"), {
          limit: 1,
        });
        expect(pageResult.items).toHaveLength(1);
        expect(pageResult.nextCursor).toBeNull();
      }
      if (kind === "billing") {
        const callContext = context(northstar, "billing-write-1");
        await expectPagedCollection({
          create: () => suite.billing.publishEligibility(callContext, eligibility),
          get: () =>
            suite.billing.getEligibility(context(northstar, "billing-read-1"), eligibility.orderId),
          list: (request) =>
            suite.billing.listEligibilityEvents(context(northstar, "billing-list-1"), request),
          expected: eligibility,
        });
      }
    },
  );

  it("does not leak records across tenant references", async () => {
    const suite = createMockAdapterSuite();
    await suite.commerce.upsertOrder(context(northstar, "tenant-a-order"), order);
    expect(
      await suite.commerce.getOrder(context(southridge, "tenant-b-read"), order.sourceOrderId),
    ).toBeNull();
    expect(
      (await suite.commerce.listOrders(context(southridge, "tenant-b-list"), { limit: 10 })).items,
    ).toEqual([]);
  });

  it("reproduces seeded failures and supports programmable failure budgets", async () => {
    const scenario: MockScenario = {
      seed: 77,
      failureRate: 0.5,
      delayMs: 0,
    };
    const first = createMockAdapterSuite(scenario);
    const second = createMockAdapterSuite(scenario);
    const outcomes = async (suite: ReturnType<typeof createMockAdapterSuite>) =>
      Promise.all(
        Array.from({ length: 6 }, async (_, index) => {
          try {
            await suite.commerce.getOrder(context(northstar, `seeded-read-${index}`), "missing");
            return "success";
          } catch (error) {
            expect(error).toMatchObject({ operation: "commerce.get_order", scenarioSeed: 77 });
            return "failure";
          }
        }),
      );
    const firstOutcomes = await outcomes(first);
    expect(firstOutcomes).toEqual(await outcomes(second));
    expect(firstOutcomes).toEqual([
      "failure",
      "failure",
      "failure",
      "failure",
      "success",
      "success",
    ]);

    const budgeted = createMockAdapterSuite({
      seed: 3,
      failureRate: 0,
      delayMs: 0,
      failures: { "commerce.get_order": 1 },
    });
    const readBudgeted = () =>
      budgeted.commerce.getOrder(context(northstar, "budgeted-read"), "missing");
    await expect(readBudgeted()).rejects.toThrow("deterministic mock failure");
    await expect(readBudgeted()).resolves.toBeNull();
  });

  it("reports configured delays without changing the adapter contract", async () => {
    const suite = createMockAdapterSuite({
      seed: 9,
      failureRate: 0,
      delayMs: 2,
      delays: { "commerce.get_order": 4 },
    });
    const started = Date.now();
    await suite.commerce.getOrder(context(northstar, "delayed-read"), "missing");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2);
    expect(suite.scenario.snapshot()).toMatchObject({
      seed: 9,
      delayMs: 2,
      delays: { "commerce.get_order": 4 },
    });
  });
});
