import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/auth.js';
import { parseConfig } from '../src/config.js';

const API_KEY = 'test-key-123';
let upstream: FastifyInstance;
let gateway: FastifyInstance;

beforeAll(async () => {
  upstream = Fastify();
  upstream.all('/*', async (request) => ({ path: request.url, headers: request.headers }));
  const upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });

  const config = parseConfig(
    {
      apiKeys: [{ name: 'acme', sha256: sha256(API_KEY) }],
      routes: [
        {
          name: 'public',
          prefix: '/public',
          upstream: upstreamUrl,
          rewritePrefix: '/v1',
          rateLimit: { algorithm: 'token-bucket', capacity: 2, refillPerSecond: 0.001 },
        },
        { name: 'private', prefix: '/private', upstream: upstreamUrl, auth: 'api-key' },
      ],
    },
    {},
  );
  gateway = await buildApp(config, { logger: false });
});

afterAll(async () => {
  await gateway.close();
  await upstream.close();
});

describe('gateway', () => {
  it('proxies to the upstream with the prefix rewritten', async () => {
    const res = await gateway.inject({ url: '/public/users?page=2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('/v1/users?page=2');
    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('returns 429 with Retry-After once the bucket is empty', async () => {
    await gateway.inject({ url: '/public/a' });
    const res = await gateway.inject({ url: '/public/a' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects requests without a valid API key', async () => {
    expect((await gateway.inject({ url: '/private/x' })).statusCode).toBe(401);
    const wrong = await gateway.inject({ url: '/private/x', headers: { 'x-api-key': 'nope' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('forwards the client identity but never the API key itself', async () => {
    const res = await gateway.inject({ url: '/private/x', headers: { 'x-api-key': API_KEY } });
    expect(res.statusCode).toBe(200);
    const { headers } = res.json();
    expect(headers['x-gateway-client']).toBe('key:acme');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('exposes Prometheus metrics', async () => {
    const res = await gateway.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('gatekeeper_requests_total{route="public",status="200"}');
    expect(res.body).toContain('gatekeeper_rejected_total{route="public",reason="rate_limited"}');
  });

  it('fails open when the limiter store is down', async () => {
    const config = parseConfig(
      {
        routes: [
          {
            name: 'flaky',
            prefix: '/flaky',
            upstream: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`,
            rateLimit: { algorithm: 'sliding-window', limit: 1, windowMs: 1000 },
          },
        ],
      },
      {},
    );
    const app = await buildApp(config, {
      logger: false,
      limiterFactory: () => ({ consume: () => Promise.reject(new Error('ECONNREFUSED')) }),
    });
    expect((await app.inject({ url: '/flaky/' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('upstream failures', () => {
  it('returns 502 when the upstream is unreachable', async () => {
    const config = parseConfig(
      { routes: [{ name: 'down', prefix: '/down', upstream: 'http://127.0.0.1:1' }] },
      {},
    );
    const app = await buildApp(config, { logger: false });
    const res = await app.inject({ url: '/down/' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Bad Gateway');
    await app.close();
  });
});

describe('config', () => {
  it('reports readable validation errors', () => {
    expect(() => parseConfig({ routes: [{ name: 'Bad Name', prefix: 'x' }] }, {})).toThrow(
      /Invalid gateway configuration/,
    );
  });

  it('switches to Redis when REDIS_URL is set', () => {
    const config = parseConfig(
      { routes: [{ name: 'a', prefix: '/a', upstream: 'http://localhost:1' }] },
      { REDIS_URL: 'redis://localhost:6379' },
    );
    expect(config.store).toMatchObject({ type: 'redis', redisUrl: 'redis://localhost:6379' });
  });
});
