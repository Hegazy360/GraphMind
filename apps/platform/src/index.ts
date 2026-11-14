/**
 * The GraphMind platform: everything an end user reaches with a browser,
 * on ONE origin, behind ONE account.
 *
 *   /                 the marketing homepage (apps/web), when `site` is set;
 *                     otherwise the hub
 *   /signup, /login   → the hub's sign-up / sign-in (what graphmind.ai's
 *                     vercel.json redirects do in production)
 *   <hub>/            the hub: sign in, your products, your account
 *   <hub>/auth/*      the shared accounts routes (one store, one cookie)
 *   <hub>/circuit/    the Circuit dashboard and its /v1 API
 *   <hub>/jack/       the Jack dashboard and its /v1 API
 *   /p/<slug>/…       every Jack project's MCP server and OAuth sign-in,
 *                     at the origin root: that URL is what AI clients hold
 *
 * `<hub>` is `/app` when the homepage is served too (local dev: the whole
 * journey from graphmind.ai to a running dashboard) and `/` when this is
 * deployed as app.graphmind.ai behind the static homepage.
 *
 * One `Accounts` instance is shared by the hub, Circuit and Jack, so a
 * session started on the hub is valid in both dashboards (the cookie is
 * origin-wide), and a personal API token works against either API.
 */
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { Accounts } from '@graphmind-ai/accounts';
import { uiAsset } from '@graphmind-ai/ui';
import type { Jack } from 'jack-api';

export interface PlatformOptions {
  accounts: Accounts;
  /** The Circuit app (`createApi` from circuit-api). */
  circuit: Hono;
  /** The Jack app (`createJack` from jack-api), created with `dashboardPath` = `<hub>/jack/`. */
  jack: Jack;
  /** Directory holding the static homepage (apps/web). Omit to serve the hub at `/`. */
  site?: string;
  /**
   * Directory holding the viewer built for `/try/` (`pnpm --filter viewer build:try`
   * → apps/viewer/dist-try/try). Served at `/try/*` so the homepage's embedded
   * demo works locally exactly as graphmind.ai's rewrite serves it in production.
   */
  tryDist?: string;
}

const UI_DIR = new URL('../ui/', import.meta.url);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  gif: 'image/gif',
  webp: 'image/webp',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  woff2: 'font/woff2',
};
const type = (file: string) => TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The hub prefix for a given configuration. */
export const hubPathFor = (site: boolean) => (site ? '/app' : '');

/**
 * Hand everything under `prefix/` to another app as if it were at `/`.
 * `prefix` itself redirects to `prefix/`, because the dashboards use
 * page-relative URLs and need the trailing slash to resolve against.
 */
function mount(app: Hono, prefix: string, fetch: (req: Request) => Response | Promise<Response>): void {
  app.all(prefix, (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return forward(c.req.raw, prefix, fetch);
    // A relative Location: this app may itself be mounted under a prefix it cannot see.
    const u = new URL(c.req.url);
    return c.redirect(`${prefix.split('/').pop()}/${u.search}`, 308);
  });
  app.all(`${prefix}/*`, (c) => forward(c.req.raw, prefix, fetch));
}

function forward(req: Request, prefix: string, fetch: (req: Request) => Response | Promise<Response>) {
  const u = new URL(req.url);
  u.pathname = u.pathname.slice(prefix.length) || '/';
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }
  return fetch(new Request(u, init));
}

