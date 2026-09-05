import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { checkReadiness, type AppConfig, type DependencyProbe } from "@handoff/config";
import type { DatabaseHandle } from "@handoff/db";
import Redis from "ioredis";
import { APP_CONFIG, DATABASE_HANDLE, REDIS_CLIENT } from "./tokens";

@Injectable()
export class HealthService implements OnModuleDestroy {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  live(): { status: "ok" } {
    return { status: "ok" };
  }

  async ready() {
    const probes: DependencyProbe[] = [
      {
        name: "postgres",
        check: async () => {
          await this.database.pool.query("select 1");
        },
      },
      {
        name: "redis",
        check: async () => {
          await this.redis.ping();
        },
      },
    ];
    const result = await checkReadiness(probes);
    return {
      ...result,
      environment: this.config.appEnv,
      adapterMode: this.config.adapterMode,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
    await this.database.pool.end();
  }
}
