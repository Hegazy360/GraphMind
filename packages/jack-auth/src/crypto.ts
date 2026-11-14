/**
 * Small, boring cryptography. Everything secret Jack stores at rest goes
 * through SecretBox (AES-256-GCM, random 96-bit nonce, versioned). Every
 * bearer value Jack hands out (codes, refresh tokens, session bindings) is
 * stored only as a SHA-256 hash, so a database dump cannot replay them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) === code_challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  // RFC 7636 §4.1: 43–128 characters from the unreserved set.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(sha256(verifier), challenge);
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new RangeError('SecretBox needs a 32-byte key');
    this.key = Buffer.from(key);
  }

  seal(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  /** `aad` binds a ciphertext to its row: a sealed value copied to another grant fails to open. */
  open(sealed: string, aad = ''): string {
    const [v, iv, body, tag] = sealed.split('.');
    if (v !== 'v1' || !iv || !body || !tag) throw new Error('malformed sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}
