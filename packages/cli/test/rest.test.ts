/** REST endpoints, static serving, persistence across restarts, port errors. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { FakeApp, fetchJson, startTestServer, waitUntil, type TestServer } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const ts = await startTestServer(options);
  cleanups.push(() => ts.cleanup());
  return ts;
}

const runStarted = { app: 'rest-app', sdk: { name: 'ai', version: '7.0.0' } };

describe('REST API', () => {
  it('GET /health reports ok + version', async () => {
    const { port } = await boot();
    const { status, body } = await fetchJson(port, '/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe('graphmind-ai');
    expect(typeof body.version).toBe('string');
  });

  it('GET /api/runs lists runs with counts, status, source and live flag', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'rest-app' });
    app.send('run.started', 'run_x', runStarted);
    app.send('node.error', 'run_x', { nodeId: 'n1', error: { name: 'E', message: 'boom' } });
    app.send('run.finished', 'run_x', { status: 'error', error: { name: 'E', message: 'boom' } });
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs')).body.runs[0]?.status === 'error',
      'run_x finished',
    );

    const { body } = await fetchJson(port, '/api/runs');
    expect(body.runs).toHaveLength(1);
    const run = body.runs[0];
    expect(run).toMatchObject({
      id: 'run_x',
      app: 'rest-app',
      status: 'error',
      source: 'live',
      eventCount: 3,
      errorCount: 1,
      live: true,
      schemaVersion: 1,
    });
    expect(typeof run.startedAt).toBe('number');
    expect(typeof run.finishedAt).toBe('number');
    await app.close();
  });

  it('GET /api/runs/:id/events paginates with afterSeq/limit cursors', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port);
    app.send('run.started', 'run_p', runStarted);
    for (let i = 0; i < 4; i += 1) {
      app.send('node.token', 'run_p', { nodeId: 'n', deltas: [{ t: 'text', v: `${i}` }] });
    }
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs/run_p/events')).body.total === 5,
      'all events persisted',
    );

    const page1 = await fetchJson(port, '/api/runs/run_p/events?limit=2');
    expect(page1.body.total).toBe(5);
    expect(page1.body.events).toHaveLength(2);
    expect(page1.body.nextAfterSeq).toBe(page1.body.events[1].seq);

    const page2 = await fetchJson(
      port,
      `/api/runs/run_p/events?limit=2&afterSeq=${page1.body.nextAfterSeq}`,
    );
    expect(page2.body.events).toHaveLength(2);

    const page3 = await fetchJson(
      port,
      `/api/runs/run_p/events?limit=2&afterSeq=${page2.body.nextAfterSeq}`,
    );
    expect(page3.body.events).toHaveLength(1);
    expect(page3.body.nextAfterSeq).toBeNull();

    const seqs = [...page1.body.events, ...page2.body.events, ...page3.body.events].map(
      (e: { seq: number }) => e.seq,
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);
    await app.close();
  });

  it('404s for an unknown run and 400s for bad pagination params', async () => {
    const { port } = await boot();
    const missing = await fetchJson(port, '/api/runs/nope/events');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('not found');

    const app = await FakeApp.connect(port);
    app.send('run.started', 'run_q', runStarted);
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs')).body.runs.length === 1,
      'run_q persisted',
    );
    const bad = await fetchJson(port, '/api/runs/run_q/events?limit=banana');
    expect(bad.status).toBe(400);
    await app.close();
  });
});

describe('static viewer', () => {
  it('serves the built-in placeholder when viewer-dist is absent', async () => {
    const { port } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const text = await response.text();
    expect(text).toContain('GraphMind server is running');
    expect(text).toContain("isn't built");
  });

  it('serves files (and the SPA fallback) from viewer-dist when present', async () => {
    const ts = await startTestServer();
    cleanups.push(() => ts.cleanup());
    const viewerDist = join(ts.dir, 'viewer-dist');
    mkdirSync(join(viewerDist, 'assets'), { recursive: true });
    writeFileSync(join(viewerDist, 'index.html'), '<!doctype html><title>viewer</title>real viewer');
    writeFileSync(join(viewerDist, 'assets', 'app.js'), 'console.log("app")');
    writeFileSync(join(ts.dir, 'secret.txt'), 'do-not-serve');
    await ts.server.close();

    const ts2 = await startTestServer({ dbPath: ts.dbPath, viewerDist });
    cleanups.push(() => ts2.cleanup());

    const index = await fetch(`http://127.0.0.1:${ts2.port}/`);
    expect(await index.text()).toContain('real viewer');

    const asset = await fetch(`http://127.0.0.1:${ts2.port}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');

    // SPA fallback for route-like paths.
    const route = await fetch(`http://127.0.0.1:${ts2.port}/runs/run_123`);
    expect(await route.text()).toContain('real viewer');

    // Traversal out of viewer-dist is blocked.
    const sneaky = await fetch(`http://127.0.0.1:${ts2.port}/%2e%2e/secret.txt`);
    expect(sneaky.status).toBe(404);
  });
});

describe('lifecycle', () => {
  it('runs survive a server restart on the same database file', async () => {
    const ts = await boot();
    const app = await FakeApp.connect(ts.port, { app: 'persist-app' });
    app.send('run.started', 'run_s', { ...runStarted, app: 'persist-app' });
    app.send('run.finished', 'run_s', { status: 'ok' });
    await waitUntil(
      async () => (await fetchJson(ts.port, '/api/runs')).body.runs[0]?.status === 'ok',
      'run_s finished',
    );
    await app.close();
    await ts.server.close();

    const ts2 = await startTestServer({ dbPath: ts.dbPath });
    cleanups.push(() => ts2.cleanup());
    const { body } = await fetchJson(ts2.port, '/api/runs');
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: 'run_s',
      app: 'persist-app',
      status: 'ok',
      live: false,
      eventCount: 2,
    });
    const events = await fetchJson(ts2.port, '/api/runs/run_s/events');
    expect(events.body.events.map((e: { type: string }) => e.type)).toEqual([
      'run.started',
      'run.finished',
    ]);
  });

  it('rejects with a clear EADDRINUSE error suggesting --port', async () => {
    const ts = await boot();
    await expect(
      startServer({ port: ts.port, dbPath: join(ts.dir, 'other.db'), log: () => {} }),
    ).rejects.toThrow(/already in use.*--port/s);
  });
});
