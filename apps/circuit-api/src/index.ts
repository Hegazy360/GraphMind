/**
 * Circuit control plane (v1). A Hono app factory over an Executor — the API
 * surface spec'd in docs/plans/hosted-workflow-platform.md §3.6, minus the
 * hosted-only parts (deployment bundles, MCP endpoint — M6+).
 *
 * Auth: optional static bearer keys for now (dev mode allows none). The
 * hosted service replaces this with hashed per-environment keys; the route
 * shapes are the contract that stays.
 *
 * Errors follow RFC 9457 (application/problem+json).
 */
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  checkDeploy,
  exportFixture,
  type Executor,
  InvalidResumeError,
  type JournalStore,
  WorkflowNotRegisteredError,
} from '@graphmind-ai/circuit-engine';
import {
  breakpointMatcher,
  jsonValue,
  resumeAction,
  runStatus,
  type JsonValue,
} from '@graphmind-ai/circuit-schema';
import type { AnyWorkflow } from '@graphmind-ai/circuit-sdk';

export interface ApiOptions {
  executor: Executor;
  store: JournalStore;
  /**
   * Registered definitions — a getter keeps /v1/workflows, the deploy check
   * and the dashboard current across dev-mode reloads.
   */
  workflows?: ReadonlyArray<AnyWorkflow> | (() => ReadonlyArray<AnyWorkflow>);
  /** Accepted bearer keys. Empty/omitted = open (local dev only). */
  apiKeys?: readonly string[];
  /** Kick the engine after writes so `circuit dev` feels immediate. */
  onWork?: () => void;
  /** Serve the web dashboard at `/` (default true). */
  dashboard?: boolean;
  /**
   * Dev-only conveniences (the hosted service never sets this). `scaffold`
   * appends a template workflow to the loaded workflows file and returns the
   * file path; the dev server's watcher then hot-reloads it.
   */
  devTools?: {
    scaffold: (name: string, template: string) => { file: string };
    templates: readonly string[];
  };
}

/** Dashboard assets: a dependency-free SPA shipped next to dist/ in ui/. */
const UI_FILES: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const UI_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const UI_DIR = new URL('../ui/', import.meta.url);

function describeWorkflow(def: AnyWorkflow) {
  let inputSchema: unknown = null;
  if (def.config.input) {
    try {
      inputSchema = z.toJSONSchema(def.config.input);
    } catch {
      inputSchema = null; // schemas with transforms etc. can't be expressed
    }
  }
  return {
    name: def.config.name,
    triggers: def.config.triggers,
    onError: def.config.onError,
    retries: def.config.retries,
    timeoutMs: def.config.timeoutMs,
    inputSchema,
  };
}

const enqueueBody = z.object({
  input: jsonValue.optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
});

const resumeBody = z.object({
  action: resumeAction,
  input: jsonValue.optional(),
  output: jsonValue.optional(),
  reason: z.string().max(2_000).optional(),
});

const forkBody = z.object({
  uptoSeq: z.number().int().min(0).optional(),
  substitute: z.object({ seq: z.number().int().min(0), output: jsonValue }).optional(),
});

const scaffoldBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'kebab-case, like my-workflow'),
  template: z.string().min(1).max(64),
});

const eventBody = z.object({
  name: z.string().min(1).max(256),
  data: jsonValue.optional(),
});

const approvalBody = z.object({
  approved: z.boolean(),
  by: z.string().min(1).max(256),
  comment: z.string().max(2_000).optional(),
});

