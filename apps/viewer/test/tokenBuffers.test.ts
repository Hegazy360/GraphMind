import { describe, expect, it, vi } from 'vitest';
import { EMPTY_TOKEN_SNAPSHOT, TokenBufferRegistry } from '../src/store/tokenBuffers.js';

const RUN = 'run-1';
const NODE = 'llm:s1';

/** Feed one node a delta sequence and read back what the card would see. */
function snapshotAfter(deltas: { t: 'reasoning' | 'text' | 'tool-args'; v: string }[]) {
  const reg = new TokenBufferRegistry();
  deltas.forEach((d, i) => reg.push(RUN, i + 1, NODE, [d]));
  reg.flushNow();
  return reg.getSnapshot(RUN, NODE);
}

describe('TokenBufferRegistry', () => {
  it('accumulates deltas per channel', () => {
    const reg = new TokenBufferRegistry();
    reg.push(RUN, 1, NODE, [
      { t: 'reasoning', v: 'thinking ' },
      { t: 'text', v: 'Hello' },
    ]);
    reg.push(RUN, 2, NODE, [{ t: 'text', v: ', world' }]);
    reg.flushNow();
    const snap = reg.getSnapshot(RUN, NODE);
    expect(snap.text).toBe('Hello, world');
    expect(snap.reasoning).toBe('thinking ');
    expect(snap.version).toBe(1);
  });

  it('dedupes on (runId, seq)', () => {
    const reg = new TokenBufferRegistry();
    expect(reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }])).toBe(true);
    expect(reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }])).toBe(false); // replay
    expect(reg.push('other-run', 1, NODE, [{ t: 'text', v: 'b' }])).toBe(true);
    reg.flushNow();
    expect(reg.getSnapshot(RUN, NODE).text).toBe('a');
    expect(reg.getSnapshot('other-run', NODE).text).toBe('b');
  });

  it('publishes a stable snapshot between flushes (useSyncExternalStore contract)', () => {
    const reg = new TokenBufferRegistry();
    reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }]);
    reg.flushNow();
    const snap1 = reg.getSnapshot(RUN, NODE);
    expect(reg.getSnapshot(RUN, NODE)).toBe(snap1); // identical reference
    reg.push(RUN, 2, NODE, [{ t: 'text', v: 'b' }]);
    // not flushed yet — snapshot unchanged
    expect(reg.getSnapshot(RUN, NODE)).toBe(snap1);
    reg.flushNow();
    const snap2 = reg.getSnapshot(RUN, NODE);
    expect(snap2).not.toBe(snap1);
    expect(snap2.text).toBe('ab');
  });

  it('notifies subscribers once per flush, not per delta', () => {
    const reg = new TokenBufferRegistry();
    const listener = vi.fn();
    reg.subscribe(RUN, NODE, listener);
    reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }]);
    reg.push(RUN, 2, NODE, [{ t: 'text', v: 'b' }]);
    reg.push(RUN, 3, NODE, [{ t: 'text', v: 'c' }]);
    expect(listener).not.toHaveBeenCalled();
    reg.flushNow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flushes on the coalescing timer', async () => {
    vi.useFakeTimers();
    try {
      const reg = new TokenBufferRegistry();
      const listener = vi.fn();
      reg.subscribe(RUN, NODE, listener);
      reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }]);
      expect(listener).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(reg.getSnapshot(RUN, NODE).text).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the shared empty snapshot for unknown nodes', () => {
    const reg = new TokenBufferRegistry();
    expect(reg.getSnapshot(RUN, 'nope')).toBe(EMPTY_TOKEN_SNAPSHOT);
  });

  it('clearRun drops buffers and seq memory', () => {
    const reg = new TokenBufferRegistry();
    reg.push(RUN, 1, NODE, [{ t: 'text', v: 'a' }]);
    reg.flushNow();
    reg.clearRun(RUN);
    expect(reg.getSnapshot(RUN, NODE)).toBe(EMPTY_TOKEN_SNAPSHOT);
    // same seq is accepted again after a clear (fixture restart)
    expect(reg.push(RUN, 1, NODE, [{ t: 'text', v: 'again' }])).toBe(true);
  });
});

/**
 * The exact condition `LlmStepNode`'s TokenTail styles on:
 *
 *     showingReasoning = snapshot.text === '' && snapshot.reasoning !== ''
 *
 * Asserted here rather than in the browser. On screen that state is only six
 * deltas wide — reasoning has arrived, text has not — and React can coalesce
 * the whole window into a single render, so an e2e that waits for it fails
 * intermittently while claiming the reasoning stream was never rendered.
 * The rule is deterministic; the rendering of it is not worth a flaky test.
 */
describe('the reasoning-first display rule', () => {
  it('reports reasoning-only while no visible text has arrived', () => {
    const snap = snapshotAfter([{ t: 'reasoning', v: 'weighing the budget' }]);
    expect(snap.text).toBe('');
    expect(snap.reasoning).not.toBe('');
    expect(snap.text === '' && snap.reasoning !== '').toBe(true);
  });

  it('stops reporting reasoning-only the moment visible text arrives', () => {
    const snap = snapshotAfter([
      { t: 'reasoning', v: 'weighing the budget' },
      { t: 'text', v: "I'll start by" },
    ]);
    expect(snap.reasoning).not.toBe('');
    expect(snap.text).not.toBe('');
    expect(snap.text === '' && snap.reasoning !== '').toBe(false);
  });
});
