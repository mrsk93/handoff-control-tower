import type {
  BillingAdapterV1,
  CarrierAdapterV1,
  CommerceAdapterV1,
  ConnectorContext,
  HealthProbeV1,
  WarehouseAdapterV1,
} from "@handoff/domain";
import { DeterministicMockBillingAdapter } from "./mock-billing";
import { DeterministicMockCarrierAdapter } from "./mock-carrier";
import { DeterministicMockCommerceAdapter } from "./mock-commerce";
import {
  MockScenarioController,
  type MockScenario,
  type MockScenarioSnapshot,
} from "./mock-runtime";
import { DeterministicMockWarehouseAdapter } from "./mock-warehouse";

export type MockAdapterSuite = {
  commerce: CommerceAdapterV1;
  warehouse: WarehouseAdapterV1;
  carrier: CarrierAdapterV1;
  billing: BillingAdapterV1;
  health: HealthProbeV1;
  scenario: {
    snapshot(): MockScenarioSnapshot;
    setScenario(scenario: MockScenario): MockScenarioSnapshot;
    reset(): MockScenarioSnapshot;
  };
};

export function createMockAdapterSuite(
  initialScenario: Partial<MockScenario> = {},
): MockAdapterSuite {
  const scenario = new MockScenarioController(initialScenario);
  const health: HealthProbeV1 = {
    version: "health.v1",
    check(context: ConnectorContext) {
      return Promise.resolve({
        value: {
          ok: true,
          connectorVersion: "mock.v1",
          providerVersion: "synthetic",
          checkedAt: context.requestedAt,
        },
        requestId: `mock-health:${context.tenantId}:${context.connectionId}`,
      });
    },
  };
  return {
    commerce: new DeterministicMockCommerceAdapter(scenario),
    warehouse: new DeterministicMockWarehouseAdapter(scenario),
    carrier: new DeterministicMockCarrierAdapter(scenario),
    billing: new DeterministicMockBillingAdapter(scenario),
    health,
    scenario,
  };
}
