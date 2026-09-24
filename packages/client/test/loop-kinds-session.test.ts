/**
 * Loop kinds v4 through a live session: what adapters emit (node.started,
 * node.error, node.finished) feeds the history, a cycle or an error-repeat
 * holds the next call's before-gate with `reason: 'loop'`, `loop.kind`, and
 * the four legacy fields a 0.5 viewer requires; the salted fingerprint is
 * hidden under any covering HIDE switch; detached or in warn mode the session
 * warns once (rate-limited) and never quotes a value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventPayloadSchemas, LoopInfoSchema, parseEnvelope } from '@graphmind-ai/schema';
import { createSession, type Session, type SessionOptions } from '../src/index.js';
import type { GateNode } from '../src/gate-engine.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const SEARCH: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };
const FETCH: GateNode = { nodeId: 'tool:fetch', kind: 'tool', name: 'fetch' };
const SQL: GateNode = { nodeId: 'tool:run_sql', kind: 'tool', name: 'run_sql' };
const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };
const SECRET = 'hunter2-secret-value';

let instances = 0;

interface Call {
  instanceId: string;
  gate: Promise<unknown>;
}

/** node.started + the before-gate, as every adapter does. */
function start(session: Session, node: GateNode, input: unknown): Call {
  const instanceId = `i${(instances += 1)}`;
  session.emit('node.started', { nodeId: node.nodeId, kind: node.kind, name: node.name, instanceId, input });
  return { instanceId, gate: session.gate('before', node) };
}

async function ok(session: Session, node: GateNode, input: unknown, output: unknown): Promise<unknown> {
  const call = start(session, node, input);
  const decision = await call.gate;
  session.emit('node.finished', { nodeId: node.nodeId, instanceId: call.instanceId, output, durationMs: 1, status: 'ok' });
  return decision;
}

async function thrown(session: Session, node: GateNode, input: unknown, message: string): Promise<unknown> {
  const call = start(session, node, input);
  const decision = await call.gate;
  session.emit('node.error', { nodeId: node.nodeId, instanceId: call.instanceId, error: { name: 'Error', message } });
  session.emit('node.finished', { nodeId: node.nodeId, instanceId: call.instanceId, durationMs: 1, status: 'error' });
  return decision;
}

async function attachedSession(viewer: FakeViewer, extra: SessionOptions = {}): Promise<Session> {
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: {}, ...extra });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return session;
}

async function startViewer(options: Parameters<typeof FakeViewer.start>[0] = {}): Promise<FakeViewer> {
  const viewer = await FakeViewer.start(options);
  cleanups.push(() => viewer.close());
  return viewer;
}

class NeverConnectsWS implements WebSocketLike {
  readonly readyState = 0;
  constructor(_url: string) {}
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

function detachedSession(extra: SessionOptions = {}): { session: Session; warnings: string[] } {
  const warnings: string[] = [];
  const session = createSession({
    enabled: true,
    env: {},
    webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => session.dispose());
  return { session, warnings };
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

async function threeLaps(session: Session): Promise<void> {
  for (let lap = 0; lap < 3; lap += 1) {
    expect(await settledWithin(ok(session, SEARCH, { q: SECRET }, { hits: [SECRET] }), 300)).toEqual({ action: 'continue' });
    expect(await settledWithin(ok(session, FETCH, { id: 1 }, { body: 'same' }), 300)).toEqual({ action: 'continue' });
  }
}

async function threeFailures(session: Session): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    expect(await settledWithin(thrown(session, SQL, { sql: `select ${i}` }, `relation "${SECRET}" does not exist`), 300)).toEqual({
      action: 'continue',
    });
  }
}

function startSeqs(viewer: FakeViewer, nodeId: string): number[] {
  return viewer
    .ofType('node.started')
    .filter((f) => f.payload['nodeId'] === nodeId)
    .map((f) => f.seq);
}

/** The frame a 0.5 viewer would require: the four legacy loop fields, valid. */
function expectLegacyLoop(paused: ReceivedFrame): void {
  const loop = paused.payload['loop'] as Record<string, unknown>;
  for (const field of ['repeats', 'firstSeq', 'lastSeq']) {
    expect(Number.isInteger(loop[field]), field).toBe(true);
    expect(loop[field] as number, field).toBeGreaterThanOrEqual(0);
  }
  expect(typeof loop['fingerprint']).toBe('string');
  // The 0.5 schema: required four fields, loose object (kind/period/laps are extra).
  const legacy = LoopInfoSchema.pick({ repeats: true, firstSeq: true, lastSeq: true, fingerprint: true }).strict();
  expect(legacy.safeParse({ repeats: loop['repeats'], firstSeq: loop['firstSeq'], lastSeq: loop['lastSeq'], fingerprint: loop['fingerprint'] }).success).toBe(true);
  expect(EventPayloadSchemas['exec.paused'].safeParse(paused.payload).success).toBe(true);
  expect(parseEnvelope(paused).kind).toBe('ok');
}

describe('cycle through a live session', () => {
  it('holds the first call of lap 4 with kind cycle and every legacy field; resume works', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await threeLaps(session);
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    const held = start(session, SEARCH, { q: SECRET });
    const paused = await viewer.waitForType('exec.paused');
    const searches = startSeqs(viewer, SEARCH.nodeId);
    expect(paused.payload).toMatchObject({
      nodeId: SEARCH.nodeId,
      point: 'before',
      reason: 'loop',
      loop: { kind: 'cycle', period: 2, laps: 3, repeats: 3, firstSeq: searches[0], lastSeq: searches[3] },
    });
    const loop = paused.payload['loop'] as { fingerprint: string };
    expect(loop.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(paused.payload)).not.toContain(SECRET);
    expectLegacyLoop(paused);
    expect(await settledWithin(held.gate, 100)).toBe('pending');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await held.gate).toEqual({ action: 'continue' });
  });

