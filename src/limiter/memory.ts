import type { SlidingWindowConfig, TokenBucketConfig } from '../config.js';
import {
  countInWindow,
  takeToken,
  type SlidingWindowState,
  type TokenBucketState,
} from './algorithms.js';
import type { Clock, Decision, RateLimiter } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Single-process limiter. Ideal for development or a single gateway instance;
 * use the Redis store when running several replicas.
 */
abstract class MemoryLimiter<S> implements RateLimiter {
  protected readonly entries = new Map<string, S>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(protected readonly now: Clock = Date.now) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  protected abstract step(state: S | undefined, now: number): { state: S; decision: Decision };
  protected abstract isIdle(state: S, now: number): boolean;

  async consume(key: string): Promise<Decision> {
    const now = this.now();
    const { state, decision } = this.step(this.entries.get(key), now);
    this.entries.set(key, state);
    return decision;
  }

  /** Drop entries that would be indistinguishable from a brand-new client. */
  sweep(): void {
    const now = this.now();
    for (const [key, state] of this.entries) {
      if (this.isIdle(state, now)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
  }
}

export class MemoryTokenBucket extends MemoryLimiter<TokenBucketState> {
  constructor(
    private readonly config: TokenBucketConfig,
    now?: Clock,
  ) {
    super(now);
  }

  protected step(state: TokenBucketState | undefined, now: number) {
    return takeToken(state, now, this.config);
  }

  protected isIdle(state: TokenBucketState, now: number): boolean {
    const refilled = state.tokens + ((now - state.updatedAt) * this.config.refillPerSecond) / 1000;
    return refilled >= this.config.capacity;
  }
}

export class MemorySlidingWindow extends MemoryLimiter<SlidingWindowState> {
  constructor(
    private readonly config: SlidingWindowConfig,
    now?: Clock,
  ) {
    super(now);
  }

  protected step(state: SlidingWindowState | undefined, now: number) {
    return countInWindow(state, now, this.config);
  }

  protected isIdle(state: SlidingWindowState, now: number): boolean {
    return now - state.windowStart >= 2 * this.config.windowMs;
  }
}
