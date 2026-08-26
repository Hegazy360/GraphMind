/** End-to-end server behavior over real sockets on an ephemeral port. */
import { afterEach, describe, expect, it } from 'vitest';
import type { MessagePayloadMap } from '@graphmind/schema';
import { FakeApp, FakeUI, fetchJson, startTestServer, waitUntil, type TestServer } from './helpers.js';
import type { UiServerMessage, WireEnvelope } from '../src/ui-protocol.js';

let ts: TestServer;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(): Promise<TestServer> {
  ts = await startTestServer();
  cleanups.push(() => ts.cleanup());
  return ts;
}

const runStarted: MessagePayloadMap['run.started'] = {
  app: 'demo-app',
  sdk: { name: 'ai', version: '7.0.79' },
};

function isEvent(m: UiServerMessage): m is Extract<UiServerMessage, { type: 'event' }> {
  return m.type === 'event';
}

describe('handshake', () => {
  it('answers hello with hello.ack carrying current breakpoints and mode', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'demo-app' });
    expect(app.ack).toBeDefined();
    expect(app.ack?.versions.protocol).toBe(1);
    expect(app.ack?.breakpoints).toEqual([]);
    expect(app.ack?.mode).toBe('run');
    expect(app.ack?.capabilities).toEqual(['pause', 'step']);
    await app.close();
  });

  it('arms breakpoints and mode set before the app connects (via hello.ack)', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.control('breakpoint.set', '*', { matcher: { kind: 'tool', name: 'searchFlights' } });
    await ui.next((m) => m.type === 'state', 'state after breakpoint.set');
    ui.control('mode.set', '*', { mode: 'step' });
    await ui.next((m) => m.type === 'state' && m.mode === 'step', 'state after mode.set');

    const app = await FakeApp.connect(port);
    expect(app.ack?.breakpoints).toEqual([{ kind: 'tool', name: 'searchFlights' }]);
    expect(app.ack?.mode).toBe('step');
    await app.close();
    await ui.close();
  });

  it('ignores event envelopes sent before hello', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { handshake: false });
    app.send('run.started', 'run_pre', runStarted);
    // Now handshake properly; the pre-hello event must not have been stored.
    app.send('hello', '*', {
      versions: { protocol: 1, client: 'test' },
      capabilities: [],
    });
    await app.received.next((e) => e.type === 'hello.ack', 3000, 'hello.ack');
    const runs = await fetchJson(port, '/api/runs');
    expect(runs.body.runs).toEqual([]);
    await app.close();
  });
});

