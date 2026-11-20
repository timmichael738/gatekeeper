import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisSlidingWindow, RedisTokenBucket } from '../src/limiter/redis.js';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('redis store (integration)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(url!);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('token bucket enforces capacity atomically under concurrency', async () => {
    const bucket = new RedisTokenBucket(redis, {
      algorithm: 'token-bucket',
      capacity: 10,
      refillPerSecond: 0.01,
    });
    const key = randomUUID();
    // 50 concurrent requests from "different gateway replicas": exactly 10 may pass.
    const results = await Promise.all(Array.from({ length: 50 }, () => bucket.consume(key)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('sliding window enforces the limit atomically under concurrency', async () => {
    const window = new RedisSlidingWindow(redis, {
      algorithm: 'sliding-window',
      limit: 7,
      windowMs: 60_000,
    });
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 30 }, () => window.consume(key)));
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(7);
    expect(results.some((r) => !r.allowed)).toBe(true);
  });

  it('recovers when the script cache is flushed', async () => {
    const bucket = new RedisTokenBucket(redis, {
      algorithm: 'token-bucket',
      capacity: 5,
      refillPerSecond: 1,
    });
    await bucket.consume(randomUUID());
    await redis.script('FLUSH');
    expect((await bucket.consume(randomUUID())).allowed).toBe(true);
  });
});
