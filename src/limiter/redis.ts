import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SlidingWindowConfig, TokenBucketConfig } from '../config.js';
import { slidingWindowDecision, tokenBucketDecision } from './algorithms.js';
import type { Decision, RateLimiter } from './types.js';

/**
 * Both scripts run atomically inside Redis, so N gateway replicas share one consistent
 * view of each client's quota with no race conditions. They read the clock from Redis
 * (TIME) rather than the caller, so clock skew between gateway hosts cannot leak quota.
 *
 * Fractional values are returned as strings because Redis truncates Lua numbers to integers.
 */
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2]) / 1000
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now

tokens = math.min(capacity, tokens + math.max(0, now - ts) * per_ms)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / per_ms) + 1000)
return { allowed, tostring(tokens) }
`;

const SLIDING_WINDOW_LUA = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ws = math.floor(now / window) * window

local state = redis.call('HMGET', KEYS[1], 'ws', 'prev', 'cur')
local old_ws = tonumber(state[1])
local prev = tonumber(state[2]) or 0
local cur = tonumber(state[3]) or 0

if old_ws == nil then
  prev, cur = 0, 0
elseif old_ws ~= ws then
  if ws - old_ws == window then prev = cur else prev = 0 end
  cur = 0
end

local estimated = prev * (1 - (now - ws) / window) + cur
local allowed = 0
if estimated + 1 <= limit then
  cur = cur + 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'ws', ws, 'prev', prev, 'cur', cur)
redis.call('PEXPIRE', KEYS[1], window * 2)
return { allowed, tostring(estimated), ws, prev, cur, now }
`;

class LuaScript {
  private readonly sha: string;

  constructor(private readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  /** EVALSHA first (cheap), falling back to EVAL once if the script cache was flushed. */
  async run(redis: Redis, key: string, args: (string | number)[]): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, 1, key, ...args);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        return redis.eval(this.source, 1, key, ...args);
      }
      throw error;
    }
  }
}

const tokenBucketScript = new LuaScript(TOKEN_BUCKET_LUA);
const slidingWindowScript = new LuaScript(SLIDING_WINDOW_LUA);

export class RedisTokenBucket implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly config: TokenBucketConfig,
    private readonly prefix = 'gk:tb:',
  ) {}

  async consume(key: string): Promise<Decision> {
    const [allowed, tokens] = (await tokenBucketScript.run(this.redis, this.prefix + key, [
      this.config.capacity,
      this.config.refillPerSecond,
    ])) as [number, string];
    return tokenBucketDecision(Number(tokens), allowed === 1, this.config);
  }
}

export class RedisSlidingWindow implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly config: SlidingWindowConfig,
    private readonly prefix = 'gk:sw:',
  ) {}

  async consume(key: string): Promise<Decision> {
    const [allowed, estimated, windowStart, previous, current, now] =
      (await slidingWindowScript.run(this.redis, this.prefix + key, [
        this.config.limit,
        this.config.windowMs,
      ])) as [number, string, number, number, number, number];
    return slidingWindowDecision(
      this.config,
      { windowStart, previous, current },
      now,
      Number(estimated),
      allowed === 1,
    );
  }
}
