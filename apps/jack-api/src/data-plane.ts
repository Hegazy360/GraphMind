/**
 * The data plane: what AI clients talk to. One origin hosts every project:
 *
 *   /p/<slug>/mcp                                        the MCP endpoint
 *   /p/<slug>/oauth/*                                    its authorization server (issuer /p/<slug>)
 *   /.well-known/oauth-authorization-server/p/<slug>     RFC 8414 (path-inserted)
 *   /.well-known/oauth-protected-resource/p/<slug>/mcp   RFC 9728 (path-inserted)
 *
 * Hosted, each project gets its own host instead (plan §1.1); the same
 * bundle serves either layout because the auth server takes any issuer.
 *
 * A bundle (runtime handler + auth server) is built per project from its
 * ACTIVE deployment and live sign-in settings, and rebuilt only when those
 * change, so a deploy or rollback is live on the next request. Each project
 * keeps its sign-in state in its own AuthStore: by default its own SQLite
 * file (tenants share nothing); hosted, a Postgres handle scoped to the
 * project id (`authStoreFor`).
 *
 * Hosted instances are many and short-lived; the bundle cache is only a
 * per-instance memo keyed by the live version and settings read from the
 * store on every request, so each instance converges on the next request
 * after a deploy without any cross-instance signal.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { canonicalJson, sha256Hex, type Manifest, type Project } from '@graphmind-ai/jack-schema';
import { createToolHttpHandler, type CallRecord, type EgressPolicy } from '@graphmind-ai/jack-runtime';
import { createAuthServer, resolveAuth, SqliteAuthStore, type AuthEvent, type AuthServer, type AuthStore, type GrantRecord } from '@graphmind-ai/jack-auth';
import type { JackStore, StoredDeployment } from './store.js';

export interface DataPlaneOptions {
  store: JackStore;
  publicOrigin: string;
  /**
   * The sign-in store of one project. Given (hosted: Postgres handles scoped
   * to the project), the data plane never touches the filesystem and
   * deleting a project purges its rows through the store. Omitted: one
   * SQLite file per project under `dataDir/projects/<id>/auth.db`.
   */
  authStoreFor?: (projectId: string) => AuthStore;
  /** Required when `authStoreFor` is not given. */
  dataDir?: string;
  secretKey: Uint8Array;
  egress: EgressPolicy;
  /** Resolve `secret:`/`env:` references of a project (async: secrets live in the store). */
  resolveSecret: (projectId: string, ref: string) => Promise<string | undefined>;
  onEvent?: (projectId: string, e: AuthEvent) => void;
  /**
   * Keep background work (the call log write after a tool call) alive past
   * the response. Serverless hosts pass their `waitUntil` (Vercel:
   * `@vercel/functions`), or an instance may be frozen before the write
   * lands. Default: tracked in-process and awaited by close().
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

export type Mode = 'open' | 'sign-in';

interface Bundle {
  key: string;
  mode: Mode;
  manifest: Manifest;
  handler: McpHttpHandler;
  auth: AuthServer | null;
}

export class NotLiveError extends Error {
  override name = 'NotLiveError';
}

export const issuerFor = (origin: string, slug: string) => `${origin}/p/${slug}`;
export const mcpUrlFor = (origin: string, slug: string) => `${origin}/p/${slug}/mcp`;

/** The sign-in settings' secret references, so they can be resolved before the (synchronous) resolveAuth. */
function secretRefs(auth: Project['auth']): string[] {
  if (auth.mode === 'oidc') return [auth.clientSecretRef];
  if (auth.mode === 'link') return [auth.secretRef];
  return [];
}

