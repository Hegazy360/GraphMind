/**
 * The customer-side verifier, and the token rules Jack's side relies on.
 */
import { describe, expect, it } from 'vitest';
import { createJackVerifier, JackLinkError, signHs256, TYP, verifyHs256, type Assertion } from '../src/index.js';

const SECRET = 'a-shared-secret-of-at-least-32-characters-long';
const ISSUER = 'https://acme.mcp.graphmind.ai';
const AUD = 'https://api.acme.com';
let t = 1_800_000_000_000;
const clock = { now: () => t };

const request = (over: Record<string, unknown> = {}, secret = SECRET) =>
  signHs256(
    { typ: TYP.request, iss: ISSUER, aud: AUD, jti: 'jar_1', return: `${ISSUER}/oauth/link/callback`, scope: 'notes:read', iat: t / 1000, exp: t / 1000 + 300, ...over },
    secret,
  );
const assertion = (over: Record<string, unknown> = {}, secret = SECRET) =>
  signHs256({ typ: TYP.assertion, iss: ISSUER, aud: AUD, sub: 'usr_1', grant_id: 'grt_1', scope: 'notes:read notes:write', jti: `j${Math.random()}`, iat: t / 1000, exp: t / 1000 + 60, ...over }, secret);

describe('createJackVerifier', () => {
  it('refuses weak secrets', () => {
    expect(() => createJackVerifier({ secret: 'short', issuer: ISSUER, audience: AUD })).toThrow(/32 characters/);
  });

  it('link request → response: round trip, with the response bound to the request', () => {
    const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD, ...clock });
    const req = jack.verifyLinkRequest(request());
    expect(req).toEqual({ requestId: 'jar_1', returnUrl: `${ISSUER}/oauth/link/callback`, scopes: ['notes:read'] });
    const url = new URL(jack.linkResponseUrl(request(), { userId: 'usr_1', name: 'Alice', email: 'a@x.test' }));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/link/callback`);
    const p = verifyHs256(url.searchParams.get('response')!, SECRET, { typ: TYP.response, issuer: AUD, audience: ISSUER, now: t });
    expect(p).toMatchObject({ jti: 'jar_1', sub: 'usr_1', name: 'Alice', email: 'a@x.test' });
    expect(() => jack.linkResponse(request(), { userId: '' })).toThrow(/userId/);
  });

  it('a link request is refused when tampered, foreign, expired, or pointing away from the issuer', () => {
    const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD, ...clock });
    const cases: Array<[string, RegExp]> = [
      [request({}, 'another-secret-that-is-long-enough-0000000000'), /bad signature/],
      [request({ iss: 'https://evil.mcp.graphmind.ai' }), /wrong issuer/],
      [request({ aud: 'https://other.acme.com' }), /wrong audience/],
      [request({ exp: t / 1000 - 120 }), /expired/],
      [request({ typ: TYP.assertion }), /wrong token type/],
      [request({ return: 'https://evil.example/steal' }), /not the issuer/],
      [`${request()}x`, /bad signature|malformed/],
      ['not.a.jwt', /malformed/],
    ];
    for (const [tok, why] of cases) expect(() => jack.verifyLinkRequest(tok), why.source).toThrow(why);
    // alg:none and RS256 headers are refused even with a valid-looking body.
    const [, body] = request().split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`;
    expect(() => jack.verifyLinkRequest(none)).toThrow(/algorithm/);
  });

  it('assertions: verified once; a replay is refused; expiry has a 30 s skew', () => {
    const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD, ...clock });
    const tok = assertion({ jti: 'once' });
    expect(jack.verifyAssertion(tok)).toEqual({ userId: 'usr_1', grantId: 'grt_1', jti: 'once', scopes: ['notes:read', 'notes:write'] });
    expect(() => jack.verifyAssertion(tok)).toThrow(/replayed/);
    t += 61_000; // past exp, inside the skew
    expect(() => jack.verifyAssertion(assertion({ jti: 'late' }, SECRET))).not.toThrow();
    const stale = assertion({ jti: 'stale', exp: (t - 61_000) / 1000 + 60 }); // signed against the old time
    t += 60_000;
    expect(() => jack.verifyAssertion(stale)).toThrow(/expired/);
    expect(() => jack.verifyAssertion(assertion({ grant_id: undefined }))).toThrow(/malformed/);
    expect(() => jack.verifyAssertion(request())).toThrow(/wrong token type/);
  });

  it('express and hono middleware: absent header passes through, invalid is 401, valid sets the user', async () => {
    const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD, ...clock });
    // express
    const ex = jack.express();
    const run = (headers: Record<string, string>) =>
      new Promise<{ user?: unknown; status?: number }>((resolve) => {
        const req: { headers: Record<string, string | string[] | undefined>; jackUser?: Assertion } = { headers };
        ex(req, { status: (code) => ({ json: () => resolve({ status: code }) }) }, () => resolve({ user: req.jackUser }));
      });
    expect(await run({})).toEqual({ user: undefined });
    expect(await run({ 'jack-assertion': 'garbage' })).toEqual({ status: 401 });
    expect((await run({ 'jack-assertion': assertion() })).user).toMatchObject({ userId: 'usr_1' });
    // hono
    const ho = jack.hono();
    const ctx = (value?: string) => {
      const set: Record<string, unknown> = {};
      return {
        c: { req: { header: () => value }, set: (k: string, v: unknown) => (set[k] = v), json: (body: unknown, status: number) => Response.json(body, { status }) },
        set,
      };
    };
    let x = ctx();
    let nexted = false;
    await ho(x.c, async () => void (nexted = true));
    expect(nexted).toBe(true);
    x = ctx(assertion());
    await ho(x.c, async () => {});
    expect(x.set.jackUser).toMatchObject({ userId: 'usr_1' });
    const bad = await ho(ctx('nope').c, async () => {});
    expect((bad as Response).status).toBe(401);
  });

  it('JackLinkError is what callers see', () => {
    const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD, ...clock });
    try {
      jack.verifyAssertion('x');
    } catch (err) {
      expect(err).toBeInstanceOf(JackLinkError);
    }
  });
});
