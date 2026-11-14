/**
 * @graphmind-ai/jack-verify — what you add to YOUR API for Jack's `link`
 * sign-in mode. Zero dependencies. Two jobs:
 *
 *  1. The link route. Jack sends a signed-in user of your app to it with
 *     `?request=<token>`. You verify the request, take the user from your own
 *     session, and send them back with a signed response:
 *
 *       const jack = createJackVerifier({ secret: process.env.JACK_LINK_SECRET, issuer, audience });
 *       app.get('/jack/link', (req, res) => {
 *         const { returnUrl } = jack.verifyLinkRequest(req.query.request);
 *         if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
 *         res.redirect(jack.linkResponseUrl(req.query.request, { userId: req.user.id, name: req.user.name }));
 *       });
 *
 *  2. The assertion. Every request Jack makes for that user carries a
 *     `Jack-Assertion` header, a short-lived signed token naming the user and
 *     the permissions they granted. Verify it instead of a session:
 *
 *       app.use(jack.express());          // sets req.jackUser = { userId, scopes } when present
 *
 * One shared secret (`JACK_LINK_SECRET`, also stored encrypted in Jack) signs
 * all three token kinds; each has its own `typ`, so none can stand in for
 * another. Assertions live 60 s and are single-use (replays are refused).
 */
import { JwtError, signHs256, verifyHs256 } from './jwt.js';

export { JwtError, signHs256, verifyHs256 } from './jwt.js';

export const ASSERTION_HEADER = 'jack-assertion';
export const TYP = { request: 'jack-link-request', response: 'jack-link-response', assertion: 'jack-link-assertion' } as const;
export const RESPONSE_TTL_SECONDS = 300;

export interface JackVerifierOptions {
  /** JACK_LINK_SECRET: at least 32 characters; the same value is set on the Jack project. */
  secret: string;
  /** The Jack project's issuer, e.g. https://acme.mcp.graphmind.ai (shown on its Sign-in page). */
  issuer: string;
  /** Your API as Jack calls it — the project's `upstream` origin, e.g. https://api.acme.com. */
  audience: string;
  /** Milliseconds since epoch; injectable for tests. */
  now?: () => number;
}

export interface LinkRequest {
  /** Opaque id of the sign-in in progress; echo it back (`linkResponse` does). */
  requestId: string;
  /** Where to send the user when done (`linkResponseUrl` builds the full URL). */
  returnUrl: string;
  /** Permissions the AI app asked for; show them if you like. */
  scopes: string[];
}

export interface LinkedUser {
  /** Your stable id for the user; Jack stores it and puts it in every assertion's `sub`. */
  userId: string;
  /** Shown on Jack's consent page and in its dashboard. */
  name?: string;
  email?: string;
}

export interface Assertion {
  userId: string;
  scopes: string[];
  /** The Jack grant this call acts under (stable per user + AI app). */
  grantId: string;
  jti: string;
}

