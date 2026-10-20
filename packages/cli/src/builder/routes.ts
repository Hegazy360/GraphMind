/**
 * The builder's HTTP surface, under `/api/builder`. Every route — GET
 * included — needs the VIEWER token: this is the only part of the API that
 * writes files and starts processes, and reading it reveals what is on the
 * engineer's disk, so a tokenless tab (or another local process) gets 403.
 * The agent token is refused too; a coding agent has `graphmind init`.
 *
 *   GET  /api/builder/targets              targets, the default spec, where projects go
 *   POST /api/builder/preview              {spec} -> the files Create would write
 *   GET  /api/builder/projects             projects the builder made (names, never values)
 *   POST /api/builder/projects             {spec, dir?, secrets?, overwrite?} -> write it
 *   GET  /api/builder/projects/env?dir=    which variables .env sets (names only)
 *   POST /api/builder/projects/env         {dir, secrets} -> merge into .env
 *   POST /api/builder/jobs                 {dir} -> install (once) and run
 *   GET  /api/builder/jobs/:id?after=n     job state + log lines from n
 *   POST /api/builder/jobs/:id/stop
 *
 * No response carries a secret value: `secrets` is consumed by env-file.ts
 * and only the NAMES come back; job logs are scrubbed before they are kept.
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
import { TARGETS, defaultSpec, parseSpec } from './spec.js';
import { join } from 'node:path';

/** A spec plus a project is a few KB; this is generous, not a frame budget. */
const MAX_BODY_BYTES = 512 * 1024;

export interface BuilderRouteDeps {
  verifier: CredentialVerifier;
  runner: ProjectRunner;
  env: EnvLike;
  log: LogFn;
}

function forbidden(c: Context, message: string) {
  return c.json({ error: 'forbidden', message }, 403);
}

/** Viewer token or nothing. */
function requireViewer(c: Context, verifier: CredentialVerifier): Response | undefined {
  const credential = credentialOf(c, verifier);
  if (credential.kind === 'none') {
    c.header('www-authenticate', 'Bearer');
    return c.json(
      {
        error: 'unauthorized',
        message:
          'the builder needs the viewer token: open the viewer from the link `graphmind serve` printed (or its redirect file)',
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
  const { verifier, runner, env, log } = deps;
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'too-large', message: 'request body too large' }, 413),
  });

  app.get('/api/builder/targets', (c) => {
    const refusal = requireViewer(c, verifier);
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
    const refusal = requireViewer(c, verifier);
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
    const refusal = requireViewer(c, verifier);
    if (refusal !== undefined) return refusal;
    return c.json({ workflowsDir: resolveWorkflowsDir(env), projects: listProjects(env), jobs: runner.list() });
  });

  app.post('/api/builder/projects', limit, async (c) => {
    const refusal = requireViewer(c, verifier);
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
    try {
      const result = createProject({
        spec: parsed.spec,
        dir: dir as string | undefined,
        secrets: secrets as Record<string, unknown> | undefined,
        overwrite: body['overwrite'] === true,
        env,
        local: resolveLocalPackages(env),
      });
      log(`builder: wrote ${result.files.length} files to ${result.dir}`);
      const project = requireProject(result.dir);
      return c.json(
        {
          dir: result.dir,
          files: result.files,
          envWritten: result.envWritten,
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
    const refusal = requireViewer(c, verifier);
    if (refusal !== undefined) return refusal;
    try {
      const project = requireProject(c.req.query('dir'));
      return c.json({ dir: project.dir, keys: envKeysPresent(join(project.dir, '.env')) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/builder/projects/env', limit, async (c) => {
    const refusal = requireViewer(c, verifier);
    if (refusal !== undefined) return refusal;
    const body = await jsonBody(c);
    if (body === undefined) return c.json({ error: 'bad-request', message: 'send a JSON object' }, 400);
    const secrets = body['secrets'];
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
      return c.json({ error: 'bad-env', message: 'secrets must be an object of NAME: value' }, 400);
    }
    try {
      const project = requireProject(body['dir']);
      const updates = validateEnvUpdates(secrets as Record<string, unknown>);
      const result = writeEnvFile(join(project.dir, '.env'), updates);
      log(`builder: updated .env in ${project.dir} (${result.written.length} set, ${result.removed.length} removed)`);
      return c.json({ dir: project.dir, written: result.written, removed: result.removed, keys: envKeysPresent(join(project.dir, '.env')) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/builder/jobs', limit, async (c) => {
    const refusal = requireViewer(c, verifier);
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
    const refusal = requireViewer(c, verifier);
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
    const refusal = requireViewer(c, verifier);
    if (refusal !== undefined) return refusal;
    const id = c.req.param('id');
    if (runner.get(id) === undefined) return c.json({ error: 'not-found', message: 'no such job' }, 404);
    return c.json({ ok: runner.stop(id), job: runner.get(id) });
  });
}
