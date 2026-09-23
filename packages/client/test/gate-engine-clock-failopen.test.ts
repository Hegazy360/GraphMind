/**
 * A throwing clock must not strand held gates (fail-open).
 *
 * `settle()` unregisters a gate and clears its timer, then reads the clock to
 * compute `heldMs`, then resolves the gate. The clock is injectable (the
 * public `SessionOptions.clock`, or one installed with the exported
 * `setClock`), so it can throw. If that read escapes:
 *   - the gate is unregistered but its promise never settles (the host hangs);
 *   - `releaseAll()` stops at the first throw, so detach / dispose strand
 *     every other held gate too;
 *   - on the pause-timeout path the throw lands in a timer callback (an
 *     uncaught exception in the host).
 * Detach, dispose and pause timeouts auto-continue every held gate, whatever
 * the bookkeeping does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, type GateDecision, type Session } from '../src/index.js';
import { CONTINUE_DECISION, GateEngine, type GateEngineCallbacks, type GateNode } from '../src/gate-engine.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';

const NODE: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };

/** A clock that works until `break()` is called, then throws on every read. */
function breakableClock(): { now: () => number; break: () => void } {
  let t = 1000;
  let broken = false;
  return {
    now: () => {
      if (broken) throw new Error('clock exploded');
      return (t += 1);
    },
    break: () => {
      broken = true;
    },
  };
}

function engineRig(pauseTimeoutMs?: number) {
  let ids = 0;
  const paused: string[] = [];
  const resumed: string[] = [];
  const clock = breakableClock();
  const callbacks: GateEngineCallbacks = {
    newPauseId: () => `pause_${(ids += 1)}`,
    onPaused: (pauseId) => paused.push(pauseId),
    onResumed: (pauseId) => resumed.push(pauseId),
  };
  const engine = new GateEngine(callbacks, pauseTimeoutMs, clock.now);
  return { engine, paused, resumed, clock };
}

/** A promise's settled value, or 'pending' after a macrotask turn. */
async function state<T>(promise: Promise<T>): Promise<T | 'pending'> {
  const marker = Symbol('pending');
  const result = await Promise.race([promise, new Promise<symbol>((resolve) => setImmediate(() => resolve(marker)))]);
  return result === marker ? 'pending' : (result as T);
}

/** Settled value within `ms` of real time, or 'pending'. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  const marker = Symbol('pending');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise,
    new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(marker), ms);
    }),
  ]);
  clearTimeout(timer);
  return result === marker ? 'pending' : (result as T);
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('GateEngine — a throwing clock never strands a held gate', () => {
  it('releaseAll(): does not throw, and continues EVERY held gate', async () => {
    const { engine, paused, resumed, clock } = engineRig();
    const first = engine.hold('before', NODE, 'run_1');
    const second = engine.hold('before', { ...NODE, name: 'fetch', nodeId: 'tool:fetch' }, 'run_1');
    expect(paused).toHaveLength(2);

    clock.break(); // the clock fails AFTER both gates opened

    let thrown: unknown;
    try {
      engine.releaseAll();
    } catch (error) {
      thrown = error;
    }
    expect({
      thrown,
      heldAfter: engine.heldCount,
      firstState: await state(first),
      secondState: await state(second),
    }).toEqual({
      thrown: undefined,
      heldAfter: 0,
      firstState: CONTINUE_DECISION,
      secondState: CONTINUE_DECISION,
    });
    // Both releases are still announced (heldMs falls back to 0).
    expect(resumed).toEqual(paused);
  });

  it('a plain resume: the gate is released, nothing thrown', async () => {
    const { engine, paused, clock } = engineRig();
    const gate = engine.hold('before', NODE, 'run_1');
    clock.break();
    expect(() => engine.resume(paused[0] as string, 'abort')).not.toThrow();
    expect(await state(gate)).toEqual({ action: 'abort' });
    expect(engine.heldCount).toBe(0);
  });

  it('pause timeout: auto-continues the gate and throws nothing into the timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, clock } = engineRig(1000);
    const gate = engine.hold('before', NODE, 'run_1');

    clock.break();

    // fake-timers rethrows an exception raised inside a timer callback; with
    // real timers it would be an uncaught exception in the host process.
    let thrownIntoTimer: unknown;
    try {
      vi.advanceTimersByTime(1000);
    } catch (error) {
      thrownIntoTimer = error;
    }
    vi.useRealTimers();
    expect({ thrownIntoTimer, heldAfter: engine.heldCount, gateState: await state(gate) }).toEqual({
      thrownIntoTimer: undefined,
      heldAfter: 0,
      gateState: CONTINUE_DECISION,
    });
  });
});

describe('Session — a throwing injected clock never strands a held gate', () => {
  it('a debugger disconnect auto-continues every held gate', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = breakableClock();
    const session: Session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      clock: clock.now,
      logger: () => {},
    });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);

    // Two concurrent tool calls, both held at their before-gate.
    const gateA = session.gate('before', { nodeId: 'tool:search', kind: 'tool', name: 'search' });
    const gateB = session.gate('before', { nodeId: 'tool:fetch', kind: 'tool', name: 'fetch' });
    await waitUntil(() => viewer.ofType('exec.paused').length === 2, 3000, 'two pauses');
    expect(session.stats().heldGates).toBe(2);

    clock.break();
    viewer.dropConnections(); // FAIL-OPEN: a disconnect must auto-continue held gates
    await waitUntil(() => !session.attached, 3000, 'detach');

    const results: (GateDecision | 'pending')[] = await Promise.all([within(gateA, 500), within(gateB, 500)]);
    expect({ heldGates: session.stats().heldGates, results }).toEqual({
      heldGates: 0,
      results: [{ action: 'continue' }, { action: 'continue' }],
    });

    // The releases are still recorded: replayed to the debugger on re-attach.
    await waitUntil(() => session.attached, 5000, 're-attach');
    const pauseIds = viewer.ofType('exec.paused').map((f) => f.payload['pauseId']);
    await waitUntil(
      () => pauseIds.every((id) => viewer.ofType('exec.resumed').some((f) => f.payload['pauseId'] === id)),
      5000,
      'both exec.resumed replayed',
    );
  });

  it('dispose() auto-continues every held gate', async () => {
    const viewer = await FakeViewer.start({ breakpoints: [{ kind: 'tool' }] });
    cleanups.push(() => viewer.close());
    const clock = breakableClock();
    const session: Session = createSession({
      url: viewer.url,
      enabled: true,
      retryIntervalMs: 60_000,
      clock: clock.now,
      logger: () => {},
    });
    expect(await session.ready()).toBe(true);
    const gateA = session.gate('before', { nodeId: 'tool:search', kind: 'tool', name: 'search' });
    const gateB = session.gate('before', { nodeId: 'tool:fetch', kind: 'tool', name: 'fetch' });
    await waitUntil(() => viewer.ofType('exec.paused').length === 2, 3000, 'two pauses');

    clock.break();
    await session.dispose();

    expect(await Promise.all([within(gateA, 500), within(gateB, 500)])).toEqual([
      { action: 'continue' },
      { action: 'continue' },
    ]);
    expect(session.stats().heldGates).toBe(0);
  });
});