describe('ingest -> persist -> fanout', () => {
  it('fans live events out to subscribed viewers in order and persists them', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.subscribe('run_1');
    await ui.next((m) => m.type === 'replay.end', 'empty replay end');

    const app = await FakeApp.connect(port, { app: 'demo-app' });
    const s1 = app.send('run.started', 'run_1', runStarted);
    const s2 = app.send('node.started', 'run_1', {
      nodeId: 'tool:search',
      kind: 'tool',
      name: 'search',
      instanceId: 'call_1',
      input: { q: 'x' },
    });
    const s3 = app.send('node.finished', 'run_1', {
      nodeId: 'tool:search',
      output: { hits: 3 },
      durationMs: 12,
      status: 'ok',
    });

    const received: WireEnvelope[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await ui.next(isEvent, `live event ${i}`);
      if (isEvent(m)) received.push(m.envelope);
    }
    expect(received.map((e) => e.type)).toEqual(['run.started', 'node.started', 'node.finished']);
    expect(received.map((e) => e.seq)).toEqual([s1, s2, s3]);

    const events = await fetchJson(port, '/api/runs/run_1/events');
    expect(events.body.events.map((e: WireEnvelope) => e.seq)).toEqual([s1, s2, s3]);
    await app.close();
    await ui.close();
  });

  it('persists unknown event types opaquely and fans them out', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.subscribe('run_u');
    await ui.next((m) => m.type === 'replay.end', 'replay end');

    const app = await FakeApp.connect(port);
    app.sendRaw({
      gm: 1,
      seq: 7,
      ts: 1234,
      runId: 'run_u',
      type: 'wormhole.opened',
      payload: { intensity: 11, nodeId: 'warp:core' },
    });

    const m = await ui.next(isEvent, 'unknown-type event');
    if (isEvent(m)) {
      expect(m.envelope.type).toBe('wormhole.opened');
      expect(m.envelope.payload).toEqual({ intensity: 11, nodeId: 'warp:core' });
    }
    const events = await fetchJson(port, '/api/runs/run_u/events');
    expect(events.body.events).toEqual([
      {
        gm: 1,
        seq: 7,
        ts: 1234,
        runId: 'run_u',
        type: 'wormhole.opened',
        payload: { intensity: 11, nodeId: 'warp:core' },
      },
    ]);
    await app.close();
    await ui.close();
  });

  it('dedupes re-sent envelopes on (runId, seq): replay after reconnect', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.subscribe('run_d');
    await ui.next((m) => m.type === 'replay.end', 'replay end');

    const app = await FakeApp.connect(port);
    app.send('run.started', 'run_d', runStarted, 0);
    app.send('node.started', 'run_d', {
      nodeId: 'llm:step',
      kind: 'llm',
      name: 'step',
      instanceId: 'i1',
      input: null,
    }, 1);
    // Consume both live events so anything left in the queue is a duplicate.
    await ui.next((m) => isEvent(m) && m.envelope.seq === 0, 'first copy of seq 0');
    await ui.next((m) => isEvent(m) && m.envelope.seq === 1, 'first copy of seq 1');
    await app.close();

    // Reconnect and replay the buffer with ORIGINAL seqs, plus one new event.
    const app2 = await FakeApp.connect(port);
    app2.send('run.started', 'run_d', runStarted, 0);
    app2.send('node.started', 'run_d', {
      nodeId: 'llm:step',
      kind: 'llm',
      name: 'step',
      instanceId: 'i1',
      input: null,
    }, 1);
    app2.send('node.finished', 'run_d', {
      nodeId: 'llm:step',
      output: 'done',
      durationMs: 5,
      status: 'ok',
    }, 2);

    // The viewer must see the NEW event next — not duplicates of 0/1.
    const m = await ui.next(isEvent, 'post-replay event');
    if (isEvent(m)) expect(m.envelope.seq).toBe(2);

    const events = await fetchJson(port, '/api/runs/run_d/events');
    expect(events.body.events.map((e: WireEnvelope) => e.seq)).toEqual([0, 1, 2]);
    expect(events.body.total).toBe(3);
    await app2.close();
    await ui.close();
  });

  it('keeps two concurrent runs isolated', async () => {
    const { port } = await boot();
    const uiA = await FakeUI.connect(port);
    const uiB = await FakeUI.connect(port);
    uiA.subscribe('run_A');
    uiB.subscribe('run_B');
    await uiA.next((m) => m.type === 'replay.end', 'A replay end');
    await uiB.next((m) => m.type === 'replay.end', 'B replay end');

    const appA = await FakeApp.connect(port, { app: 'app-A' });
    const appB = await FakeApp.connect(port, { app: 'app-B' });
    appA.send('run.started', 'run_A', { ...runStarted, app: 'app-A' });
    appB.send('run.started', 'run_B', { ...runStarted, app: 'app-B' });
    appA.send('node.error', 'run_A', {
      nodeId: 'tool:x',
      error: { name: 'Boom', message: 'kaput' },
    });

    const a1 = await uiA.next(isEvent, 'A event 1');
    const a2 = await uiA.next(isEvent, 'A event 2');
    const b1 = await uiB.next(isEvent, 'B event 1');
    expect([a1, a2].every((m) => isEvent(m) && m.runId === 'run_A')).toBe(true);
    expect(isEvent(b1) && b1.runId === 'run_B').toBe(true);
    expect(uiB.received.peekAll().filter(isEvent)).toEqual([]);

    const runs = await fetchJson(port, '/api/runs');
    const ids = runs.body.runs.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual(['run_A', 'run_B']);
    const runA = runs.body.runs.find((r: { id: string }) => r.id === 'run_A');
    expect(runA.eventCount).toBe(2);
    expect(runA.errorCount).toBe(1);
    expect(runA.app).toBe('app-A');

    // Control routing respects ownership: resume for B reaches appB only.
    uiA.control('exec.resume', 'run_B', { pauseId: 'p9', action: 'continue' });
    const control = await appB.nextControl((e) => e.type === 'exec.resume');
    expect(control.runId).toBe('run_B');
    expect(appA.received.peekAll().filter((e) => e.type === 'exec.resume')).toEqual([]);

    await Promise.all([appA.close(), appB.close(), uiA.close(), uiB.close()]);
  });
});

