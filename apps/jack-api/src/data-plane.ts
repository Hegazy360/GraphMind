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
 * keeps its sign-in state in its own database file: tenants share nothing.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { canonicalJson, sha256Hex, type Manifest, type Project } from '@graphmind-ai/jack-schema';
import { createToolHttpHandler, type CallRecord, type EgressPolicy } from '@graphmind-ai/jack-runtime';
import { createAuthServer, resolveAuth, SqliteAuthStore, type AuthEvent, type AuthServer, type GrantRecord } from '@graphmind-ai/jack-auth';
import type { JackStore } from './store.js';

export interface DataPlaneOptions {
  store: JackStore;
  publicOrigin: string;
  dataDir: string;
  secretKey: Uint8Array;
  egress: EgressPolicy;
  resolveSecret: (projectId: string, ref: string) => string | undefined;
  onEvent?: (projectId: string, e: AuthEvent) => void;
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

export class DataPlane {
  private readonly bundles = new Map<string, Bundle>();
  private readonly authStores = new Map<string, SqliteAuthStore>();

  constructor(private readonly opts: DataPlaneOptions) {}

  private authStore(projectId: string): SqliteAuthStore {
    let s = this.authStores.get(projectId);
    if (!s) {
      const dir = join(this.opts.dataDir, 'projects', projectId);
      mkdirSync(dir, { recursive: true });
      s = new SqliteAuthStore(join(dir, 'auth.db'));
      this.authStores.set(projectId, s);
    }
    return s;
  }

  /** The live bundle for a project, (re)built if its deployment or sign-in settings changed. */
  bundle(project: Project): Bundle {
    const live = this.opts.store.activeDeployment(project.id);
    if (!live) throw new NotLiveError(`${project.name} has not been deployed yet`);
    const mode: Mode = project.auth.mode === 'none' && !project.auth.requireSignIn ? 'open' : 'sign-in';
    const key = sha256Hex(canonicalJson([live.version, project.slug, project.auth, this.opts.egress]));
    const cached = this.bundles.get(project.id);
    if (cached?.key === key) return cached;
    if (cached) void cached.handler.close();

    const record = (r: CallRecord) =>
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
      });

    let auth: AuthServer | null = null;
    if (mode === 'sign-in') {
      auth = createAuthServer({
        issuer: issuerFor(this.opts.publicOrigin, project.slug),
        resource: mcpUrlFor(this.opts.publicOrigin, project.slug),
        projectName: project.name,
        manifest: () => live.manifest,
        auth: resolveAuth(project.auth, (ref) => this.opts.resolveSecret(project.id, ref)),
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
    const bundle: Bundle = { key, mode, manifest: live.manifest, handler, auth };
    this.bundles.set(project.id, bundle);
    return bundle;
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
    const project = this.opts.store.getProjectBySlug(m[1] as string);
    const rest = m[2] as string;
    if (!project) return Response.json({ title: 'Unknown project', status: 404 }, { status: 404, headers: { 'content-type': 'application/problem+json' } });
    let b: Bundle;
    try {
      b = this.bundle(project);
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

  grants(project: Project): GrantRecord[] {
    return this.authStore(project.id).listGrants();
  }

  revoke(project: Project, grantId: string): boolean {
    const store = this.authStore(project.id);
    const g = store.getGrant(grantId);
    if (!g) return false;
    // Through the live auth server when there is one (it emits the event); otherwise directly.
    const live = this.bundles.get(project.id)?.auth;
    if (live) live.revokeGrant(grantId);
    else store.revokeGrant(grantId, Date.now());
    return true;
  }

  /** Forget a project entirely (on delete): close its stores and remove its sign-in data. */
  drop(projectId: string) {
    const b = this.bundles.get(projectId);
    if (b) void b.handler.close();
    this.bundles.delete(projectId);
    this.authStores.get(projectId)?.close();
    this.authStores.delete(projectId);
    rmSync(join(this.opts.dataDir, 'projects', projectId), { recursive: true, force: true });
  }

  async close() {
    await Promise.all([...this.bundles.values()].map((b) => b.handler.close()));
    this.bundles.clear();
    for (const s of this.authStores.values()) s.close();
    this.authStores.clear();
  }
}
