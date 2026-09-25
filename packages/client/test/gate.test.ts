/**
 * Gate semantics against a live fake viewer: hold/resume with every action,
 * parallel independence, step mode, breakpoint management, pause timeout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, resultGateOptions, unsupportedGateOptions, type GateNode, type Session } from '../src/index.js';
import { FakeViewer, tick, waitUntil } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function attachedSession(
  viewer: FakeViewer,
  extra: Parameters<typeof createSession>[0] = {},
): Promise<Session> {
  const session = createSession({
    url: viewer.url,
    enabled: true,
    retryIntervalMs: 60_000,
    ...extra,
  });
  cleanups.push(() => session.dispose());
  session.emit('graph.hint', { nodes: [] }); // trigger lazy connect
  await waitUntil(() => session.attached, 3000, 'session attach');
  return session;
}

describe('gate', () => {
  it('holds at a matching breakpoint until resumed, then continues', async () => {
    const viewer = await FakeViewer.start({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }],
    });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    const startedAt = Date.now();
    const gatePromise = session.gate('before', {
      nodeId: 'n1',
      kind: 'tool',
      name: 'searchFlights',
    });

    const paused = await viewer.waitForType('exec.paused');
    expect(paused.payload['nodeId']).toBe('n1');
    expect(paused.payload['point']).toBe('before');

    await tick(150);
    expect(session.stats().heldGates).toBe(1);

    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    const decision = await gatePromise;
    expect(decision).toEqual({ action: 'continue' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);

    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['action']).toBe('continue');
    expect(session.stats().heldGates).toBe(0);
  });

  it('does not pause on non-matching nodes or points', async () => {
    const viewer = await FakeViewer.start({
      breakpoints: [{ kind: 'tool', name: 'searchFlights' }], // point defaults to 'before'
    });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    for (const [point, node] of [
      ['before', { nodeId: 'n1', kind: 'llm', name: 'searchFlights' }],
      ['before', { nodeId: 'n2', kind: 'tool', name: 'checkWeather' }],
      ['after', { nodeId: 'n3', kind: 'tool', name: 'searchFlights' }],
      ['error', { nodeId: 'n4', kind: 'tool', name: 'searchFlights' }],
    ] as const) {
      expect(await session.gate(point, node)).toEqual({ action: 'continue' });
    }
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('inject returns the viewer-provided output', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ name: 'convertCurrency', point: 'error' }] });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    const gatePromise = session.gate('error', { nodeId: 'n1', kind: 'tool', name: 'convertCurrency' });
    const paused = await viewer.waitForType('exec.paused');
    const injected = { amount: 100, converted: 91.3, note: 'injected-by-debugger' };
    viewer.resume(paused.payload['pauseId'] as string, 'inject', injected);

    expect(await gatePromise).toEqual({ action: 'inject', output: injected });
  });

  it('retry decision is passed through', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ point: 'error' }] });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    const gatePromise = session.gate('error', { nodeId: 'n1', kind: 'tool', name: 'x' });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'retry');
    expect(await gatePromise).toEqual({ action: 'retry' });
  });

  it('abort aborts the run AbortController with an AbortError reason', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'llm' }] });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    await expect(
      session.run('trip-planner', async (ctx) => {
        const decision = await (async () => {
          const gatePromise = session.gate('before', { nodeId: 'step-1', kind: 'llm', name: 'step' });
          const paused = await viewer.waitForType('exec.paused');
          viewer.resume(paused.payload['pauseId'] as string, 'abort');
          return gatePromise;
        })();
        expect(decision).toEqual({ action: 'abort' });
        expect(ctx.signal.aborted).toBe(true);
        expect((ctx.signal.reason as Error).name).toBe('AbortError');
        throw ctx.signal.reason; // what an adapter does with an abort decision
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // run.finished must record the abort
    const finished = await viewer.waitForType('run.finished');
    expect(finished.payload['status']).toBe('aborted');
  });

  it('parallel gates are independent', async () => {
    const viewer = await FakeViewer.start({
      breakpoints: [
        { kind: 'tool', name: 'checkWeather' },
        { kind: 'tool', name: 'convertCurrency' },
      ],
    });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    let weatherDone = false;
    let currencyDone = false;
    const weather = session
      .gate('before', { nodeId: 'w', kind: 'tool', name: 'checkWeather' })
      .then((d) => { weatherDone = true; return d; });
    const currency = session
      .gate('before', { nodeId: 'c', kind: 'tool', name: 'convertCurrency' })
      .then((d) => { currencyDone = true; return d; });

    await waitUntil(() => viewer.ofType('exec.paused').length === 2, 3000, 'both gates held');
    expect(session.stats().heldGates).toBe(2);

    const pausedWeather = viewer.received.find(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'w',
    );
    const pausedCurrency = viewer.received.find(
      (f) => f.type === 'exec.paused' && f.payload['nodeId'] === 'c',
    );
    viewer.resume(pausedWeather?.payload['pauseId'] as string, 'continue');
    await weather;
    expect(weatherDone).toBe(true);

    await tick(120); // the other one must still be held
    expect(currencyDone).toBe(false);
    expect(session.stats().heldGates).toBe(1);

    viewer.resume(pausedCurrency?.payload['pauseId'] as string, 'continue');
    expect(await currency).toEqual({ action: 'continue' });
  });

  it('step mode pauses every before/error gate; mode.set run stops it', async () => {
    const viewer = await FakeViewer.start({ mode: 'step' });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    const gatePromise = session.gate('before', { nodeId: 'n1', kind: 'agent', name: 'anything' });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gatePromise;

    // 'after' does not pause in step mode
    expect(await session.gate('after', { nodeId: 'n1', kind: 'agent', name: 'anything' })).toEqual({
      action: 'continue',
    });

    viewer.setMode('run');
    await tick(50);
    expect(await session.gate('before', { nodeId: 'n2', kind: 'agent', name: 'anything' })).toEqual({
      action: 'continue',
    });
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('breakpoint.set adds and breakpoint.clear removes matchers live', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    // no breakpoints: passes
    expect(await session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });

    viewer.setBreakpoint({ kind: 'tool', name: 'x' });
    await tick(50);
    const gatePromise = session.gate('before', { nodeId: 'n2', kind: 'tool', name: 'x' });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    await gatePromise;

    viewer.clearBreakpoint({ kind: 'tool', name: 'x' });
    await tick(50);
    expect(await session.gate('before', { nodeId: 'n3', kind: 'tool', name: 'x' })).toEqual({
      action: 'continue',
    });
    expect(viewer.ofType('exec.paused')).toHaveLength(1);
  });

  it('pauseTimeoutMs auto-continues an unresumed gate and emits exec.resumed', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{}] });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer, { pauseTimeoutMs: 200 });

    const startedAt = Date.now();
    const decision = await session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'slow' });
    expect(decision).toEqual({ action: 'continue' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);

    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload['action']).toBe('continue');
    expect(session.stats().heldGates).toBe(0);
  });

  it('resume for an unknown pauseId is ignored', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ name: 'x' }] });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer);

    const gatePromise = session.gate('before', { nodeId: 'n1', kind: 'tool', name: 'x' });
    await viewer.waitForType('exec.paused');
    viewer.resume('pause_does_not_exist', 'abort');
    await tick(100);
    expect(session.stats().heldGates).toBe(1); // still held

    const paused = viewer.ofType('exec.paused')[0];
    viewer.resume(paused?.payload['pauseId'] as string, 'continue');
    expect(await gatePromise).toEqual({ action: 'continue' });
  });
});

/*
 * A gate whose adapter cannot carry out an action (a streamed model step's
 * after gate cannot retry or inject, a LangChain callback gate only observes)
 * refuses it instead of quietly continuing: exec.refused 'unsupported', the
 * gate stays held, and no exec.resumed claims the action.
 */
