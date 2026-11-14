/**
 * Password hashing: scrypt from node:crypto (RFC 7914), so there is no
 * dependency to audit. Parameters are stored with the hash, so they can be
 * raised later without invalidating existing accounts.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 256 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || salt.length === 0 || expected.length !== KEY_LEN) return false;
  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}