export class JackLinkError extends Error {
  override name = 'JackLinkError';
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function createJackVerifier(opts: JackVerifierOptions) {
  if (typeof opts.secret !== 'string' || opts.secret.length < 32) throw new JackLinkError('secret must be at least 32 characters');
  const issuer = opts.issuer.replace(/\/$/, '');
  const audience = new URL(opts.audience).origin;
  const now = opts.now ?? (() => Date.now());
  // Replay cache for assertions: jti → expiry. Swept lazily; bounded by the 60 s lifetime.
  const seen = new Map<string, number>();
  const sweep = () => {
    const t = Math.floor(now() / 1000);
    if (seen.size < 10_000) return;
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
  };
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw err instanceof JwtError ? new JackLinkError(err.message) : err;
    }
  };

  return {
    verifyLinkRequest(token: string): LinkRequest {
      return wrap(() => {
        const p = verifyHs256(token, opts.secret, { typ: TYP.request, issuer, audience, now: now() });
        const requestId = text(p.jti);
        const returnUrl = text(p.return);
        if (!requestId || !returnUrl) throw new JwtError('malformed link request');
        // The return URL must point back at the issuer: never redirect a user to a third party.
        if (!returnUrl.startsWith(`${issuer}/`)) throw new JwtError('link request return URL is not the issuer');
        return { requestId, returnUrl, scopes: typeof p.scope === 'string' ? p.scope.split(' ').filter(Boolean) : [] };
      });
    },

    /** The signed response token for a linked user. Usually you want `linkResponseUrl`. */
    linkResponse(requestToken: string, user: LinkedUser): string {
      const req = this.verifyLinkRequest(requestToken);
      if (typeof user.userId !== 'string' || user.userId === '') throw new JackLinkError('userId is required');
      const iat = Math.floor(now() / 1000);
      return signHs256(
        {
          typ: TYP.response,
          iss: audience,
          aud: issuer,
          jti: req.requestId,
          sub: user.userId,
          ...(user.name ? { name: user.name } : {}),
          ...(user.email ? { email: user.email } : {}),
          iat,
          exp: iat + RESPONSE_TTL_SECONDS,
        },
        opts.secret,
      );
    },

    /** Where to redirect the user after linking: the request's return URL carrying the response. */
    linkResponseUrl(requestToken: string, user: LinkedUser): string {
      const req = this.verifyLinkRequest(requestToken);
      const u = new URL(req.returnUrl);
      u.searchParams.set('response', this.linkResponse(requestToken, user));
      return u.href;
    },

    /** Verify a `Jack-Assertion` header value. Throws JackLinkError on anything wrong, including a replay. */
    verifyAssertion(token: string): Assertion {
      return wrap(() => {
        const p = verifyHs256(token, opts.secret, { typ: TYP.assertion, issuer, audience, now: now(), skew: 30 });
        const jti = text(p.jti);
        const userId = text(p.sub);
        const grantId = text(p.grant_id);
        if (!jti || !userId || !grantId) throw new JwtError('malformed assertion');
        sweep();
        const nowS = Math.floor(now() / 1000);
        if ((seen.get(jti) ?? 0) >= nowS) throw new JwtError('assertion replayed');
        seen.set(jti, Number(p.exp) + 30);
        return { userId, grantId, jti, scopes: typeof p.scope === 'string' ? p.scope.split(' ').filter(Boolean) : [] };
      });
    },

    /** Read and verify the header from any Headers-like object. Returns null when the header is absent. */
    assertionFrom(headers: { get(name: string): string | null | undefined } | Record<string, string | string[] | undefined>): Assertion | null {
      const raw = typeof (headers as { get?: unknown }).get === 'function' ? (headers as { get(n: string): string | null | undefined }).get(ASSERTION_HEADER) : (headers as Record<string, string | string[] | undefined>)[ASSERTION_HEADER];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (!value) return null;
      return this.verifyAssertion(value);
    },

    /**
     * Express/Connect middleware: `req.jackUser` is set when a valid assertion is present;
     * an invalid one is a 401; no header passes through (your other auth still applies).
     */
    express() {
      return (req: { headers: Record<string, string | string[] | undefined>; jackUser?: Assertion }, res: { status(code: number): { json(body: unknown): unknown } }, next: (err?: unknown) => void) => {
        try {
          const a = this.assertionFrom(req.headers);
          if (a) req.jackUser = a;
          next();
        } catch (err) {
          res.status(401).json({ title: 'Unauthorized', status: 401, detail: `invalid Jack assertion: ${err instanceof Error ? err.message : String(err)}` });
        }
      };
    },

    /** Hono middleware: `c.get('jackUser')` is the Assertion when present. */
    hono() {
      return async (c: { req: { header(name: string): string | undefined }; set(key: string, value: unknown): void; json(body: unknown, status: number): Response }, next: () => Promise<void>) => {
        const raw = c.req.header(ASSERTION_HEADER);
        if (raw) {
          try {
            c.set('jackUser', this.verifyAssertion(raw));
          } catch (err) {
            return c.json({ title: 'Unauthorized', status: 401, detail: `invalid Jack assertion: ${err instanceof Error ? err.message : String(err)}` }, 401);
          }
        }
        await next();
      };
    },
  };
}

export type JackVerifier = ReturnType<typeof createJackVerifier>;
