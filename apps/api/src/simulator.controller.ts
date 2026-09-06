import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Put,
} from "@nestjs/common";
import type { AppConfig } from "@handoff/config";
import {
  mockOperations,
  type MockAdapterSuite,
  type MockOperation,
  type MockScenario,
} from "@handoff/adapters";
import { APP_CONFIG, MOCK_ADAPTER_SUITE } from "./tokens";

type JsonRecord = Record<string, unknown>;

function record(input: unknown): JsonRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HttpException({ error: "INVALID_SCENARIO" }, HttpStatus.BAD_REQUEST);
  }
  return input as JsonRecord;
}

function integer(input: JsonRecord, key: string, minimum: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new HttpException({ error: "INVALID_SCENARIO", field: key }, HttpStatus.BAD_REQUEST);
  }
  return value;
}

function rate(input: JsonRecord): number {
  const value = input.failureRate;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpException(
      { error: "INVALID_SCENARIO", field: "failureRate" },
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}

function operationMap(
  input: unknown,
  field: "failures" | "delays",
): Partial<Record<MockOperation, number>> | undefined {
  if (input === undefined) return undefined;
  const value = record(input);
  const output: Partial<Record<MockOperation, number>> = {};
  for (const [operation, count] of Object.entries(value)) {
    if (!mockOperations.includes(operation as MockOperation)) {
      throw new HttpException(
        { error: "INVALID_SCENARIO", field: `${field}.${operation}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new HttpException(
        { error: "INVALID_SCENARIO", field: `${field}.${operation}` },
        HttpStatus.BAD_REQUEST,
      );
    }
    output[operation as MockOperation] = count;
  }
  return output;
}

export function parseScenario(input: unknown): MockScenario {
  const value = record(input);
  const failures = operationMap(value.failures, "failures");
  const delays = operationMap(value.delays, "delays");
  return {
    seed: integer(value, "seed", 0),
    failureRate: rate(value),
    delayMs: integer(value, "delayMs", 0),
    ...(failures === undefined ? {} : { failures }),
    ...(delays === undefined ? {} : { delays }),
  };
}

@Controller("simulator")
export class SimulatorController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MOCK_ADAPTER_SUITE) private readonly suite: MockAdapterSuite,
  ) {}

  private assertEnabled(): void {
    if (this.config.appEnv === "production" || !this.config.enableDemoSimulator) {
      throw new HttpException({ error: "DEMO_SIMULATOR_DISABLED" }, HttpStatus.NOT_FOUND);
    }
  }

  @Get("scenario")
  getScenario() {
    this.assertEnabled();
    return { enabled: true, scenario: this.suite.scenario.snapshot() };
  }

  @Put("scenario")
  @HttpCode(HttpStatus.OK)
  setScenario(@Body() input: unknown) {
    this.assertEnabled();
    return { enabled: true, scenario: this.suite.scenario.setScenario(parseScenario(input)) };
  }

  @Post("scenario/reset")
  @HttpCode(HttpStatus.OK)
  resetScenario() {
    this.assertEnabled();
    return { enabled: true, scenario: this.suite.scenario.reset() };
  }
}
