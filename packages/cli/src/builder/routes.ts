/**
 * The builder's HTTP surface, under `/api/builder`.
 *
 * Who may call it: anyone the origin guard admits — which from a browser
 * means the viewer this server serves, or an origin the operator allow-listed
 * (`GRAPHMIND_ALLOWED_ORIGINS`, for the Vite dev server). No token. The
 * builder is a canvas for trying a workflow out before writing it into code;
 * asking for a credential first was friction with nothing behind it, since
 * nothing a project or an MCP probe does needs the debugger's control plane.
 *
 * What that leaves open, stated plainly: another LOCAL process — one that can
 * reach 127.0.0.1 on this port — can create a project under the serving
 * user's home, run one the builder wrote, or spawn an MCP command through the
 * probe. On a single-user machine that process already runs as you and could
 * do all of that directly. On a shared machine, set
 * `GRAPHMIND_BUILDER_REQUIRE_TOKEN=1` and every builder route needs the
 * viewer token again (the agent token is refused either way; a coding agent
 * has `graphmind init`).
 *
 *   GET  /api/builder/targets              targets, the default spec, where projects go
 *   POST /api/builder/preview              {spec} -> the files Create would write
 *   GET  /api/builder/projects             projects the builder made (names, never values)
 *   POST /api/builder/projects             {spec, dir?, secrets?, persistSecrets?, overwrite?} -> write it
 *   GET  /api/builder/projects/env?dir=    which variables are set (names only)
 *   POST /api/builder/projects/env         {dir, secrets, persist} -> store them
 *   POST /api/builder/projects/env/forget  {dir} -> drop the session-only keys
 *   POST /api/builder/mcp/probe            {server, bearer?} -> connect, list tools, disconnect
 *   POST /api/builder/jobs                 {dir} -> install (once) and run
 *   GET  /api/builder/jobs/:id?after=n     job state + log lines from n
 *   POST /api/builder/jobs/:id/stop
 *
 * No response carries a secret value: `secrets` is consumed by env-file.ts
 * (`persist: true`, the default) or by secret-store.ts (`persist: false` —
 * memory only, nothing written to disk) and only the NAMES come back. Job
 * logs are scrubbed before they are kept, and no route logs a value or a
 * request body.
 */
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { credentialOf } from '../control-http.js';
import type { CredentialVerifier } from '../control-auth.js';
import type { LogFn } from '../hub.js';
import type { EnvLike } from '../paths.js';
import { VERSION } from '../version.js';
import { generateProject, platformOf } from './codegen/index.js';
import { LocalPackagesError, detectCheckout, resolveLocalPackages } from './local-packages.js';
import { resolvePython } from './toolchain.js';
import { EnvFileError, envKeysPresent, validateEnvUpdates, writeEnvFile } from './env-file.js';
import {
  ProjectError,
  createProject,
  listProjects,
  requireProject,
  resolveWorkflowsDir,
  summarize,
} from './projects.js';
import { RunnerError, type ProjectRunner } from './runner.js';
import type { SessionSecrets } from './secret-store.js';
import { McpServerSchema, TARGETS, defaultSpec, parseSpec } from './spec.js';
import { probeMcpServer } from './mcp-probe.js';
import { join } from 'node:path';

/** A spec plus a project is a few KB; this is generous, not a frame budget. */
const MAX_BODY_BYTES = 512 * 1024;

export interface BuilderRouteDeps {
  verifier: CredentialVerifier;
  runner: ProjectRunner;
  /** Keys held in memory only, for `persist: false`. */
  sessionSecrets: SessionSecrets;
  env: EnvLike;
  log: LogFn;
}

function forbidden(c: Context, message: string) {
  return c.json({ error: 'forbidden', message }, 403);
}

/** Set to `1` to put the viewer token back in front of every builder route. */
export const REQUIRE_TOKEN_ENV = 'GRAPHMIND_BUILDER_REQUIRE_TOKEN';

/**
 * The gate, such as it is. Open by default (see the header); with
 * GRAPHMIND_BUILDER_REQUIRE_TOKEN=1, viewer token or nothing.
 */
