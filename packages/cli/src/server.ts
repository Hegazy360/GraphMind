/**
 * The GraphMind server: HTTP (REST + static viewer) and two WebSocket
 * endpoints on one port.
 *
 *   WS  /ingest              instrumented apps (schema envelopes)
 *   WS  /ws/ui               viewers (see ui-protocol.ts)
 *   GET /health              liveness + version
 *   GET /api/runs            all runs (with counts + live flag)
 *   GET /api/runs/:id/events paginated events of one run
 *   POST /api/demo/start     replay the bundled demo run (in-process client)
 *   GET /*                   built viewer (or placeholder page)
 *
 * Local-first: binds 127.0.0.1 only, no auth. Never expose this port.
 *
 * "Bound to loopback" is not by itself access control in a browser: a
 * WebSocket upgrade is exempt from the same-origin policy, and DNS rebinding
 * turns a foreign origin into a same-origin one. Every HTTP request and every
 * upgrade therefore goes through origin-guard.ts, which requires a loopback
 * `Host` and either no `Origin` (non-browser clients) or this server's own.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { parsePauseOnError } from './debug-state.js';
import { startBundledDemoReplay, type DemoReplay } from './demo/replayer.js';
import { Hub, type LogFn } from './hub.js';
import { openBrowser } from './open-browser.js';
import { checkRequestHeaders, parseOriginPolicy, type Rejection } from './origin-guard.js';
import { DEFAULT_PORT, resolveDbPath, resolveViewerDist, type EnvLike } from './paths.js';
import { SqliteStorage } from './sqlite-storage.js';
import { serveViewer } from './static-site.js';
import { DEFAULT_RETENTION, MAX_FRAME_BYTES, type Storage, type StoredEvent } from './storage.js';
import type { WireEnvelope } from './ui-protocol.js';
import { VERSION } from './version.js';

export interface ServerOptions {
  /** Default 4747. Use 0 for an ephemeral port (tests). */
  port?: number;
  /** Default `GRAPHMIND_DB` or `~/.graphmind/graphmind.db`. */
  dbPath?: string;
  /** Storage override (tests). Beats `dbPath`. The server closes it. */
  storage?: Storage;
  /** Directory of the built viewer. Default `<package>/viewer-dist`. */
  viewerDist?: string;
  /** Open the viewer in the default browser once listening. Default false. */
  openBrowser?: boolean;
  /** Stale-socket ping interval. Default 30s. */
  pingIntervalMs?: number;
  /** Log sink. Default console.log. Pass a no-op in tests. */
  log?: LogFn;
  /** Environment override (tests). Default process.env. */
  env?: EnvLike;
  /**
   * Which errors the default breakpoint covers: `on` (default, every node),
   * `off` (start with no breakpoints), or a node kind (`tool`, `llm`, ...).
   * Beats `GRAPHMIND_PAUSE_ON_ERROR`.
   */
  pauseOnError?: string;
  /**
   * Grace period before a run whose app disconnected is reconciled to
   * `abandoned`. Default 15s (`GRAPHMIND_ABANDON_GRACE_MS`); 0 reconciles on
   * the next tick.
   */
  abandonGraceMs?: number;
}

export interface GraphMindServer {
  port: number;
  url: string;
  dbPath: string;
  storage: Storage;
  hub: Hub;
  /**
   * Resolves once startup retention has run (or been skipped). Retention is
   * deliberately scheduled *after* the port is bound, so a large backlog can
   * never delay a `graphmind serve` from answering; this handle exists so
   * tests (and embedders) can still await it.
   */
  retentionDone: Promise<void>;
  close(): Promise<void>;
}

const PAGE_LIMIT_DEFAULT = 1000;
const PAGE_LIMIT_MAX = 5000;

function toEnvelopeJson(event: StoredEvent, gm: number): WireEnvelope {
  return {
    gm,
    seq: event.seq,
    ts: event.ts,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
  };
}

function intQuery(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Answer a refused WebSocket handshake with a real 403 rather than dropping
 * the socket: `ws` surfaces "Unexpected server response: 403" to the caller,
 * and a developer who hit this by accident gets told how to allow their setup.
 */
function rejectUpgrade(socket: Duplex, rejection: Rejection): void {
  const body = `${rejection.message}\n`;
  try {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body,
    );
  } catch {
    // the peer may already be gone; destroying below is enough
  }
  socket.destroy();
}

