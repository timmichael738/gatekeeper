import type { Redis } from 'ioredis';
import type { RateLimitConfig } from '../config.js';
import { MemorySlidingWindow, MemoryTokenBucket } from './memory.js';
import { RedisSlidingWindow, RedisTokenBucket } from './redis.js';
import type { RateLimiter } from './types.js';

export type { Decision, RateLimiter } from './types.js';

export type LimiterFactory = (config: RateLimitConfig, routeName: string) => RateLimiter;

export const memoryLimiterFactory: LimiterFactory = (config) =>
  config.algorithm === 'token-bucket'
    ? new MemoryTokenBucket(config)
    : new MemorySlidingWindow(config);

export const redisLimiterFactory =
  (redis: Redis): LimiterFactory =>
  (config, routeName) =>
    config.algorithm === 'token-bucket'
      ? new RedisTokenBucket(redis, config, `gk:tb:${routeName}:`)
      : new RedisSlidingWindow(redis, config, `gk:sw:${routeName}:`);