  it('LLM steps between the tool calls do not break the laps; a changing result never holds', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    for (let lap = 0; lap < 3; lap += 1) {
      await ok(session, LLM, { messages: lap }, { text: 'call search' });
      await ok(session, SEARCH, { q: 'x' }, 1);
      await ok(session, LLM, { messages: lap + 0.5 }, { text: 'call fetch' });
      await ok(session, FETCH, { id: 1 }, 2);
    }
    await ok(session, LLM, { messages: 9 }, { text: 'call search' });
    const held = start(session, SEARCH, { q: 'x' });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { kind: 'cycle', period: 2 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held.gate;

    const other = await startViewer();
    const polling = await attachedSession(other);
    for (let lap = 0; lap < 5; lap += 1) {
      expect(await settledWithin(ok(polling, SEARCH, { job: 1 }, { progress: lap }), 300)).toEqual({ action: 'continue' });
      expect(await settledWithin(ok(polling, FETCH, { s: 1 }, null), 300)).toEqual({ action: 'continue' });
    }
    expect(other.ofType('exec.paused')).toHaveLength(0);
  });

  it('GRAPHMIND_LOOP_ALLOW nodes are invisible; laps made only of them never hold', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { env: { GRAPHMIND_LOOP_ALLOW: 'search, fetch' } });
    for (let lap = 0; lap < 5; lap += 1) {
      expect(await settledWithin(ok(session, SEARCH, { job: 1 }, 'pending'), 300)).toEqual({ action: 'continue' });
      expect(await settledWithin(ok(session, FETCH, { job: 1 }, 'pending'), 300)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });
});

