/**
 * The HTTP half of the control plane (Phase 7, contract C3), plus the
 * security headers every response carries.
 *
 *   GET  /api/session                               who a Bearer token is (401 if unknown)
 *   GET  /api/pauses[?runId=][&wait=<s>]            open pauses; `wait` long-polls for one
 *   GET  /api/runs/:runId/pauses/:pauseId           one pause with the held node's input
 *   POST /api/runs/:runId/pauses/:pauseId/resume    release it (Bearer, JSON, first writer wins)
 *
 * GETs have the same exposure as the rest of the read API (`/api/runs`): any
 * local process can read runs, as it always could. Everything that is not a
 * GET under `/api` needs a credential.
 *
 * The resume endpoint is shaped against cross-site request forgery even
 * though the origin guard already refuses browser origins: it is POST-only
 * (GET and friends are 405 — a top-level navigation carries no `Origin` and
 * must never mutate anything), it takes only `Content-Type: application/json`
 * (which a form cannot send), it reads the credential only from
 * `Authorization` (which a page cannot attach cross-site without a preflight
 * this server never answers), and it never sends a CORS header.
 */
import { ControlPayloadSchemas } from '@graphmind-ai/schema';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  bearerToken,
  resolveCredential,
  type CredentialResult,
  type CredentialVerifier,
} from './control-auth.js';
import { outcomeStatus, type Hub } from './hub.js';
import type { PauseInfo, ResumeOutcome } from './pause-registry.js';
import { MAX_FRAME_BYTES, type Storage, type StoredEvent } from './storage.js';
import { VERSION } from './version.js';

export const RESUME_PATH = '/api/runs/:runId/pauses/:pauseId/resume';
/** How long `POST …/resume` waits for the app's answer by default. */
export const DEFAULT_RESUME_WAIT_MS = 30_000;
/** Longest wait a caller may ask for, on either long-poll. */
export const MAX_WAIT_MS = 120_000;
/** Long-polls (resume waits and `GET /api/pauses?wait=`) in flight at once. */
export const MAX_CONCURRENT_WAITS = 16;
/**
 * Of those, the most a caller without a credential may hold. Reads need no
 * credential, so any local process — or a page's `<img>` (no Origin, a
 * loopback Host) — can park `GET /api/pauses?wait=`; it must never take the
 * slots an authenticated resume (or `graphmind wait`, which sends the agent
 * token) needs.
 */
export const MAX_TOKENLESS_WAITS = 8;

const FRAME_ANCESTORS = "frame-ancestors 'none'";

/**
 * Framing, sniffing and referrer headers for every response — HTML, API,
 * static assets, errors. `frame-ancestors 'none'` (and `X-Frame-Options` for
 * older browsers) stop a page from framing the viewer and tricking a click on
 * "Run edited"; `no-referrer` keeps a URL from leaking into another site's
 * logs; `no-store` keeps API answers (run data) out of any cache.
 */
export function applySecurityHeaders(headers: Headers, path: string): void {
  const existing = headers.get('content-security-policy');
  if (existing === null || existing.trim() === '') {
    headers.set('content-security-policy', FRAME_ANCESTORS);
  } else if (/(^|;)\s*frame-ancestors\b/i.test(existing)) {
    headers.set(
      'content-security-policy',
      existing.replace(/(^|;)(\s*)frame-ancestors\b[^;]*/i, `$1$2${FRAME_ANCESTORS}`),
    );
  } else {
    headers.set('content-security-policy', `${existing.replace(/;\s*$/, '')}; ${FRAME_ANCESTORS}`);
  }
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  if (path === '/api' || path.startsWith('/api/')) headers.set('cache-control', 'no-store');
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  try {
    applySecurityHeaders(c.res.headers, c.req.path);
  } catch {
    // Immutable headers (a Response we did not construct): copy, then set.
    c.res = new Response(c.res.body, c.res);
    applySecurityHeaders(c.res.headers, c.req.path);
  }
};

/** The raw header block for a hand-written response (a refused upgrade). */
export function securityHeaderLines(): string {
  return (
    `Content-Security-Policy: ${FRAME_ANCESTORS}\r\n` +
    'X-Frame-Options: DENY\r\n' +
    'Referrer-Policy: no-referrer\r\n' +
    'X-Content-Type-Options: nosniff\r\n' +
    'Cache-Control: no-store\r\n'
  );
}

