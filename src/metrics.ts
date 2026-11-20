import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'gatekeeper_' });

  return {
    registry,
    requests: new Counter({
      name: 'gatekeeper_requests_total',
      help: 'Requests handled by the gateway, by route and HTTP status.',
      labelNames: ['route', 'status'] as const,
      registers: [registry],
    }),
    rejected: new Counter({
      name: 'gatekeeper_rejected_total',
      help: 'Requests rejected before reaching an upstream, by reason.',
      labelNames: ['route', 'reason'] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'gatekeeper_request_duration_seconds',
      help: 'End-to-end request latency through the gateway.',
      labelNames: ['route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    limiterErrors: new Counter({
      name: 'gatekeeper_limiter_errors_total',
      help: 'Rate-limiter store failures (requests were let through when failOpen is enabled).',
      labelNames: ['route'] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
