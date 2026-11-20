import { randomUUID } from 'node:crypto';
import httpProxy from '@fastify/http-proxy';
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { API_KEY_HEADER, ApiKeyAuthenticator } from './auth.js';
import type { GatewayConfig, RouteConfig } from './config.js';
import { memoryLimiterFactory, type Decision, type LimiterFactory } from './limiter/index.js';
import { createMetrics, type Metrics } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    gatewayRoute: string | null;
    gatewayClient: string | null;
  }
}

export interface BuildOptions {
  limiterFactory?: LimiterFactory;
  logger?: FastifyServerOptions['logger'];
  /** Reports whether the backing store is healthy, for /readyz. */
  storeHealthy?: () => Promise<boolean>;
}

export async function buildApp(config: GatewayConfig, options: BuildOptions = {}) {
  const {
    limiterFactory = memoryLimiterFactory,
    logger = true,
    storeHealthy = async () => true,
  } = options;

  const app = Fastify({
    logger,
    trustProxy: config.server.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  const metrics = createMetrics();
  const authenticator = new ApiKeyAuthenticator(config.apiKeys);

  app.decorateRequest('gatewayRoute', null);
  app.decorateRequest('gatewayClient', null);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!request.gatewayRoute) return;
    metrics.requests.inc({ route: request.gatewayRoute, status: reply.statusCode });
    metrics.duration.observe({ route: request.gatewayRoute }, reply.elapsedTime / 1000);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const healthy = await storeHealthy().catch(() => false);
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ready' : 'store-unavailable' });
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  for (const route of config.routes) {
    const limiter = route.rateLimit ? limiterFactory(route.rateLimit, route.name) : null;

    await app.register(httpProxy, {
      upstream: route.upstream,
      prefix: route.prefix,
      rewritePrefix: route.rewritePrefix,
      preHandler: async (request, reply) => {
        request.gatewayRoute = route.name;

        const client = identifyClient(route, request, authenticator);
        if (client === null) {
          metrics.rejected.inc({ route: route.name, reason: 'unauthorized' });
          return reply.code(401).send({
            error: 'Unauthorized',
            message: `A valid API key is required in the "${API_KEY_HEADER}" header.`,
          });
        }
        request.gatewayClient = client;

        if (!limiter) return;
        const decision = await consumeSafely(
          () => limiter.consume(client),
          route,
          config.store.failOpen,
          metrics,
          request,
        );
        if (!decision) return; // store failed and we are failing open

        applyRateLimitHeaders(reply, decision);
        if (!decision.allowed) {
          metrics.rejected.inc({ route: route.name, reason: 'rate_limited' });
          reply.header('retry-after', Math.ceil(decision.retryAfterMs / 1000));
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Retry in ${Math.ceil(decision.retryAfterMs / 1000)}s.`,
          });
        }
      },
      replyOptions: {
        onError: (reply, { error }) => {
          // Upstream failures are the upstream's fault, not ours: 502/504, never 500.
          const code = (error as NodeJS.ErrnoException).code ?? '';
          const timedOut = /timeout/i.test(`${code} ${error.message}`);
          reply.log.warn({ err: error, route: route.name }, 'upstream request failed');
          void reply.code(timedOut ? 504 : 502).send({
            error: timedOut ? 'Gateway Timeout' : 'Bad Gateway',
            message: `Upstream for route "${route.name}" is unavailable.`,
          });
        },
        rewriteRequestHeaders: (request, headers) => {
          // Never forward the client's credential upstream; pass the resolved identity instead.
          const { [API_KEY_HEADER]: _apiKey, ...rest } = headers;
          const client = (request as FastifyRequest).gatewayClient;
          return {
            ...rest,
            'x-request-id': (request as FastifyRequest).id,
            ...(client ? { 'x-gateway-client': client } : {}),
          };
        },
      },
    });
  }

  return app;
}

function identifyClient(
  route: RouteConfig,
  request: FastifyRequest,
  authenticator: ApiKeyAuthenticator,
): string | null {
  if (route.auth === 'api-key') {
    const name = authenticator.identify(request.headers[API_KEY_HEADER]);
    return name ? `key:${name}` : null;
  }
  return `ip:${request.ip}`;
}

async function consumeSafely(
  consume: () => Promise<Decision>,
  route: RouteConfig,
  failOpen: boolean,
  metrics: Metrics,
  request: FastifyRequest,
): Promise<Decision | null> {
  try {
    return await consume();
  } catch (error) {
    metrics.limiterErrors.inc({ route: route.name });
    request.log.error({ err: error, route: route.name }, 'rate limiter store failure');
    if (failOpen) return null;
    throw Object.assign(new Error('Rate limiter unavailable'), { statusCode: 503 });
  }
}

/** Headers follow the IETF "RateLimit header fields for HTTP" draft. */
function applyRateLimitHeaders(reply: FastifyReply, decision: Decision): void {
  reply.header('ratelimit-limit', decision.limit);
  reply.header('ratelimit-remaining', decision.remaining);
  reply.header('ratelimit-reset', Math.ceil(decision.resetMs / 1000));
}
