import { createHash, timingSafeEqual } from 'node:crypto';
import type { GatewayConfig } from './config.js';

export const API_KEY_HEADER = 'x-api-key';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Only SHA-256 digests of API keys live in config, so a leaked config file
 * does not leak usable credentials. Lookup compares digests in constant time.
 */
export class ApiKeyAuthenticator {
  private readonly keys: { name: string; digest: Buffer }[];

  constructor(apiKeys: GatewayConfig['apiKeys']) {
    this.keys = apiKeys.map((k) => ({ name: k.name, digest: Buffer.from(k.sha256, 'hex') }));
  }

  /** Returns the key's name, or null if the key is missing or unknown. */
  identify(presentedKey: string | string[] | undefined): string | null {
    if (typeof presentedKey !== 'string' || presentedKey.length === 0) return null;
    const digest = Buffer.from(sha256(presentedKey), 'hex');
    let match: string | null = null;
    for (const key of this.keys) {
      // Check every key (no early return) to keep timing independent of position.
      if (timingSafeEqual(key.digest, digest)) match = key.name;
    }
    return match;
  }
}
