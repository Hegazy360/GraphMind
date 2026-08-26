/**
 * Unit layer for the pure helpers: signal chaining/neutralization,
 * invocation grouping, token batching, SDK shape mapping, and the
 * AsyncIterable fallback of the tool wrapper.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { graphmind } from '../src/index.js';
import { InvocationTracker } from '../src/invocation.js';
import { chainAbortSignals, isTimeoutAbortReason } from '../src/signals.js';
import { TokenBatcher } from '../src/token-batcher.js';
import {
  isAsyncGeneratorFunction,
  mapUsage,
  parseToolInput,
  unifiedFinishReason,
} from '../src/sdk-types.js';
import { tick } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function timeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

describe('signals', () => {
  it('isTimeoutAbortReason recognizes TimeoutError names only', () => {
    expect(isTimeoutAbortReason(timeoutError())).toBe(true);
    const err = new Error('t');
    err.name = 'TimeoutError';
    expect(isTimeoutAbortReason(err)).toBe(true);
    const abort = new Error('a');
    abort.name = 'AbortError';
    expect(isTimeoutAbortReason(abort)).toBe(false);
    expect(isTimeoutAbortReason('TimeoutError')).toBe(false);
  });

  it('returns undefined when there is nothing to chain', () => {
    expect(chainAbortSignals(undefined, undefined, () => {})).toBeUndefined();
  });

  it('forwards user aborts, reason intact', () => {
    const user = new AbortController();
    let neutralized = 0;
    const chained = chainAbortSignals(user.signal, undefined, () => (neutralized += 1))!;
    expect(chained.aborted).toBe(false);
    const reason = new Error('user cancelled');
    user.abort(reason);
    expect(chained.aborted).toBe(true);
    expect(chained.reason).toBe(reason);
    expect(neutralized).toBe(0);
  });

  it('swallows timeout aborts from the user/SDK signal and reports them', () => {
    const sdk = new AbortController();
    let neutralized = 0;
    const chained = chainAbortSignals(sdk.signal, undefined, () => (neutralized += 1))!;
    sdk.abort(timeoutError());
    expect(chained.aborted).toBe(false);
    expect(neutralized).toBe(1);
  });

  it('handles an already-aborted timeout signal', () => {
    const sdk = new AbortController();
    sdk.abort(timeoutError());
    let neutralized = 0;
    const chained = chainAbortSignals(sdk.signal, undefined, () => (neutralized += 1))!;
    expect(chained.aborted).toBe(false);
    expect(neutralized).toBe(1);
  });

  it('chains the debugger signal without filtering it', () => {
    const user = new AbortController();
    const debug = new AbortController();
    const chained = chainAbortSignals(user.signal, debug.signal, () => {})!;
    debug.abort(new Error('debugger abort'));
    expect(chained.aborted).toBe(true);
    expect((chained.reason as Error).message).toBe('debugger abort');
  });
});

describe('InvocationTracker', () => {
  it('chains growing prompts into one invocation and restarts otherwise', () => {
    const tracker = new InvocationTracker();
    const m1 = { role: 'user', content: 'hi' };
    const s0 = tracker.next('run-a', [m1]);
    expect(s0).toMatchObject({ stepIndex: 0, isFirstStep: true });
    const s1 = tracker.next('run-a', [m1, { role: 'assistant' }, { role: 'tool' }]);
    expect(s1.invocationId).toBe(s0.invocationId);
    expect(s1.stepIndex).toBe(1);
    // Same length again = a NEW call, not a continuation.
    const s2 = tracker.next('run-a', [m1]);
    expect(s2.invocationId).not.toBe(s0.invocationId);
    expect(s2.stepIndex).toBe(0);
  });

  it('scopes by run id: concurrent runs never cross-talk', () => {
    const tracker = new InvocationTracker();
    const m1 = { role: 'user', content: 'same' };
    const a = tracker.next('run-a', [m1]);
    const b = tracker.next('run-b', [m1]);
    expect(a.invocationId).not.toBe(b.invocationId);
    const a1 = tracker.next('run-a', [m1, { role: 'assistant' }]);
    expect(a1.invocationId).toBe(a.invocationId);
  });

  it('starts a new invocation when the first message differs', () => {
    const tracker = new InvocationTracker();
    const s0 = tracker.next('scope', [{ role: 'user', content: 'one' }]);
    const s1 = tracker.next('scope', [
      { role: 'user', content: 'two' },
      { role: 'assistant' },
    ]);
    expect(s1.invocationId).not.toBe(s0.invocationId);
    expect(s1.isFirstStep).toBe(true);
  });
});

describe('TokenBatcher', () => {
  it('batches bursts into one node.token flush per interval per node', async () => {
    const flushes: { nodeId: string; count: number }[] = [];
    const batcher = new TokenBatcher((nodeId, deltas) => {
      flushes.push({ nodeId, count: deltas.length });
    }, 25);
    batcher.push('n1', { t: 'text', v: 'a' });
    batcher.push('n1', { t: 'text', v: 'b' });
    batcher.push('n2', { t: 'text', v: 'c' });
    expect(flushes).toHaveLength(0); // throttled, not per-delta
    await tick(60);
    expect(flushes).toHaveLength(2);
    expect(flushes.find((f) => f.nodeId === 'n1')?.count).toBe(2);
    expect(flushes.find((f) => f.nodeId === 'n2')?.count).toBe(1);
    batcher.dispose();
  });

  it('flushNode forces pending deltas out (ordering before node.finished)', () => {
    const flushes: string[] = [];
    const batcher = new TokenBatcher((nodeId) => flushes.push(nodeId), 10_000);
    batcher.push('n1', { t: 'text', v: 'a' });
    batcher.flushNode('n1');
    expect(flushes).toEqual(['n1']);
    batcher.flushNode('n1'); // nothing pending: no empty batch
    expect(flushes).toEqual(['n1']);
    batcher.dispose();
  });

  it('dispose flushes what is pending and stops accepting', () => {
    const flushes: string[] = [];
    const batcher = new TokenBatcher((nodeId) => flushes.push(nodeId), 10_000);
    batcher.push('n1', { t: 'text', v: 'a' });
    batcher.dispose();
    expect(flushes).toEqual(['n1']);
    batcher.push('n1', { t: 'text', v: 'b' });
    batcher.flushNode('n1');
    expect(flushes).toEqual(['n1']);
  });
});

describe('SDK shape mapping', () => {
  it('mapUsage handles V4 object totals and legacy plain numbers', () => {
    expect(
      mapUsage({
        inputTokens: { total: 20 },
        outputTokens: { total: 10 },
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(mapUsage({ inputTokens: 5, outputTokens: 7 })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(mapUsage({ inputTokens: { total: undefined }, outputTokens: {} })).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
  });

  it('unifiedFinishReason handles V4 objects and legacy strings', () => {
    expect(unifiedFinishReason({ unified: 'stop' })).toBe('stop');
    expect(unifiedFinishReason('tool-calls')).toBe('tool-calls');
    expect(unifiedFinishReason(undefined)).toBeUndefined();
  });

  it('parseToolInput parses stringified JSON and passes anything else through', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput('not json')).toBe('not json');
    const obj = { b: 2 };
    expect(parseToolInput(obj)).toBe(obj);
  });

  it('isAsyncGeneratorFunction detects only async generators', () => {
    expect(isAsyncGeneratorFunction(async function* () {})).toBe(true);
    expect(isAsyncGeneratorFunction(async () => {})).toBe(false);
    expect(isAsyncGeneratorFunction(function* () {})).toBe(false);
    expect(isAsyncGeneratorFunction(() => {})).toBe(false);
    expect(isAsyncGeneratorFunction(undefined)).toBe(false);
  });
});

describe('AsyncIterable fallback (non-generator execute)', () => {
  it('drains to the final value and warns once', async () => {
    const warnings: string[] = [];
    const gm = graphmind({
      enabled: true,
      webSocket: undefined,
      logger: (message) => warnings.push(message),
    });
    cleanups.push(() => gm.dispose());

    const tools = gm.wrapTools({
      sneaky: tool({
        inputSchema: z.object({}),
        // A plain async function that RETURNS an iterable (not a generator):
        // the wrapper cannot pass it through synchronously, so it drains.
        execute: async (): Promise<unknown> => {
          return (async function* () {
            yield { step: 1 };
            yield { step: 2, final: true };
          })();
        },
      }),
    });
    const execute = tools.sneaky.execute as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    const result = await execute({}, { toolCallId: 'call-sneaky-1', messages: [] });
    expect(result).toEqual({ step: 2, final: true });
    await execute({}, { toolCallId: 'call-sneaky-2', messages: [] });
    expect(warnings.filter((w) => w.includes('AsyncIterable'))).toHaveLength(1);
  });
});
