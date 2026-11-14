/**
 * The smallest correct HS256 JWT: node:crypto only, so the package a
 * customer installs in their API has zero dependencies. Verification is
 * constant-time on the signature and strict on the header (`alg` must be
 * HS256; `none` and every asymmetric algorithm are refused, so a token
 * cannot be downgraded).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class JwtError extends Error {
  override name = 'JwtError';
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export interface VerifyOptions {
  /** Required `typ` claim inside the payload (Jack uses a payload `typ`, so one secret serves three token kinds safely). */
  typ: string;
  issuer: string;
  audience: string;
  now?: number;
  /** Allowed clock skew in seconds (default 60). */
  skew?: number;
}

export function verifyHs256(token: string, secret: string, opts: VerifyOptions): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [head, body, sig] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new JwtError('malformed token');
  }
  if (header.alg !== 'HS256') throw new JwtError('unexpected algorithm');
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError('bad signature');
  if (payload.typ !== opts.typ) throw new JwtError(`wrong token type (expected ${opts.typ})`);
  if (payload.iss !== opts.issuer) throw new JwtError('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.audience)) throw new JwtError('wrong audience');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.skew ?? 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) throw new JwtError('expired');
  if (typeof payload.nbf === 'number' && payload.nbf - skew > now) throw new JwtError('not yet valid');
  if (typeof payload.iat === 'number' && payload.iat - skew > now) throw new JwtError('issued in the future');
  return payload;
}
