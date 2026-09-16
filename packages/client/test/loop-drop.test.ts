/**
 * A node.started that never reaches the wire (binding decision "A dropped
 * event takes no seq and clears its kind's loop streak", Ruby parity):
 *
 *  (a) an event the fail-closed redactor DROPS takes no seq — the seqs of the
 *      events that are emitted stay consecutive, with no hole where it was;
 *  (b) a dropped start clears its kind's loop streak — it is not "the call
 *      right before" the next one, so the count restarts after it, and a
 *      later hold's firstSeq/lastSeq only ever name events that were sent;
 *  (c) the loop record happens after the frame exists: a start that could not
 *      be serialised clears the streak too.
 *
 * The divergence probe (loop-v3 verifier): GRAPHMIND_HIDE_INPUTS on, the same
 * tool:a start four times, call 2's instanceId a boxed `new String('i2')`.
 * The redactor cannot build a valid failed form for it and drops it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { createSession, type Session, type SessionOptions } from '../src/index.js';
import type { GateNode } from '../src/gate-engine.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const TOOL_A: GateNode = { nodeId: 'tool:a', kind: 'tool', name: 'a' };
const ARGS = { q: 'same' };
const HIDE = { GRAPHMIND_HIDE_INPUTS: '1' };
const boxed = (text: string): string => new String(text) as unknown as string;

/** A socket that never opens: permanently detached, network-free. */
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
    env: HIDE,
    webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => session.dispose());
  return { session, warnings };
}

