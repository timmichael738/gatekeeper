/**
 * Generates a new API key and prints the SHA-256 digest to paste into gatekeeper.yaml.
 * Usage: npm run hash-key -- <name>
 */
import { randomBytes } from 'node:crypto';
import { sha256 } from '../src/auth.js';

const name = process.argv[2] ?? 'my-client';
const key = `gk_${randomBytes(24).toString('base64url')}`;

console.log(`API key (give this to the client, it is shown only once):\n  ${key}\n`);
console.log('Add this to the apiKeys section of gatekeeper.yaml:');
console.log(`  - name: ${name}\n    sha256: ${sha256(key)}`);