function requireAccess(c: Context, verifier: CredentialVerifier, strict: boolean): Response | undefined {
  if (!strict) return undefined;
  const credential = credentialOf(c, verifier);
  if (credential.kind === 'none') {
    c.header('www-authenticate', 'Bearer');
    return c.json(
      {
        error: 'unauthorized',
        message: `this server requires the viewer token for the builder (${REQUIRE_TOKEN_ENV}=1): open the viewer from the link \`graphmind serve\` printed`,
      },
      401,
    );
  }
  if (credential.kind === 'invalid') {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'unauthorized', message: credential.message }, 401);
  }
  if (credential.principal !== 'viewer') {
    return forbidden(c, 'the builder is driven from the viewer only; a coding agent can use `graphmind init`');
  }
  return undefined;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return undefined;
  try {
    const body = (await c.req.json()) as unknown;
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectError) {
    const status = error.code === 'exists' ? 409 : error.code === 'not-a-project' ? 404 : 400;
    return c.json({ error: error.code, message: error.message }, status);
  }
  if (error instanceof EnvFileError) return c.json({ error: error.code, message: error.message }, 400);
  if (error instanceof LocalPackagesError) return c.json({ error: 'checkout-not-built', message: error.message }, 500);
  if (error instanceof RunnerError) {
    return c.json({ error: error.code, message: error.message }, error.code === 'already-running' ? 409 : 404);
  }
  // A filesystem error names a path, never a value; the message is safe to relay.
  return c.json({ error: 'failed', message: error instanceof Error ? error.message : String(error) }, 500);
}