describe('actions a gate cannot carry out (unsupportedActions)', () => {
  const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };

  async function heldLlmGate(
    unsupportedActions: unknown,
    viewerExtra: Parameters<typeof FakeViewer.start>[0] = {},
    sessionExtra: Parameters<typeof createSession>[0] = {},
  ) {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'llm', point: 'after' }], ...viewerExtra });
    cleanups.push(() => viewer.close());
    const session = await attachedSession(viewer, sessionExtra);
    const gate = session.gate('after', LLM, { result: {}, unsupportedActions } as never);
    const paused = await viewer.waitForType('exec.paused');
    return { viewer, session, gate, pauseId: paused.payload['pauseId'] as string };
  }

  it('refuses retry and inject with unsupported and stays held; continue then releases it', async () => {
    const { viewer, session, gate, pauseId } = await heldLlmGate(['retry', 'inject'], { hubCapabilities: [] });
    viewer.resumeWith({ pauseId, action: 'retry', requestId: 'r1' });
    const first = await viewer.waitForType('exec.refused');
    expect(first.payload).toEqual({
      pauseId,
      code: 'unsupported',
      message: 'this pause cannot run the call again; continue or abort',
      requestId: 'r1',
    });
    viewer.resume(pauseId, 'inject', { text: 'nope' });
    await waitUntil(() => viewer.ofType('exec.refused').length === 2, 3000, 'second refusal');
    expect(viewer.ofType('exec.refused')[1]?.payload).toMatchObject({
      pauseId,
      code: 'unsupported',
      message: 'this pause cannot substitute a value for the call; continue or abort',
    });
    await tick(50);
    expect(session.stats().heldGates).toBe(1);
    expect(viewer.ofType('exec.resumed')).toHaveLength(0);

    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
    expect((await viewer.waitForType('exec.resumed')).payload).toMatchObject({ pauseId, action: 'continue' });
  });

  it('an action the gate did not list works as before (retry where only inject is unsupported)', async () => {
    const { viewer, gate, pauseId } = await heldLlmGate(['inject'], { hubCapabilities: [] });
    viewer.resume(pauseId, 'inject', { text: 'nope' });
    expect((await viewer.waitForType('exec.refused')).payload).toMatchObject({
      code: 'unsupported',
      message: 'this pause cannot substitute a value for the call; continue, retry or abort',
    });
    viewer.resume(pauseId, 'retry');
    expect(await gate).toEqual({ action: 'retry' });
  });

  it('abort always works', async () => {
    const { viewer, gate, pauseId } = await heldLlmGate(['retry', 'inject']);
    viewer.resume(pauseId, 'abort');
    expect(await gate).toEqual({ action: 'abort' });
  });

  it('a 0.5 debugger (no hubCapabilities) cannot show the refusal: the app log says it', async () => {
    const warnings: string[] = [];
    const { viewer, session, gate, pauseId } = await heldLlmGate(['retry'], {}, { logger: (m) => warnings.push(m) });
    viewer.resume(pauseId, 'retry');
    await viewer.waitForType('exec.refused');
    expect(warnings.some((w) => w.includes('refused retry') && w.includes('still paused'))).toBe(true);
    expect(session.stats().heldGates).toBe(1);
    viewer.resume(pauseId, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });

  it.each([
    ['a string', 'retry'],
    ['unknown actions', ['continue', 'abort', 'jump']],
    [
      'an array that throws when read',
      new Proxy([], {
        get() {
          throw new Error('boom');
        },
      }),
    ],
  ])('a malformed list (%s) refuses nothing and never breaks the gate', async (_label, list) => {
    const { viewer, gate, pauseId } = await heldLlmGate(list);
    viewer.resume(pauseId, 'retry');
    expect(await gate).toEqual({ action: 'retry' });
    expect(viewer.ofType('exec.refused')).toHaveLength(0);
  });

  it('detached, the helpers hand the gate no options at all', () => {
    const detached = { attached: false };
    expect(resultGateOptions(detached, { a: 1 }, ['retry'])).toBeUndefined();
    expect(unsupportedGateOptions(detached, ['inject'])).toBeUndefined();
    const attached = { attached: true };
    expect(resultGateOptions(attached, { a: 1 })).toEqual({ result: { a: 1 } });
    expect(resultGateOptions(attached, { a: 1 }, ['retry'])).toEqual({ result: { a: 1 }, unsupportedActions: ['retry'] });
    expect(unsupportedGateOptions(attached, ['inject'])).toEqual({ unsupportedActions: ['inject'] });
  });
});

