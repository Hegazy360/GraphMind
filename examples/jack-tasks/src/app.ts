/**
 * Acme Tasks — the HTTP app. Plain Hono: two ways to authenticate (a
 * personal API key, or an access token from Acme's own OIDC login), scope
 * checks per route, Zod validation, RFC 9457 errors. `GET /openapi.json`
 * serves the generated document, so `jack init http://127.0.0.1:4830/openapi.json`
 * works against the live app.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { buildOpenApi, DEFAULT_ORIGIN } from './openapi.js';
import { createIdp, type OidcClient, type Scope } from './idp.js';
import { jackVerifierFromEnv, linkRoutes } from './link.js';
import { HttpError, scopeOf, type RouteDef } from './route.js';
import { routes } from './routes.js';
import { seed, TasksStore } from './store.js';

export interface AppOptions {
  store?: TasksStore;
  /** This app's public origin: the OpenAPI `servers` entry and the OIDC issuer. */
  origin?: string;
  /** OIDC clients allowed to use Acme's login (Jack is one). */
  oidcClients?: Record<string, OidcClient>;
  accessTokenTtlSeconds?: number;
  /** For Jack's link mode (JACK_LINK_SECRET, JACK_LINK_ISSUER, JACK_LINK_AUDIENCE). Default: process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * The client Jack's `jack.oidc.yaml` uses. Its redirect is Jack's callback on
 * ANY loopback port (RFC 8252 §7.3), so a preview on whatever port this
 * worktree got still signs in. A real IdP registration lists the exact URL.
 */
export function defaultOidcClients(env: Record<string, string | undefined> = process.env): Record<string, OidcClient> {
  return {
    'jack-preview': {
      name: 'Acme Tasks for AI assistants (via Jack)',
      secret: env.ACME_OIDC_CLIENT_SECRET ?? 'acme-dev-secret',
      redirectUris: (env.ACME_OIDC_REDIRECT_URIS ?? 'http://127.0.0.1/oauth/upstream/callback').split(',').map((s) => s.trim()),
    },
  };
}

function problem(status: number, title: string, detail?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}), ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

const toHonoPath = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

export async function createTasksApp(opts: AppOptions = {}): Promise<{ app: Hono; store: TasksStore }> {
  const store = opts.store ?? seed(new TasksStore());
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const idp = await createIdp({ issuer: origin, clients: opts.oidcClients ?? defaultOidcClients(), store, ...(opts.accessTokenTtlSeconds ? { accessTokenTtlSeconds: opts.accessTokenTtlSeconds } : {}) });
  const app = new Hono();
  app.route('/', idp.app);
  // Jack link mode: the session login + /jack/link route, and the assertion middleware.
  const jack = jackVerifierFromEnv(opts.env ?? process.env, origin);
  app.route('/', linkRoutes(store, jack?.verifier ?? null));
  if (jack) app.use('*', jack.verifier.hono() as never);

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/openapi.json', (c) => c.json(buildOpenApi(routes, origin)));

  app.onError((err) => {
    if (err instanceof HttpError) return problem(err.status, err.title, err.message === err.title ? undefined : err.message, err.extra);
    if (err instanceof z.ZodError) {
      return problem(400, 'Invalid request', z.prettifyError(err), {
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    console.error('[acme-tasks]', err);
    return problem(500, 'Internal error');
  });

  // Sort so literal segments win over parameters (/tasks/search before /tasks/{taskId}).
  const ordered = [...routes].sort((a, b) => Number(a.path.includes('{')) - Number(b.path.includes('{')));
  for (const r of ordered) app.on(r.method.toUpperCase(), toHonoPath(r.path), (c) => handle(c, r));

  async function handle(c: Context, r: RouteDef): Promise<Response> {
    const header = c.req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // A personal API key (tk_…) has full access; an OIDC access token has the scopes it was granted.
    let user = bearer.startsWith('tk_') ? store.userForKey(bearer) : null;
    let scopes: Scope[] = user ? ['tasks:read', 'tasks:write'] : [];
    if (!user && bearer !== '') {
      const verified = await idp.verifyAccessToken(bearer);
      if (verified) {
        user = store.users.get(verified.userId) ?? null;
        scopes = verified.scopes;
      }
    }
    // A Jack-Assertion (link mode): the middleware verified it; it names the user and the granted scopes.
    const linked = (c as unknown as { get(k: string): { userId: string; scopes: string[] } | undefined }).get('jackUser');
    if (!user && linked) {
      user = store.users.get(linked.userId) ?? null;
      scopes = linked.scopes.filter((s): s is Scope => s === 'tasks:read' || s === 'tasks:write');
    }
    if (!user) return problem(401, 'Unauthorized', 'send an API key or an access token as Authorization: Bearer <token>', {}, { 'www-authenticate': 'Bearer' });
    const needed = scopeOf(r);
    if (!scopes.includes(needed)) {
      return problem(403, 'Insufficient scope', `this needs the ${needed} permission`, {}, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${needed}"` });
    }

    const params = r.params ? r.params.parse(c.req.param()) : {};
    const query = r.query ? r.query.parse(c.req.query()) : {};
    let body: unknown;
    if (r.body) {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
      body = r.body.parse(raw);
    }
    const reply = await r.handler({ user, store, params, query, body } as never);
    if (reply.status === 204) return c.body(null, 204);
    return c.json(reply.body as object, reply.status as 200);
  }

  app.notFound(() => problem(404, 'Not found'));
  return { app, store };
}
