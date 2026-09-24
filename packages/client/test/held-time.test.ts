/**
 * Held time is not run time — through the real session and a live fake viewer.
 *
 * `durationMs` stays exactly what the adapter measured (wall clock, held
 * time included). The session pins every gate hold to the node instance it
 * belongs to and stamps the sum onto `node.finished` / `node.error` as the
 * loose field `heldMs`, measured on an injectable monotonic clock so the
 * numbers here are exact rather than "roughly the sleep".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, type Session } from '../src/index.js';
import { FakeViewer, tick, waitUntil, type ReceivedFrame } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A clock the test advances by hand. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

async function attached(
  viewer: FakeViewer,
  extra: Parameters<typeof createSession>[0] = {},
): Promise<Session> {
  const session = createSession({ url: viewer.url, enabled: true, retryIntervalMs: 60_000, ...extra });
  cleanups.push(() => session.dispose());
  session.emit('graph.hint', { nodes: [] });
  await waitUntil(() => session.attached, 3000, 'attach');
  return session;
}

function finishedFor(viewer: FakeViewer, instanceId: string): Promise<ReceivedFrame> {
  return viewer.waitFor((f) => f.type === 'node.finished' && f.payload['instanceId'] === instanceId);
}

describe('heldMs on node.finished', () => {
  it('is the exact time the before-gate was held; durationMs is left untouched', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool', name: 'search' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });

    await session.run('agent', async () => {
      session.emit('node.started', { nodeId: 'tool:search', kind: 'tool', name: 'search', instanceId: 'c1' });
      const gate = session.gate('before', { nodeId: 'tool:search', kind: 'tool', name: 'search' });
      const paused = await viewer.waitForType('exec.paused');
      clock.advance(38_100.123); // the developer thinks for 38 s
      viewer.resume(paused.payload['pauseId'] as string, 'continue');
      await gate;
      session.emit('node.finished', {
        nodeId: 'tool:search',
        instanceId: 'c1',
        durationMs: 38_102.4, // what the adapter measured: hold + 2.4 ms of work
        status: 'ok',
      });
    });

    const finished = await finishedFor(viewer, 'c1');
    expect(finished.payload['durationMs']).toBe(38_102.4);
    expect(finished.payload['heldMs']).toBe(38_100.12);
  });

  it('is 0 for an instance that ran through without a hold (measured, not missing)', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = await attached(viewer);

    session.emit('node.started', { nodeId: 'tool:fast', kind: 'tool', name: 'fast', instanceId: 'c1' });
    await session.gate('before', { nodeId: 'tool:fast', kind: 'tool', name: 'fast' }); // no breakpoint → no hold
    session.emit('node.finished', { nodeId: 'tool:fast', instanceId: 'c1', durationMs: 0.07, status: 'ok' });

    const finished = await finishedFor(viewer, 'c1');
    expect(finished.payload['durationMs']).toBe(0.07);
    expect(finished.payload['heldMs']).toBe(0);
  });

  it('is omitted for an instance the session never saw start', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = await attached(viewer);

    session.emit('node.finished', { nodeId: 'tool:x', instanceId: 'never-started', durationMs: 3, status: 'ok' });
    const finished = await finishedFor(viewer, 'never-started');
    expect('heldMs' in finished.payload).toBe(false);
  });

  it('sums every hold inside one instance across a retry loop, and node.error carries the running total', async () => {
    const viewer = await FakeViewer.start({
      breakpoints: [
        { kind: 'tool', name: 'flaky', point: 'before' },
        { kind: 'tool', name: 'flaky', point: 'error' },
      ],
    });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const node = { nodeId: 'tool:flaky', kind: 'tool', name: 'flaky' } as const;

    const holdAndResume = async (point: 'before' | 'error', ms: number, action: 'continue' | 'retry') => {
      const seen = viewer.ofType('exec.paused').length;
      const gate = session.gate(point, node);
      await viewer.waitFor((f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').length > seen);
      const paused = viewer.ofType('exec.paused')[seen];
      clock.advance(ms);
      viewer.resume(paused?.payload['pauseId'] as string, action);
      return gate;
    };

    await session.run('agent', async () => {
      session.emit('node.started', { nodeId: 'tool:flaky', kind: 'tool', name: 'flaky', instanceId: 'c1' });
      await holdAndResume('before', 1000, 'continue');
      // attempt 1 throws → node.error → error gate → retry
      session.emit('node.error', { nodeId: 'tool:flaky', instanceId: 'c1', error: { name: 'E', message: 'boom' } });
      expect(await holdAndResume('error', 2000, 'retry')).toEqual({ action: 'retry' });
      // back to the top of the loop: same instance, before gate again
      await holdAndResume('before', 300, 'continue');
      session.emit('node.finished', { nodeId: 'tool:flaky', instanceId: 'c1', durationMs: 3305.5, status: 'ok' });
    });

    const errored = await viewer.waitForType('node.error');
    expect(errored.payload['heldMs']).toBe(1000); // only the before-hold had happened
    const finished = await finishedFor(viewer, 'c1');
    expect(finished.payload['heldMs']).toBe(3300);
    expect(finished.payload['durationMs']).toBe(3305.5);
  });

  it('does not credit a hold that opens after the instance finished (LangGraph error-gate ordering)', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ point: 'error' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { nodeId: 'tool:t', kind: 'tool', name: 't', instanceId: 'c1' });
    session.emit('node.finished', { nodeId: 'tool:t', instanceId: 'c1', durationMs: 12, status: 'error' });
    const gate = session.gate('error', node);
    const paused = await viewer.waitForType('exec.paused');
    clock.advance(40_000);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    // The graph retries the node: a fresh instance whose durationMs never held.
    session.emit('node.started', { nodeId: 'tool:t', kind: 'tool', name: 't', instanceId: 'c2' });
    session.emit('node.finished', { nodeId: 'tool:t', instanceId: 'c2', durationMs: 9, status: 'ok' });

    expect((await finishedFor(viewer, 'c1')).payload['heldMs']).toBe(0);
    expect((await finishedFor(viewer, 'c2')).payload['heldMs']).toBe(0);
  });

  it('keeps concurrent instances of the same tool apart when each hold follows its own start', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool', name: 'search' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const node = { nodeId: 'tool:search', kind: 'tool', name: 'search' } as const;

    // ai@7 invokes parallel tool calls concurrently: start A, gate A, start B, gate B.
    session.emit('node.started', { ...node, instanceId: 'A' });
    const gateA = session.gate('before', node);
    session.emit('node.started', { ...node, instanceId: 'B' });
    const gateB = session.gate('before', node);
    await viewer.waitFor((f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').length === 2);
    const [pA, pB] = viewer.ofType('exec.paused');
    clock.advance(2000);
    viewer.resume(pA?.payload['pauseId'] as string, 'continue');
    await gateA;
    clock.advance(2000);
    viewer.resume(pB?.payload['pauseId'] as string, 'continue');
    await gateB;
    // A is slow, B is fast: B finishes first — its heldMs must not absorb A's.
    session.emit('node.finished', { nodeId: 'tool:search', instanceId: 'B', durationMs: 4010, status: 'ok' });
    session.emit('node.finished', { nodeId: 'tool:search', instanceId: 'A', durationMs: 9000, status: 'ok' });

    expect((await finishedFor(viewer, 'A')).payload['heldMs']).toBe(2000);
    expect((await finishedFor(viewer, 'B')).payload['heldMs']).toBe(4000);
  });

  it('keeps runs apart while both holds are open at once', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;
    const bothPaused = () => viewer.ofType('exec.paused').length === 2;
    const pausedIn = (runId: string) => viewer.ofType('exec.paused').find((f) => f.runId === runId);

    await Promise.all([
      session.run('one', async (ctx) => {
        session.emit('node.started', { ...node, instanceId: 'i1' });
        const gate = session.gate('before', node);
        await waitUntil(bothPaused, 5000, 'both runs held');
        clock.advance(500); // both holds are open during this
        viewer.resume(pausedIn(ctx.runId)?.payload['pauseId'] as string, 'continue');
        await gate;
        session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 501, status: 'ok' });
      }),
      session.run('two', async (ctx) => {
        session.emit('node.started', { ...node, instanceId: 'i1' });
        const gate = session.gate('before', node);
        await viewer.waitForType('exec.resumed'); // run one released first
        clock.advance(70); // only this hold is open now
        viewer.resume(pausedIn(ctx.runId)?.payload['pauseId'] as string, 'continue');
        await gate;
        session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 571, status: 'ok' });
      }),
    ]);

    await viewer.waitFor((f) => f.type === 'node.finished' && viewer.ofType('node.finished').length === 2);
    const finished = viewer.ofType('node.finished');
    const byDuration = Object.fromEntries(finished.map((f) => [f.payload['durationMs'], f.payload['heldMs']]));
    // Same nodeId, same instanceId, different runs: each got exactly its own hold.
    expect(byDuration).toEqual({ 501: 500, 571: 570 });
  }, 10_000);

  it('a fail-open release (viewer gone) still closes the hold and credits the time held so far', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now, retryIntervalMs: 50 });
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { ...node, instanceId: 'i1' });
    const gate = session.gate('before', node);
    await viewer.waitForType('exec.paused');
    clock.advance(1234.5);
    viewer.dropConnections();
    expect(await gate).toEqual({ action: 'continue' }); // fail open
    await waitUntil(() => session.attached, 5000, 're-attach');
    session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 1240, status: 'ok' });

    const finished = await finishedFor(viewer, 'i1');
    expect(finished.payload['heldMs']).toBe(1234.5);
  });

  it('respects a heldMs the adapter already set', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { ...node, instanceId: 'i1' });
    const gate = session.gate('before', node);
    const paused = await viewer.waitForType('exec.paused');
    clock.advance(999);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 1000, status: 'ok', heldMs: 5 } as never);

    expect((await finishedFor(viewer, 'i1')).payload['heldMs']).toBe(5);
  });

  it('credits a child hold to the open agent node above it, once, however many children were held', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const weather = { nodeId: 'tool:weather', kind: 'tool', name: 'weather' } as const;
    const currency = { nodeId: 'tool:currency', kind: 'tool', name: 'currency' } as const;

    await session.run('trip', async () => {
      session.emit('node.started', { nodeId: 'agent:trip', kind: 'agent', name: 'trip', instanceId: 'r1' });
      session.emit('node.started', { ...weather, instanceId: 'w1', parentId: 'agent:trip' });
      const gateW = session.gate('before', weather);
      session.emit('node.started', { ...currency, instanceId: 'c1', parentId: 'agent:trip' });
      const gateC = session.gate('before', currency);
      await viewer.waitFor((f) => f.type === 'exec.paused' && viewer.ofType('exec.paused').length === 2);
      const [pW, pC] = viewer.ofType('exec.paused');
      clock.advance(3000); // both held
      viewer.resume(pW?.payload['pauseId'] as string, 'continue');
      await gateW;
      clock.advance(500); // only currency held
      viewer.resume(pC?.payload['pauseId'] as string, 'continue');
      await gateC;
      session.emit('node.finished', { ...weather, instanceId: 'w1', durationMs: 3501, status: 'ok' });
      session.emit('node.finished', { ...currency, instanceId: 'c1', durationMs: 3502, status: 'ok' });
      session.emit('node.finished', { nodeId: 'agent:trip', instanceId: 'r1', durationMs: 3510, status: 'ok' });
    });

    expect((await finishedFor(viewer, 'w1')).payload['heldMs']).toBe(3000);
    expect((await finishedFor(viewer, 'c1')).payload['heldMs']).toBe(3500);
    // The agent was held for 3.5 s of wall time, not 6.5 s.
    expect((await finishedFor(viewer, 'r1')).payload['heldMs']).toBe(3500);
  });

  it('normalises a raw durationMs on the way out (two decimals, never negative or NaN)', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = await attached(viewer);
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'a', durationMs: 3.14159, status: 'ok' });
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'b', durationMs: -5, status: 'ok' });
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'c', durationMs: Number.NaN, status: 'ok' });
    session.emit('node.finished', { nodeId: 'tool:a', instanceId: 'd', durationMs: 12, status: 'ok' });
    expect((await finishedFor(viewer, 'a')).payload['durationMs']).toBe(3.14);
    expect((await finishedFor(viewer, 'b')).payload['durationMs']).toBe(0);
    expect((await finishedFor(viewer, 'c')).payload['durationMs']).toBe(0);
    expect((await finishedFor(viewer, 'd')).payload['durationMs']).toBe(12);
  });

  it('exec.paused / exec.resumed still carry only what they always did (wire shape unchanged)', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const session = await attached(viewer);
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { ...node, instanceId: 'i1' });
    const gate = session.gate('before', node);
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    const resumed = await viewer.waitForType('exec.resumed');
    // + `reason` (0.6.0: every hold carries one), never anything held-time related.
    expect(Object.keys(paused.payload).sort()).toEqual(['nodeId', 'pauseId', 'point', 'reason']);
    expect(Object.keys(resumed.payload).sort()).toEqual(['action', 'pauseId']);
  });

  it('measures a real hold with the default clock at sub-millisecond resolution', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const session = await attached(viewer);
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { ...node, instanceId: 'i1' });
    const gate = session.gate('before', node);
    const paused = await viewer.waitForType('exec.paused');
    await tick(120);
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gate;
    session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 130, status: 'ok' });

    const heldMs = (await finishedFor(viewer, 'i1')).payload['heldMs'] as number;
    expect(heldMs).toBeGreaterThanOrEqual(100);
    expect(heldMs).toBeLessThan(5000);
    expect(heldMs).toBe(Number(heldMs.toFixed(2)));
  });

  it('a hold that opens after the node finished (LangGraph error gate) is still held time on the open agent above it', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ point: 'error' }] });
    cleanups.push(() => viewer.close());
    const clock = manualClock();
    const session = await attached(viewer, { clock: clock.now });
    const tool = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    await session.run('graph', async (ctx) => {
      session.emit('node.started', { nodeId: 'agent:graph', kind: 'agent', name: 'graph', instanceId: ctx.runId });
      session.emit('node.started', { ...tool, instanceId: 'c1', parentId: 'agent:graph' });
      session.emit('node.finished', { nodeId: 'tool:t', instanceId: 'c1', durationMs: 12, status: 'error' });
      const gate = session.gate('error', tool);
      const paused = await viewer.waitForType('exec.paused');
      clock.advance(40_000);
      viewer.resume(paused.payload['pauseId'] as string, 'continue');
      await gate;
      session.emit('node.started', { ...tool, instanceId: 'c2', parentId: 'agent:graph' });
      session.emit('node.finished', { nodeId: 'tool:t', instanceId: 'c2', durationMs: 9, status: 'ok' });
      session.emit('node.finished', { nodeId: 'agent:graph', instanceId: ctx.runId, durationMs: 40_030, status: 'ok' });
    });

    expect((await finishedFor(viewer, 'c1')).payload['heldMs']).toBe(0);
    expect((await finishedFor(viewer, 'c2')).payload['heldMs']).toBe(0);
    const agent = await viewer.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'agent:graph');
    expect(agent.payload['heldMs']).toBe(40_000); // the agent ran 30 ms, not 40 s
  });

  it('a hold released by pauseTimeoutMs (nobody answered) is credited like any other', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const session = await attached(viewer, { pauseTimeoutMs: 60 });
    const node = { nodeId: 'tool:t', kind: 'tool', name: 't' } as const;

    session.emit('node.started', { ...node, instanceId: 'i1' });
    const decision = await session.gate('before', node); // no resume: the timeout releases it
    expect(decision).toEqual({ action: 'continue' });
    session.emit('node.finished', { ...node, instanceId: 'i1', durationMs: 70, status: 'ok' });

    const heldMs = (await finishedFor(viewer, 'i1')).payload['heldMs'] as number;
    expect(heldMs).toBeGreaterThanOrEqual(50);
    expect(heldMs).toBeLessThan(5000);
  });
});
