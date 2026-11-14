/**
 * What Acme added for Jack's account-linking mode — the whole customer side,
 * about 40 lines. Acme already has a session login (a cookie set by a form);
 * it has no OAuth server, and does not want one.
 *
 *   1. GET /jack/link      Jack sends a user here with ?request=<token>. If
 *                          they are logged in, answer at once; if not, send
 *                          them through the normal login and come back.
 *   2. Jack-Assertion      every call Jack makes carries this header. The
 *                          middleware turns it into the current user + scopes.
 *
 * Settings come from the environment, copied from the project's Sign-in page:
 *   JACK_LINK_SECRET    the shared secret (also stored encrypted in Jack)
 *   JACK_LINK_ISSUER    the Jack project's issuer URL
 *   JACK_LINK_AUDIENCE  this API's origin as Jack calls it (optional: defaults to the request origin)
 */
import { Hono } from 'hono';
import { createJackVerifier, type Assertion, type JackVerifier } from '@graphmind-ai/jack-verify';
import type { TasksStore, User } from './store.js';

export const SESSION_COOKIE = 'acme_session';
/** Demo session cookie values (a real app signs or stores these). */
const SESSIONS: Record<string, string> = { 'sess-alice': 'usr_alice', 'sess-bob': 'usr_bob' };
const PASSWORDS: Record<string, { userId: string; password: string; session: string }> = {
  alice: { userId: 'usr_alice', password: 'alice-password', session: 'sess-alice' },
  bob: { userId: 'usr_bob', password: 'bob-password', session: 'sess-bob' },
};

export function sessionUser(cookieHeader: string | undefined, store: TasksStore): User | null {
  const m = new RegExp(`${SESSION_COOKIE}=([\\w-]+)`).exec(cookieHeader ?? '');
  const userId = m ? SESSIONS[m[1] as string] : undefined;
  return userId ? (store.users.get(userId) ?? null) : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface LinkOptions {
  secret: string;
  issuer: string;
  audience: string;
}

/** Jack's verifier for this app, or null when link mode is not configured. */
export function jackVerifierFromEnv(env: Record<string, string | undefined>, origin: string): { verifier: JackVerifier; options: LinkOptions } | null {
  const secret = env.JACK_LINK_SECRET;
  const issuer = env.JACK_LINK_ISSUER;
  if (!secret || !issuer) return null;
  const options = { secret, issuer, audience: env.JACK_LINK_AUDIENCE ?? origin };
  return { verifier: createJackVerifier(options), options };
}

/** The session login and the link route. Mount at the app root. */
export function linkRoutes(store: TasksStore, jack: JackVerifier | null): Hono {
  const app = new Hono();

  app.get('/session/login', (c) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>Log in to Acme Tasks</title>
<style>body{font:15px system-ui;background:#eef2ff;display:flex;justify-content:center;padding:60px}form{background:#fff;padding:28px;border-radius:12px;width:340px}input{width:100%;padding:8px;margin:4px 0 12px;box-sizing:border-box}button{width:100%;padding:10px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600}</style>
<form id="acme-session-login" method="post" action="/session/login"><h2>Log in to Acme Tasks</h2>
<input type="hidden" name="next" value="${esc(c.req.query('next') ?? '/')}">
${c.req.query('error') ? '<p style="color:#b91c1c">Wrong username or password.</p>' : ''}
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button>Log in</button><p style="font-size:12px;color:#6b7280">Demo: alice / alice-password · bob / bob-password</p></form>`),
  );

  app.post('/session/login', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    const next = f.next?.startsWith('/') ? f.next : '/';
    const account = PASSWORDS[(f.username ?? '').toLowerCase()];
    if (!account || account.password !== f.password) return c.redirect(`/session/login?error=1&next=${encodeURIComponent(next)}`, 303);
    return new Response(null, { status: 303, headers: { location: next, 'set-cookie': `${SESSION_COOKIE}=${account.session}; Path=/; HttpOnly; SameSite=Lax` } });
  });

  // --- the one route Jack needs -------------------------------------------
  app.get('/jack/link', (c) => {
    if (!jack) return c.text('Account linking is not configured (set JACK_LINK_SECRET and JACK_LINK_ISSUER).', 404);
    const token = c.req.query('request') ?? '';
    try {
      jack.verifyLinkRequest(token); // bad or expired: stop before touching the session
    } catch (err) {
      return c.text(`This link request is not valid: ${err instanceof Error ? err.message : String(err)}`, 400);
    }
    const user = sessionUser(c.req.header('cookie'), store);
    if (!user) {
      const here = `${new URL(c.req.url).pathname}?${new URL(c.req.url).searchParams.toString()}`;
      return c.redirect(`/session/login?next=${encodeURIComponent(here)}`, 302);
    }
    return c.redirect(jack.linkResponseUrl(token, { userId: user.id, name: user.name, email: user.email }), 302);
  });

  return app;
}

export type { Assertion };