describe('replay-then-tail', () => {
  it('replays full history in seq order, then continues live without dupes', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'demo-app' });
    app.send('run.started', 'run_r', runStarted);
    for (let i = 0; i < 3; i += 1) {
      app.send('node.token', 'run_r', { nodeId: 'llm:step', deltas: [{ t: 'text', v: `${i}` }] });
    }

    // Wait until the server has persisted all 4, then attach the viewer mid-run.
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs/run_r/events')).body.total === 4,
      'all 4 events persisted',
    );
    const ui = await FakeUI.connect(port);
    ui.subscribe('run_r');

    const start = await ui.next((m) => m.type === 'replay.start', 'replay.start');
    expect(start.type === 'replay.start' && start.count).toBe(4);

    const replayed: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const m = await ui.next(isEvent, `replayed event ${i}`);
      if (isEvent(m)) replayed.push(m.envelope.seq);
    }
    await ui.next((m) => m.type === 'replay.end', 'replay.end');
    expect(replayed).toEqual([...replayed].sort((a, b) => a - b));

    // Live continuation.
    const s5 = app.send('node.finished', 'run_r', {
      nodeId: 'llm:step',
      output: 'ok',
      durationMs: 1,
      status: 'ok',
    });
    const s6 = app.send('run.finished', 'run_r', { status: 'ok' });
    const live1 = await ui.next(isEvent, 'live event 1');
    const live2 = await ui.next(isEvent, 'live event 2');
    const liveSeqs = [live1, live2].filter(isEvent).map((m) => m.envelope.seq);
    expect(liveSeqs).toEqual([s5, s6]);

    // No seq appears twice across replay + tail.
    const all = [...replayed, ...liveSeqs];
    expect(new Set(all).size).toBe(all.length);
    await app.close();
    await ui.close();
  });

  it('allows subscribing to a run that does not exist yet (empty replay, live tail)', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.subscribe('run_future');
    const start = await ui.next((m) => m.type === 'replay.start', 'replay.start');
    expect(start.type === 'replay.start' && start.count).toBe(0);
    await ui.next((m) => m.type === 'replay.end', 'replay.end');

    const app = await FakeApp.connect(port);
    app.send('run.started', 'run_future', runStarted);
    const m = await ui.next(isEvent, 'first live event');
    if (isEvent(m)) expect(m.envelope.type).toBe('run.started');
    await app.close();
    await ui.close();
  });
});

