/**
 * The soak server, in its own OS process.
 *
 * Out-of-process on purpose: "memory of the server process over time" is only
 * a meaningful number when the driver's own allocations are somewhere else.
 * This is the real `startServer()` from graphmind-ai on an ephemeral port with
 * a throwaway SQLite file — the same code path `graphmind serve` runs.
 *
 * Protocol with the parent is plain node IPC; see server-handle.ts.
 */
import { statSync } from 'node:fs';
import { startServer, type GraphMindServer } from 'graphmind-ai';

interface ChildOptions {
  dbPath: string;
  pingIntervalMs: number;
  memIntervalMs: number;
  retention: 'off' | 'on';
}

const options = JSON.parse(process.argv[2] ?? '{}') as ChildOptions;

const send = (message: unknown): void => {
  process.send?.(message);
};

const logs: string[] = [];

let server: GraphMindServer;
try {
  server = await startServer({
    port: 0,
    dbPath: options.dbPath,
    pingIntervalMs: options.pingIntervalMs,
    // A directory that does not exist: the viewer placeholder page is served
    // instead of a 40MB bundle, which keeps the RSS trace about the server.
    viewerDist: `${options.dbPath}-no-viewer`,
    log: (line: string) => {
      logs.push(line);
      if (logs.length > 500) logs.shift();
      send({ t: 'log', line });
    },
    env: {
      GRAPHMIND_TELEMETRY: '0',
      GRAPHMIND_RETENTION: options.retention === 'off' ? 'off' : 'on',
    },
  });
} catch (error) {
  send({ t: 'fatal', error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
}

function dbBytes(): { db: number; wal: number; shm: number; total: number } {
  const size = (path: string): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  const db = size(server.dbPath);
  const wal = size(`${server.dbPath}-wal`);
  const shm = size(`${server.dbPath}-shm`);
  return { db, wal, shm, total: db + wal + shm };
}

const memTimer = setInterval(() => {
  const usage = process.memoryUsage();
  send({
    t: 'mem',
    at: Date.now(),
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  });
}, options.memIntervalMs);
memTimer.unref();

process.on('message', (raw: unknown) => {
  const message = raw as { t: string; id?: number; [key: string]: unknown };
  const reply = (body: Record<string, unknown>): void => send({ t: 'reply', id: message.id, ...body });
  switch (message.t) {
    case 'mem': {
      const usage = process.memoryUsage();
      reply({ rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external });
      return;
    }
    case 'gc': {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (gc === undefined) {
        reply({ ok: false, error: 'no --expose-gc' });
        return;
      }
      gc();
      gc();
      const usage = process.memoryUsage();
      reply({ ok: true, rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external });
      return;
    }
    case 'db': {
      reply(dbBytes());
      return;
    }
    case 'prune': {
      const started = performance.now();
      try {
        const result = server.storage.prune({
          keepRuns: message['keepRuns'] as number | undefined,
          keepDays: message['keepDays'] as number | undefined,
        });
        reply({ ok: true, ...result, ms: performance.now() - started, ...dbBytes() });
      } catch (error) {
        reply({ ok: false, error: String(error) });
      }
      return;
    }
    case 'vacuum': {
      const started = performance.now();
      server.storage.vacuum();
      reply({ ok: true, ms: performance.now() - started, ...dbBytes() });
      return;
    }
    case 'runs': {
      const started = performance.now();
      const runs = server.hub.listRunInfos();
      reply({ ok: true, ms: performance.now() - started, count: runs.length });
      return;
    }
    case 'close': {
      clearInterval(memTimer);
      void server.close().then(
        () => {
          reply({ ok: true, ...dbBytes() });
          setTimeout(() => process.exit(0), 50);
        },
        (error: unknown) => {
          reply({ ok: false, error: String(error) });
          setTimeout(() => process.exit(1), 50);
        },
      );
      return;
    }
    default:
      reply({ ok: false, error: `unknown message ${message.t}` });
  }
});

send({ t: 'ready', port: server.port, url: server.url, dbPath: server.dbPath, pid: process.pid });
