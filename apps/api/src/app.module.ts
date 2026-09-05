import { DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "@handoff/config";
import { createDatabase } from "@handoff/db";
import Redis from "ioredis";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { APP_CONFIG, DATABASE_HANDLE, REDIS_CLIENT } from "./tokens";

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const database = createDatabase(config);
    const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    return {
      module: AppModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE_HANDLE, useValue: database },
        { provide: REDIS_CLIENT, useValue: redis },
        HealthService,
      ],
      controllers: [HealthController],
      exports: [HealthService],
    };
  }
}