describe('error-repeat through a live session', () => {
  it('three identical thrown errors (arguments vary), the fourth call holds', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await threeFailures(session);
    const held = start(session, SQL, { sql: 'select 99' });
    const paused = await viewer.waitForType('exec.paused');
    const seqs = startSeqs(viewer, SQL.nodeId);
    expect(paused.payload).toMatchObject({
      nodeId: SQL.nodeId,
      reason: 'loop',
      loop: { kind: 'error-repeat', repeats: 3, firstSeq: seqs[0], lastSeq: seqs[3] },
    });
    expect(paused.payload['loop']).not.toHaveProperty('period');
    expect(JSON.stringify(paused.payload)).not.toContain(SECRET);
    expectLegacyLoop(paused);
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    expect(await held.gate).toEqual({ action: 'abort' });
  });

  it('an error-shaped result that did not throw counts as a failure', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { breakOnErrorResult: false });
    for (let i = 0; i < 3; i += 1) {
      await ok(session, SQL, { sql: `q${i}` }, { isError: true, content: [{ type: 'text', text: 'denied' }] });
    }
    const held = start(session, SQL, { sql: 'q9' });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { kind: 'error-repeat', repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held.gate;
  });

  it('a success in between resets it', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await thrown(session, SQL, { n: 1 }, 'boom');
    await thrown(session, SQL, { n: 2 }, 'boom');
    await ok(session, SQL, { n: 3 }, { rows: [] });
    await thrown(session, SQL, { n: 4 }, 'boom');
    await thrown(session, SQL, { n: 5 }, 'boom');
    expect(await settledWithin(start(session, SQL, { n: 6 }).gate, 300)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('a node.finished the redactor dropped never counts (it never reached the wire)', async () => {
    const viewer = await startViewer();
    // With a switch on, a non-string instanceId fails redaction closed, and a
    // failed form that cannot be valid (NaN duration) is dropped.
    const session = await attachedSession(viewer, { hideOutputs: true, logger: () => {} });
    await thrown(session, SQL, { n: 1 }, 'boom');
    const call = start(session, SQL, { n: 2 });
    await call.gate;
    session.emit('node.error', { nodeId: SQL.nodeId, instanceId: call.instanceId, error: { name: 'Error', message: 'boom' } });
    session.emit('node.finished', {
      nodeId: SQL.nodeId,
      instanceId: new String(call.instanceId) as unknown as string,
      durationMs: Number.NaN,
      status: 'error',
    });
    await thrown(session, SQL, { n: 3 }, 'boom');
    await thrown(session, SQL, { n: 4 }, 'boom');
    expect(await settledWithin(start(session, SQL, { n: 5 }).gate, 300)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    // n1, n3, n4 reached the debugger; n2's node.finished did not.
    const finishedOf = () => viewer.ofType('node.finished').filter((f) => f.payload['nodeId'] === SQL.nodeId);
    await waitUntil(() => finishedOf().length === 3, 3000, 'three finished');
    await tick(50);
    expect(finishedOf()).toHaveLength(3);
  });
});

describe('redaction of the new kinds', () => {
  it.each<[string, SessionOptions, boolean]>([
    ['no switch', {}, false],
    ['HIDE_INPUTS', { hideInputs: true }, true],
    ['HIDE_OUTPUTS', { hideOutputs: true }, true],
    ['HIDE_TOOL_ARGS', { env: { GRAPHMIND_HIDE_TOOL_ARGS: 'yes' } }, true],
    ['HIDE_TOOL_RESULTS', { hideToolResults: true }, true],
  ])('under %s the salted fingerprint is %s', async (_label, options, hidden) => {
    for (const kind of ['cycle', 'error-repeat'] as const) {
      const viewer = await startViewer();
      const session = await attachedSession(viewer, options);
      if (kind === 'cycle') await threeLaps(session);
      else await threeFailures(session);
      const held = kind === 'cycle' ? start(session, SEARCH, { q: SECRET }) : start(session, SQL, { sql: 'x' });
      const paused = await viewer.waitForType('exec.paused');
      const loop = paused.payload['loop'] as Record<string, unknown>;
      expect(loop['kind']).toBe(kind);
      if (hidden) expect(loop['fingerprint']).toBe('__REDACTED__');
      else expect(loop['fingerprint']).toMatch(/^[0-9a-f]{32}$/);
      // Counts and seqs survive every switch; nothing else is derived from values.
      expect(Object.keys(loop).sort()).toEqual(
        kind === 'cycle'
          ? ['fingerprint', 'firstSeq', 'kind', 'laps', 'lastSeq', 'period', 'repeats']
          : ['fingerprint', 'firstSeq', 'kind', 'lastSeq', 'repeats'],
      );
      expect(JSON.stringify(viewer.ofType('exec.paused'))).not.toContain(SECRET);
      viewer.resume(paused.payload['pauseId'] as string, 'continue');
      await held.gate;
    }
  });

  it('the v3 rule keeps its 0.5 behaviour: fingerprint hidden only under an input switch, no kind', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { hideOutputs: true });
    for (let i = 0; i < 2; i += 1) await ok(session, SEARCH, { q: 'same' }, 1);
    const held = start(session, SEARCH, { q: 'same' });
    const paused = await viewer.waitForType('exec.paused');
    const loop = paused.payload['loop'] as Record<string, unknown>;
    expect(loop['kind']).toBeUndefined();
    expect(Object.keys(loop).sort()).toEqual(['fingerprint', 'firstSeq', 'lastSeq', 'repeats']);
    expect(loop['fingerprint']).toMatch(/^[0-9a-f]{32}$/);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held.gate;
  });
});

