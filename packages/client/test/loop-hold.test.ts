/**
 * Loop hold through a live session: the Nth identical tool call made
 * back-to-back (rule v3: no other watched call of the same kind between)
 * is held at its before-gate while a debugger is attached — through the
 * normal gate path, so every resume action, the pause timeout and fail-open
 * release keep their meaning — and is merely warned about when nobody is
 * attached or the mode says warn.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { createSession, type Session, type SessionOptions } from '../src/index.js';
import type { GateNode } from '../src/gate-engine.js';
import type { WebSocketConstructor, WebSocketLike } from '../src/transport.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const FLIGHTS: GateNode = { nodeId: 'tool:searchFlights', kind: 'tool', name: 'searchFlights' };
const HOTELS: GateNode = { nodeId: 'tool:searchHotels', kind: 'tool', name: 'searchHotels' };
const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };
const ARGS = { from: 'AMS', to: 'LIS' };

let instances = 0;

/** What every adapter does: emit node.started, then await the before-gate. */
function call(session: Session, node: GateNode, input: unknown) {
  session.emit('node.started', {
    nodeId: node.nodeId,
    kind: node.kind,
    name: node.name,
    instanceId: `i${(instances += 1)}`,
    input,
  });
  return session.gate('before', node);
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

async function startViewer(options: Parameters<typeof FakeViewer.start>[0] = {}): Promise<FakeViewer> {
  const viewer = await FakeViewer.start(options);
  cleanups.push(() => viewer.close());
  return viewer;
}

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
    env: {},
    webSocket: NeverConnectsWS as unknown as WebSocketConstructor,
    retryIntervalMs: 60_000,
    logger: (message) => warnings.push(message),
    ...extra,
  });
  cleanups.push(() => session.dispose());
  return { session, warnings };
}