export function registerBuilderRoutes(app: Hono, deps: BuilderRouteDeps): void {
  const { verifier, runner, sessionSecrets, env, log } = deps;
  const strict = (env[REQUIRE_TOKEN_ENV] ?? '') === '1';
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'too-large', message: 'request body too large' }, 413),
  });

  app.get('/api/builder/targets', (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const python = resolvePython(env as Record<string, string | undefined>);
    return c.json({
      version: VERSION,
      platform: platformOf(),
      workflowsDir: resolveWorkflowsDir(env),
      /** `checkout` = this CLI runs from the repository; adapters come from local tarballs. */
      source: detectCheckout() === undefined || (env['GRAPHMIND_BUILDER_REGISTRY'] ?? '') === '1' ? 'registry' : 'checkout',
      /** Which Python the runner would use for a Python project, if any. */
      python: python === undefined ? null : { kind: python.kind, describe: python.describe },
      targets: Object.values(TARGETS),
      defaultSpec: defaultSpec(),
    });
  });

  app.post('/api/builder/preview', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    const parsed = parseSpec(body['spec']);
    if (!parsed.ok) return c.json({ error: 'invalid-spec', issues: parsed.issues }, 400);
    let project;
    try {
      project = generateProject(parsed.spec, platformOf(), { local: resolveLocalPackages(env) });
    } catch (error) {
      return errorResponse(c, error);
    }
    return c.json({
      spec: parsed.spec,
      target: project.target,
      source: project.source,
      files: project.files,
      install: project.install.map((command) => command.label),
      start: project.start.label,
      envKeys: project.envKeys,
    });
  });

  app.get('/api/builder/projects', (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const projects = listProjects(env).map((project) => ({
      ...project,
      sessionKeys: sessionSecrets.names(project.dir),
    }));
    return c.json({ workflowsDir: resolveWorkflowsDir(env), projects, jobs: runner.list() });
  });

  app.post('/api/builder/projects', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    const parsed = parseSpec(body['spec']);
    if (!parsed.ok) return c.json({ error: 'invalid-spec', issues: parsed.issues }, 400);
    const dir = body['dir'];
    if (dir !== undefined && typeof dir !== 'string') return c.json({ error: 'bad-dir', message: 'dir must be a string' }, 400);
    const secrets = body['secrets'];
    if (secrets !== undefined && (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets))) {
      return c.json({ error: 'bad-env', message: 'secrets must be an object of NAME: value' }, 400);
    }
    // `persistSecrets: false` means the keys sent with Create are held in
    // memory for the run and never written next to the code.
    const persistSecrets = body['persistSecrets'] !== false;
    try {
      const result = createProject({
        spec: parsed.spec,
        dir: dir as string | undefined,
        secrets: persistSecrets ? (secrets as Record<string, unknown> | undefined) : undefined,
        overwrite: body['overwrite'] === true,
        env,
        local: resolveLocalPackages(env),
      });
      log(`builder: wrote ${result.files.length} files to ${result.dir}`);
      let sessionKeys: string[] = sessionSecrets.names(result.dir);
      if (!persistSecrets && secrets !== undefined) {
        sessionKeys = sessionSecrets.set(result.dir, secrets as Record<string, unknown>);
        log(`builder: ${sessionKeys.length} session key(s) held in memory for ${result.dir} (nothing written)`);
      }
      const project = requireProject(result.dir);
      return c.json(
        {
          dir: result.dir,
          files: result.files,
          envWritten: result.envWritten,
          sessionKeys,
          source: result.project.source,
          install: result.project.install.map((command) => command.label),
          start: result.project.start.label,
          project: summarize(project),
        },
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/api/builder/projects/env', (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    try {
      const project = requireProject(c.req.query('dir'));
      return c.json({
        dir: project.dir,
        keys: envKeysPresent(join(project.dir, '.env')),
        sessionKeys: sessionSecrets.names(project.dir),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * `persist: false` is the no-trace path: the values stay in this process's
   * memory, go into the next run's environment, and are gone when the server
   * exits. Either way the response is names only.
   */
  app.post('/api/builder/projects/env', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    const secrets = body['secrets'];
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
      return c.json({ error: 'bad-env', message: 'secrets must be an object of NAME: value' }, 400);
    }
    const persist = body['persist'] !== false;
    try {
      const project = requireProject(body['dir']);
      if (!persist) {
        const names = sessionSecrets.set(project.dir, secrets as Record<string, unknown>);
        log(`builder: ${names.length} session key(s) held in memory for ${project.dir} (nothing written)`);
        return c.json({
          dir: project.dir,
          written: [],
          removed: [],
          keys: envKeysPresent(join(project.dir, '.env')),
          sessionKeys: names,
        });
      }
      const updates = validateEnvUpdates(secrets as Record<string, unknown>);
      const result = writeEnvFile(join(project.dir, '.env'), updates);
      log(`builder: updated .env in ${project.dir} (${result.written.length} set, ${result.removed.length} removed)`);
      return c.json({
        dir: project.dir,
        written: result.written,
        removed: result.removed,
        keys: envKeysPresent(join(project.dir, '.env')),
        sessionKeys: sessionSecrets.names(project.dir),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /** Drop the session-only keys for a project, now. */
  app.post('/api/builder/projects/env/forget', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    try {
      const project = requireProject(body['dir']);
      const forgotten = sessionSecrets.clear(project.dir);
      log(`builder: forgot ${forgotten.length} session key(s) for ${project.dir}`);
      return c.json({ dir: project.dir, forgotten, sessionKeys: sessionSecrets.names(project.dir) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * Test an MCP node before anything is generated. Spawns (stdio) or calls
   * (http) exactly what the canvas describes, under the viewer token, with
   * the MCP SDK's default environment; see mcp-probe.ts for the boundaries.
   * A bearer token sent here is used for this one connection and never kept.
   */
  app.post('/api/builder/mcp/probe', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    const parsed = McpServerSchema.safeParse(body['server']);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid-server',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
        },
        400,
      );
    }
    const bearer = body['bearer'];
    if (bearer !== undefined && (typeof bearer !== 'string' || bearer.length > 4096 || /[\r\n\0]/.test(bearer))) {
      return c.json({ error: 'bad-bearer', message: 'the bearer token must be a single-line string' }, 400);
    }
    const result = await probeMcpServer(parsed.data, { bearer: bearer === '' ? undefined : (bearer as string | undefined) });
    // Name and outcome only: never the URL (it may carry a query token), never a message.
    log(`builder: probed MCP server "${parsed.data.name}" (${parsed.data.transport}): ${result.ok ? `${result.tools.length} tools` : 'failed'}`);
    return c.json(result);
  });

  app.post('/api/builder/jobs', limit, async (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    try {
      const dir = body['dir'];
      if (typeof dir !== 'string') return c.json({ error: 'bad-dir', message: 'dir must be a string' }, 400);
      const job = runner.start(dir);
      return c.json({ job }, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/api/builder/jobs/:id', (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const id = c.req.param('id');
    const job = runner.get(id);
    if (job === undefined) return c.json({ error: 'not-found', message: 'no such job' }, 404);
    const rawAfter = c.req.query('after');
    const after = rawAfter === undefined || rawAfter === '' ? 0 : Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) {
      return c.json({ error: 'bad-request', message: 'after must be a non-negative integer' }, 400);
    }
    return c.json({ job, lines: runner.lines(id, after) });
  });

  app.post('/api/builder/jobs/:id/stop', (c) => {
    const refusal = requireAccess(c, verifier, strict);
    if (refusal !== undefined) return refusal;
    const id = c.req.param('id');
    if (runner.get(id) === undefined) return c.json({ error: 'not-found', message: 'no such job' }, 404);
    return c.json({ ok: runner.stop(id), job: runner.get(id) });
  });
}
