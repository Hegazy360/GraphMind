/**
 * Loop hold, the cases an attacker (or an unlucky host) would try: hidden
 * arguments must not leak through the fingerprint, hostile inputs must never
 * throw into the host, big inputs must stay cheap, many runs looping at once
 * must hold independently and be released together when the debugger dies,
 * and a gate that never saw a node.started must not invent a streak.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED, createSession, fingerprintCall, type Session, type SessionOptions } from '../src/index.js';
import type { GateNode } from '../src/gate-engine.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const LOOKUP: GateNode = { nodeId: 'tool:lookupUser', kind: 'tool', name: 'lookupUser' };
const PII = { email: 'alice@corp.example' };

let instances = 0;

function call(session: Session, node: GateNode, input: unknown, withInput = true) {
  session.emit('node.started', {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    instanceId: `i${(instances += 1)}`,
    ...(withInput ? { input } : {}),
  });
  return session.gate('before', node);
}

async function startViewer(options: Parameters<typeof FakeViewer.start>[0] = {}): Promise<FakeViewer> {
  const viewer = await FakeViewer.start(options);
  cleanups.push(() => viewer.close());
  return viewer;
}

async function attachedSession(viewer: FakeViewer, extra: SessionOptions = {}): Promise<Session> {
  const session = createSession({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: {},
    ...extra,
  });
  cleanups.push(() => session.dispose());
  session.emit('graph.hint', { nodes: [] });
  await waitUntil(() => session.attached, 3000, 'session attach');
  return session;
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

describe('loop hold — redaction', () => {
  it('hidden tool arguments never leak through the loop fingerprint (an unsalted digest of them)', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { hideToolArgs: true });
    await call(session, LOOKUP, PII);
    await call(session, LOOKUP, PII);
    const held = call(session, LOOKUP, PII);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ reason: 'loop', loop: { repeats: 3 } });
    // The input itself is hidden on the wire...
    for (const started of viewer.ofType('node.started')) expect(started.payload['input']).toBe(REDACTED);
    // ...so the fingerprint of it must be hidden too: a 128-bit digest of
    // `{"email":"alice@corp.example"}` is a dictionary attack away from the email.
    const loop = paused.payload['loop'] as { fingerprint: string };
    expect(loop.fingerprint).toBe(REDACTED);
    expect(loop.fingerprint).not.toBe(fingerprintCall(LOOKUP.nodeId, PII));
    expect(JSON.stringify(paused)).not.toContain(fingerprintCall(LOOKUP.nodeId, PII));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await held).toEqual({ action: 'continue' });
  });

  it('GRAPHMIND_HIDE_INPUTS (env) hides it as well; hiding only tool RESULTS keeps the real fingerprint', async () => {
    const viewer = await startViewer();
    const byEnv = await attachedSession(viewer, { env: { GRAPHMIND_HIDE_INPUTS: '1' } });
    await call(byEnv, LOOKUP, PII);
    await call(byEnv, LOOKUP, PII);
    const held = call(byEnv, LOOKUP, PII);
    const paused = await viewer.waitForType('exec.paused');
    expect((paused.payload['loop'] as { fingerprint: string }).fingerprint).toBe(REDACTED);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;

    const results = await attachedSession(viewer, { hideToolResults: true });
    await call(results, LOOKUP, PII);
    await call(results, LOOKUP, PII);
    const held2 = call(results, LOOKUP, PII);
    const p2 = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['pauseId'] !== paused.payload['pauseId']);
    expect((p2.payload['loop'] as { fingerprint: string }).fingerprint).toBe(fingerprintCall(LOOKUP.nodeId, PII));
    viewer.resume(p2.payload['pauseId'] as string, 'continue');
    await held2;
  });
});

describe('loop hold — hostile and oversized inputs never throw into the host', () => {
  it('a Proxy that throws on enumeration, a throwing getter, and a throwing toJSON all pass through', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const hostile: unknown[] = [
      new Proxy({}, { ownKeys: () => { throw new Error('ownKeys'); } }),
      { get q(): never { throw new Error('getter'); } },
      { toJSON: () => { throw new Error('toJSON'); } },
      { toJSON: (): unknown => ({ self: 1 }) },
      Object.create(null),
      new Map([['a', 1]]),
      Symbol('s'),
      () => 1,
      123n,
    ];
    for (const input of hostile) {
      let decision: unknown;
      expect(() => {
        decision = call(session, { nodeId: 'tool:hostile', kind: 'tool', name: 'hostile' }, input);
      }).not.toThrow();
      const settled = await settledWithin(decision as Promise<unknown>, 300);
      // Held (three unserializable inputs look identical — documented) or
      // continued; never rejected, never thrown.
      if (settled === 'pending') {
        const paused = viewer.ofType('exec.paused').at(-1);
        expect(paused?.payload['reason']).toBe('loop');
        viewer.resume(paused?.payload['pauseId'] as string, 'continue');
        expect(await (decision as Promise<unknown>)).toEqual({ action: 'continue' });
      } else {
        expect(settled).toEqual({ action: 'continue' });
      }
    }
    // The session is still healthy afterwards.
    expect(session.attached).toBe(true);
    expect(session.stats().heldGates).toBe(0);
  });

  it('malformed node.started payloads are absorbed', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const bad = [null, undefined, 1, 'x', {}, { kind: 'tool' }, { nodeId: 1, kind: 2, name: 3, input: 4 }];
    for (const payload of bad) {
      expect(() => session.emit('node.started', payload as never)).not.toThrow();
    }
    expect(await settledWithin(session.gate('before', LOOKUP), 200)).toEqual({ action: 'continue' });
    expect(session.stats().heldGates).toBe(0);
  });

  it('a 2 MB input is fingerprinted in bounded time and still trips', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const big = { doc: 'x'.repeat(2 * 1024 * 1024), rows: Array.from({ length: 2000 }, (_v, i) => ({ i, k: `v${i}` })) };
    const t0 = performance.now();
    await call(session, LOOKUP, big);
    await call(session, LOOKUP, big);
    const held = call(session, LOOKUP, big);
    const paused = await viewer.waitForType('exec.paused', 10_000);
    const elapsed = performance.now() - t0;
    expect(paused.payload['reason']).toBe('loop');
    expect(elapsed).toBeLessThan(2_000);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;
  });
});

describe('loop hold — many runs, a dying hub, and phantom streaks', () => {
  it('twenty concurrent runs looping on one tool are twenty independent holds, all released when the hub dies', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const decisions: string[] = [];
    const runs = Array.from({ length: 20 }, (_v, i) =>
      session.run(`r${i}`, async () => {
        await call(session, LOOKUP, PII);
        await call(session, LOOKUP, PII);
        const d = await call(session, LOOKUP, PII);
        decisions.push(d.action);
      }),
    );
    await waitUntil(() => viewer.ofType('exec.paused').length === 20, 5000, 'twenty holds');
    expect(session.stats().heldGates).toBe(20);
    const runIds = new Set(viewer.ofType('exec.paused').map((f) => f.runId));
    expect(runIds.size).toBe(20);
    for (const f of viewer.ofType('exec.paused')) expect(f.payload).toMatchObject({ reason: 'loop', loop: { repeats: 3 } });

    viewer.killAbruptly(); // FAIL OPEN
    await Promise.all(runs);
    expect(decisions).toEqual(Array(20).fill('continue'));
    expect(session.stats().heldGates).toBe(0);
  });

  it('a before-gate that never saw a node.started, or one whose kind differs, never holds', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    for (let i = 0; i < 5; i += 1) {
      expect(await settledWithin(session.gate('before', LOOKUP), 100)).toEqual({ action: 'continue' });
    }
    // node.started says tool, the gate says llm: not the same watched node.
    const asLlm: GateNode = { nodeId: LOOKUP.nodeId, kind: 'llm', name: LOOKUP.name };
    for (let i = 0; i < 4; i += 1) {
      session.emit('node.started', { nodeId: LOOKUP.nodeId, kind: 'tool', name: LOOKUP.name, instanceId: `m${i}`, input: PII });
      expect(await settledWithin(session.gate('before', asLlm), 100)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('a tool with no input at all repeats "identically", and threshold 1 holds the very first call', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const noArgs: GateNode = { nodeId: 'tool:now', kind: 'tool', name: 'now' };
    await call(session, noArgs, undefined, false);
    await call(session, noArgs, undefined, false);
    const held = call(session, noArgs, undefined, false);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:now', reason: 'loop', loop: { repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;

    const eager = await attachedSession(viewer, { loopGuard: { threshold: 1 } });
    const first = call(eager, LOOKUP, PII);
    const p1 = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === LOOKUP.nodeId);
    expect((p1.payload['loop'] as { repeats: number }).repeats).toBe(1);
    viewer.resume(p1.payload['pauseId'] as string, 'abort');
    expect(await first).toEqual({ action: 'abort' });
  });
});
