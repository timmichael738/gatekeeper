import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const tokenBucketSchema = z.object({
  algorithm: z.literal('token-bucket'),
  /** Maximum burst size. */
  capacity: z.number().int().positive(),
  /** Sustained rate: tokens added back per second. */
  refillPerSecond: z.number().positive(),
});

const slidingWindowSchema = z.object({
  algorithm: z.literal('sliding-window'),
  /** Maximum requests per window. */
  limit: z.number().int().positive(),
  windowMs: z.number().int().positive(),
});

export const rateLimitSchema = z.discriminatedUnion('algorithm', [
  tokenBucketSchema,
  slidingWindowSchema,
]);

const routeSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'route names must be kebab-case'),
  prefix: z.string().startsWith('/'),
  upstream: z.url(),
  rewritePrefix: z.string().default(''),
  auth: z.enum(['none', 'api-key']).default('none'),
  rateLimit: rateLimitSchema.optional(),
});

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(0).max(65535).default(8080),
      trustProxy: z.boolean().default(false),
    })
    .prefault({}),
  store: z
    .object({
      type: z.enum(['memory', 'redis']).default('memory'),
      redisUrl: z.string().optional(),
      /** When the store is unreachable, allow traffic instead of rejecting it. */
      failOpen: z.boolean().default(true),
    })
    .prefault({}),
  apiKeys: z
    .array(
      z.object({
        name: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be a hex-encoded SHA-256 digest'),
      }),
    )
    .default([]),
  routes: z.array(routeSchema).min(1),
});

export type RateLimitConfig = z.infer<typeof rateLimitSchema>;
export type TokenBucketConfig = z.infer<typeof tokenBucketSchema>;
export type SlidingWindowConfig = z.infer<typeof slidingWindowSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type GatewayConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid gateway configuration:\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;

  // Environment variables win over the file so the same config works across environments.
  if (env.PORT) config.server.port = Number(env.PORT);
  if (env.REDIS_URL) {
    config.store.type = 'redis';
    config.store.redisUrl = env.REDIS_URL;
  }
  if (config.store.type === 'redis' && !config.store.redisUrl) {
    throw new Error('store.type is "redis" but no redisUrl / REDIS_URL was provided');
  }
  return config;
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const text = await readFile(path, 'utf8');
  return parseConfig(parse(text));
}