/** Resolves to the settled decision, or 'pending' if the gate is still held after `ms`. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return await Promise.race([promise, tick(ms).then(() => 'pending' as const)]);
}

describe('loop hold — attached, mode pause (default)', () => {
  it('holds the third identical call with reason loop, then every action keeps its meaning', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);

    expect(await call(session, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(await call(session, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    const third = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({
      nodeId: 'tool:searchFlights',
      point: 'before',
      reason: 'loop',
      loop: { repeats: 3 },
    });
    // The wire frame is a valid envelope with the loop fields where the
    // schema documents them.
    const parsed = parseEnvelope(paused);
    expect(parsed.kind).toBe('ok');

    // firstSeq/lastSeq are the REAL seqs of the node.started envelopes.
    const starts = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'tool:searchFlights')
      .map((f) => f.seq);
    expect(starts).toHaveLength(3);
    const loop = paused.payload['loop'] as { firstSeq: number; lastSeq: number; fingerprint: string };
    expect(loop.firstSeq).toBe(starts[0]);
    expect(loop.lastSeq).toBe(starts[2]);
    expect(loop.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(session.stats().heldGates).toBe(1);
    expect(await settledWithin(third, 100)).toBe('pending');

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['action']).toBe('continue');
    expect(session.stats().heldGates).toBe(0);

    // A fourth identical call is held again — the model is still looping.
    const fourth = call(session, FLIGHTS, ARGS);
    const again = await viewer.waitFor(
      (f) => f.type === 'exec.paused' && (f.payload['loop'] as { repeats: number })?.repeats === 4,
    );
    expect((again.payload['loop'] as { firstSeq: number }).firstSeq).toBe(loop.firstSeq);
    viewer.resume(again.payload['pauseId'] as string, 'inject', { flights: [] });
    expect(await fourth).toEqual({ action: 'inject', output: { flights: [] } });
  });

  it('trips on identical arguments in a different key order, not on different arguments', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);

    await call(session, FLIGHTS, { from: 'AMS', to: 'LIS' });
    await call(session, FLIGHTS, { to: 'LIS', from: 'AMS' });
    const gate = call(session, FLIGHTS, { to: 'LIS', from: 'AMS' });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['reason']).toBe('loop');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;

    // Different arguments each time: never held, however many.
    for (let i = 0; i < 6; i += 1) {
      expect(await call(session, HOTELS, { city: 'LIS', night: i })).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('ignores per-request _meta by default (not pagination); a custom ignoreKeys list replaces the default', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    // A walk through pages is not a loop: every page is a different call.
    for (const [cursor, page] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) {
      expect(await call(session, HOTELS, { city: 'LIS', cursor, page })).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    // A fresh MCP progressToken on every request does not hide a real loop.
    await call(session, HOTELS, { city: 'LIS', _meta: { progressToken: 1 } });
    await call(session, HOTELS, { city: 'LIS', _meta: { progressToken: 2 } });
    const gate = call(session, HOTELS, { city: 'LIS', _meta: { progressToken: 3 } });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['nodeId']).toBe('tool:searchHotels');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;

    // ignoreKeys replaces the default: `[]` makes the token count again...
    const strict = await attachedSession(viewer, { loopGuard: { ignoreKeys: [] } });
    for (const progressToken of [1, 2, 3, 4]) {
      expect(await call(strict, HOTELS, { city: 'LIS', _meta: { progressToken } })).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
    // ...and a caller who WANTS page walks treated as repeats can opt in.
    const pagesRepeat = await attachedSession(viewer, { loopGuard: { ignoreKeys: ['cursor'] } });
    await call(pagesRepeat, HOTELS, { city: 'LIS', cursor: 'a' });
    await call(pagesRepeat, HOTELS, { city: 'LIS', cursor: 'b' });
    const opted = call(pagesRepeat, HOTELS, { city: 'LIS', cursor: 'c' });
    // (pause ids are per session, so wait for the second frame, not a new id)
    await waitUntil(() => viewer.ofType('exec.paused').length === 2, 3000, 'the opted-in hold');
    const again = viewer.ofType('exec.paused')[1]!;
    expect(again.payload).toMatchObject({ nodeId: 'tool:searchHotels', reason: 'loop' });
    viewer.resume(again.payload['pauseId'] as string, 'continue');
    await opted;
  });

  it('a retry resume re-enters the same before-gate without counting as a new repeat', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await call(session, FLIGHTS, ARGS);
    await call(session, FLIGHTS, ARGS);
    const held = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await held).toEqual({ action: 'retry' });

    // The adapter loops back to gate('before') for the SAME instance — no
    // node.started — and must run straight through.
    const reentered = session.gate('before', FLIGHTS);
    expect(await settledWithin(reentered, 150)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('abort at a loop hold aborts the run context (like any gate)', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    let signalAborted = false;
    await session.run('agent', async (ctx) => {
      await call(session, FLIGHTS, ARGS);
      await call(session, FLIGHTS, ARGS);
      const held = call(session, FLIGHTS, ARGS);
      const paused = await viewer.waitForType('exec.paused');
      viewer.resume(paused.payload['pauseId'] as string, 'abort');
      expect(await held).toEqual({ action: 'abort' });
      signalAborted = ctx.signal.aborted;
    });
    expect(signalAborted).toBe(true);
  });

  it('is a built-in breakpoint: fires with no breakpoints in run mode, and only at the before point', async () => {
    const viewer = await startViewer({ breakpoints: [], mode: 'run' });
    const session = await attachedSession(viewer);
    await call(session, FLIGHTS, ARGS);
    await call(session, FLIGHTS, ARGS);
    const third = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });
    // after / error gates of the same node are not loop gates.
    expect(await settledWithin(session.gate('after', FLIGHTS), 100)).toEqual({ action: 'continue' });
    expect(await settledWithin(session.gate('error', FLIGHTS), 100)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('respects pauseTimeoutMs and fail-open release on disconnect', async () => {
    const viewer = await startViewer();
    const timed = await attachedSession(viewer, { pauseTimeoutMs: 120 });
    await call(timed, FLIGHTS, ARGS);
    await call(timed, FLIGHTS, ARGS);
    const t0 = Date.now();
    expect(await call(timed, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(viewer.ofType('exec.paused')).toHaveLength(1);

    const crash = await FakeViewer.start();
    const session = await attachedSession(crash);
    await call(session, FLIGHTS, ARGS);
    await call(session, FLIGHTS, ARGS);
    const held = call(session, FLIGHTS, ARGS);
    await crash.waitForType('exec.paused');
    crash.killAbruptly();
    expect(await held).toEqual({ action: 'continue' }); // FAIL OPEN
    expect(session.stats().heldGates).toBe(0);
  });

  it('watches only tools by default; kinds and allowNodes are configurable', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    for (let i = 0; i < 4; i += 1) {
      expect(await call(session, LLM, { messages: [{ role: 'user', content: 'hi' }] })).toEqual({
        action: 'continue',
      });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);

    const llm = await attachedSession(viewer, { loopGuard: { kinds: ['llm'], threshold: 2 } });
    await call(llm, LLM, { messages: [] });
    const held = call(llm, LLM, { messages: [] });
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['nodeId']).toBe('llm:step');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;

    const allow = await attachedSession(viewer, { loopGuard: { allowNodes: ['searchFlights'], threshold: 2 } });
    for (let i = 0; i < 5; i += 1) expect(await call(allow, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('threshold: option beats env beats default; 0 disables', async () => {
    const viewer = await startViewer();
    const byEnv = await attachedSession(viewer, { env: { GRAPHMIND_LOOP_THRESHOLD: '2' } });
    await call(byEnv, FLIGHTS, ARGS);
    const held = call(byEnv, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect((paused.payload['loop'] as { repeats: number }).repeats).toBe(2);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;

    const byOption = await attachedSession(viewer, {
      env: { GRAPHMIND_LOOP_THRESHOLD: '2' },
      loopGuard: { threshold: 4 },
    });
    for (let i = 0; i < 3; i += 1) expect(await call(byOption, HOTELS, ARGS)).toEqual({ action: 'continue' });
    const fourth = call(byOption, HOTELS, ARGS);
    const p4 = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'tool:searchHotels');
    expect((p4.payload['loop'] as { repeats: number }).repeats).toBe(4);
    viewer.resume(p4.payload['pauseId'] as string, 'continue');
    await fourth;

    const off = await attachedSession(viewer, { env: { GRAPHMIND_LOOP_THRESHOLD: '0' } });
    for (let i = 0; i < 6; i += 1) expect(await call(off, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    const disabled = await attachedSession(viewer, { loopGuard: false });
    for (let i = 0; i < 6; i += 1) expect(await call(disabled, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(2);
  });

  it('counts per run: the same tool looping in two concurrent runs is two independent streaks', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    const pausedRuns: string[] = [];

    const runA = session.run('A', async (ctx) => {
      await call(session, FLIGHTS, ARGS);
      await tick(10);
      await call(session, FLIGHTS, ARGS);
      await tick(10);
      const held = call(session, FLIGHTS, ARGS);
      const paused = await viewer.waitFor((f) => f.type === 'exec.paused' && f.runId === ctx.runId);
      pausedRuns.push(paused.runId);
      viewer.resume(paused.payload['pauseId'] as string, 'continue');
      await held;
    });
    const runB = session.run('B', async () => {
      // Only two identical calls here, interleaved with A's three: never held.
      await tick(5);
      expect(await call(session, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
      await tick(10);
      expect(await call(session, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
      // And a sibling tool with its own streak in B does not touch A's count.
      expect(await call(session, HOTELS, { city: 'LIS' })).toEqual({ action: 'continue' });
      expect(await call(session, HOTELS, { city: 'LIS' })).toEqual({ action: 'continue' });
    });
    await Promise.all([runA, runB]);
    expect(pausedRuns).toHaveLength(1);
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('parallel siblings with the same arguments (fan-out) hold once, and the other gates pass', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    // Three parallel calls of one tool with identical args: node.started x3,
    // then all three gates. Exactly one gate holds (the streak IS three
    // identical calls), the others run — no deadlock, no double hold.
    const gates = [call(session, FLIGHTS, ARGS), call(session, FLIGHTS, ARGS), call(session, FLIGHTS, ARGS)];
    const paused = await viewer.waitForType('exec.paused');
    await tick(50);
    expect(session.stats().heldGates).toBe(1);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await Promise.all(gates)).toEqual([
      { action: 'continue' },
      { action: 'continue' },
      { action: 'continue' },
    ]);
  });
});

describe('loop hold — detached, or mode warn / off', () => {
  it('detached: never holds, warns once per streak, and the fast path stays fast', async () => {
    const { session, warnings } = detachedSession();
    const node = FLIGHTS;
    for (let i = 0; i < 6; i += 1) {
      const t0 = performance.now();
      expect(await settledWithin(call(session, node, ARGS), 50)).toEqual({ action: 'continue' });
      expect(performance.now() - t0).toBeLessThan(20);
    }
    const loopWarnings = warnings.filter((w) => w.includes('possible loop'));
    expect(loopWarnings).toHaveLength(1);
    expect(loopWarnings[0]).toContain('searchFlights');
    expect(loopWarnings[0]).toContain('3×');
    expect(loopWarnings[0]).toContain('no debugger is attached');

    // A new streak (different args, then identical again) may warn again —
    // but the warner rate-limits per node, so within the interval it is silent.
    await call(session, node, { other: 1 });
    for (let i = 0; i < 3; i += 1) await call(session, node, { other: 1 });
    expect(warnings.filter((w) => w.includes('possible loop'))).toHaveLength(1);
    // A different node has its own warning.
    for (let i = 0; i < 3; i += 1) await call(session, HOTELS, ARGS);
    expect(warnings.filter((w) => w.includes('possible loop'))).toHaveLength(2);
  });

  it('mode warn, attached: never holds, warns once, says why it did not hold', async () => {
    const viewer = await startViewer();
    const warnings: string[] = [];
    const session = await attachedSession(viewer, {
      env: { GRAPHMIND_ON_LOOP: 'warn' },
      logger: (message) => warnings.push(message),
    });
    for (let i = 0; i < 6; i += 1) {
      expect(await settledWithin(call(session, FLIGHTS, ARGS), 50)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    const loopWarnings = warnings.filter((w) => w.includes('possible loop'));
    expect(loopWarnings).toHaveLength(1);
    expect(loopWarnings[0]).toContain('GRAPHMIND_ON_LOOP=warn');

    // The option form wins over the env.
    const viaOption = await attachedSession(viewer, {
      env: { GRAPHMIND_ON_LOOP: 'pause' },
      loopGuard: { mode: 'warn' },
      logger: (message) => warnings.push(message),
    });
    for (let i = 0; i < 4; i += 1) expect(await call(viaOption, HOTELS, ARGS)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('mode off: nothing — no hold, no warning, attached or not', async () => {
    const viewer = await startViewer();
    const warnings: string[] = [];
    const session = await attachedSession(viewer, {
      env: { GRAPHMIND_ON_LOOP: 'off' },
      logger: (message) => warnings.push(message),
    });
    for (let i = 0; i < 8; i += 1) expect(await call(session, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    const { session: detached, warnings: detachedWarnings } = detachedSession({ env: { GRAPHMIND_ON_LOOP: 'off' } });
    for (let i = 0; i < 8; i += 1) expect(await call(detached, FLIGHTS, ARGS)).toEqual({ action: 'continue' });
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    expect(warnings.filter((w) => w.includes('loop'))).toHaveLength(0);
    expect(detachedWarnings.filter((w) => w.includes('loop'))).toHaveLength(0);
  });

  it('a debugger that attaches mid-loop holds on the next identical call at or past the threshold', async () => {
    // Detached counting is what makes an attach-late debugger useful: the
    // streak is already known when the developer arrives.
    const viewer = await startViewer();
    const session = createSession({ url: viewer.url, enabled: true, env: {}, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());
    // Two identical calls before the handshake completes are still counted.
    session.emit('node.started', { nodeId: FLIGHTS.nodeId, kind: 'tool', name: FLIGHTS.name, instanceId: 'a', input: ARGS });
    session.emit('node.started', { nodeId: FLIGHTS.nodeId, kind: 'tool', name: FLIGHTS.name, instanceId: 'b', input: ARGS });
    await waitUntil(() => session.attached, 3000, 'attach');
    const held = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect((paused.payload['loop'] as { repeats: number }).repeats).toBe(3);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;
  });
});

// ── Loop hold v3: a loop is the same call BACK-TO-BACK (decisions.md) ─────────
// v2 kept a streak per (run, nodeId) that other tools never reset. Under
// `graphmind mcp-proxy` the whole host session is ONE run, so an agent calling
// `list_issues({})` at minute 1, 20 and 45 — dozens of other tools between —
// had its third call held as "Loop: 3× list_issues". These tests fail on v2.
describe('loop hold v3 — back-to-back only', () => {
  const LIST_ISSUES: GateNode = { nodeId: 'tool:list_issues', kind: 'tool', name: 'list_issues' };
  const READ_FILE: GateNode = { nodeId: 'tool:read_file', kind: 'tool', name: 'read_file' };
  const SEARCH: GateNode = { nodeId: 'tool:search_code', kind: 'tool', name: 'search_code' };

  it('the long session: identical list_issues calls each separated by other tools are never held (live viewer)', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    // One process-long implicit run, like every request of a server app or
    // the whole host conversation through mcp-proxy.
    for (let round = 0; round < 6; round += 1) {
      expect(await settledWithin(call(session, LIST_ISSUES, {}), 300), `list_issues #${round + 1}`).toEqual({
        action: 'continue',
      });
      for (let k = 0; k < 4; k += 1) {
        expect(await settledWithin(call(session, READ_FILE, { path: `src/${round}-${k}.ts` }), 300)).toEqual({
          action: 'continue',
        });
        expect(await settledWithin(call(session, LLM, { messages: [round, k] }), 300)).toEqual({ action: 'continue' });
        // Constant-argument tools between the list_issues calls, too.
        expect(await settledWithin(call(session, SEARCH, { q: 'TODO' }), 300)).toEqual({ action: 'continue' });
      }
    }
    await waitUntil(
      () => viewer.ofType('node.started').filter((f) => f.payload['nodeId'] === 'tool:list_issues').length === 6,
      3000,
      'six list_issues starts on the wire',
    );
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    expect(session.stats().heldGates).toBe(0);

    // ...while the same session still holds a real back-to-back loop.
    await call(session, LIST_ISSUES, {});
    await call(session, LIST_ISSUES, {});
    const third = call(session, LIST_ISSUES, {});
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:list_issues', reason: 'loop', loop: { repeats: 3 } });
    const starts = viewer
      .ofType('node.started')
      .filter((f) => f.payload['nodeId'] === 'tool:list_issues')
      .map((f) => f.seq);
    const loop = paused.payload['loop'] as { firstSeq: number; lastSeq: number };
    expect(loop.firstSeq).toBe(starts.at(-3));
    expect(loop.lastSeq).toBe(starts.at(-1));
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });
  });

  it('detached, the long session never warns either', async () => {
    const { session, warnings } = detachedSession();
    for (let round = 0; round < 5; round += 1) {
      await call(session, LIST_ISSUES, {});
      await call(session, READ_FILE, { path: `f${round}` });
    }
    expect(warnings.filter((w) => w.includes('possible loop'))).toHaveLength(0);
  });

  it('a model alternating between two tools (search, read, search, read) is not held — the accepted v3 limit', async () => {
    // v2 held the third `search` here. v3 does not: another watched call
    // between two identical calls makes them not back-to-back.
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    for (let i = 0; i < 6; i += 1) {
      expect(await settledWithin(call(session, SEARCH, { q: 'same' }), 300)).toEqual({ action: 'continue' });
      expect(await settledWithin(call(session, READ_FILE, { path: 'same' }), 300)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('model -> tool -> model -> tool: an LLM step between identical tool calls does not break the streak', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await call(session, FLIGHTS, ARGS);
    await call(session, LLM, { messages: ['a'] });
    await call(session, FLIGHTS, ARGS);
    await call(session, LLM, { messages: ['a', 'b'] });
    const third = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:searchFlights', reason: 'loop', loop: { repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await third).toEqual({ action: 'continue' });
  });

  it('an allow-listed poller between identical calls is invisible; A, A, B, A, A is not held', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { loopGuard: { allowNodes: ['pollJob'] } });
    const POLL: GateNode = { nodeId: 'tool:pollJob', kind: 'tool', name: 'pollJob' };
    await call(session, FLIGHTS, ARGS);
    await call(session, POLL, { id: 1 });
    await call(session, FLIGHTS, ARGS);
    await call(session, POLL, { id: 1 });
    const held = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload).toMatchObject({ nodeId: 'tool:searchFlights', loop: { repeats: 3 } });
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;

    await call(session, HOTELS, ARGS);
    await call(session, HOTELS, ARGS);
    await call(session, FLIGHTS, { other: true });
    for (let i = 0; i < 2; i += 1) {
      expect(await settledWithin(call(session, HOTELS, ARGS), 300)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('a node.started whose input getter throws clears the streak, never throws, and the next identical call starts at 1', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer);
    await call(session, FLIGHTS, ARGS);
    await call(session, FLIGHTS, ARGS);
    expect(() =>
      session.emit('node.started', {
        nodeId: FLIGHTS.nodeId,
        kind: 'tool',
        name: FLIGHTS.name,
        instanceId: 'unreadable',
        get input(): never {
          throw new Error('not readable');
        },
      }),
    ).not.toThrow();
    for (let i = 0; i < 2; i += 1) {
      expect(await settledWithin(call(session, FLIGHTS, ARGS), 300)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
    const held = call(session, FLIGHTS, ARGS);
    const paused = await viewer.waitForType('exec.paused');
    expect((paused.payload['loop'] as { repeats: number }).repeats).toBe(3);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await held;
  });

  it('kinds [tool, llm]: two kinds keep independent streaks through a live session', async () => {
    const viewer = await startViewer();
    const session = await attachedSession(viewer, { loopGuard: { kinds: ['tool', 'llm'] } });
    const holds: Promise<unknown>[] = [];
    for (let i = 0; i < 2; i += 1) {
      await call(session, FLIGHTS, ARGS);
      await call(session, LLM, { messages: ['same'] });
    }
    holds.push(call(session, FLIGHTS, ARGS));
    const toolHold = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === FLIGHTS.nodeId);
    viewer.resume(toolHold.payload['pauseId'] as string, 'continue');
    await holds[0];
    holds.push(call(session, LLM, { messages: ['same'] }));
    const llmHold = await viewer.waitFor((f) => f.type === 'exec.paused' && f.payload['nodeId'] === LLM.nodeId);
    expect(llmHold.payload).toMatchObject({ reason: 'loop', loop: { repeats: 3 } });
    viewer.resume(llmHold.payload['pauseId'] as string, 'continue');
    await holds[1];
  });
});
