/**
 * Orphaned-run reconciliation.
 *
 * An instrumented process that dies while holding a gate never sends
 * `run.finished`. Before this suite existed the run row stayed
 * `status: "running", finishedAt: null` forever: `/api/runs` accumulated
 * phantom in-flight rows (two sample apps still showed them hours later) and
 * retention refused to prune them, because "unfinished" runs are protected.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MessagePayloadMap } from '@graphmind-ai/schema';
import {
  FakeApp,
  FakeUI,
  fetchJson,
  startTestServer,
  waitUntil,
  type TestServer,
} from './helpers.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import type { UiServerMessage } from '../src/ui-protocol.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const runStarted: MessagePayloadMap['run.started'] = {
  app: 'orphan-app',
  sdk: { name: 'ai', version: '7.0.79' },
};

/** Grace period of 0: the disconnect is reconciled on the next tick. */
async function boot(env: Record<string, string> = {}): Promise<TestServer> {
  const ts = await startTestServer({
    abandonGraceMs: 0,
    env: { GRAPHMIND_RETENTION: 'off', ...env },
  });
  cleanups.push(() => ts.cleanup());
  return ts;
}

async function runRow(port: number, id: string): Promise<Record<string, unknown> | undefined> {
  const { body } = await fetchJson(port, '/api/runs');
  return (body.runs as Record<string, unknown>[]).find((r) => r['id'] === id);
}

describe('a run whose app dies mid-flight', () => {
  it('is reconciled to a terminal "abandoned" state instead of staying "running"', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'orphan-app' });
    app.send('run.started', 'run_orphan', runStarted);
    app.send('node.started', 'run_orphan', {
      nodeId: 'tool:charge',
      kind: 'tool',
      name: 'charge',
      instanceId: 'i1',
    });
    app.send('exec.paused', 'run_orphan', {
      pauseId: 'p1',
      nodeId: 'tool:charge',
      point: 'error',
    });
    await waitUntil(async () => (await runRow(port, 'run_orphan')) !== undefined, 'run visible');
    expect(await runRow(port, 'run_orphan')).toMatchObject({ status: 'running', finishedAt: null });

    // The process dies while holding the gate.
    await app.close();

    await waitUntil(
      async () => (await runRow(port, 'run_orphan'))?.['status'] === 'abandoned',
      'run reconciled to abandoned',
    );
    const run = await runRow(port, 'run_orphan');
    expect(run).toMatchObject({ status: 'abandoned', live: false });
    expect(typeof run?.['finishedAt']).toBe('number');
    // The last moment the run was known alive, not "whenever the server noticed".
    expect(run?.['finishedAt']).toBeLessThanOrEqual(Date.now());
  });

  it('pushes the reconciliation to run-list viewers', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.subscribe('*');
    await ui.next((m) => m.type === 'runs', 'runs snapshot');

    const app = await FakeApp.connect(port, { app: 'orphan-app' });
    app.send('run.started', 'run_push', runStarted);
    await ui.next(
      (m) => m.type === 'run.update' && m.run.id === 'run_push',
      'run.update for the new run',
    );
    await app.close();

    const update = (await ui.next(
      (m) => m.type === 'run.update' && m.run.id === 'run_push' && m.run.status === 'abandoned',
      'run.update carrying the abandoned status',
    )) as Extract<UiServerMessage, { type: 'run.update' }>;
    expect(update.run.live).toBe(false);
    expect(update.run.finishedAt).not.toBeNull();
    await ui.close();
  });

  it('never relabels a run that genuinely finished', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'orphan-app' });
    app.send('run.started', 'run_done', runStarted);
    app.send('run.finished', 'run_done', { status: 'ok' });
    await waitUntil(
      async () => (await runRow(port, 'run_done'))?.['status'] === 'ok',
      'run finished',
    );
    const finishedAt = (await runRow(port, 'run_done'))?.['finishedAt'];

    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await runRow(port, 'run_done')).toMatchObject({ status: 'ok', finishedAt });
  });

  it('lets a reconnecting app continue the same run (and re-reconciles it later)', async () => {
    const { port } = await boot();
    const first = await FakeApp.connect(port, { app: 'orphan-app' });
    first.send('run.started', 'run_span', runStarted);
    await waitUntil(async () => (await runRow(port, 'run_span')) !== undefined, 'run visible');
    await first.close();
    await waitUntil(
      async () => (await runRow(port, 'run_span'))?.['status'] === 'abandoned',
      'run reconciled after the first disconnect',
    );

    // Reattach: the client replays its buffer with the original seq numbers
    // (dedup keeps them out of storage) and then keeps streaming.
    const second = await FakeApp.connect(port, { app: 'orphan-app' });
    second.send('run.started', 'run_span', runStarted, 0); // replayed, deduped
    second.send('node.started', 'run_span', {
      nodeId: 'tool:x',
      kind: 'tool',
      name: 'x',
      instanceId: 'i2',
    });
    await waitUntil(
      async () => (await runRow(port, 'run_span'))?.['status'] === 'running',
      'run is live again after reattach',
    );
    expect(await runRow(port, 'run_span')).toMatchObject({
      status: 'running',
      finishedAt: null,
      live: true,
    });

    // ...and the phantom must not come back: a second death reconciles again.
    await second.close();
    await waitUntil(
      async () => (await runRow(port, 'run_span'))?.['status'] === 'abandoned',
      'run reconciled after the second disconnect',
    );
  });

  it('leaves a live run alone during the grace period', async () => {
    const ts = await startTestServer({ abandonGraceMs: 60_000 });
    cleanups.push(() => ts.cleanup());
    const app = await FakeApp.connect(ts.port, { app: 'orphan-app' });
    app.send('run.started', 'run_blip', runStarted);
    await waitUntil(async () => (await runRow(ts.port, 'run_blip')) !== undefined, 'run visible');
    await app.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Still inside the grace window: the row must not be terminal yet.
    expect(await runRow(ts.port, 'run_blip')).toMatchObject({
      status: 'running',
      finishedAt: null,
    });
  });
});

