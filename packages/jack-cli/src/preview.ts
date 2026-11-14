/**
 * `jack preview` — serve jack.yaml as a real MCP server on your machine.
 *
 * Same runtime (and, in sign-in mode, the same authorization server) the
 * hosted service uses. Three ways to run, chosen from jack.yaml + env:
 *
 *   open         auth: none            — no sign-in, no credentials
 *   single-user  apikey + $JACK_UPSTREAM_API_KEY — acts as that one key (M2)
 *   sign-in      oidc, or apikey without the env var, or none + requireSignIn —
 *                every AI client that connects signs its user in through
 *                Jack's OAuth 2.1 server (/oauth/*); Jack holds each user's
 *                upstream credential, the client only gets a Jack token.
 *
 * Local differences from hosted: binds 127.0.0.1 only and refuses
 * non-localhost Host/Origin headers; egress `any` by default (your API is
 * usually on localhost too); sign-in state lives in .jack/ next to jack.yaml.
 * jack.yaml (and a local `source:`) are watched and hot-reloaded.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { diffManifests, PROTOCOL_VERSION, type JackConfig, type Manifest } from '@graphmind-ai/jack-schema';
import { compileProject, isUrl } from '@graphmind-ai/jack-openapi';
import {
  createToolHttpHandler,
  createToolServerFactory,
  headerCredentials,
  LEGACY_POLICY,
  type CallRecord,
  type CredentialResolver,
  type EgressPolicy,
} from '@graphmind-ai/jack-runtime';
import { createAuthServer, resolveAuth, SqliteAuthStore, UpstreamAuthError, type AuthEvent, type AuthServer, type ResolvedAuth } from '@graphmind-ai/jack-auth';
import type { Io } from './commands.js';
import { choosePort, PortError, writeRunInfo, type PortRequest } from './ports.js';

/** Only used when a caller asks for it explicitly; `jack preview` defaults to a per-worktree port. */
export const DEFAULT_PREVIEW_PORT = 4823;
export const API_KEY_ENV = 'JACK_UPSTREAM_API_KEY';

export interface PreviewOptions {
  config?: string;
  /** `auto` (default): stable per worktree, next free if busy · 0: any free port · n: exactly n. */
  port?: PortRequest;
  /**
   * Worktree root to record this server in (`.jack/run/preview.json`), so
   * `jack tools`/`call` in that worktree find it. The CLI passes the
   * worktree; library callers (tests) leave it unset and nothing is written.
   */
  runRoot?: string;
  stdio?: boolean;
  egress?: EgressPolicy;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Watch jack.yaml for changes (default true). */
  watch?: boolean;
  /** Where sign-in state (grants, keys) lives. Default: .jack/ next to jack.yaml. */
  stateDir?: string;
}

export type PreviewMode = 'open' | 'single-user' | 'sign-in';

export interface PreviewHandle {
  url: string | null;
  mode: PreviewMode;
  /** The authorization server, in sign-in mode. */
  auth: AuthServer | null;
  manifest: () => Manifest;
  close: () => Promise<void>;
}

export class PreviewError extends Error {
  override name = 'PreviewError';
}

export type AuthPlan =
  | { mode: 'open'; note: string }
  | { mode: 'single-user'; resolver: CredentialResolver; note: string }
  | { mode: 'sign-in'; resolved: ResolvedAuth; note: string };

/** `env:NAME` → that environment variable. The only secret reference the preview understands. */
export function resolveSecretRef(ref: string, env: Record<string, string | undefined>): string | undefined {
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (!m) throw new PreviewError(`secret reference '${ref}' is not supported in preview; use env:NAME`);
  return env[m[1] as string];
}

/** Decide how the preview authenticates, from jack.yaml's `auth` and the environment. */
export function planAuth(config: JackConfig, env: Record<string, string | undefined>): AuthPlan {
  const auth = config.auth ?? { mode: 'none' as const, requireSignIn: false };
  const key = env[API_KEY_ENV]?.trim();
  try {
    switch (auth.mode) {
      case 'none':
        return auth.requireSignIn
          ? { mode: 'sign-in', resolved: { mode: 'none' }, note: 'sign-in: required (auth: none + requireSignIn), no upstream credentials' }
          : { mode: 'open', note: 'auth: none (no sign-in; requests go to the API without credentials)' };
      case 'apikey':
        if (key) {
          return {
            mode: 'single-user',
            resolver: headerCredentials({ [auth.header.toLowerCase()]: `${auth.prefix}${key}` }),
            note: `single-user: acting as ${API_KEY_ENV} (unset it to have each user sign in with their own key)`,
          };
        }
        return { mode: 'sign-in', resolved: resolveAuth(auth, () => undefined), note: 'sign-in: each user pastes their own API key on Jack\'s sign-in page' };
      case 'oidc':
        return {
          mode: 'sign-in',
          resolved: resolveAuth(auth, (ref) => resolveSecretRef(ref, env)),
          note: `sign-in: oidc via ${auth.issuer} (client ${auth.clientId})`,
        };
      case 'link':
        return {
          mode: 'sign-in',
          resolved: resolveAuth(auth, (ref) => resolveSecretRef(ref, env)),
          note: `sign-in: account linking via ${auth.linkUrl} (your app verifies with @graphmind-ai/jack-verify)`,
        };
    }
  } catch (err) {
    if (err instanceof UpstreamAuthError) throw new PreviewError(`${err.message}. Set it in the environment, e.g. ${((auth as { clientSecretRef?: string; secretRef?: string }).clientSecretRef ?? (auth as { secretRef?: string }).secretRef)?.replace(/^env:/, '') ?? 'THE_SECRET'}=… jack preview`);
    throw err;
  }
}

