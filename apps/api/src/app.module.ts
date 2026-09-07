import { DynamicModule, Module } from "@nestjs/common";
import { createMockAdapterSuite } from "@handoff/adapters";
import type { AppConfig } from "@handoff/config";
import { createDatabase } from "@handoff/db";
import Redis from "ioredis";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { IngestionController } from "./ingestion.controller";
import { SimulatorController } from "./simulator.controller";
import { OperatorController } from "./operator.controller";
import { ConsoleController } from "./console.controller";
import { APP_CONFIG, DATABASE_HANDLE, MOCK_ADAPTER_SUITE, REDIS_CLIENT } from "./tokens";

@Module({
  controllers: [
    HealthController,
    IngestionController,
    SimulatorController,
    OperatorController,
    ConsoleController,
  ],
  providers: [HealthService],
})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const database = createDatabase(config);
    const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const mockAdapters = createMockAdapterSuite();
    return {
      module: AppModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE_HANDLE, useValue: database },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MOCK_ADAPTER_SUITE, useValue: mockAdapters },
        HealthService,
      ],
      controllers: [
        HealthController,
        IngestionController,
        SimulatorController,
        OperatorController,
        ConsoleController,
      ],
      exports: [HealthService],
    };
  }
}