/*
 * The adapter's own release: once nobody waits for a gate's decision (the host
 * cancelled the stream a held model step was about to hand over), the hold is
 * released with continue — fail-open, like a pause timeout.
 */
describe('a gate released by its own signal (GateOptions.signal)', () => {
  const LLM: GateNode = { nodeId: 'llm:step', kind: 'llm', name: 'step' };

  async function llmAfterViewer() {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'llm', point: 'after' }] });
    cleanups.push(() => viewer.close());
    return { viewer, session: await attachedSession(viewer) };
  }

  it('an abort while held releases the gate with continue (no requestId)', async () => {
    const { viewer, session } = await llmAfterViewer();
    const controller = new AbortController();
    const gate = session.gate('after', LLM, { result: {}, signal: controller.signal });
    const paused = await viewer.waitForType('exec.paused');
    expect(session.stats().heldGates).toBe(1);
    controller.abort();
    expect(await gate).toEqual({ action: 'continue' });
    expect(session.stats().heldGates).toBe(0);
    const resumed = await viewer.waitForType('exec.resumed');
    expect(resumed.payload).toMatchObject({ pauseId: paused.payload['pauseId'], action: 'continue' });
    expect(resumed.payload['requestId']).toBeUndefined();
  });

  it('an already-aborted signal never holds', async () => {
    const { viewer, session } = await llmAfterViewer();
    const controller = new AbortController();
    controller.abort();
    expect(await session.gate('after', LLM, { result: {}, signal: controller.signal })).toEqual({ action: 'continue' });
    await tick(50);
    expect(viewer.ofType('exec.paused')).toHaveLength(0);
  });

  it('after a normal resume the signal is let go: a later abort changes nothing', async () => {
    const { viewer, session } = await llmAfterViewer();
    const controller = new AbortController();
    const gate = session.gate('after', LLM, { result: {}, signal: controller.signal });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'abort');
    expect(await gate).toEqual({ action: 'abort' });
    controller.abort();
    await tick(50);
    expect(viewer.ofType('exec.resumed').map((f) => f.payload['action'])).toEqual(['abort']);
  });

  it('a value that is not an AbortSignal is ignored (the gate holds as usual)', async () => {
    const { viewer, session } = await llmAfterViewer();
    const gate = session.gate('after', LLM, { result: {}, signal: { aborted: 'no' } as never });
    const paused = await viewer.waitForType('exec.paused');
    viewer.resume(paused.payload['pauseId'] as string, 'continue');
    expect(await gate).toEqual({ action: 'continue' });
  });
});