describe('runs left behind by a previous server process', () => {
  it('are reconciled at startup, not left phantom forever', async () => {
    const ts = await startTestServer({ abandonGraceMs: 60_000 });
    cleanups.push(() => ts.cleanup());
    const app = await FakeApp.connect(ts.port, { app: 'orphan-app' });
    app.send('run.started', 'run_prev', runStarted);
    app.send('node.started', 'run_prev', {
      nodeId: 'llm:step',
      kind: 'llm',
      name: 'step',
      instanceId: 'i1',
    });
    await waitUntil(
      async () => (await runRow(ts.port, 'run_prev')) !== undefined,
      'run visible',
    );
    // Kill the server while the run is still open (grace timer never fires).
    await ts.server.close();

    const storage = new SqliteStorage(ts.dbPath);
    const lastEventTs = storage.listEvents('run_prev').events.at(-1)?.ts;
    expect(storage.getRun('run_prev')).toMatchObject({ status: 'running', finishedAt: null });
    storage.close();

    const ts2 = await startTestServer({ dbPath: ts.dbPath });
    cleanups.push(() => ts2.cleanup());
    await ts2.server.retentionDone;
    const run = await runRow(ts2.port, 'run_prev');
    expect(run).toMatchObject({ status: 'abandoned', live: false });
    // finishedAt is the last moment the run was known alive.
    expect(run?.['finishedAt']).toBe(lastEventTs);
  });

  it('makes reconciled runs prunable (they no longer look like they are streaming)', async () => {
    const ts = await startTestServer({ abandonGraceMs: 60_000 });
    cleanups.push(() => ts.cleanup());
    const app = await FakeApp.connect(ts.port, { app: 'orphan-app' });
    app.send('run.started', 'run_stuck', runStarted);
    await waitUntil(async () => (await runRow(ts.port, 'run_stuck')) !== undefined, 'run visible');
    await ts.server.close();

    // Retention on, keeping zero runs but a wide day window — so the only
    // thing that could save this row is the "still streaming" guard
    // (`finished_at IS NULL` inside the window), which is exactly what an
    // unreconciled phantom trips. Reconciliation sets finishedAt, so it goes.
    const ts2 = await startTestServer({
      dbPath: ts.dbPath,
      env: { GRAPHMIND_RETENTION: 'on', GRAPHMIND_KEEP_RUNS: '0', GRAPHMIND_KEEP_DAYS: '30' },
    });
    cleanups.push(() => ts2.cleanup());
    await ts2.server.retentionDone;
    const { body } = await fetchJson(ts2.port, '/api/runs');
    expect(body.runs).toEqual([]);
  });
});

describe('GET /api/runs duration', () => {
  it('serves durationMs for finished runs and null while in flight', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'orphan-app' });
    app.send('run.started', 'run_dur', runStarted);
    await waitUntil(async () => (await runRow(port, 'run_dur')) !== undefined, 'run visible');
    expect(await runRow(port, 'run_dur')).toMatchObject({ durationMs: null });

    app.send('run.finished', 'run_dur', { status: 'ok' });
    await waitUntil(
      async () => (await runRow(port, 'run_dur'))?.['status'] === 'ok',
      'run finished',
    );
    const run = await runRow(port, 'run_dur');
    expect(typeof run?.['durationMs']).toBe('number');
    expect(run?.['durationMs']).toBe(
      (run?.['finishedAt'] as number) - (run?.['startedAt'] as number),
    );
    await app.close();
  });
});