async function attachedSession(extra: SessionOptions = {}): Promise<{
  viewer: FakeViewer;
  session: Session;
  warnings: string[];
}> {
  const viewer = await FakeViewer.start();
  cleanups.push(() => viewer.close());
  const warnings: string[] = [];
  const session = createSession({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    env: HIDE,
    logger: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => session.dispose());
  expect(await session.ready()).toBe(true);
  return { viewer, session, warnings };
}

/** What every adapter does: emit node.started, then await the before-gate. */
function call(session: Session, instanceId: string, input: unknown = ARGS) {
  session.emit('node.started', { ...TOOL_A, instanceId, input });
  return session.gate('before', TOOL_A);
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

const loopWarnings = (warnings: string[]): string[] => warnings.filter((w) => w.includes('possible loop'));

/** Every seq this session put on the wire must be 0..n-1, each exactly once. */
function expectGapFree(frames: ReceivedFrame[]): void {
  const seqs = frames.map((f) => f.seq).sort((a, b) => a - b);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual(seqs.map((_, i) => i));
}

describe('a node.started dropped by fail-closed redaction — detached', () => {
  it('control: three identical well-formed starts warn about a loop at call 3', () => {
    const { session, warnings } = detachedSession();
    for (const id of ['i1', 'i2', 'i3']) session.emit('node.started', { ...TOOL_A, instanceId: id, input: ARGS });
    expect(loopWarnings(warnings)).toHaveLength(1);
    expect(session.stats().seq).toBe(4); // implicit run.started + 3 starts
  });

  it('the divergence probe: a boxed instanceId on call 2 is dropped, clears the streak and takes no seq', () => {
    const { session, warnings } = detachedSession();
    session.emit('node.started', { ...TOOL_A, instanceId: 'i1', input: ARGS });
    const before = session.stats().seq;
    session.emit('node.started', { ...TOOL_A, instanceId: boxed('i2'), input: ARGS });
    // it really was dropped by the redactor (not emitted in a failed form)...
    expect(warnings.some((w) => w.includes('dropped it rather than send data'))).toBe(true);
    // ...and took no seq
    expect(session.stats().seq).toBe(before);
    session.emit('node.started', { ...TOOL_A, instanceId: 'i3', input: ARGS });
    expect(loopWarnings(warnings)).toEqual([]); // call 3: streak restarted at 1
    session.emit('node.started', { ...TOOL_A, instanceId: 'i4', input: ARGS });
    expect(loopWarnings(warnings)).toEqual([]); // call 4: only 2 in a row
    session.emit('node.started', { ...TOOL_A, instanceId: 'i5', input: ARGS });
    expect(loopWarnings(warnings)).toHaveLength(1); // call 5: 3 sent in a row
    // run.started + 4 emitted starts, nothing for the dropped one
    expect(session.stats().seq).toBe(5);
  });

  it('a dropped start whose kind is unusable still takes no seq and never throws', () => {
    const { session, warnings } = detachedSession();
    const before = (session.emit('node.started', { ...TOOL_A, instanceId: 'i1', input: ARGS }), session.stats().seq);
    expect(() =>
      session.emit('node.started', { ...TOOL_A, kind: boxed('tool') as never, instanceId: 'i2', input: ARGS }),
    ).not.toThrow();
    expect(session.stats().seq).toBe(before);
    expect(warnings.some((w) => w.includes('dropped it rather than send data'))).toBe(true);
  });

  it('a dropped node.finished / node.token takes no seq either', () => {
    const { session } = detachedSession({ env: { GRAPHMIND_HIDE_OUTPUTS: '1' } });
    session.emit('node.started', { ...TOOL_A, instanceId: 'i1', input: ARGS });
    const before = session.stats().seq;
    session.emit('node.finished', { nodeId: boxed('tool:a'), instanceId: 'i1', durationMs: 1, status: 'ok', output: 1 });
    session.emit('node.token', { nodeId: boxed('tool:a'), deltas: [{ t: 'text', v: 'x' }] });
    expect(session.stats().seq).toBe(before);
  });
});

describe('a node.started dropped by fail-closed redaction — attached', () => {
  it('no hold at call 3; emitted seqs are consecutive; a later hold names only sent events', async () => {
    const { viewer, session } = await attachedSession();

    expect(await call(session, 'i1')).toEqual({ action: 'continue' });
    expect(await call(session, boxed('i2'))).toEqual({ action: 'continue' });
    const third = call(session, 'i3');
    expect(await settledWithin(third, 150)).toEqual({ action: 'continue' }); // call 3: not held
    expect(await call(session, 'i4')).toEqual({ action: 'continue' }); // call 4: 2 in a row
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    // call 5 is the 3rd SENT identical start in a row: held.
    const fifth = call(session, 'i5');
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:a', reason: 'loop', loop: { repeats: 3 } });
    expect(parseEnvelope(paused).kind).toBe('ok');
    const starts = viewer.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:a');
    // the dropped start never reached the wire
    expect(starts.map((f) => f.payload['instanceId'])).toEqual(['i1', 'i3', 'i4', 'i5']);
    const loop = paused.payload['loop'] as { firstSeq: number; lastSeq: number };
    const sentSeqs = new Set(viewer.received.map((f) => f.seq));
    expect(sentSeqs.has(loop.firstSeq)).toBe(true);
    expect(sentSeqs.has(loop.lastSeq)).toBe(true);
    expect(loop.firstSeq).toBe(starts[1]!.seq); // i3
    expect(loop.lastSeq).toBe(starts[3]!.seq); // i5
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await fifth).toEqual({ action: 'continue' });

    await waitUntil(() => viewer.ofType('exec.resumed').length === 1, 3000, 'exec.resumed');
    expectGapFree(viewer.received);
    expect(session.stats().seq).toBe(viewer.received.length);
  });

  it('a drop right after two identical starts: the next identical start is not held', async () => {
    const { viewer, session } = await attachedSession();
    await call(session, 'i1');
    await call(session, 'i2');
    // would have been the 3rd; dropped, so it neither holds nor counts
    expect(await settledWithin(call(session, boxed('i3')), 150)).toEqual({ action: 'continue' });
    expect(await settledWithin(call(session, 'i4'), 150)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    await waitUntil(
      () => viewer.ofType('node.started').some((f) => f.payload['instanceId'] === 'i4'),
      3000,
      'i4 on the wire',
    );
    expectGapFree(viewer.received);
  });

  it('events dropped before attach leave no hole in the replay either', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, env: HIDE, logger: () => {} });
    cleanups.push(() => session.dispose());
    // Synchronous emits: the socket cannot have opened yet, so these are
    // buffered and replayed on attach.
    session.emit('node.started', { ...TOOL_A, instanceId: 'i1', input: ARGS });
    session.emit('node.started', { ...TOOL_A, instanceId: boxed('i2'), input: ARGS });
    session.emit('node.started', { ...TOOL_A, instanceId: 'i3', input: ARGS });
    expect(session.attached).toBe(false);
    await waitUntil(() => viewer.ofType('node.started').length === 2, 5000, 'replay');
    expect(viewer.ofType('node.started').map((f) => f.payload['instanceId'])).toEqual(['i1', 'i3']);
    expectGapFree(viewer.received);
  });
});

