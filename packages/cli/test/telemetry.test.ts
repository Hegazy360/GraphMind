/**
 * Unit tests for src/telemetry.ts against a local capture server
 * (GRAPHMIND_TELEMETRY_URL). GRAPHMIND_HOME points at a per-test tmp dir so
 * the real ~/.graphmind is never touched.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { recordTelemetry } from '../src/telemetry.js';
import { VERSION } from '../src/version.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TELEMETRY_TS = fileURLToPath(new URL('../src/telemetry.ts', import.meta.url));
const ENV_KEYS = ['GRAPHMIND_TELEMETRY', 'GRAPHMIND_TELEMETRY_URL', 'GRAPHMIND_HOME', 'CI'] as const;

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface CaptureServer {
  url: string;
  requests: CapturedRequest[];
  /** Resolves once at least `count` requests have arrived. */
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function startCaptureServer(): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter !== undefined && requests.length >= waiter.count) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
      res.statusCode = 204;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({
        url: `http://127.0.0.1:${address.port}/api/telemetry`,
        requests,
        waitFor(count, timeoutMs = 3000) {
          if (requests.length >= count) return Promise.resolve();
          return new Promise<void>((resolveWait, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`timed out waiting for ${count} request(s)`)),
              timeoutMs,
            );
            waiters.push({
              count,
              resolve: () => {
                clearTimeout(timer);
                resolveWait();
              },
            });
          });
        },
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let home: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key]; // CI in particular would disable telemetry
  }
  home = mkdtempSync(join(tmpdir(), 'graphmind-telemetry-'));
  process.env['GRAPHMIND_HOME'] = home;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test('fires a POST with { event, installId, version, ts } and persists the install id', async () => {
  const capture = await startCaptureServer();
  try {
    process.env['GRAPHMIND_TELEMETRY_URL'] = capture.url;
    recordTelemetry('serve');
    await capture.waitFor(1);

    const request = capture.requests[0];
    expect(request).toBeDefined();
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/telemetry');
    expect(request?.contentType).toBe('application/json');

    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['event', 'installId', 'ts', 'version']);
    expect(body['event']).toBe('serve');
    expect(body['version']).toBe(VERSION);
    expect(typeof body['installId']).toBe('string');
    expect(body['installId']).toMatch(UUID_RE);
    expect(Number.isNaN(Date.parse(String(body['ts'])))).toBe(false);

    const idFile = join(home, 'telemetry-id');
    expect(existsSync(idFile)).toBe(true);
    expect(readFileSync(idFile, 'utf8').trim()).toBe(body['installId']);
  } finally {
    await capture.close();
  }
});

test('reuses the same install id across events and respects a pre-existing id file', async () => {
  const capture = await startCaptureServer();
  try {
    const existing = 'c0ffee00-1234-4abc-8def-000000000042';
    writeFileSync(join(home, 'telemetry-id'), `${existing}\n`);
    process.env['GRAPHMIND_TELEMETRY_URL'] = capture.url;

    recordTelemetry('serve');
    recordTelemetry('demo');
    await capture.waitFor(2);

    const bodies = capture.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies.map((b) => b['event'])).toEqual(['serve', 'demo']);
    expect(bodies[0]?.['installId']).toBe(existing);
    expect(bodies[1]?.['installId']).toBe(existing);
    expect(readFileSync(join(home, 'telemetry-id'), 'utf8').trim()).toBe(existing);
  } finally {
    await capture.close();
  }
});

test.each([
  ['GRAPHMIND_TELEMETRY', '0'],
  ['GRAPHMIND_TELEMETRY', 'false'],
  ['CI', 'true'],
  ['CI', ''], // "set" at all counts — never collect from CI
])('disabled via %s=%j: no request and no id file', async (key, value) => {
  const capture = await startCaptureServer();
  try {
    process.env['GRAPHMIND_TELEMETRY_URL'] = capture.url;
    process.env[key] = value;
    recordTelemetry('serve');
    await sleep(150);
    expect(capture.requests).toHaveLength(0);
    expect(existsSync(join(home, 'telemetry-id'))).toBe(false);
  } finally {
    await capture.close();
  }
});

test('invalid event names are dropped without a request', async () => {
  const capture = await startCaptureServer();
  try {
    process.env['GRAPHMIND_TELEMETRY_URL'] = capture.url;
    for (const bad of ['', 'Serve', 'run_ingested', 'has space', 'a'.repeat(64), 'x{"j":1}']) {
      recordTelemetry(bad);
    }
    await sleep(150);
    expect(capture.requests).toHaveLength(0);
  } finally {
    await capture.close();
  }
});

test('server down: silent, no unhandled rejection, no throw', async () => {
  // Grab a port that is definitely closed by opening and closing a listener.
  const capture = await startCaptureServer();
  const deadUrl = capture.url;
  await capture.close();

  const failures: unknown[] = [];
  const onRejection = (reason: unknown) => failures.push(reason);
  const onException = (error: unknown) => failures.push(error);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  try {
    process.env['GRAPHMIND_TELEMETRY_URL'] = deadUrl;
    expect(() => recordTelemetry('serve')).not.toThrow();
    await sleep(300);
    expect(failures).toEqual([]);
    // The install id is still minted (identity is independent of delivery).
    expect(existsSync(join(home, 'telemetry-id'))).toBe(true);
  } finally {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  }
});

test('an unanswered request never holds the process open', async () => {
  // A TCP black hole: accepts connections, reads, never responds, never closes.
  const sockets: Socket[] = [];
  const blackHole: TcpServer = createTcpServer((socket) => {
    sockets.push(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', () => resolve()));
  const address = blackHole.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  const script = [
    `const { recordTelemetry } = await import(${JSON.stringify(TELEMETRY_TS)});`,
    "recordTelemetry('serve');",
  ].join('\n');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !ENV_KEYS.includes(key as (typeof ENV_KEYS)[number])) env[key] = value;
  }
  env['GRAPHMIND_TELEMETRY_URL'] = `http://127.0.0.1:${address.port}/api/telemetry`;
  env['GRAPHMIND_HOME'] = home;

  try {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    const elapsed = Date.now() - startedAt;

    expect(code, stderr).toBe(0);
    // Well under the 3s request timeout: the unref()ed socket lets the
    // process exit as soon as the event loop is otherwise empty.
    expect(elapsed).toBeLessThan(2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => blackHole.close(() => resolve()));
  }
});
