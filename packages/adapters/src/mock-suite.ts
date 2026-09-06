import type {
  BillingAdapterV1,
  CarrierAdapterV1,
  CommerceAdapterV1,
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
  return {
    commerce: new DeterministicMockCommerceAdapter(scenario),
    warehouse: new DeterministicMockWarehouseAdapter(scenario),
    carrier: new DeterministicMockCarrierAdapter(scenario),
    billing: new DeterministicMockBillingAdapter(scenario),
    scenario,
  };
}
