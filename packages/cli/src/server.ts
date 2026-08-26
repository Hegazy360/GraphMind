/**
 * The GraphMind server: HTTP (REST + static viewer) and two WebSocket
 * endpoints on one port.
 *
 *   WS  /ingest              instrumented apps (schema envelopes)
 *   WS  /ws/ui               viewers (see ui-protocol.ts)
 *   GET /health              liveness + version
 *   GET /api/runs            all runs (with counts + live flag)
 *   GET /api/runs/:id/events paginated events of one run
 *   GET /*                   built viewer (or placeholder page)
 *
 * Local-first: binds 127.0.0.1 only, no auth. Never expose this port.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { Hub, type LogFn } from './hub.js';
import { openBrowser } from './open-browser.js';
import { DEFAULT_PORT, resolveDbPath, resolveViewerDist, type EnvLike } from './paths.js';
import { SqliteStorage } from './sqlite-storage.js';
import { serveViewer } from './static-site.js';
import type { Storage, StoredEvent } from './storage.js';
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
}

export interface GraphMindServer {
  port: number;
  url: string;
  dbPath: string;
  storage: Storage;
  hub: Hub;
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
  const hub = new Hub(storage, log);

  const app = new Hono();
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
  const url = `http://${host}:${port}`;

  const ingestWss = new WebSocketServer({ noServer: true });
  const uiWss = new WebSocketServer({ noServer: true });
  ingestWss.on('connection', (ws) => hub.addIngestSocket(ws));
  uiWss.on('connection', (ws) => hub.addUiSocket(ws));

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', url).pathname;
    if (pathname === '/ingest') {
      ingestWss.handleUpgrade(request, socket, head, (ws) =>
        ingestWss.emit('connection', ws, request),
      );
    } else if (pathname === '/ws/ui') {
      uiWss.handleUpgrade(request, socket, head, (ws) => uiWss.emit('connection', ws, request));
    } else {
      socket.destroy();
    }
  });

  const pingTimer = setInterval(() => hub.pingAll(), options.pingIntervalMs ?? 30_000);
  pingTimer.unref();

  if (options.openBrowser === true) openBrowser(url);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    await hub.closeAll(500);
    ingestWss.close();
    uiWss.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
    });
    storage.close(); // WAL checkpoint happens here
  };

  return { port, url, dbPath, storage, hub, close };
}
