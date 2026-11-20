# Gatekeeper

[![CI](https://github.com/timmichael738/gatekeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/timmichael738/gatekeeper/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

**A lightweight API gateway with distributed rate limiting.** Put it in front of any HTTP service to get
per-client rate limits (token bucket or sliding window), API-key authentication and Prometheus metrics.
Limits are shared across any number of gateway replicas through atomic Redis Lua scripts.

```text
                    ┌───────────────────── Gatekeeper ─────────────────────┐
 client ──HTTP──▶   │ request-id → auth (API key / IP) → rate limiter → proxy │ ──▶ upstream service
                    └───────────────┬──────────────────────────┬───────────┘
                                    │ atomic Lua (EVALSHA)     │ /metrics
                                    ▼                          ▼
                                  Redis                    Prometheus
```

## Features

- **Two rate-limiting algorithms**, configurable per route:
  - **Token bucket** — permits short bursts up to `capacity`, then a sustained `refillPerSecond`.
  - **Sliding-window counter** — smooth limits with no boundary bursts and O(1) memory per client.
- **Distributed by design** — Redis-backed limits are evaluated in a single Lua script per request,
  so concurrent replicas can't race. The script reads the clock from Redis (`TIME`), so clock
  skew between gateway hosts can't leak extra quota.
- **Standard headers** — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
  ([IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)) and `Retry-After` on `429`.
- **API-key auth** — only SHA-256 digests are stored in config and compared in constant time; the key
  is stripped before forwarding and replaced by an `x-gateway-client` identity header.
- **Fail-open** — if Redis goes down, traffic keeps flowing and `gatekeeper_limiter_errors_total` alerts you
  (set `failOpen: false` to reject requests with `503` instead).
- **Observability** — Prometheus metrics, structured JSON logs, `x-request-id` propagation,
  `/healthz` (liveness) and `/readyz` (store connectivity).
- **Validated config** — YAML is checked against a Zod schema at startup with readable errors.

## Quick start

```bash
# Two gateway replicas + Redis + a demo upstream
docker compose up --build

# Public route (per-IP token bucket: burst 20, then 5 req/s). The 21st rapid request returns 429.
for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code} " localhost:8081/public/; done

# Limits are shared: requests to the second replica draw from the same bucket
curl -i localhost:8082/public/

# Partner route (per-API-key sliding window: 100 req/min)
curl -i -H "x-api-key: demo-key-change-me" localhost:8081/partner/
```

Run locally without Docker:

```bash
npm install
npm run dev            # uses gatekeeper.yaml with the in-memory store
REDIS_URL=redis://localhost:6379 npm run dev   # shared Redis store
```

## Configuration

```yaml
store:
  type: redis # or memory
  failOpen: true

apiKeys:
  - name: acme
    sha256: <digest> # generate with: npm run hash-key -- acme

routes:
  - name: partner
    prefix: /partner
    upstream: http://orders-service:3000
    rewritePrefix: /api
    auth: api-key # limit per API key instead of per IP
    rateLimit:
      algorithm: sliding-window
      limit: 100
      windowMs: 60000
```

| Variable            | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `GATEKEEPER_CONFIG` | Path to the YAML config (default `gatekeeper.yaml`)    |
| `REDIS_URL`         | Enables the Redis store and overrides `store.redisUrl` |
| `PORT`              | Overrides `server.port`                                |

## Design notes

**Why a sliding-window counter instead of a sliding log?** A log stores every request timestamp
(O(n) memory per client). The counter keeps two numbers and weights the previous window by its
remaining overlap, so it's accurate to within a few percent with constant memory. The test suite
shows the case it solves: a fixed window would let 20 requests through in 200 ms around a window
boundary, while this limiter allows 10.

**One source of truth for the math.** The decision logic lives in pure functions
([`src/limiter/algorithms.ts`](src/limiter/algorithms.ts)), used directly by the memory store and
mirrored in the Lua scripts. Tests use an injected clock, so they are deterministic.

**Fractional tokens in Redis.** Redis truncates Lua numbers to integers when they're returned, so the
scripts return token counts as strings to keep sub-token precision.

## Metrics

| Metric                                | Labels            |
| ------------------------------------- | ----------------- |
| `gatekeeper_requests_total`           | `route`, `status` |
| `gatekeeper_rejected_total`           | `route`, `reason` |
| `gatekeeper_request_duration_seconds` | `route`           |
| `gatekeeper_limiter_errors_total`     | `route`           |

## Development

```bash
npm test               # unit + gateway tests (Redis integration tests run when REDIS_URL is set)
npm run lint && npm run typecheck
k6 run bench/load.js   # load test against a running gateway
```

## Project structure

```text
src/
  app.ts              Fastify app: auth, limiting, proxying, metrics
  config.ts           Zod schema + YAML loader
  auth.ts             Hashed API-key authentication
  metrics.ts          Prometheus registry
  limiter/
    algorithms.ts     Pure token-bucket and sliding-window math
    memory.ts         Single-instance store with idle-entry sweeping
    redis.ts          Atomic Lua scripts for distributed limiting
  server.ts           Entry point with graceful shutdown
```

## License

[MIT](LICENSE) © Michael Timothy
