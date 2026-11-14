/**
 * jack-api — GraphMind Jack's server: the dashboard, the control plane
 * (`/v1`) and the data plane (`/p/<slug>/mcp` + its sign-in) in one Hono app.
 * The planes are separate routers and share nothing but the store, so the
 * hosted service can split them into separate deployables.
 *
 * Operator auth for /v1, in order of preference:
 *   - `accounts` (@graphmind-ai/accounts): self-serve sign-up, browser
 *     sessions and personal API tokens; every project belongs to the account
 *     that created it and other accounts cannot see it. `jack serve --accounts`
 *     and the hosted service.
 *   - static bearer `apiKeys`: one shared key, one workspace (`--api-key`).
 *     With accounts on as well, a static key acts as the operator and sees
 *     every project.
 *   - neither: open, for local `jack serve` on 127.0.0.1.
 * Errors follow RFC 9457.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { hostHeaderValidationResponse, localhostAllowedHostnames } from '@modelcontextprotocol/server';
import {
  PROTOCOL_VERSION,
  SERVICE,
  createDeploymentBody,
  createProjectBody,
  diffManifests,
  manifestHash,
  ManifestError,
  parseManifest,
  projectSlug,
  type Project,
} from '@graphmind-ai/jack-schema';
import { loadSource, MAX_DOCUMENT_BYTES } from '@graphmind-ai/jack-openapi';
import { guardedFetch, type EgressPolicy } from '@graphmind-ai/jack-runtime';
import { SecretBox } from '@graphmind-ai/jack-auth';
import type { Accounts, Principal } from '@graphmind-ai/accounts';
import { uiAsset } from '@graphmind-ai/ui';
import { ConsoleError, TestConsole } from './console.js';
import { DataPlane, issuerFor, mcpUrlFor as dataPlaneMcpUrl, NotLiveError } from './data-plane.js';
import { DraftError, isUserError, previewImport, Projects } from './projects.js';
import { NotFoundError, SlugTakenError, type JackStore, type OwnedProject } from './store.js';

export { SqliteStore } from './sqlite-store.js';
export { NotFoundError, SlugTakenError, type CallRow, type JackStore, type NewDeployment, type NewProject, type OwnedProject, type StoredDeployment } from './store.js';
export { DataPlane, issuerFor, NotLiveError } from './data-plane.js';
export { Projects, previewImport, type DraftView, type ToolView } from './projects.js';
export { TestConsole, type TryResult } from './console.js';

export interface ApiOptions {
  store: JackStore;
  /** Accepted bearer keys for /v1. Empty/omitted = open (local only). */
  apiKeys?: readonly string[];
  /** User accounts (sign-up, sessions, personal tokens). When set, /v1 requires a signed-in user and projects are per account. */
  accounts?: Accounts;
  /** Public origin of this server, e.g. https://mcp.graphmind.ai or http://127.0.0.1:20412. */
  publicOrigin?: string;
  /** Serve the dashboard at `/` (default true). */
  dashboard?: boolean;
  /**
   * Where browsers reach the dashboard, when this app is mounted under a
   * prefix (the platform serves it at `/jack/`). Only the test sign-in's
   * redirect back to the page needs it. Default `/`.
   */
  dashboardPath?: string;
  /** Where per-project sign-in databases live. Default: a fresh temp dir. */
  dataDir?: string;
  /** 32 bytes sealing secrets and upstream credentials. Default: random (lost on restart). */
  secretKey?: Uint8Array;
  /** Egress for the data plane and imports. Default `public`; local `jack serve` uses `any`. */
  egress?: EgressPolicy;
  /** For `env:NAME` secret references. Default: process.env. */
  env?: Record<string, string | undefined>;
}

export interface Jack {
  app: Hono;
  projects: Projects;
  plane: DataPlane;
  close: () => Promise<void>;
}