describe('a node.started that could not be serialised', () => {
  /**
   * A start whose frame cannot be built at all: its `input` getter throws the
   * first time JSON.stringify reads it and answers normally otherwise, so the
   * shrink's retry serialises it fine, finds nothing to degrade, and rethrows
   * (the emit guard warns; the event is never emitted).
   */
  function unserialisableStart(instanceId: string): Record<string, unknown> {
    let thrown = false;
    const start: Record<string, unknown> = { ...TOOL_A, instanceId };
    Object.defineProperty(start, 'input', {
      enumerable: true,
      get() {
        if (!thrown && (new Error().stack ?? '').includes('JSON.stringify')) {
          thrown = true;
          throw new Error('unserialisable');
        }
        return { ...ARGS };
      },
    });
    return start;
  }

  it('takes no seq and clears its kind streak (never counted as the call right before the next one)', () => {
    // No redaction here: the event passes the redactor, then its frame fails.
    const { session, warnings } = detachedSession({ env: {} });
    session.emit('node.started', { ...TOOL_A, instanceId: 'i1', input: ARGS });
    const before = session.stats().seq;
    expect(() => session.emit('node.started', unserialisableStart('i2') as never)).not.toThrow();
    // it really was not emitted: the emit guard reported the internal error
    expect(warnings.some((w) => w.includes('internal error in emit'))).toBe(true);
    expect(session.stats().seq).toBe(before);
    session.emit('node.started', { ...TOOL_A, instanceId: 'i3', input: ARGS });
    expect(loopWarnings(warnings)).toEqual([]);
    session.emit('node.started', { ...TOOL_A, instanceId: 'i4', input: ARGS });
    session.emit('node.started', { ...TOOL_A, instanceId: 'i5', input: ARGS });
    expect(loopWarnings(warnings)).toHaveLength(1);
    expect(session.stats().seq).toBe(before + 3);
  });

  it('attached: frames stay gap-free around it and no hold names it', async () => {
    const { viewer, session } = await attachedSession({ env: {} });
    await call(session, 'i1');
    await call(session, 'i2');
    session.emit('node.started', unserialisableStart('i3') as never);
    expect(await settledWithin(session.gate('before', TOOL_A), 150)).toEqual({ action: 'continue' });
    expect(await settledWithin(call(session, 'i4'), 150)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    await waitUntil(
      () => viewer.ofType('node.started').some((f) => f.payload['instanceId'] === 'i4'),
      3000,
      'i4 on the wire',
    );
    expectGapFree(viewer.received);
  });
});

describe('re-entrancy never duplicates a seq', () => {
  it('a logger that emits from the redactor drop warning: every frame has its own seq, gap-free', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    let session: Session | undefined;
    let reentered = 0;
    session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      env: HIDE,
      logger: () => {
        reentered += 1;
        session?.emit('graph.hint', { nodes: [] });
      },
    });
    const s = session;
    cleanups.push(() => s.dispose());
    expect(await s.ready()).toBe(true);
    await call(s, 'i1');
    await call(s, boxed('i2'));
    await call(s, 'i3');
    expect(reentered).toBeGreaterThan(0);
    await waitUntil(() => viewer.ofType('graph.hint').length === reentered, 3000, 're-entrant hints');
    await waitUntil(() => viewer.ofType('node.started').length === 2, 3000, 'starts');
    expectGapFree(viewer.received);
  });

  it('a getter that emits while its own frame fails to serialise: seqs stay unique (a hole is allowed)', async () => {
    const { viewer, session } = await attachedSession({ env: {} });
    let thrown = false;
    const start: Record<string, unknown> = { ...TOOL_A, instanceId: 'i1' };
    Object.defineProperty(start, 'input', {
      enumerable: true,
      get() {
        if (!thrown && (new Error().stack ?? '').includes('JSON.stringify')) {
          thrown = true;
          session.emit('node.started', { nodeId: 'tool:b', kind: 'tool', name: 'b', instanceId: 'b1', input: 1 });
          throw new Error('unserialisable');
        }
        return { ...ARGS };
      },
    });
    session.emit('node.started', start as never);
    expect(thrown).toBe(true);
    session.emit('node.started', { nodeId: 'tool:c', kind: 'tool', name: 'c', instanceId: 'c1', input: 1 });
    await waitUntil(() => viewer.ofType('node.started').length === 2, 3000, 'b1 and c1');
    expect(viewer.ofType('node.started').map((f) => f.payload['instanceId'])).toEqual(['b1', 'c1']);
    const seqs = viewer.received.map((f) => f.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(seqs); // strictly increasing in wire order
    expect(session.stats().seq).toBe(Math.max(...seqs) + 1);
  });
});
