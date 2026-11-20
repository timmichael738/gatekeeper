import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { memoryLimiterFactory, redisLimiterFactory } from './limiter/index.js';

const configPath = process.env.GATEKEEPER_CONFIG ?? 'gatekeeper.yaml';
const config = await loadConfig(configPath);

let redis: Redis | undefined;
if (config.store.type === 'redis') {
  redis = new Redis(config.store.redisUrl!, {
    // Fail fast instead of queueing: a slow limiter is worse than a skipped one.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await redis.connect();
}

const app = await buildApp(config, {
  limiterFactory: redis ? redisLimiterFactory(redis) : memoryLimiterFactory,
  storeHealthy: async () => (redis ? (await redis.ping()) === 'PONG' : true),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await redis?.quit();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.server.host, port: config.server.port });
app.log.info(
  { store: config.store.type, routes: config.routes.map((r) => `${r.prefix} -> ${r.upstream}`) },
  'gatekeeper ready',
);