export class DataPlane {
  /**
   * Per project, the bundle for one key — as a promise, so concurrent
   * requests that find it missing or stale share ONE build instead of each
   * building (and leaking) a handler. Replaced synchronously when the key
   * changes; a failed build is evicted so the next request retries.
   */
  private readonly bundles = new Map<string, { key: string; bundle: Promise<Bundle> }>();
  private readonly authStores = new Map<string, AuthStore>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly opts: DataPlaneOptions) {
    if (!opts.authStoreFor && !opts.dataDir) throw new Error('DataPlane needs dataDir or authStoreFor');
  }

  private authStore(projectId: string): AuthStore {
    let s = this.authStores.get(projectId);
    if (!s) {
      if (this.opts.authStoreFor) s = this.opts.authStoreFor(projectId);
      else {
        const dir = join(this.opts.dataDir as string, 'projects', projectId);
        mkdirSync(dir, { recursive: true });
        s = new SqliteAuthStore(join(dir, 'auth.db'));
      }
      this.authStores.set(projectId, s);
    }
    return s;
  }

  private keepAlive(p: Promise<unknown>) {
    const guarded = p.catch((err) => console.error('[jack] background write failed:', err));
    if (this.opts.waitUntil) return this.opts.waitUntil(guarded);
    this.background.add(guarded);
    void guarded.finally(() => this.background.delete(guarded));
  }

  /** The live bundle for a project, (re)built if its deployment or sign-in settings changed. */
  async bundle(project: Project): Promise<Bundle> {
    const live = await this.opts.store.activeDeployment(project.id);
    if (!live) throw new NotLiveError(`${project.name} has not been deployed yet`);
    const key = sha256Hex(canonicalJson([live.version, project.slug, project.auth, this.opts.egress]));
    const cached = this.bundles.get(project.id);
    if (cached?.key === key) return cached.bundle;
    const entry = { key, bundle: this.build(project, live, key) };
    this.bundles.set(project.id, entry);
    // Close the superseded handler once it exists (it may still be building).
    if (cached) void cached.bundle.then((b) => b.handler.close(), () => {});
    entry.bundle.catch(() => {
      if (this.bundles.get(project.id) === entry) this.bundles.delete(project.id);
    });
    return entry.bundle;
  }

  private async build(project: Project, live: StoredDeployment, key: string): Promise<Bundle> {
    const mode: Mode = project.auth.mode === 'none' && !project.auth.requireSignIn ? 'open' : 'sign-in';
    const record = (r: CallRecord) =>
      this.keepAlive(
        this.opts.store.insertCall({
          projectId: project.id,
          version: live.version,
          tool: r.tool,
          status: r.status,
          upstreamStatus: r.upstreamStatus ?? null,
          ms: r.ms,
          requestBytes: r.requestBytes,
          responseBytes: r.responseBytes,
          subject: r.subject ?? null,
          clientId: r.clientId ?? null,
          at: Date.now(),
        }),
      );

    let auth: AuthServer | null = null;
    if (mode === 'sign-in') {
      const secrets = new Map<string, string | undefined>();
      for (const ref of secretRefs(project.auth)) secrets.set(ref, await this.opts.resolveSecret(project.id, ref));
      auth = createAuthServer({
        issuer: issuerFor(this.opts.publicOrigin, project.slug),
        resource: mcpUrlFor(this.opts.publicOrigin, project.slug),
        projectName: project.name,
        manifest: () => live.manifest,
        auth: resolveAuth(project.auth, (ref) => secrets.get(ref)),
        store: this.authStore(project.id),
        secretKey: this.opts.secretKey,
        egress: this.opts.egress,
        onEvent: (e) => this.opts.onEvent?.(project.id, e),
      });
    }
    const handler = createToolHttpHandler({
      manifest: live.manifest,
      egress: this.opts.egress,
      onCall: record,
      ...(auth ? { credentials: auth.credentials, listAll: true } : {}),
    });
    return { key, mode, manifest: live.manifest, handler, auth };
  }

  /** The live auth server of a project, if a bundle is built (or being built). */
  private async liveAuth(projectId: string): Promise<AuthServer | null> {
    const entry = this.bundles.get(projectId);
    return entry ? ((await entry.bundle.catch(() => null))?.auth ?? null) : null;
  }

  /**
   * Route a data-plane request, or return null if the path is not ours.
   * `slug` comes from the URL; unknown or undeployed projects get a 404
   * that says which (the dashboard links here before the first deploy).
   */
  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    const m =
      /^\/p\/([a-z0-9-]+)(\/.*)$/.exec(path) ??
      /^\/\.well-known\/oauth-authorization-server\/p\/([a-z0-9-]+)()$/.exec(path) ??
      /^\/\.well-known\/oauth-protected-resource\/p\/([a-z0-9-]+)(\/mcp)$/.exec(path);
    if (!m) return null;
    const project = await this.opts.store.getProjectBySlug(m[1] as string);
    const rest = m[2] as string;
    if (!project) return Response.json({ title: 'Unknown project', status: 404 }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    let b: Bundle;
    try {
      b = await this.bundle(project);
    } catch (err) {
      if (err instanceof NotLiveError) return Response.json({ title: 'Not deployed', status: 404, detail: err.message }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
      throw err;
    }
    if (path.endsWith('/mcp') && !path.startsWith('/.well-known/')) {
      if (b.auth === null) return b.handler.fetch(req);
      return b.auth.protect((r, authInfo) => b.handler.fetch(r, { authInfo }))(req);
    }
    if (b.auth && (rest.startsWith('/oauth/') || path.startsWith('/.well-known/'))) return b.auth.routes.fetch(req);
    return Response.json({ title: 'Not found', status: 404 }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
  }

  grants(project: Project): Promise<GrantRecord[]> {
    return this.authStore(project.id).listGrants();
  }

  async revoke(project: Project, grantId: string): Promise<boolean> {
    const store = this.authStore(project.id);
    const g = await store.getGrant(grantId);
    if (!g) return false;
    // Through the live auth server when there is one (it emits the event); otherwise directly.
    const live = await this.liveAuth(project.id);
    if (live) await live.revokeGrant(grantId);
    else await store.revokeGrant(grantId, Date.now());
    return true;
  }

  /**
   * Forget a project entirely (on delete): close its handler and remove its
   * sign-in data — the project's rows through the store when stores come
   * from `authStoreFor`, otherwise its directory under dataDir.
   */
  async drop(projectId: string): Promise<void> {
    const entry = this.bundles.get(projectId);
    this.bundles.delete(projectId);
    if (entry) void entry.bundle.then((b) => b.handler.close(), () => {});
    if (this.opts.authStoreFor) {
      const store = this.authStore(projectId);
      this.authStores.delete(projectId);
      await store.purge();
      await store.close();
      return;
    }
    await this.authStores.get(projectId)?.close();
    this.authStores.delete(projectId);
    rmSync(join(this.opts.dataDir as string, 'projects', projectId), { recursive: true, force: true });
  }

  async close() {
    const entries = [...this.bundles.values()];
    this.bundles.clear();
    await Promise.all(entries.map((e) => e.bundle.then((b) => b.handler.close(), () => {})));
    await Promise.all([...this.background]);
    for (const s of this.authStores.values()) await s.close();
    this.authStores.clear();
  }
}