describe('control relay', () => {
  it('routes exec.resume to the ingest socket that owns the run', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'demo-app' });
    app.send('run.started', 'run_c', runStarted);
    app.send('exec.paused', 'run_c', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' });
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs/run_c/events')).body.total === 2,
      'run_c persisted (ownership established)',
    );

    const ui = await FakeUI.connect(port);
    ui.control('exec.resume', 'run_c', { pauseId: 'p1', action: 'inject', output: { fake: true } });

    const control = await app.nextControl((e) => e.type === 'exec.resume');
    expect(control.runId).toBe('run_c');
    expect(control.payload).toMatchObject({ pauseId: 'p1', action: 'inject', output: { fake: true } });
    await app.close();
    await ui.close();
  });

  it('reports an error to the viewer when no app owns the run', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.control('exec.resume', 'run_ghost', { pauseId: 'p1', action: 'continue' });
    const err = await ui.next((m) => m.type === 'error', 'error message');
    expect(err.type === 'error' && err.runId).toBe('run_ghost');
    await ui.close();
  });

  it('relays breakpoint.set/clear and mode.set to connected apps and broadcasts state', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port);
    const ui = await FakeUI.connect(port);
    const observer = await FakeUI.connect(port);

    ui.control('breakpoint.set', '*', { matcher: { name: 'searchFlights' } });
    const set = await app.nextControl((e) => e.type === 'breakpoint.set');
    expect(set.payload).toEqual({ matcher: { name: 'searchFlights' } });
    const state1 = await observer.next((m) => m.type === 'state', 'state broadcast');
    expect(state1.type === 'state' && state1.breakpoints).toEqual([{ name: 'searchFlights' }]);

    ui.control('mode.set', '*', { mode: 'step' });
    const mode = await app.nextControl((e) => e.type === 'mode.set');
    expect(mode.payload).toEqual({ mode: 'step' });
    const state2 = await observer.next(
      (m) => m.type === 'state' && m.mode === 'step',
      'mode state broadcast',
    );
    expect(state2.type === 'state' && state2.mode).toBe('step');

    ui.control('breakpoint.clear', '*', { matcher: { name: 'searchFlights' } });
    await app.nextControl((e) => e.type === 'breakpoint.clear');
    const state3 = await observer.next(
      (m) => m.type === 'state' && m.breakpoints.length === 0,
      'cleared state broadcast',
    );
    expect(state3.type === 'state' && state3.breakpoints).toEqual([]);

    await app.close();
    await ui.close();
    await observer.close();
  });

  it('rejects malformed control envelopes with an error message', async () => {
    const { port } = await boot();
    const ui = await FakeUI.connect(port);
    ui.send({ type: 'control', envelope: { nope: true } });
    const err = await ui.next((m) => m.type === 'error', 'error for bad control');
    expect(err.type === 'error' && err.message).toContain('invalid control envelope');
    await ui.close();
  });
});

describe('run-list subscription (*)', () => {
  it('sends a runs snapshot and pushes run.update on lifecycle changes', async () => {
    const { port } = await boot();
    const app = await FakeApp.connect(port, { app: 'demo-app' });
    app.send('run.started', 'run_l', runStarted);
    await waitUntil(
      async () => (await fetchJson(port, '/api/runs')).body.runs.length === 1,
      'run_l persisted',
    );

    const ui = await FakeUI.connect(port);
    ui.subscribe('*');
    const snapshot = await ui.next((m) => m.type === 'runs', 'runs snapshot');
    if (snapshot.type === 'runs') {
      expect(snapshot.runs.map((r) => r.id)).toEqual(['run_l']);
      expect(snapshot.runs[0]?.live).toBe(true);
      expect(snapshot.runs[0]?.status).toBe('running');
    }

    app.send('run.finished', 'run_l', { status: 'error', error: { name: 'E', message: 'x' } });
    const update = await ui.next(
      (m) => m.type === 'run.update' && m.run.status === 'error',
      'run.update on finish',
    );
    if (update.type === 'run.update') {
      expect(update.run.finishedAt).not.toBeNull();
      expect(update.run.status).toBe('error');
    }

    await app.close();
    const offline = await ui.next(
      (m) => m.type === 'run.update' && !m.run.live,
      'run.update on app disconnect',
    );
    expect(offline.type === 'run.update' && offline.run.id).toBe('run_l');
    await ui.close();
  });
});