/** `Authorization: Bearer` only — never `?token=`, never a cookie. */
export function credentialOf(c: Context, verifier: CredentialVerifier): CredentialResult {
  const bearer = bearerToken(c.req.header('authorization'));
  return resolveCredential(bearer === undefined ? [] : [bearer], verifier);
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return (value.split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The held node, as `graphmind wait` summarizes it. */
export interface PauseDetail extends Omit<PauseInfo, 'state'> {
  state: PauseInfo['state'] | 'closed';
  node: {
    kind?: string;
    name?: string;
    instanceId?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
  resumed?: { action: unknown; principal?: unknown; operator?: unknown; ts: number };
}

/**
 * Rebuild one pause from the stored run: the `exec.paused`, the latest
 * `node.started` of that node before it (the held execution — its input),
 * and any `node.error` / `node.finished` of that execution before the hold.
 */
export function describePause(
  events: readonly StoredEvent[],
  runId: string,
  pauseId: string,
  live: PauseInfo | undefined,
): PauseDetail | undefined {
  let paused: StoredEvent | undefined;
  for (const event of events) {
    if (event.type === 'exec.paused' && recordOf(event.payload)['pauseId'] === pauseId) paused = event;
  }
  if (paused === undefined) return undefined;
  const p = recordOf(paused.payload);
  const nodeId = typeof p['nodeId'] === 'string' ? p['nodeId'] : '';

  let started: StoredEvent | undefined;
  for (const event of events) {
    if (event.seq >= paused.seq) break;
    if (event.type === 'node.started' && event.nodeId === nodeId) started = event;
  }
  const s = recordOf(started?.payload);
  const instanceId = typeof s['instanceId'] === 'string' ? s['instanceId'] : undefined;
  const node: PauseDetail['node'] = {
    ...(typeof s['kind'] === 'string' ? { kind: s['kind'] } : {}),
    ...(typeof s['name'] === 'string' ? { name: s['name'] } : {}),
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(started !== undefined && Object.hasOwn(s, 'input') ? { input: s['input'] } : {}),
  };
  let resumed: PauseDetail['resumed'];
  for (const event of events) {
    const payload = recordOf(event.payload);
    if (started !== undefined && event.seq > started.seq && event.seq < paused.seq && event.nodeId === nodeId) {
      const sameInstance = instanceId === undefined || payload['instanceId'] === undefined || payload['instanceId'] === instanceId;
      if (sameInstance && event.type === 'node.error') node.error = payload['error'];
      if (sameInstance && event.type === 'node.finished' && Object.hasOwn(payload, 'output')) {
        node.output = payload['output'];
      }
    }
    if (event.seq > paused.seq && event.type === 'exec.resumed' && payload['pauseId'] === pauseId) {
      resumed = {
        action: payload['action'],
        ts: event.ts,
        ...(payload['principal'] === undefined ? {} : { principal: payload['principal'] }),
        ...(payload['operator'] === undefined ? {} : { operator: payload['operator'] }),
      };
    }
  }

  return {
    runId,
    pauseId,
    nodeId,
    point: p['point'] as PauseInfo['point'],
    since: paused.ts,
    ...(typeof p['reason'] === 'string' ? { reason: p['reason'] } : {}),
    ...(p['smart'] === undefined ? {} : { smart: p['smart'] }),
    ...(p['loop'] === undefined ? {} : { loop: p['loop'] }),
    ...(typeof p['editable'] === 'boolean' ? { editable: p['editable'] } : {}),
    ...(live?.app === undefined ? {} : { app: live.app }),
    state: live?.state ?? 'closed',
    node,
    ...(resumed === undefined ? {} : { resumed }),
  };
}

export interface ControlRoutes {
  /** Answer every open long-poll now (server shutdown). */
  closeWaits(): void;
}

/**
 * Register the control routes and the `/api` credential middleware. Must run
 * after the origin guard and before any other `/api` route, so a non-GET
 * route added later is covered by the middleware without anyone remembering.
 */
export function registerControlRoutes(
  app: Hono,
  deps: { hub: Hub; storage: Storage; verifier: CredentialVerifier },
): ControlRoutes {
  const { hub, storage, verifier } = deps;
  let activeWaits = 0;
  /** The part of `activeWaits` parked without a valid credential. */
  let tokenlessWaits = 0;
  const closers = new Set<() => void>();

  // Control paths answer only POST: a GET (a navigation, an <img>, a
  // prefetch) must never mutate, and there is no CORS preflight to answer.
  app.on(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], RESUME_PATH, (c) => {
    c.header('allow', 'POST');
    return c.json({ error: 'method-not-allowed', message: 'use POST with a JSON body' }, 405);
  });

  // Every non-GET /api route needs a credential. Registered here, before
  // the routes, so it also covers /api/demo/start and anything added later.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const credential = credentialOf(c, verifier);
    if (credential.kind !== 'ok') {
      c.header('www-authenticate', 'Bearer');
      return c.json(
        {
          error: 'unauthorized',
          message:
            credential.kind === 'none'
              ? 'this route needs "Authorization: Bearer <token>" (the agent token is in ' +
                '$GRAPHMIND_HOME/run/serve-<port>.json; graphmind resume reads it for you)'
              : credential.message,
        },
        401,
      );
    }
    return next();
  });

  app.get('/api/session', (c) => {
    const credential = credentialOf(c, verifier);
    if (credential.kind === 'invalid') {
      c.header('www-authenticate', 'Bearer');
      return c.json({ error: 'unauthorized', message: credential.message }, 401);
    }
    return c.json({
      principal: credential.kind === 'ok' ? credential.principal : 'anonymous',
      agentLevel: hub.control.agentLevel,
      editInput: hub.control.editInput,
      hubCapabilities: hub.hubCapabilities,
      version: VERSION,
    });
  });

  /** Is there a long-poll slot for this caller? */
  const slotFree = (authenticated: boolean): boolean =>
    activeWaits < MAX_CONCURRENT_WAITS && (authenticated || tokenlessWaits < MAX_TOKENLESS_WAITS);

  /**
   * Hold a request open until `subscribe`'s wake fires, the deadline passes,
   * the client goes away, or the server closes. False when no long-poll slot
   * is free for this caller (see MAX_TOKENLESS_WAITS).
   */
  const park = async (
    c: Context,
    waitMs: number,
    authenticated: boolean,
    subscribe: (wake: () => void) => () => void,
  ): Promise<boolean> => {
    if (!slotFree(authenticated)) return false;
    activeWaits += 1;
    if (!authenticated) tokenlessWaits += 1;
    try {
      await new Promise<void>((resolve) => {
        const signal = c.req.raw.signal;
        let done = false;
        let unsubscribe: () => void = () => {};
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          closers.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        closers.add(finish);
        signal.addEventListener('abort', finish);
        const off = subscribe(finish);
        if (done) off();
        else unsubscribe = off;
      });
    } finally {
      activeWaits -= 1;
      if (!authenticated) tokenlessWaits -= 1;
    }
    return true;
  };

  app.get('/api/pauses', async (c) => {
    const runIdRaw = c.req.query('runId');
    const runId = runIdRaw === undefined || runIdRaw === '' ? undefined : runIdRaw;
    const waitRaw = c.req.query('wait');
    let waitMs = 0;
    if (waitRaw !== undefined && waitRaw !== '') {
      const seconds = Number(waitRaw);
      if (!Number.isFinite(seconds) || seconds < 0) {
        return c.json({ error: 'bad-request', message: '"wait" must be a number of seconds >= 0' }, 400);
      }
      waitMs = Math.min(Math.round(seconds * 1000), MAX_WAIT_MS);
    }
    const runEnded = (): boolean => {
      if (runId === undefined) return false;
      const run = hub.getRunInfo(runId);
      return run !== undefined && run.status !== 'running';
    };
    let timedOut = false;
    if (waitMs > 0 && !hub.registry.hasOpen(runId) && !runEnded()) {
      const ready = (): boolean => hub.registry.hasOpen(runId) || runEnded();
      const authenticated = credentialOf(c, verifier).kind === 'ok';
      const parked = await park(c, waitMs, authenticated, (wake) =>
        hub.registry.onChange(() => {
          if (ready()) wake();
        }),
      );
      if (!parked) {
        return c.json(
          { error: 'too-many-requests', message: `at most ${MAX_CONCURRENT_WAITS} long-polls at once` },
          429,
        );
      }
      timedOut = !hub.registry.hasOpen(runId) && !runEnded();
    }
    const run = runId === undefined ? undefined : hub.getRunInfo(runId);
    return c.json({
      pauses: hub.listPauses(runId),
      ...(runId === undefined
        ? {}
        : { run: run === undefined ? null : { id: run.id, status: run.status, live: run.live } }),
      ...(timedOut ? { timedOut: true } : {}),
    });
  });

  app.get('/api/runs/:runId/pauses/:pauseId', (c) => {
    const runId = c.req.param('runId');
    const pauseId = c.req.param('pauseId');
    if (storage.getRun(runId) === undefined) {
      return c.json({ error: 'no-such-run', message: `run "${runId}" not found` }, 404);
    }
    const detail = describePause(
      storage.listEvents(runId).events,
      runId,
      pauseId,
      hub.registry.get(runId, pauseId),
    );
    if (detail === undefined) {
      return c.json({ error: 'no-such-pause', message: `pause "${pauseId}" not found in run "${runId}"` }, 404);
    }
    return c.json({ pause: detail });
  });

  app.post(
    RESUME_PATH,
    bodyLimit({
      maxSize: MAX_FRAME_BYTES,
      onError: (c) => c.json({ error: 'too-large', message: 'request body too large' }, 413),
    }),
    async (c) => {
      const credential = credentialOf(c, verifier);
      if (credential.kind !== 'ok') {
        // Unreachable behind the middleware; kept so this handler is safe alone.
        return c.json({ error: 'unauthorized', message: 'missing or unknown token' }, 401);
      }
      if (!isJsonContentType(c.req.header('content-type'))) {
        return c.json(
          { error: 'unsupported-media-type', message: 'Content-Type must be application/json' },
          415,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'bad-request', message: 'body is not valid JSON' }, 400);
      }
      if (!isRecord(body)) {
        return c.json({ error: 'bad-request', message: 'body must be a JSON object' }, 400);
      }
      const runId = c.req.param('runId');
      const pauseId = c.req.param('pauseId');
      let waitMs = DEFAULT_RESUME_WAIT_MS;
      if (body['timeoutMs'] !== undefined) {
        const n = body['timeoutMs'];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1_000 || n > MAX_WAIT_MS) {
          return c.json(
            { error: 'bad-request', message: `"timeoutMs" must be an integer from 1000 to ${MAX_WAIT_MS}` },
            400,
          );
        }
        waitMs = n;
      }
      const { timeoutMs: _drop, ...rest } = body;
      const parsed = ControlPayloadSchemas['exec.resume'].safeParse({ ...rest, pauseId });
      if (!parsed.success) {
        return c.json(
          {
            error: 'bad-request',
            message: '"action" must be one of continue, retry, inject, abort (and "requestId", if given, a string)',
          },
          400,
        );
      }
      // Take a slot BEFORE forwarding: a refused request must have no effect.
      if (!slotFree(true)) {
        return c.json(
          { error: 'too-many-requests', message: `at most ${MAX_CONCURRENT_WAITS} long-polls at once` },
          429,
        );
      }
      const start = hub.requestResume(runId, parsed.data, credential.principal, waitMs);
      if (start.kind === 'answered') {
        return c.json(start.outcome, outcomeStatus(start.outcome) as ContentfulStatusCode);
      }
      let outcome: ResumeOutcome | undefined;
      // The registry settles the request by `waitMs` at the latest (as a
      // `timeout` with its own message); the park's deadline is a backstop.
      await park(c, waitMs + 1_000, true, (wake) =>
        hub.registry.whenAnswered(
          start.requestId,
          (answer) => {
            outcome = answer;
            wake();
          },
          waitMs,
        ),
      );
      const answer: ResumeOutcome = outcome ?? {
        outcome: 'timeout',
        runId,
        pauseId,
        requestId: start.requestId,
        code: 'no-answer',
        message: 'no answer from the app',
      };
      return c.json(answer, outcomeStatus(answer) as ContentfulStatusCode);
    },
  );

  return {
    closeWaits() {
      for (const close of [...closers]) close();
    },
  };
}
