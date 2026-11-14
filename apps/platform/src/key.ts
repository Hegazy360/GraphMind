/** Jack's 32-byte sealing key, kept next to its sign-in state (same as `jack serve`). */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export function loadOrCreateKey(dir: string): Uint8Array {
  const path = resolve(dir, 'secret.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${path} is not a valid key; delete it to start fresh`);
    return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
