/**
 * Unit layer for the pure helpers: Anthropic shape mapping, invocation
 * grouping, token batching, signal chaining, and the gated APIPromise
 * stand-in's contract (single error report, memoized value, no unhandled
 * rejection when only `withResponse()` is consumed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { gatedApiPromise } from '../src/api-promise.js';
import { InvocationTracker } from '../src/invocation.js';
import { chainAbortSignals, isTimeoutAbortReason } from '../src/signals.js';
import { TokenBatcher } from '../src/token-batcher.js';
import { readFileSync } from 'node:fs';
import { stepOutput } from '../src/observe.js';
import {
  isBuiltinToolDef,
  isServerToolResultBlock,
  isToolUseBlock,
  mapUsage,
  mergeUsage,
  messageText,
  parseToolInput,
  type UsageLike,
} from '../src/sdk-types.js';
import { tick } from './helpers/fake-viewer.js';

/** The shared LLM-capture fixture's usage cases for one provider. */
function usageCases(provider: string): [string, unknown, unknown][] {
  const fixture = JSON.parse(
    readFileSync(new URL('../../client/test/fixtures/llm.json', import.meta.url), 'utf8'),
  ) as { usage: { provider: string; name: string; raw: unknown; out: unknown }[] };
  return fixture.usage.filter((c) => c.provider === provider).map((c) => [c.name, c.raw, c.out]);
}

/** The fixture compares the canonical fields; the 0.5 alias is checked separately. */
function withoutAliases(usage: Record<string, unknown> | undefined): unknown {
  if (usage === undefined) return null;
  const { cacheCreationTokens: _alias, ...rest } = usage;
  return rest;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function timeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

describe('Anthropic shape mapping', () => {
  it('mapUsage: input is uncached tail + cache reads + cache writes, inclusive; cacheCreationTokens stays as an alias', () => {
    expect(
      mapUsage({
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      }),
    ).toEqual({
      inputTokens: 27,
      outputTokens: 10,
      inclusive: true,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      cacheCreationTokens: 2,
    });
    // Nulls (the wire default) are dropped, not coerced into zeros.
    expect(
      mapUsage({
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3, inclusive: true });
    expect(mapUsage({})).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
  });

  it.each(usageCases('anthropic'))('mapUsage (shared fixture): %s', (_name, raw, expected) => {
    expect(withoutAliases(mapUsage(raw as UsageLike))).toEqual(expected);
  });

  it('the cacheCreationTokens alias always equals cacheWriteTokens (split sums included)', () => {
    for (const [, raw] of usageCases('anthropic')) {
      const usage = mapUsage(raw as UsageLike);
      expect(usage?.['cacheCreationTokens']).toBe(usage?.['cacheWriteTokens']);
    }
  });

  it('mergeUsage merges message_start input counts with message_delta output counts', () => {
    const merged = mergeUsage(
      { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5 },
      { output_tokens: 42 },
    );
    expect(merged).toEqual({
      input_tokens: 20,
      output_tokens: 42,
      cache_read_input_tokens: 5,
    });
    expect(mergeUsage(undefined, { output_tokens: 1 })).toEqual({ output_tokens: 1 });
    expect(mergeUsage({ input_tokens: 1 }, undefined)).toEqual({ input_tokens: 1 });
  });

  it('mergeUsage keeps the 5m/1h split and lets a cumulative message_delta update every count', () => {
    const merged = mergeUsage(
      {
        input_tokens: 3,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 150,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
      },
      // Newer API versions repeat the input/cache counts (null when unknown).
      { output_tokens: 99, input_tokens: null, cache_read_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 60 } },
    );
    expect(mapUsage(merged)).toEqual({
      inputTokens: 153,
      outputTokens: 99,
      inclusive: true,
      cacheReadTokens: 0,
      cacheWriteTokens: 150,
      cacheCreationTokens: 150,
    });
    expect(merged?.cache_creation).toEqual({ ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 60 });
  });

  it('stepOutput normalizes stop_reason, keeps it raw (and as the 0.5 stopReason), lists tool calls', () => {
    expect(stepOutput('hi', 'end_turn', 'claude-x')).toEqual({
      text: 'hi',
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      stopReason: 'end_turn',
      model: 'claude-x',
    });
    expect(
      stepOutput('', 'max_tokens', 'm', [{ id: 't1', name: 'write', input: null, inputText: '{"a":' }]),
    ).toMatchObject({ finishReason: 'length', rawFinishReason: 'max_tokens', toolCalls: [{ id: 't1', name: 'write' }] });
    expect(stepOutput('', 'refusal', 'm')).toMatchObject({ finishReason: 'content-filter' });
    expect(stepOutput('', undefined, 'm')).toEqual({ text: '', stopReason: undefined, model: 'm' });
  });

  it('classifies tool definitions and content blocks', () => {
    expect(isBuiltinToolDef({ name: 'web_search', type: 'web_search_20250305' })).toBe(true);
    expect(isBuiltinToolDef({ name: 'mine' })).toBe(false);
    expect(isBuiltinToolDef({ name: 'mine', type: 'custom' })).toBe(false);
    expect(isToolUseBlock({ type: 'tool_use' })).toBe(true);
    expect(isToolUseBlock({ type: 'server_tool_use' })).toBe(false);
    expect(isServerToolResultBlock({ type: 'web_search_tool_result' })).toBe(true);
    expect(isServerToolResultBlock({ type: 'text' })).toBe(false);
  });

  it('messageText concatenates text blocks only', () => {
    expect(
      messageText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 't', name: 'n' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
    expect(messageText(undefined)).toBe('');
  });

  it('parseToolInput parses stringified JSON and passes anything else through', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput('not json')).toBe('not json');
    const obj = { b: 2 };
    expect(parseToolInput(obj)).toBe(obj);
  });
});

