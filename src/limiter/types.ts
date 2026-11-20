export interface Decision {
  allowed: boolean;
  /** The configured limit (bucket capacity or requests per window). */
  limit: number;
  /** Requests still available right now. */
  remaining: number;
  /** Milliseconds until the quota is fully restored. */
  resetMs: number;
  /** Milliseconds the client should wait before retrying (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string): Promise<Decision>;
  close?(): Promise<void>;
}

export type Clock = () => number;