async function file(dir: URL | string, name: string, opts: { cacheable?: boolean; csp?: boolean; range?: string | undefined } = {}): Promise<Response> {
  const base = typeof dir === 'string' ? new URL(`file://${dir.replace(/\/?$/, '/')}`) : dir;
  let body: Buffer;
  try {
    body = await readFile(new URL(name, base));
  } catch {
    return new Response('not found', { status: 404 });
  }
  // Byte ranges, for video: browsers seek (and Safari only plays) with them.
  const m = opts.range ? /^bytes=(\d*)-(\d*)$/.exec(opts.range) : null;
  if (m && (m[1] || m[2])) {
    const size = body.length;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(body.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': type(name), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=300' },
    });
  }
  return new Response(body, {
    headers: {
      'accept-ranges': 'bytes',
      'content-type': type(name),
      'cache-control': opts.cacheable ? 'public, max-age=300' : 'no-store',
      'x-content-type-options': 'nosniff',
      // The hub's own page is strict. The homepage is served as graphmind.ai serves it (inline scripts, Google Fonts), without one.
      ...(opts.csp ? { 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' } : {}),
    },
  });
}

export function createPlatform(opts: PlatformOptions): Hono {
  const app = new Hono();
  const hubPath = hubPathFor(opts.site !== undefined);

  // The hub: sign-in, products, account.
  const hub = new Hono();
  hub.route('/', opts.accounts.routes);
  for (const name of ['index.html', 'app.js', 'style.css']) {
    hub.get(name === 'index.html' ? '/' : `/${name}`, () => file(UI_DIR, name, { csp: name === 'index.html' }));
  }
  hub.get('/gm/:name', async (c) => (await uiAsset(c.req.param('name'))) ?? c.notFound());
  hub.get('/health', (c) => c.json({ ok: true, service: 'platform', hub: `${hubPath}/`, ...opts.accounts.status() }));
  mount(hub, '/circuit', (req) => opts.circuit.fetch(req));
  mount(hub, '/jack', (req) => opts.jack.app.fetch(req));

  // Jack's data plane lives at the origin root: these are the URLs AI clients and OAuth flows hold.
  app.all('/p/*', (c) => opts.jack.app.fetch(c.req.raw));
  app.all('/.well-known/*', (c) => opts.jack.app.fetch(c.req.raw));
  app.get('/dashboard/callback', (c) => opts.jack.app.fetch(c.req.raw));

  if (opts.site !== undefined) {
    const site = opts.site;
    // What graphmind.ai's vercel.json does in production.
    app.get('/signup', (c) => c.redirect(`${hubPath}/#/signup`, 302));
    app.get('/login', (c) => c.redirect(`${hubPath}/#/signin`, 302));
    app.get('/subscriptions', (c) => c.redirect('/#account', 302));
    app.get('/docs/*', (c) => c.redirect(`https://graphmind.ai${new URL(c.req.url).pathname}`, 302));
    app.get('/docs', (c) => c.redirect('https://graphmind.ai/docs', 302));
    if (opts.tryDist !== undefined) {
      // The in-browser debugger (the viewer's fixture run), as graphmind.ai/try serves it.
      const tryDist = opts.tryDist;
      app.get('/try', (c) => c.redirect(`/try/${new URL(c.req.url).search}`, 302));
      app.get('/try/*', (c) => {
        const rest = new URL(c.req.url).pathname.slice('/try/'.length);
        const name = rest === '' || !/\.[a-z0-9]+$/i.test(rest) ? 'index.html' : rest;
        if (name.includes('..')) return c.notFound();
        return file(tryDist, name, { cacheable: name !== 'index.html' });
      });
    } else {
      app.get('/try/*', (c) => c.redirect(`https://graphmind.ai${new URL(c.req.url).pathname}${new URL(c.req.url).search}`, 302));
      app.get('/try', (c) => c.redirect('https://graphmind.ai/try/', 302));
    }
    // The waitlist function is a Vercel serverless function; locally, accept and say so.
    app.post('/api/waitlist', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
      console.error(`[platform] waitlist sign-up (dev: not stored): ${typeof body.email === 'string' ? body.email : '?'}`);
      return c.json({ ok: true });
    });
    // Vercel injects its analytics script in production; locally it is an empty module, so the page stays error-free.
    app.get('/_vercel/insights/script.js', () => new Response('', { headers: { 'content-type': 'text/javascript' } }));
    app.get('/favicon.ico', (c) => c.redirect('/graphmind.png', 302));
    app.get('/', () => file(site, 'index.html'));
    app.get('/:name{[a-z0-9._-]+\\.(css|js|png|svg|txt|xml|gif)}', (c) => file(site, c.req.param('name'), { cacheable: true }));
    // Vendored libraries and fonts (apps/web/vendor, copied by `pnpm --filter web vendor`).
    app.get('/vendor/:name{[a-zA-Z0-9._-]+\\.(js|woff2|txt)}', (c) => file(`${site}/vendor`, c.req.param('name'), { cacheable: true }));
    // The homepage's funnel events are a Vercel function in production; locally, count and drop.
    app.post('/api/events', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { event?: unknown; where?: unknown };
      console.error(`[platform] event ${typeof body.event === 'string' ? body.event : '?'}${typeof body.where === 'string' ? ` (${body.where})` : ''} (dev: not stored)`);
      return c.body(null, 204);
    });
    // The homepage's clips and stills (recorded by `pnpm media`).
    app.get('/media/:name{[a-z0-9._-]+\\.(webm|webp|jpg|png)}', (c) => file(`${site}/media`, c.req.param('name'), { cacheable: true, range: c.req.header('range') }));
    mount(app, hubPath, (req) => hub.fetch(req));
  } else {
    app.route('/', hub);
  }

  return app;
}
