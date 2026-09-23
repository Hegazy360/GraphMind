/**
 * The engine's `validating` state (contract C2): a gate checking an edited
 * input keeps its pauseId, its pause-timeout timer and its held interval
 * across a refusal (`reopen`); a timeout or `releaseAll()` while validating
 * continues with the ORIGINAL input, and the late verdict lands nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeAction } from '@graphmind-ai/schema';
import {
  CONTINUE_DECISION,
  GateEngine,
  type GateDecision,
  type GateEngineCallbacks,
  type GateNode,
  type ResumeInfo,
} from '../src/gate-engine.js';

const NODE: GateNode = { nodeId: 'tool:search', kind: 'tool', name: 'search' };

interface Resumed {
  pauseId: string;
  action: ResumeAction;
  heldMs: number;
  info: ResumeInfo | undefined;
}

function rig(pauseTimeoutMs?: number) {
  let now = 1000;
  let ids = 0;
  const paused: string[] = [];
  const resumed: Resumed[] = [];
  const callbacks: GateEngineCallbacks = {
    newPauseId: () => `pause_${(ids += 1)}`,
    onPaused: (pauseId) => paused.push(pauseId),
    onResumed: (pauseId, _node, action, _runId, heldMs, info) => resumed.push({ pauseId, action, heldMs, info }),
  };
  const engine = new GateEngine(callbacks, pauseTimeoutMs, () => now);
  return {
    engine,
    paused,
    resumed,
    callbacks,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A promise's settled value, or 'pending' after the microtask queue drains. */
async function state<T>(promise: Promise<T>): Promise<T | 'pending'> {
  const marker = Symbol('pending');
  const result = await Promise.race([promise, new Promise<symbol>((resolve) => setImmediate(() => resolve(marker)))]);
  return result === marker ? 'pending' : (result as T);
}

describe('GateEngine — validating / reopen', () => {
  it('beginValidation moves a held gate to validating; peek shows it; a second begin is refused', () => {
    const { engine, paused } = rig();
    void engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    expect(engine.peek(pauseId)).toEqual({ pauseId, node: NODE, point: 'before', runId: 'run_1', state: 'held' });
    const ticket = engine.beginValidation(pauseId);
    expect(ticket).toEqual({ pauseId });
    expect(engine.peek(pauseId)?.state).toBe('validating');
    expect(engine.beginValidation(pauseId)).toBeUndefined();
    expect(engine.beginValidation('pause_nope')).toBeUndefined();
    expect(engine.peek('pause_nope')).toBeUndefined();
    expect(engine.heldCount).toBe(1);
  });

  it('a plain resume is ignored while validating', async () => {
    const { engine, paused, resumed } = rig();
    const gate = engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    engine.beginValidation(pauseId);
    expect(engine.resume(pauseId, 'abort')).toBe(false);
    expect(engine.resume(pauseId, 'continue')).toBe(false);
    expect(await state(gate)).toBe('pending');
    expect(resumed).toEqual([]);
  });

  it('completeValidation releases with the edit and the info; exactly one onResumed', async () => {
    const { engine, paused, resumed, advance } = rig();
    const gate = engine.hold('after', NODE, 'run_1');
    const pauseId = paused[0] as string;
    advance(40);
    const ticket = engine.beginValidation(pauseId);
    advance(2);
    const decision: GateDecision = { action: 'retry', input: { q: 'LIS' } };
    const info: ResumeInfo = { edited: { after: { q: 'LIS' } }, requestId: 'req-1' };
    expect(engine.completeValidation(ticket!, decision, info)).toBe(true);
    expect(await gate).toBe(decision);
    expect(resumed).toEqual([{ pauseId, action: 'retry', heldMs: 42, info }]);
    expect(engine.heldCount).toBe(0);
    // The ticket is spent.
    expect(engine.completeValidation(ticket!, decision, info)).toBe(false);
    expect(engine.reopen(ticket!)).toBe(false);
  });

  it('reopen keeps the pauseId and the held interval: heldMs spans every refusal', async () => {
    const { engine, paused, resumed, advance } = rig();
    const gate = engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    advance(100);
    const first = engine.beginValidation(pauseId)!;
    advance(5);
    expect(engine.reopen(first)).toBe(true);
    expect(engine.peek(pauseId)?.state).toBe('held');
    advance(200);
    const second = engine.beginValidation(pauseId)!;
    // The first ticket can never land on the second validation.
    expect(engine.reopen(first)).toBe(false);
    expect(engine.completeValidation(first, { action: 'continue', input: 1 })).toBe(false);
    expect(engine.reopen(second)).toBe(true);
    advance(95);
    expect(engine.resume(pauseId, 'continue', undefined, { requestId: 'r' })).toBe(true);
    expect(await gate).toEqual({ action: 'continue' });
    expect(paused).toEqual([pauseId]); // one pause, never re-announced
    expect(resumed).toEqual([{ pauseId, action: 'continue', heldMs: 400, info: { requestId: 'r' } }]);
  });

  it('releaseAll while validating continues with the original input; the late verdict is dropped', async () => {
    const { engine, paused, resumed } = rig();
    const gate = engine.hold('before', NODE, 'run_1');
    const ticket = engine.beginValidation(paused[0] as string)!;
    expect(engine.releaseAll()).toBe(1);
    expect(await gate).toEqual(CONTINUE_DECISION);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ action: 'continue', info: undefined });
    expect(engine.completeValidation(ticket, { action: 'continue', input: { q: 1 } })).toBe(false);
    expect(engine.reopen(ticket)).toBe(false);
    expect(resumed).toHaveLength(1);
  });

  it('onResumed throwing never strands the host', async () => {
    const { engine, paused, callbacks } = rig();
    callbacks.onResumed = () => {
      throw new Error('emit failed');
    };
    const gate = engine.hold('before', NODE, 'run_1');
    expect(() => engine.resume(paused[0] as string, 'continue')).not.toThrow();
    expect(await gate).toEqual({ action: 'continue' });
    expect(engine.heldCount).toBe(0);
  });
});