function problem(status: number, title: string, detail?: string) {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail !== undefined ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function createApi(opts: ApiOptions): Hono {
  const { executor, store } = opts;
  const getWorkflows = (): ReadonlyArray<AnyWorkflow> =>
    typeof opts.workflows === 'function' ? opts.workflows() : (opts.workflows ?? []);
  const keys = new Set(opts.apiKeys ?? []);
  const kick = opts.onWork ?? (() => {});
  const app = new Hono();

  if (opts.dashboard !== false) {
    // Registered before auth: the page itself holds no data; every data call
    // it makes goes through /v1 and is authenticated there.
    for (const [route, file] of Object.entries(UI_FILES)) {
      app.get(route, async () => {
        const body = await readFile(new URL(file, UI_DIR), 'utf8');
        const ext = file.split('.').pop() ?? 'html';
        return new Response(body, {
          headers: {
            'content-type': UI_TYPES[ext] ?? 'text/plain',
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
          },
        });
      });
    }
  }

  app.use('/v1/*', async (c, next) => {
    if (keys.size > 0) {
      const header = c.req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!keys.has(token)) return problem(401, 'Unauthorized', 'missing or unknown API key');
    }
    // The acting identity for audit trails: the key's label or 'anonymous'.
    c.set('actor' as never, (c.req.header('x-circuit-actor') ?? 'api') as never);
    await next();
  });

  app.onError((err) => {
    if (err instanceof InvalidResumeError) return problem(409, 'Invalid resume', err.message);
    if (err instanceof WorkflowNotRegisteredError) return problem(404, 'Unknown workflow', err.message);
    if (err instanceof z.ZodError) return problem(400, 'Invalid request body', err.message);
    return problem(500, 'Internal error', err instanceof Error ? err.message : String(err));
  });

  app.get('/v1/health', (c) =>
    c.json({
      ok: true,
      service: 'circuit',
      auth: keys.size > 0,
      dev: opts.devTools !== undefined,
      ...(opts.devTools !== undefined ? { templates: opts.devTools.templates } : {}),
    }),
  );

  app.get('/v1/workflows', (c) => c.json({ workflows: getWorkflows().map(describeWorkflow) }));

  app.post('/v1/dev/scaffold', async (c) => {
    if (!opts.devTools) return problem(404, 'Not a dev server', 'scaffolding only exists in `circuit dev`');
    const body = scaffoldBody.parse(await c.req.json());
    if (getWorkflows().some((w) => w.config.name === body.name)) {
      return problem(409, 'Name taken', `a workflow named '${body.name}' already exists`);
    }
    const { file } = opts.devTools.scaffold(body.name, body.template);
    return c.json({ ok: true, file, workflow: body.name }, 201);
  });

  app.post('/v1/workflows/:name/runs', async (c) => {
    const body = enqueueBody.parse(await c.req.json().catch(() => ({})));
    const run = executor.enqueue(c.req.param('name'), (body.input ?? null) as JsonValue, {
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    kick();
    return c.json({ runId: run.id, status: run.status }, 202);
  });

  app.get('/v1/runs', (c) => {
    const status = c.req.query('status');
    const workflow = c.req.query('workflow');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500);
    const runs = executor.listRuns({
      ...(workflow !== undefined ? { workflow } : {}),
      ...(status !== undefined ? { status: runStatus.parse(status) } : {}),
      limit,
    });
    return c.json({ runs });
  });

  app.get('/v1/runs/:id', (c) => {
    const run = executor.getRun(c.req.param('id'));
    if (!run) return problem(404, 'Run not found');
    return c.json({ run, journal: executor.getJournal(run.id) });
  });

  app.get('/v1/runs/:id/fixture', (c) => {
    const run = executor.getRun(c.req.param('id'));
    if (!run) return problem(404, 'Run not found');
    return c.json(exportFixture(store, run.id));
  });

  app.post('/v1/runs/:id/entries/:seq/resume', async (c) => {
    const body = resumeBody.parse(await c.req.json());
    const run = executor.resume(c.req.param('id'), Number(c.req.param('seq')), body.action, {
      actor: c.req.header('x-circuit-actor') ?? 'api',
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.input !== undefined ? { input: body.input } : {}),
      ...(body.output !== undefined ? { output: body.output } : {}),
    });
    kick();
    return c.json({ run });
  });

  app.post('/v1/runs/:id/cancel', async (c) => {
    if (!executor.getRun(c.req.param('id'))) return problem(404, 'Run not found');
    const run = executor.cancel(c.req.param('id'), { actor: c.req.header('x-circuit-actor') ?? 'api' });
    return c.json({ run });
  });

  app.post('/v1/runs/:id/fork', async (c) => {
    const body = forkBody.parse(await c.req.json());
    const fork = executor.fork(c.req.param('id'), {
      actor: c.req.header('x-circuit-actor') ?? 'api',
      ...(body.uptoSeq !== undefined ? { uptoSeq: body.uptoSeq } : {}),
      ...(body.substitute !== undefined ? { substitute: body.substitute } : {}),
    });
    kick();
    return c.json({ runId: fork.id, forkedFrom: fork.forkedFrom }, 201);
  });

  app.post('/v1/runs/:id/approvals/:seq', async (c) => {
    const body = approvalBody.parse(await c.req.json());
    const run = executor.approve(c.req.param('id'), Number(c.req.param('seq')), {
      approved: body.approved,
      by: body.by,
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
    });
    kick();
    return c.json({ run });
  });

  app.post('/v1/events', async (c) => {
    const body = eventBody.parse(await c.req.json());
    const result = executor.publishEvent(body.name, (body.data ?? null) as JsonValue);
    kick();
    return c.json(result, 202);
  });

  app.post('/v1/breakpoints', async (c) => {
    const matcher = breakpointMatcher.parse(await c.req.json());
    executor.setBreakpoint(matcher);
    return c.json({ ok: true }, 201);
  });

  app.delete('/v1/breakpoints', (c) => {
    executor.clearBreakpoints();
    return c.json({ ok: true });
  });

  app.post('/v1/deploy-check', async (c) => {
    const report = await checkDeploy(getWorkflows(), store);
    return c.json(report, report.broken.length > 0 ? 409 : 200);
  });

  return app;
}

/**
 * Drive the executor on an interval — the dev-mode engine loop. The timer is
 * unref'd so it never keeps a process alive on its own.
 */
export function startEngineLoop(executor: Executor, intervalMs = 100): { stop: () => void; kick: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void executor
      .drain()
      // A drain error is an engine bug, never a workflow failure (those land
      // on the run). Surface it instead of looping silently.
      .catch((err) => console.error('[circuit] engine loop error:', err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    kick: tick,
  };
}