const UI_DIR = new URL('../ui/', import.meta.url);
const UI_FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function problem(status: number, title: string, detail?: string) {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * Where a project's MCP server lives. Locally every project is a path under
 * one origin; hosted, each project is its own host (plan §1.1).
 */
export function mcpUrlFor(publicOrigin: string, project: Pick<Project, 'slug'>): string {
  const origin = new URL(publicOrigin);
  const local = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost';
  return local ? dataPlaneMcpUrl(origin.origin, project.slug) : `${origin.protocol}//${project.slug}.${origin.host}/mcp`;
}

const sourceBody = z.object({
  url: z.string().url().optional(),
  text: z.string().min(2).max(MAX_DOCUMENT_BYTES).optional(),
});
const importBody = z.object({
  slug: projectSlug.optional(),
  name: z.string().min(1).max(128).optional(),
  upstream: z.string().url().optional(),
  source: sourceBody,
});
const promoteBody = z.object({ version: z.number().int().min(1) });
const tryBody = z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}), approve: z.boolean().default(false) });

export function createJack(opts: ApiOptions): Jack {
  const { store } = opts;
  const keys = new Set(opts.apiKeys ?? []);
  const publicOrigin = (opts.publicOrigin ?? 'http://127.0.0.1:4820').replace(/\/$/, '');
  const local = ['127.0.0.1', 'localhost'].includes(new URL(publicOrigin).hostname);
  const egress = opts.egress ?? 'public';
  const secretKey = opts.secretKey ?? randomBytes(32);
  const box = new SecretBox(secretKey);
  const projects = new Projects(store, box, opts.env ?? process.env);
  const plane = new DataPlane({
    store,
    publicOrigin,
    dataDir: opts.dataDir ?? mkdtempSync(join(tmpdir(), 'jack-data-')),
    secretKey,
    egress,
    resolveSecret: (projectId, ref) => projects.resolveSecret(projectId, ref),
  });
  const console_ = new TestConsole(publicOrigin, plane);
  const accounts = opts.accounts;
  const dashboardPath = (opts.dashboardPath ?? '/').replace(/\/?$/, '/');
  const app = new Hono();

  const describe = (p: OwnedProject | Project) => {
    const { ownerId: _owner, ...wire } = p as OwnedProject;
    return {
      ...wire,
      mcpUrl: mcpUrlFor(publicOrigin, p),
      mode: p.auth.mode === 'none' && !p.auth.requireSignIn ? 'open' : 'sign-in',
    };
  };

  /**
   * Who is calling /v1, as far as project scoping goes: an account id, or
   * null for the operator (a static key, or an open local server) who sees
   * every project.
   */
  type Caller = { ownerId: string | null; principal: Principal | null };
  const caller = (c: Context): Caller => (c.get('caller' as never) as Caller | undefined) ?? { ownerId: null, principal: null };

  /** Fetch a spec by URL through the egress guard (the server, not the browser, fetches it). */
  const fetchSpec = (url: string) =>
    loadSource(url, {
      fetchImpl: ((u: string | URL) => guardedFetch(u, {}, { policy: egress, timeoutMs: 15_000, maxResponseBytes: MAX_DOCUMENT_BYTES })) as typeof fetch,
    }).then((s) => ({ text: JSON.stringify(s.document), url: s.documentUrl ?? url }));

  const readSource = async (s: z.infer<typeof sourceBody>) => {
    if (s.text !== undefined) return { text: s.text, url: s.url ?? null };
    if (s.url !== undefined) return fetchSpec(s.url);
    throw new DraftError('give the spec as a URL or paste it');
  };

  // A local server answers only to localhost names: DNS-rebinding protection. (Over a socket the
  // Host header is always present; in-process requests have none, so fall back to the URL's host.)
  if (local) {
    const allowed = new Set(localhostAllowedHostnames());
    app.use('*', async (c, next) => {
      if (c.req.header('host') !== undefined) return hostHeaderValidationResponse(c.req.raw, [...allowed]) ?? next();
      return allowed.has(new URL(c.req.url).hostname) ? next() : problem(403, 'Forbidden', 'unexpected host');
    });
  }

  if (opts.dashboard !== false) {
    // The shared GraphMind look and shell (top bar, sign-in, account page).
    app.get('/gm/:name', async (c) => (await uiAsset(c.req.param('name'))) ?? problem(404, 'Not found'));
    for (const [route, [file, type]] of Object.entries(UI_FILES)) {
      // Registered before auth: the files hold no data; every data call goes through /v1.
      app.get(route, async () => {
        const body = await readFile(new URL(file, UI_DIR), 'utf8');
        return new Response(body, {
          headers: {
            'content-type': type,
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          },
        });
      });
    }
  }

  // The end of "Test sign-in": the project's authorization server redirects the browser here.
  app.get('/dashboard/callback', async (c) => {
    try {
      const { projectId, error } = await console_.finish(new URL(c.req.url).searchParams);
      const q = error ? `?signin_error=${encodeURIComponent(error)}` : '?signin=ok';
      return c.redirect(`${dashboardPath}#/p/${projectId}/try${q}`, 302);
    } catch (err) {
      return c.redirect(`${dashboardPath}#/?signin_error=${encodeURIComponent(err instanceof Error ? err.message : 'sign-in failed')}`, 302);
    }
  });

  if (accounts) app.route('/', accounts.routes);

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (keys.size > 0 && keys.has(bearer)) {
      c.set('caller' as never, { ownerId: null, principal: null } as never);
      return next();
    }
    if (accounts) {
      return accounts.requireUser()(c, async () => {
        const principal = accounts.principal(c);
        c.set('caller' as never, { ownerId: principal?.user.id ?? null, principal } as never);
        await next();
      });
    }
    if (keys.size > 0) return problem(401, 'Unauthorized', 'missing or unknown API key');
    await next();
  });

  app.onError((err) => {
    if (err instanceof SlugTakenError) return problem(409, 'Slug taken', err.message);
    if (err instanceof NotFoundError) return problem(404, 'Not found', err.message);
    if (err instanceof ManifestError) return problem(400, 'Invalid manifest', err.message);
    if (err instanceof NotLiveError) return problem(409, 'Not deployed', err.message);
    if (err instanceof ConsoleError) return problem(400, 'Try it', err.message);
    if (isUserError(err)) return problem(400, 'Invalid', (err as Error).message);
    if (err instanceof z.ZodError) return problem(400, 'Invalid request body', z.prettifyError(err));
    if (err instanceof SyntaxError) return problem(400, 'Invalid JSON', err.message);
    // Never echo internals: an upstream URL, a secret or a key could be in the message.
    console.error('[jack] unhandled:', err);
    return problem(500, 'Internal error');
  });

  /** The project in the URL, if the caller may see it (another account's project is a 404, not a 403: its existence is private). */
  const project = (c: Context) => {
    const p = store.getProject(c.req.param('id') ?? '');
    const { ownerId } = caller(c);
    if (!p || (ownerId !== null && p.ownerId !== ownerId)) throw new NotFoundError('project not found');
    return p;
  };
  const actor = (c: Context) => caller(c).principal?.user.email ?? c.req.header('x-jack-actor') ?? 'dashboard';
  const visibleProjects = (c: Context) => {
    const { ownerId } = caller(c);
    return ownerId === null ? store.listProjects() : store.listProjects(ownerId);
  };

  // Health is public (the dashboard reads it before sign-in), so it counts nothing per account.
  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: SERVICE,
      protocol: PROTOCOL_VERSION,
      auth: keys.size > 0 || accounts !== undefined,
      accounts: accounts !== undefined,
      signup: accounts?.status().signup ?? false,
      origin: publicOrigin,
    }),
  );

  app.get('/v1/health', (c) =>
    c.json({
      ok: true,
      service: SERVICE,
      protocol: PROTOCOL_VERSION,
      auth: keys.size > 0 || accounts !== undefined,
      accounts: accounts !== undefined,
      signup: accounts?.status().signup ?? false,
      projects: visibleProjects(c).length,
      origin: publicOrigin,
      ...(caller(c).principal ? { user: { email: caller(c).principal!.user.email, name: caller(c).principal!.user.name } } : {}),
    }),
  );

  // ---------------------------------------------------------- projects --

  app.get('/v1/projects', (c) =>
    c.json({
      projects: visibleProjects(c).map((p) => ({ ...describe(p), tools: store.activeDeployment(p.id)?.manifest.tools.length ?? 0 })),
    }),
  );

  app.post('/v1/import/preview', async (c) => {
    const body = z.object({ source: sourceBody, upstream: z.string().url().optional() }).parse(await c.req.json());
    const src = await readSource(body.source);
    return c.json({ preview: previewImport(src.text, { url: src.url, ...(body.upstream ? { upstream: body.upstream } : {}) }) });
  });

  app.post('/v1/projects', async (c) => {
    const raw = (await c.req.json()) as Record<string, unknown>;
    if (raw && typeof raw === 'object' && 'source' in raw) {
      // Import: create from a spec (dashboard wizard, `jack deploy` on first run).
      const body = importBody.parse(raw);
      const src = await readSource(body.source);
      const { project: p, draft } = projects.createFromSource({
        text: src.text,
        url: src.url,
        ownerId: caller(c).ownerId,
        ...(body.slug ? { slug: body.slug } : {}),
        ...(body.name ? { name: body.name } : {}),
        ...(body.upstream ? { upstream: body.upstream } : {}),
      });
      return c.json({ project: describe(p), draft }, 201);
    }
    const body = createProjectBody.parse(raw);
    const p = store.createProject({
      slug: body.slug,
      name: body.name ?? body.slug,
      upstream: new URL(body.upstream).origin,
      auth: body.auth ?? { mode: 'none', requireSignIn: false },
      ownerId: caller(c).ownerId,
    });
    return c.json({ project: describe(p) }, 201);
  });

  app.get('/v1/projects/:id', (c) => {
    const p = project(c);
    const s = store.getSource(p.id);
    return c.json({
      project: describe(p),
      active: store.activeDeployment(p.id),
      issuer: issuerFor(publicOrigin, p.slug),
      oidcRedirectUri: `${issuerFor(publicOrigin, p.slug)}/oauth/upstream/callback`,
      source: s ? { url: s.url, updatedAt: s.updatedAt, bytes: s.text.length } : null,
      secrets: store.listSecrets(p.id),
      testSession: console_.whoami(p),
    });
  });

  app.delete('/v1/projects/:id', (c) => {
    const p = project(c);
    plane.drop(p.id);
    console_.signOut(p.id);
    store.deleteProject(p.id);
    return c.body(null, 204);
  });

  app.put('/v1/projects/:id/source', async (c) => {
    const p = project(c);
    const src = await readSource(sourceBody.parse(await c.req.json()));
    return c.json({ draft: projects.replaceSource(p.id, src.text, src.url) });
  });

  // ------------------------------------------------------------- draft --

  app.get('/v1/projects/:id/draft', (c) => {
    const p = project(c);
    // A project created without a spec (the M0 API, or before an import) has no draft yet: a state, not an error.
    if (!store.getSource(p.id) || !store.getDraft(p.id)) return c.json({ draft: null });
    return c.json({ draft: projects.draftView(p.id) });
  });

  app.put('/v1/projects/:id/draft', async (c) => {
    const body = z.object({ config: z.unknown() }).parse(await c.req.json());
    return c.json({ draft: projects.saveDraft(project(c).id, body.config) });
  });

  app.patch('/v1/projects/:id/draft', async (c) => {
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    return c.json({ draft: projects.updateSettings(project(c).id, body) });
  });

  app.patch('/v1/projects/:id/draft/tools/:key', async (c) => {
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    return c.json({ draft: projects.updateTool(project(c).id, c.req.param('key'), body) });
  });

  app.get('/v1/projects/:id/jack.yaml', (c) => {
    const p = project(c);
    return new Response(projects.exportYaml(p.id), {
      headers: { 'content-type': 'application/yaml; charset=utf-8', 'content-disposition': `attachment; filename="jack.${p.slug}.yaml"` },
    });
  });

  app.put('/v1/projects/:id/secrets/:name', async (c) => {
    const body = z.object({ value: z.string() }).parse(await c.req.json());
    projects.setSecret(project(c).id, c.req.param('name'), body.value);
    return c.body(null, 204);
  });

  app.delete('/v1/projects/:id/secrets/:name', (c) => {
    store.deleteSecret(project(c).id, c.req.param('name'));
    return c.body(null, 204);
  });

  // ------------------------------------------------------- deployments --

  app.post('/v1/projects/:id/deploy', async (c) => {
    const body = z.object({ message: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
    const r = projects.deploy(project(c).id, actor(c), body.message);
    return c.json({ deployment: { ...r.deployment, manifest: undefined }, diff: r.diff, project: describe(r.project) }, 201);
  });

  app.get('/v1/projects/:id/deployments', (c) => {
    const p = project(c);
    return c.json({ activeVersion: p.activeVersion, deployments: projects.history(p.id) });
  });

  // Raw manifest upload (M0 contract; `jack build` output).
  app.post('/v1/projects/:id/deployments', async (c) => {
    const p = project(c);
    const body = createDeploymentBody.parse(await c.req.json());
    const m = parseManifest(body.manifest);
    if (new URL(m.upstream).origin !== p.upstream) {
      return problem(400, 'Upstream mismatch', `manifest upstream ${m.upstream} is not the project's ${p.upstream}`);
    }
    const previous = store.activeDeployment(p.id);
    const deployment = store.createDeployment({ projectId: p.id, manifest: m, manifestHash: manifestHash(m), createdBy: caller(c).principal?.user.email ?? c.req.header('x-jack-actor') ?? 'api' });
    return c.json({ deployment: { ...deployment, manifest: undefined }, diff: diffManifests(previous?.manifest ?? null, m) }, 201);
  });

  app.get('/v1/projects/:id/deployments/:version', (c) => {
    const d = store.getDeployment(project(c).id, Number(c.req.param('version')));
    if (!d) return problem(404, 'Deployment not found');
    return c.json({ deployment: d });
  });

  app.post('/v1/projects/:id/promote', async (c) => {
    const p = project(c);
    const { version } = promoteBody.parse(await c.req.json());
    if (!store.getDeployment(p.id, version)) return problem(404, 'Deployment not found');
    return c.json({ project: describe(projects.promote(p.id, version)) });
  });

  // ------------------------------------------------- users and activity --

  app.get('/v1/projects/:id/grants', (c) => {
    const p = project(c);
    const grants = plane.grants(p).map((g) => {
      let app_ = g.clientId;
      try {
        app_ = new URL(g.clientId).host; // CIMD: the verified host
      } catch {
        app_ = g.clientId.startsWith('jdc_') ? 'registered app (unverified)' : g.clientId;
      }
      return { id: g.id, user: g.display, subject: g.subject, app: app_, clientId: g.clientId, scopes: g.scopes, createdAt: g.createdAt, revokedAt: g.revokedAt };
    });
    return c.json({ grants: grants.reverse() });
  });

  app.delete('/v1/projects/:id/grants/:grant', (c) => {
    if (!plane.revoke(project(c), c.req.param('grant'))) return problem(404, 'Grant not found');
    return c.body(null, 204);
  });

  app.get('/v1/projects/:id/calls', (c) => {
    const limit = Number(c.req.query('limit') ?? 100) || 100;
    const before = c.req.query('before');
    return c.json({ calls: store.listCalls(project(c).id, { limit, ...(before ? { before: Number(before) } : {}) }) });
  });

  // ---------------------------------------------------------- try it --

  app.post('/v1/projects/:id/test-signin', async (c) => c.json({ url: await console_.start(project(c)) }));

  app.delete('/v1/projects/:id/test-signin', (c) => {
    console_.signOut(project(c).id);
    return c.body(null, 204);
  });

  app.post('/v1/projects/:id/try', async (c) => {
    const body = tryBody.parse(await c.req.json());
    return c.json({ result: await console_.tryTool(project(c), body.tool, body.args, body.approve) });
  });

  // -------------------------------------------------------- data plane --

  app.all('*', async (c) => (await plane.handle(c.req.raw)) ?? problem(404, 'Not found'));

  return { app, projects, plane, close: () => plane.close() };
}

/** The Hono app only (M0 signature). Prefer `createJack` when you need to close it. */
export function createApi(opts: ApiOptions): Hono {
  return createJack(opts).app;
}
