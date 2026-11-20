import { afterEach, describe, expect, it } from 'vitest';
import { MemorySlidingWindow, MemoryTokenBucket } from '../src/limiter/memory.js';

let clockMs = 0;
const clock = () => clockMs;
const limiters: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(l: T) => (limiters.push(l), l);

afterEach(async () => {
  clockMs = 0;
  await Promise.all(limiters.splice(0).map((l) => l.close()));
});

describe('token bucket', () => {
  it('allows a burst up to capacity, then rejects', async () => {
    const bucket = track(
      new MemoryTokenBucket({ algorithm: 'token-bucket', capacity: 3, refillPerSecond: 1 }, clock),
    );

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await bucket.consume('client'));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBe(1000);
  });

  it('refills continuously at the configured rate', async () => {
    const bucket = track(
      new MemoryTokenBucket({ algorithm: 'token-bucket', capacity: 2, refillPerSecond: 4 }, clock),
    );
    await bucket.consume('c');
    await bucket.consume('c');
    expect((await bucket.consume('c')).allowed).toBe(false);

    clockMs += 250; // exactly one token at 4/s
    expect((await bucket.consume('c')).allowed).toBe(true);
    expect((await bucket.consume('c')).allowed).toBe(false);
  });

  it('never exceeds capacity after a long idle period', async () => {
    const bucket = track(
      new MemoryTokenBucket({ algorithm: 'token-bucket', capacity: 5, refillPerSecond: 10 }, clock),
    );
    await bucket.consume('c');
    clockMs += 60_000;
    expect((await bucket.consume('c')).remaining).toBe(4);
  });

  it('isolates clients from each other', async () => {
    const bucket = track(
      new MemoryTokenBucket({ algorithm: 'token-bucket', capacity: 1, refillPerSecond: 1 }, clock),
    );
    expect((await bucket.consume('a')).allowed).toBe(true);
    expect((await bucket.consume('a')).allowed).toBe(false);
    expect((await bucket.consume('b')).allowed).toBe(true);
  });

  it('sweeps idle, fully refilled buckets', async () => {
    const bucket = track(
      new MemoryTokenBucket({ algorithm: 'token-bucket', capacity: 2, refillPerSecond: 1 }, clock),
    );
    await bucket.consume('c');
    bucket.sweep();
    expect(bucket.size).toBe(1);
    clockMs += 1000;
    bucket.sweep();
    expect(bucket.size).toBe(0);
  });
});

describe('sliding window', () => {
  const config = { algorithm: 'sliding-window', limit: 10, windowMs: 1000 } as const;

  it('allows up to the limit within a window', async () => {
    const window = track(new MemorySlidingWindow(config, clock));
    for (let i = 0; i < 10; i++) expect((await window.consume('c')).allowed).toBe(true);
    const denied = await window.consume('c');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetMs).toBe(1000);
  });

  it('weights the previous window to prevent boundary bursts', async () => {
    const window = track(new MemorySlidingWindow(config, clock));
    clockMs = 900;
    for (let i = 0; i < 10; i++) await window.consume('c');

    // 100ms into the next window, 90% of the previous window still counts: 10 * 0.9 = 9.
    // A fixed-window limiter would allow 10 more here (20 requests in 200ms).
    clockMs = 1100;
    expect((await window.consume('c')).allowed).toBe(true);
    expect((await window.consume('c')).allowed).toBe(false);
  });

  it('forgets the previous window once it no longer overlaps', async () => {
    const window = track(new MemorySlidingWindow(config, clock));
    for (let i = 0; i < 10; i++) await window.consume('c');
    clockMs = 2500; // two windows later: previous window is empty
    expect((await window.consume('c')).remaining).toBe(9);
  });

  it('suggests a retry delay no longer than the window reset', async () => {
    const window = track(new MemorySlidingWindow(config, clock));
    clockMs = 500;
    for (let i = 0; i < 10; i++) await window.consume('c');
    const denied = await window.consume('c');
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(denied.resetMs);
  });
});