describe('detached, warn and off', () => {
  it('detached: never holds, one warning per kind and node, naming the tool and never a value', async () => {
    const { session, warnings } = detachedSession();
    await threeLaps(session);
    expect(await settledWithin(ok(session, SEARCH, { q: SECRET }, { hits: [SECRET] }), 100)).toEqual({ action: 'continue' });
    await ok(session, FETCH, { id: 1 }, { body: 'same' });
    // lap 5: the next cycle hold point, rate-limited to the one warning
    await ok(session, SEARCH, { q: SECRET }, { hits: [SECRET] });
    await threeFailures(session);
    expect(await settledWithin(start(session, SQL, { sql: 'again' }).gate, 100)).toEqual({ action: 'continue' });

    const cycle = warnings.filter((w) => w.includes('cycle'));
    const errors = warnings.filter((w) => w.includes('same error'));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toContain('search (tool:search)');
    expect(cycle[0]).toContain('cycle of 2 calls');
    expect(cycle[0]).toContain('no debugger is attached');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('run_sql (tool:run_sql) failed 3×');
    for (const warning of warnings) {
      expect(warning).not.toContain(SECRET);
      expect(warning).not.toContain('does not exist');
    }
  });

  it('failures recorded before the debugger attached count: the next call after attach holds', async () => {
    const viewer = await startViewer();
    const session = createSession({ url: viewer.url, enabled: true, env: {}, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());
    // Three identical failures emitted before the handshake completes (no gate awaited).
    for (let i = 0; i < 3; i += 1) {
      const instanceId = `late${i}`;
      session.emit('node.started', { nodeId: SQL.nodeId, kind: 'tool', name: SQL.name, instanceId, input: { i } });
      session.emit('node.error', { nodeId: SQL.nodeId, instanceId, error: { name: 'Error', message: 'boom' } });
      session.emit('node.finished', { nodeId: SQL.nodeId, instanceId, durationMs: 1, status: 'error' });
    }
    expect(session.attached).toBe(false);
    await waitUntil(() => session.attached, 3000, 'attach');
    const held = start(session, SQL, { i: 9 });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { kind: 'error-repeat', repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held.gate;
  });

  it('mode warn, attached: never holds, warns once', async () => {
    const viewer = await startViewer();
    const warnings: string[] = [];
    const session = await attachedSession(viewer, {
      env: { GRAPHMIND_ON_LOOP: 'warn' },
      logger: (message) => warnings.push(message),
    });
    await threeLaps(session);
    expect(await settledWithin(start(session, SEARCH, { q: SECRET }).gate, 200)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    const cycle = warnings.filter((w) => w.includes('cycle'));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toContain('GRAPHMIND_ON_LOOP=warn');
  });

  it('mode off / threshold 0: nothing at all', async () => {
    for (const env of [{ GRAPHMIND_ON_LOOP: 'off' }, { GRAPHMIND_LOOP_THRESHOLD: '0' }]) {
      const viewer = await startViewer();
      const warnings: string[] = [];
      const session = await attachedSession(viewer, { env, logger: (message) => warnings.push(message) });
      await threeLaps(session);
      await threeFailures(session);
      expect(await settledWithin(start(session, SEARCH, { q: SECRET }).gate, 150)).toEqual({ action: 'continue' });
      expect(await settledWithin(start(session, SQL, { sql: 'x' }).gate, 150)).toEqual({ action: 'continue' });
      expect(viewer.ofType('exec.paused')).toHaveLength(0);
      expect(warnings.filter((w) => w.includes('possible loop'))).toHaveLength(0);
    }
  });

  it('the detached gate fast path stays fast with the history on', async () => {
    const { session } = detachedSession();
    for (let i = 0; i < 200; i += 1) await ok(session, SEARCH, { i }, { i });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) await session.gate('before', SEARCH);
    expect((performance.now() - t0) / 1000).toBeLessThan(1);
  });
});

describe('never throws into the host', () => {
  it('hostile node.finished / node.error payloads are swallowed', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const call = start(session, SQL, { n: 1 });
    await call.gate;
    const hostile = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error('trap');
      },
    });
    expect(() => session.emit('node.finished', hostile as never)).not.toThrow();
    expect(() => session.emit('node.error', hostile as never)).not.toThrow();
    expect(() =>
      session.emit('node.error', { nodeId: SQL.nodeId, instanceId: call.instanceId, error: hostile as never }),
    ).not.toThrow();
    expect(() =>
      session.emit('node.finished', {
        nodeId: SQL.nodeId,
        instanceId: call.instanceId,
        durationMs: 1,
        status: 'ok',
        get output(): never {
          throw new Error('no');
        },
      }),
    ).not.toThrow();
    for (const payload of [null, undefined, 1, 'x', {}, { nodeId: 7 }]) {
      expect(() => session.emit('node.finished', payload as never)).not.toThrow();
      expect(() => session.emit('node.error', payload as never)).not.toThrow();
    }
    await waitUntil(() => session.attached, 1000, 'still attached');
  });
});