/** A 32-byte key that seals upstream credentials at rest, created once per state dir (mode 0600). */
export function loadOrCreateKey(dir: string): Uint8Array {
  const path = resolve(dir, 'secret.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new PreviewError(`${path} is not a valid Jack key; delete it to start fresh`);
    return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function formatCall(r: CallRecord): string {
  const mark = r.status === 'ok' ? '✓' : '✗';
  // Calls that reached the API show its status and size; the rest say why they stopped.
  const status = r.upstreamStatus !== undefined ? String(r.upstreamStatus) : '—';
  const detail = r.upstreamStatus !== undefined ? kb(r.responseBytes) : r.status.replaceAll('_', ' ');
  return `  ${mark} ${r.tool.padEnd(24)} ${status.padEnd(4)} ${String(r.ms).padStart(5)}ms  ${detail}`;
}

export async function startPreview(opts: PreviewOptions, io: Io): Promise<PreviewHandle> {
  const configPath = resolve(opts.config ?? 'jack.yaml');
  const env = opts.env ?? process.env;
  // In stdio mode stdout IS the protocol: everything human goes to stderr.
  const say = opts.stdio ? io.err : io.out;

  const first = await compileProject(configPath, { env });
  const plan = planAuth(first.config, env);
  if (plan.mode === 'sign-in' && opts.stdio) {
    throw new PreviewError(`stdio has no sign-in (MCP over stdio has no OAuth). Serve over HTTP, or run single-user with ${API_KEY_ENV}.`);
  }
  let current = first.manifest;
  const egress = opts.egress ?? 'any';
  // In sign-in mode the credential resolver is the auth server's, created once the port is known.
  let authServer: AuthServer | null = null;

  const serverOpts = {
    manifest: () => current,
    egress,
    ...(plan.mode === 'single-user' ? { credentials: plan.resolver } : {}),
    ...(plan.mode === 'sign-in'
      ? { credentials: (ctx: Parameters<CredentialResolver>[0]) => (authServer as AuthServer).credentials(ctx), listAll: true }
      : {}),
    onCall: (r: CallRecord) => io.err(formatCall(r)),
  };

  say(`jack preview — ${current.name}: ${current.tools.length} tools → ${first.baseUrl}`);
  say(`  ${plan.note}`);
  say(`  egress: ${egress === 'any' ? 'any (local preview: private and loopback addresses allowed)' : 'public only (hosted behaviour)'}`);
  for (const d of first.diagnostics.filter((x) => x.severity === 'warning')) say(`  warning ${d.code}${d.tool ? ` ${d.tool}` : ''}: ${d.message}`);

  // Hot reload. Watch directories (editors replace files on save) and filter by name.
  const watchers: FSWatcher[] = [];
  if (opts.watch !== false) {
    const targets = new Map<string, Set<string>>([[dirname(configPath), new Set([basename(configPath)])]]);
    if (!isUrl(first.config.source)) {
      const src = resolve(dirname(configPath), first.config.source);
      const set = targets.get(dirname(src)) ?? new Set<string>();
      set.add(basename(src));
      targets.set(dirname(src), set);
    }
    let timer: NodeJS.Timeout | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const next = await compileProject(configPath, { env });
          const diff = diffManifests(current, next.manifest);
          current = next.manifest;
          const parts = Object.entries(diff)
            .filter(([, v]) => (v as string[]).length > 0)
            .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`);
          say(`↻ reloaded jack.yaml — ${current.tools.length} tools${parts.length ? ` (${parts.join('; ')})` : ' (no tool changes)'}`);
        } catch (err) {
          say(`✗ reload failed, still serving the previous version: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, 150);
    };
    for (const [dir, names] of targets) {
      const w = watch(dir, (_event, file) => {
        if (file !== null && names.has(String(file))) reload();
      });
      w.unref();
      watchers.push(w);
    }
  }
  const stopWatching = () => watchers.forEach((w) => w.close());

  if (opts.stdio) {
    const handle = serveStdio(createToolServerFactory(serverOpts), { legacy: LEGACY_POLICY });
    say(`  serving MCP ${PROTOCOL_VERSION} on stdio`);
    return {
      url: null,
      mode: plan.mode,
      auth: null,
      manifest: () => current,
      close: async () => {
        stopWatching();
        await (handle as { close?: () => Promise<void> | void }).close?.();
      },
    };
  }

  const handler = createToolHttpHandler({ ...serverOpts, onerror: (err) => io.err(`  ! ${err.message}`) });
  const app = new Hono();
  const hostnames = localhostAllowedHostnames();
  const origins = localhostAllowedOrigins();
  // DNS-rebinding defence for everything this local server answers.
  app.use('*', async (c, next) => hostHeaderValidationResponse(c.req.raw, hostnames) ?? next());
  let mcpRoute = (req: Request) => handler.fetch(req);
  app.all('/mcp', (c) => originValidationResponse(c.req.raw, origins) ?? mcpRoute(c.req.raw));
  // Sign-in routes exist only after listen (the issuer needs the real port). Hono's
  // app.route() copies routes when called, so forward at request time instead.
  let signInRoutes: Hono | null = null;
  app.get('/', (c) =>
    c.json({
      service: 'jack-preview',
      protocol: PROTOCOL_VERSION,
      name: current.name,
      upstream: current.upstream,
      mode: plan.mode,
      tools: current.tools.map((t) => t.name),
    }),
  );

  app.all('*', (c) => (signInRoutes ? signInRoutes.fetch(c.req.raw) : c.notFound()));

  let port: number;
  try {
    const chosen = await choosePort(opts.port ?? 'auto', 'preview', opts.runRoot);
    port = chosen.port;
    if (chosen.note) say(`  ${chosen.note}`);
  } catch (err) {
    if (err instanceof PortError) throw new PreviewError(err.message);
    throw err;
  }
  let server: ServerType | undefined;
  const actualPort = await new Promise<number>((resolveListen, rejectListen) => {
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => resolveListen(info.port));
    server.once('error', (err: NodeJS.ErrnoException) =>
      rejectListen(err.code === 'EADDRINUSE' ? new PreviewError(`port ${port} is in use — use --port auto (the default) to pick a free one`) : err),
    );
  });
  const origin = `http://127.0.0.1:${actualPort}`;
  const url = `${origin}/mcp`;

  let authStore: SqliteAuthStore | null = null;
  if (plan.mode === 'sign-in') {
    const stateDir = resolve(opts.stateDir ?? resolve(dirname(configPath), '.jack'));
    mkdirSync(stateDir, { recursive: true });
    authStore = new SqliteAuthStore(resolve(stateDir, 'preview-auth.db'));
    const store = authStore;
    const describe = (e: AuthEvent) => {
      const g = e.grantId ? store.getGrant(e.grantId) : null;
      return `${g?.display ?? 'someone'} · ${(e.clientId ?? '').slice(0, 48)}`;
    };
    authServer = createAuthServer({
      issuer: origin,
      resource: url,
      projectName: current.name,
      manifest: () => current,
      auth: plan.resolved,
      store,
      secretKey: loadOrCreateKey(stateDir),
      egress,
      onEvent: (e) => {
        if (e.type === 'grant.created') say(`  + signed in: ${describe(e)}`);
        else if (e.type === 'grant.revoked') say(`  - revoked: ${describe(e)}${e.detail ? ` (${e.detail})` : ''}`);
        else if (e.type === 'signin.failed') say(`  ✗ sign-in failed: ${e.detail ?? ''}`);
      },
    });
    const auth = authServer;
    signInRoutes = auth.routes;
    mcpRoute = auth.protect((req, authInfo) => handler.fetch(req, { authInfo }));
    say(`  authorization server: ${origin} (state in ${stateDir})`);
  }
  say(`  serving MCP ${PROTOCOL_VERSION} at ${url}`);
  const unregister = opts.runRoot
    ? writeRunInfo({ service: 'preview', url, mcpUrl: url, issuer: origin, mode: plan.mode, config: configPath }, opts.runRoot)
    : () => {};
  if (opts.runRoot) say(`  registered for this worktree: jack tools / jack call / Claude Code find it without --url`);
  say('');
  say('  try it:     jack tools   ·   jack call <tool> --args \'{...}\'');
  say(`  Claude Code: claude mcp add --transport http ${current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'jack'} ${url}`);
  say('');
  return {
    url,
    mode: plan.mode,
    auth: authServer,
    manifest: () => current,
    close: async () => {
      unregister();
      stopWatching();
      await handler.close();
      authStore?.close();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    },
  };
}