// Synchronous validator work blocks the event loop, so the pause-timeout
// timer cannot fire while it runs. A verdict presented after the deadline
// has the outcome the timer would have had: continue with the ORIGINAL input.
describe('GateEngine — a verdict presented after the pause deadline', () => {
  it('completeValidation: continue with the original input; the edit and its info are dropped', async () => {
    const { engine, paused, resumed, advance } = rig(100);
    const gate = engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    const ticket = engine.beginValidation(pauseId)!;
    advance(150); // the clock moved; the (real) timer has not had a turn
    const info: ResumeInfo = { edited: { after: { q: 1 } }, requestId: 'r' };
    expect(engine.completeValidation(ticket, { action: 'continue', input: { q: 1 } }, info)).toBe(false);
    expect(await gate).toEqual(CONTINUE_DECISION);
    expect(resumed).toEqual([{ pauseId, action: 'continue', heldMs: 150, info: undefined }]);
    expect(engine.heldCount).toBe(0);
  });

  it('reopen: continue with the original input instead of holding again', async () => {
    const { engine, paused, resumed, advance } = rig(100);
    const gate = engine.hold('before', NODE, 'run_1');
    const ticket = engine.beginValidation(paused[0] as string)!;
    advance(100);
    expect(engine.reopen(ticket)).toBe(false);
    expect(await gate).toEqual(CONTINUE_DECISION);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ action: 'continue', info: undefined });
  });

  it('just inside the deadline the verdict is applied', async () => {
    const { engine, paused, resumed, advance } = rig(100);
    const gate = engine.hold('before', NODE, 'run_1');
    const ticket = engine.beginValidation(paused[0] as string)!;
    advance(99);
    const decision: GateDecision = { action: 'continue', input: { q: 1 } };
    expect(engine.completeValidation(ticket, decision)).toBe(true);
    expect(await gate).toBe(decision);
    expect(resumed).toHaveLength(1);
  });

  it('with no pause timeout there is no deadline', async () => {
    const { engine, paused, advance } = rig();
    const gate = engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    advance(60_000);
    expect(engine.reopen(engine.beginValidation(pauseId)!)).toBe(true);
    advance(60_000);
    const decision: GateDecision = { action: 'continue', input: { q: 1 } };
    expect(engine.completeValidation(engine.beginValidation(pauseId)!, decision)).toBe(true);
    expect(await gate).toBe(decision);
  });
});

describe('GateEngine — the pause timeout across validation', () => {
  beforeEach(() => {
    // setImmediate stays real: `state()` uses it to let microtasks drain.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires while validating: continue with the original input, verdict dropped', async () => {
    const { engine, paused, resumed } = rig(100);
    const gate = engine.hold('before', NODE, 'run_1');
    const ticket = engine.beginValidation(paused[0] as string)!;
    vi.advanceTimersByTime(100);
    expect(await gate).toEqual(CONTINUE_DECISION);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ action: 'continue', info: undefined });
    expect(engine.completeValidation(ticket, { action: 'continue', input: 'x' })).toBe(false);
    expect(resumed).toHaveLength(1);
  });

  it('is not restarted by a refusal: the gate still times out at the original deadline', async () => {
    const { engine, paused } = rig(100);
    const gate = engine.hold('before', NODE, 'run_1');
    const pauseId = paused[0] as string;
    vi.advanceTimersByTime(60);
    engine.reopen(engine.beginValidation(pauseId)!);
    vi.advanceTimersByTime(39);
    expect(await state(gate)).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await gate).toEqual(CONTINUE_DECISION);
  });
});