describe('InvocationTracker', () => {
  it('chains growing message lists into one invocation and restarts otherwise', () => {
    const tracker = new InvocationTracker();
    const first = { role: 'user', content: 'hi' };
    const s0 = tracker.next('run-a', [first]);
    expect(s0).toMatchObject({ stepIndex: 0, isFirstStep: true });
    const s1 = tracker.next('run-a', [first, { role: 'assistant' }, { role: 'user' }]);
    expect(s1.invocationId).toBe(s0.invocationId);
    expect(s1.stepIndex).toBe(1);
    // Same length again = a NEW loop, not a continuation.
    const s2 = tracker.next('run-a', [first]);
    expect(s2.invocationId).not.toBe(s0.invocationId);
    expect(s2.stepIndex).toBe(0);
  });

  it('scopes by run id: concurrent runs never cross-talk', () => {
    const tracker = new InvocationTracker();
    const first = { role: 'user', content: 'same' };
    const a = tracker.next('run-a', [first]);
    const b = tracker.next('run-b', [first]);
    expect(a.invocationId).not.toBe(b.invocationId);
    expect(tracker.next('run-a', [first, { role: 'assistant' }]).invocationId).toBe(
      a.invocationId,
    );
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
    batcher.dispose();
  });

  it('flushNode forces pending deltas out and dispose stops accepting', () => {
    const flushes: string[] = [];
    const batcher = new TokenBatcher((nodeId) => flushes.push(nodeId), 10_000);
    batcher.push('n1', { t: 'text', v: 'a' });
    batcher.flushNode('n1');
    expect(flushes).toEqual(['n1']);
    batcher.flushNode('n1'); // nothing pending: no empty batch
    expect(flushes).toEqual(['n1']);
    batcher.dispose();
    batcher.push('n1', { t: 'text', v: 'b' });
    batcher.flushNode('n1');
    expect(flushes).toEqual(['n1']);
  });
});

describe('signals', () => {
  it('recognizes timeout aborts by reason name only', () => {
    expect(isTimeoutAbortReason(timeoutError())).toBe(true);
    const abort = new Error('a');
    abort.name = 'AbortError';
    expect(isTimeoutAbortReason(abort)).toBe(false);
    expect(isTimeoutAbortReason('TimeoutError')).toBe(false);
  });

  it('forwards user aborts and swallows timeout aborts', () => {
    const user = new AbortController();
    let neutralized = 0;
    const chained = chainAbortSignals(user.signal, undefined, () => (neutralized += 1))!;
    const reason = new Error('user cancelled');
    user.abort(reason);
    expect(chained.aborted).toBe(true);
    expect(chained.reason).toBe(reason);
    expect(neutralized).toBe(0);

    const sdk = new AbortController();
    let swallowed = 0;
    const filtered = chainAbortSignals(sdk.signal, undefined, () => (swallowed += 1))!;
    sdk.abort(timeoutError());
    expect(filtered.aborted).toBe(false);
    expect(swallowed).toBe(1);
  });

  it('chains the debugger signal without filtering it', () => {
    const user = new AbortController();
    const debugger_ = new AbortController();
    const chained = chainAbortSignals(user.signal, debugger_.signal, () => {})!;
    debugger_.abort(new Error('debugger abort'));
    expect(chained.aborted).toBe(true);
    expect((chained.reason as Error).message).toBe('debugger abort');
  });

  it('returns undefined when there is nothing to chain', () => {
    expect(chainAbortSignals(undefined, undefined, () => {})).toBeUndefined();
  });
});

describe('gatedApiPromise', () => {
  it('resolves the transformed value once, for every consumer', async () => {
    let transforms = 0;
    const value = { id: 'm1' };
    const response = new Response('{}', { status: 200 });
    const gated = gatedApiPromise<typeof value>({
      start: async () => ({
        api: Object.assign(Promise.resolve(value), {
          withResponse: async () => ({ data: value, response, request_id: 'req_1' }),
          asResponse: async () => response,
        }),
      }),
      onValue: (v) => {
        transforms += 1;
        return v;
      },
      onError: () => {},
    });

    const envelope = await gated.withResponse!();
    expect(envelope.request_id).toBe('req_1');
    expect(await gated).toBe(envelope.data);
    expect(await gated.asResponse!()).toBe(response);
    expect(transforms).toBe(1);
  });

  it('reports a failure exactly once and never leaves it unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    cleanups.push(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    const failure = new Error('gate aborted');
    let reports = 0;
    const gated = gatedApiPromise<unknown>({
      start: () => Promise.reject(failure),
      onValue: (v) => v,
      onError: () => {
        reports += 1;
      },
    });

    // Only `withResponse()` is consumed — as MessageStream does.
    await expect(gated.withResponse!()).rejects.toBe(failure);
    await tick(50);
    expect(reports).toBe(1);
    expect(unhandled).toHaveLength(0);
  });

  it('an observation failure never changes what the host receives', async () => {
    const value = { id: 'm2' };
    const gated = gatedApiPromise<typeof value>({
      start: async () => ({ api: Promise.resolve(value) }),
      onValue: () => {
        throw new Error('observer blew up');
      },
      onError: () => {},
    });
    expect(await gated).toBe(value);
  });
});
