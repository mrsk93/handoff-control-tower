import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { RateLimitStore } from "@handoff/security";

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number, now: Date) {
    const bucketStart = Math.floor(now.getTime() / windowMs) * windowMs;
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    const redisKey = `handoff:rate:${digest}:${bucketStart}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.pexpire(redisKey, windowMs + 1_000);
    return { count, resetAt: new Date(bucketStart + windowMs) };
  }
}

export function createRedisRateLimitStore(redis: Redis): RateLimitStore {
  return new RedisRateLimitStore(redis);
}
