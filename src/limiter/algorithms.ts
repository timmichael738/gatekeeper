/**
 * Pure rate-limiting math shared by the in-memory and Redis-backed limiters.
 * Keeping the arithmetic in one place guarantees both stores make identical decisions.
 */
import type { SlidingWindowConfig, TokenBucketConfig } from '../config.js';
import type { Decision } from './types.js';

export interface TokenBucketState {
  tokens: number;
  updatedAt: number;
}

/** Refill the bucket for the elapsed time and try to take one token. */
export function takeToken(
  state: TokenBucketState | undefined,
  now: number,
  { capacity, refillPerSecond }: TokenBucketConfig,
): { state: TokenBucketState; decision: Decision } {
  const previous = state ?? { tokens: capacity, updatedAt: now };
  const elapsed = Math.max(0, now - previous.updatedAt);
  let tokens = Math.min(capacity, previous.tokens + (elapsed * refillPerSecond) / 1000);

  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;

  return {
    state: { tokens, updatedAt: now },
    decision: tokenBucketDecision(tokens, allowed, { capacity, refillPerSecond }),
  };
}

export function tokenBucketDecision(
  tokens: number,
  allowed: boolean,
  { capacity, refillPerSecond }: Pick<TokenBucketConfig, 'capacity' | 'refillPerSecond'>,
): Decision {
  const msPerToken = 1000 / refillPerSecond;
  return {
    allowed,
    limit: capacity,
    remaining: Math.floor(tokens),
    resetMs: Math.ceil((capacity - tokens) * msPerToken),
    retryAfterMs: allowed ? 0 : Math.ceil((1 - tokens) * msPerToken),
  };
}

export interface SlidingWindowState {
  windowStart: number;
  previous: number;
  current: number;
}

/**
 * Sliding-window counter: approximates a true sliding log using two fixed windows,
 * weighting the previous window by how much of it still overlaps the sliding window.
 * O(1) memory per client, unlike a sliding log which stores every timestamp.
 */
export function countInWindow(
  state: SlidingWindowState | undefined,
  now: number,
  { limit, windowMs }: SlidingWindowConfig,
): { state: SlidingWindowState; decision: Decision } {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  let next: SlidingWindowState;
  if (!state) {
    next = { windowStart, previous: 0, current: 0 };
  } else if (state.windowStart !== windowStart) {
    // Only carry the count over if the old window is the one immediately before this one.
    const adjacent = windowStart - state.windowStart === windowMs;
    next = { windowStart, previous: adjacent ? state.current : 0, current: 0 };
  } else {
    next = { ...state };
  }

  const elapsed = now - windowStart;
  const estimated = next.previous * (1 - elapsed / windowMs) + next.current;
  const allowed = estimated + 1 <= limit;
  if (allowed) next.current += 1;

  return {
    state: next,
    decision: slidingWindowDecision({ limit, windowMs }, next, now, estimated, allowed),
  };
}

export function slidingWindowDecision(
  { limit, windowMs }: Pick<SlidingWindowConfig, 'limit' | 'windowMs'>,
  state: SlidingWindowState,
  now: number,
  estimatedBefore: number,
  allowed: boolean,
): Decision {
  const resetMs = state.windowStart + windowMs - now;
  const used = estimatedBefore + (allowed ? 1 : 0);

  let retryAfterMs = 0;
  if (!allowed) {
    // Solve previous * (1 - (elapsed + x) / W) + current <= limit - 1 for x.
    const excess = estimatedBefore - (limit - 1);
    retryAfterMs =
      state.previous > 0
        ? Math.min(resetMs, Math.ceil((excess / state.previous) * windowMs))
        : resetMs;
  }

  return {
    allowed,
    limit,
    remaining: Math.max(0, Math.floor(limit - used)),
    resetMs,
    retryAfterMs,
  };
}