export async function startServer(options: ServerOptions = {}): Promise<GraphMindServer> {
  const env = options.env ?? (process.env as EnvLike);
  const requestedPort = options.port ?? DEFAULT_PORT;
  const host = '127.0.0.1'; // local-first: never bind anything else
  const dbPath = options.storage instanceof SqliteStorage
    ? options.storage.path
    : resolveDbPath(options.dbPath, env);
  const viewerDist = resolveViewerDist(options.viewerDist, env);
  const log = options.log ?? ((message: string) => console.log(message));

  const storage = options.storage ?? new SqliteStorage(dbPath);

  /**
   * Keep the local database from growing without bound. Opt out with
   * GRAPHMIND_RETENTION=off; tune with GRAPHMIND_KEEP_RUNS / _KEEP_DAYS.
   *
   * Deleting rows is not the same as reclaiming disk: in WAL mode the deletes
   * land in the WAL and the freed pages stay in the file, so a prune that
   * actually removed something is followed by a vacuum.
   */
  const runStartupRetention = (): void => {
    if (options.storage !== undefined) return; // caller owns the storage
    if ((env['GRAPHMIND_RETENTION'] ?? '').toLowerCase() === 'off') return;
    try {
      const keepRuns = Number(env['GRAPHMIND_KEEP_RUNS'] ?? DEFAULT_RETENTION.keepRuns);
      const keepDays = Number(env['GRAPHMIND_KEEP_DAYS'] ?? DEFAULT_RETENTION.keepDays);
      const pruned = storage.prune({
        keepRuns: Number.isFinite(keepRuns) ? keepRuns : DEFAULT_RETENTION.keepRuns,
        keepDays: Number.isFinite(keepDays) ? keepDays : DEFAULT_RETENTION.keepDays,
      });
      if (pruned.runsDeleted > 0) {
        log(`Pruned ${pruned.runsDeleted} old run(s), ${pruned.eventsDeleted} event(s).`);
        storage.vacuum();
      }
    } catch {
      // retention is housekeeping: never take the server down over it
    }
  };

  /**
   * Pause-on-error stays default-on (internal/decisions.md #8). This only
   * lets a user narrow or remove it without editing code — an explicit
   * `--pause-on-error` / `GRAPHMIND_PAUSE_ON_ERROR` value. A bad env value is
   * a warning + the default, because an unusable env var must not stop a
   * server from starting; a bad flag is rejected earlier, in args.ts.
   */
  const pauseOnError = parsePauseOnError(options.pauseOnError ?? env['GRAPHMIND_PAUSE_ON_ERROR']);
  if (!pauseOnError.ok) log(`graphmind: ${pauseOnError.error}; using the default`);
  const breakpoints = pauseOnError.ok ? pauseOnError.breakpoints : undefined;

  const rawGrace = env['GRAPHMIND_ABANDON_GRACE_MS'];
  // `Number('')` is 0, so an empty variable must not read as "no grace".
  const envGrace =
    rawGrace === undefined || rawGrace.trim() === '' ? Number.NaN : Number(rawGrace);
  const abandonGraceMs =
    options.abandonGraceMs ?? (Number.isFinite(envGrace) && envGrace >= 0 ? envGrace : undefined);

  const hub = new Hub(storage, log, {
    ...(breakpoints === undefined ? {} : { breakpoints }),
    ...(abandonGraceMs === undefined ? {} : { abandonGraceMs }),
  });
  const originPolicy = parseOriginPolicy(env);

  let boundPort = requestedPort; // reassigned once the listener is up

  const app = new Hono();
  /**
   * Access control, ahead of every route. A loopback bind is not a boundary
   * once a browser is involved (see origin-guard.ts) — this is.
   */
  app.use('*', async (c, next) => {
    const rejection = checkRequestHeaders(
      { origin: c.req.header('origin'), host: c.req.header('host') },
      boundPort,
      originPolicy,
    );
    if (rejection !== undefined) {
      log(`refused ${rejection.kind} "${rejection.value}" on ${c.req.path}`);
      return c.text(`${rejection.message}\n`, 403);
    }
    return next();
  });
  app.get('/health', (c) => c.json({ ok: true, name: 'graphmind-ai', version: VERSION }));
  app.get('/api/runs', (c) => c.json({ runs: hub.listRunInfos() }));
  app.get('/api/runs/:id/events', (c) => {
    const id = c.req.param('id');
    const run = hub.getRunInfo(id);
    if (run === undefined) return c.json({ error: 'run not found' }, 404);
    const afterSeq = intQuery(c.req.query('afterSeq'), -1);
    const rawLimit = intQuery(c.req.query('limit'), PAGE_LIMIT_DEFAULT);
    if (afterSeq === undefined || rawLimit === undefined || rawLimit < 1) {
      return c.json({ error: 'afterSeq and limit must be integers (limit >= 1)' }, 400);
    }
    const limit = Math.min(rawLimit, PAGE_LIMIT_MAX);
    const page = storage.listEvents(id, { afterSeq, limit });
    const events = page.events.map((event) => toEnvelopeJson(event, run.schemaVersion));
    const lastSeq = page.events.at(-1)?.seq;
    return c.json({
      runId: id,
      total: page.total,
      events,
      nextAfterSeq: page.hasMore && lastSeq !== undefined ? lastSeq : null,
    });
  });
  // The viewer's first-run card posts here: replay the bundled demo run
  // through this server's own ingest pipeline (the replayer is a normal
  // ingest client living in this process). One replay at a time.
  let activeDemo: DemoReplay | undefined;
  app.post('/api/demo/start', async (c) => {
    if (activeDemo !== undefined && !activeDemo.finished) {
      return c.json({ ok: true, runId: activeDemo.runId, alreadyRunning: true });
    }
    try {
      activeDemo = await startBundledDemoReplay({
        url: `ws://${host}:${boundPort}/ingest`,
        log,
      });
    } catch (error) {
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
    return c.json({ ok: true, runId: activeDemo.runId });
  });
  app.get('/*', (c) => serveViewer(c.req.url, viewerDist));

  let httpServer: HttpServer;
  try {
    httpServer = await new Promise<HttpServer>((resolve, reject) => {
      const server = serve(
        { fetch: app.fetch, hostname: host, port: requestedPort },
        () => resolve(server as HttpServer),
      ) as HttpServer;
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          error.message =
            `port ${requestedPort} is already in use — is another graphmind running? ` +
            `Pick a different port with --port (e.g. graphmind --port ${requestedPort + 1}).`;
        }
        reject(error);
      });
    });
  } catch (error) {
    if (options.storage === undefined) storage.close();
    throw error;
  }

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  boundPort = port;
  const url = `http://${host}:${port}`;

  // `ws` defaults to a 100 MiB frame ceiling. Nothing here can use a frame
  // that big: the storage budget is MAX_PAYLOAD_BYTES (512 KB), so everything
  // above it is discarded down to a preview anyway — but the frame is
  // buffered, decoded and parsed first, and one 64 MB frame took the server
  // from 95 MB RSS to ~500 MB permanently. 16 MiB is 32x the storage budget,
  // so every payload a developer could plausibly want a preview of still gets
  // through and degrades gracefully; past it the frame is refused during
  // assembly (close 1009) and the client reconnects and replays.
  const maxPayload = MAX_FRAME_BYTES;
  const ingestWss = new WebSocketServer({ noServer: true, maxPayload });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload });
  ingestWss.on('connection', (ws) => hub.addIngestSocket(ws));
  uiWss.on('connection', (ws) => hub.addUiSocket(ws));

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head) => {
    const pathname = new URL(request.url ?? '/', url).pathname;
    if (pathname !== '/ingest' && pathname !== '/ws/ui') {
      socket.destroy();
      return;
    }
    // The handshake is a plain HTTP request and the same-origin policy does
    // not cover it, so this is the only place a hostile page can be stopped.
    const rejection = checkRequestHeaders(
      { origin: request.headers.origin, host: request.headers.host },
      port,
      originPolicy,
    );
    if (rejection !== undefined) {
      log(`refused ${rejection.kind} "${rejection.value}" on ${pathname} (websocket upgrade)`);
      rejectUpgrade(socket, rejection);
      return;
    }
    if (pathname === '/ingest') {
      ingestWss.handleUpgrade(request, socket, head, (ws) =>
        ingestWss.emit('connection', ws, request),
      );
    } else {
      uiWss.handleUpgrade(request, socket, head, (ws) => uiWss.emit('connection', ws, request));
    }
  });

  const pingTimer = setInterval(() => hub.pingAll(), options.pingIntervalMs ?? 30_000);
  pingTimer.unref();

  if (options.openBrowser === true) openBrowser(url);

  let closed = false;

  // Retention runs AFTER the port is bound. Pruning (and vacuuming) a large
  // backlog is seconds of synchronous SQLite work; doing it before `listen`
  // is a startup stall the user reads as "graphmind is broken".
  let retentionTimer: NodeJS.Timeout | undefined;
  let settleRetention = (): void => {};
  const retentionDone = new Promise<void>((resolve) => {
    settleRetention = resolve;
  });
  retentionTimer = setTimeout(() => {
    retentionTimer = undefined;
    if (!closed) {
      // Order matters: reconciliation has to run BEFORE the prune. Retention
      // deliberately protects runs that are still streaming (`finishedAt IS
      // NULL`), which is exactly what a phantom row looks like — so an
      // unreconciled orphan is un-prunable as well as un-finishable.
      try {
        const orphans = hub.reconcileOrphanedRuns();
        if (orphans.length > 0) {
          log(
            `Reconciled ${orphans.length} run(s) left in flight by a previous session ` +
              `(marked abandoned).`,
          );
        }
      } catch {
        // housekeeping: never take the server down over it
      }
      runStartupRetention();
    }
    settleRetention();
  }, 0);
  retentionTimer.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (retentionTimer !== undefined) {
      clearTimeout(retentionTimer);
      retentionTimer = undefined;
      settleRetention(); // a closed server never prunes, but the handle settles
    }
    clearInterval(pingTimer);
    activeDemo?.stop();
    await hub.closeAll(500);
    // After closeAll: closing the ingest sockets arms one reconciliation
    // timer per open run, and a server going down is not the moment to
    // declare them abandoned — the next startup sweep does that honestly.
    hub.dispose();
    ingestWss.close();
    uiWss.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
    });
    storage.close(); // WAL checkpoint happens here
  };

  return { port, url, dbPath, storage, hub, retentionDone, close };
}
