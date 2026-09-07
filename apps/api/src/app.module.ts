import { DynamicModule, Module } from "@nestjs/common";
import { createMockAdapterSuite, createRedisRateLimitStore } from "@handoff/adapters";
import type { AppConfig } from "@handoff/config";
import { createDatabase } from "@handoff/db";
import { MetricsRegistry, StructuredLogger } from "@handoff/observability";
import {
  createAesGcmCredentialCipher,
  deriveCredentialKey,
  FixedWindowRateLimiter,
} from "@handoff/security";
import Redis from "ioredis";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { IngestionController } from "./ingestion.controller";
import { SimulatorController } from "./simulator.controller";
import { OperatorController } from "./operator.controller";
import { ConsoleController } from "./console.controller";
import { MetricsController } from "./metrics.controller";
import { rateLimitRules } from "./security";
import {
  APP_CONFIG,
  CREDENTIAL_CIPHER,
  DATABASE_HANDLE,
  LOGGER,
  METRICS,
  MOCK_ADAPTER_SUITE,
  RATE_LIMITER,
  REDIS_CLIENT,
} from "./tokens";

@Module({
  controllers: [
    HealthController,
    IngestionController,
    SimulatorController,
    OperatorController,
    ConsoleController,
    MetricsController,
  ],
  providers: [HealthService],
})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const database = createDatabase(config);
    const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const mockAdapters = createMockAdapterSuite();
    const logger = new StructuredLogger();
    const metrics = new MetricsRegistry();
    const credentialCipher = createAesGcmCredentialCipher(
      deriveCredentialKey(config.credentialEncryptionSecret),
    );
    const rateLimiter = new FixedWindowRateLimiter(
      createRedisRateLimitStore(redis),
      rateLimitRules(config),
    );
    return {
      module: AppModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE_HANDLE, useValue: database },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MOCK_ADAPTER_SUITE, useValue: mockAdapters },
        { provide: LOGGER, useValue: logger },
        { provide: METRICS, useValue: metrics },
        { provide: CREDENTIAL_CIPHER, useValue: credentialCipher },
        { provide: RATE_LIMITER, useValue: rateLimiter },
        HealthService,
      ],
      controllers: [
        HealthController,
        IngestionController,
        SimulatorController,
        OperatorController,
        ConsoleController,
        MetricsController,
      ],
      exports: [HealthService],
    };
  }
}
