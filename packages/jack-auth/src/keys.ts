/**
 * The issuer's signing keys: ES256, generated on first use, private half
 * sealed at rest. Access tokens are JWTs so the data plane can verify them
 * without a database read; revocation is still checked per call.
 */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';
import type { SecretBox } from './crypto.js';
import type { AuthStore } from './store.js';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export class KeyRing {
  private current: SigningKey | null = null;

  constructor(
    private readonly store: AuthStore,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  async signingKey(): Promise<SigningKey> {
    if (this.current) return this.current;
    const existing = this.store.listSigningKeys()[0];
    if (existing) {
      const jwk = JSON.parse(this.box.open(existing.sealedPrivateJwk, `key:${existing.kid}`)) as JWK;
      this.current = { kid: existing.kid, privateKey: (await importJWK(jwk, 'ES256')) as CryptoKey, publicJwk: existing.publicJwk as JWK };
      return this.current;
    }
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    const full = { ...publicJwk, kid, alg: 'ES256', use: 'sig' };
    this.store.putSigningKey({
      kid,
      publicJwk: full,
      sealedPrivateJwk: this.box.seal(JSON.stringify(await exportJWK(privateKey)), `key:${kid}`),
      createdAt: this.now(),
    });
    this.current = { kid, privateKey, publicJwk: full };
    return this.current;
  }

  /** Every key still trusted for verification (rotation keeps the previous one published). */
  jwks(): { keys: JWK[] } {
    return { keys: this.store.listSigningKeys().map((k) => k.publicJwk as JWK) };
  }
}
