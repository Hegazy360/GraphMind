/**
 * Unit coverage for the version-sensitive and safety-critical helpers:
 * LangChain shape normalization, payload hygiene, the run tree, the abort
 * marker, and the run scope's fail-open behavior.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@graphmind-ai/client';
import { isDeliberateAbort, markDeliberate } from '../src/abort.js';
import { nodeIdFor } from '../src/ids.js';
import { peerVersion } from '../src/peer-version.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';
import { graphmind } from '../src/index.js';
import { schemaHash } from '@graphmind-ai/client';
import {
  compactMessages,
  llmOutput,
  llmStartExtras,
  parseToolInput,
  rawFinishReasonFromLLMResult,
  resolveChainStartArgs,
  serializedName,
  textFromLLMResult,
  toolCallsFromLLMResult,
  unwrapToolOutput,
  usageFromLLMResult,
  usageFromRecord,
} from '../src/lc-types.js';

/** The shared LLM-capture fixture's usage cases for one provider. */
function usageCases(provider: string): [string, unknown, unknown][] {
  const fixture = JSON.parse(
    readFileSync(new URL('../../client/test/fixtures/llm.json', import.meta.url), 'utf8'),
  ) as { usage: { provider: string; name: string; raw: unknown; out: unknown }[] };
  return fixture.usage.filter((c) => c.provider === provider).map((c) => [c.name, c.raw, c.out]);
}
import { safePayload } from '../src/payload.js';
import { RunScope } from '../src/run-scope.js';
import { RunTree } from '../src/run-tree.js';
import { TokenBatcher } from '../src/token-batcher.js';

const UUID = '01a04079-b40a-701f-8edd-01ceabd1bace';

describe('resolveChainStartArgs', () => {
  it('reads the RUNTIME order (parentRunId at position 4)', () => {
    // What @langchain/core actually passes: (…, runId, parentRunId, tags,
    // metadata, runType, runName).
    expect(resolveChainStartArgs(UUID, 'chain', 'plan')).toEqual({
      parentRunId: UUID,
      runName: 'plan',
      runType: 'chain',
    });
  });

  it('also reads the DECLARED order (parentRunId at position 8)', () => {
    expect(resolveChainStartArgs('chain', 'plan', UUID)).toEqual({
      parentRunId: UUID,
      runName: 'plan',
      runType: 'chain',
    });
  });

  it('reports a root run (no uuid in either position)', () => {
    expect(resolveChainStartArgs(undefined, undefined, 'LangGraph')).toEqual({
      parentRunId: undefined,
      runName: 'LangGraph',
      runType: undefined,
    });
  });
});

describe('usageFromLLMResult', () => {
  it('reads chat-model usage_metadata', () => {
    expect(
      usageFromLLMResult({
        generations: [[{ text: 'hi', message: { usage_metadata: { input_tokens: 7, output_tokens: 3 } } }]],
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3, inclusive: true });
  });

  it('reads llmOutput.tokenUsage (OpenAI-style LLMs)', () => {
    expect(
      usageFromLLMResult({
        generations: [[{ text: 'hi' }]],
        llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
      }),
    ).toEqual({ inputTokens: 11, outputTokens: 5, inclusive: true });
  });

  it('reads snake_case llmOutput.usage', () => {
    expect(
      usageFromLLMResult({
        generations: [[{ text: 'hi' }]],
        llmOutput: { usage: { prompt_tokens: 2, completion_tokens: 4 } },
      }),
    ).toEqual({ inputTokens: 2, outputTokens: 4, inclusive: true });
  });

  it.each(usageCases('langchain'))('usageFromRecord (shared fixture): %s', (_name, raw, expected) => {
    expect(usageFromRecord(raw) ?? null).toEqual(expected);
  });

  it('prefers usage_metadata, falls back to the raw Anthropic usage in response_metadata (exclusive -> summed)', () => {
    expect(
      usageFromLLMResult({
        generations: [
          [
            {
              text: 'hi',
              message: {
                response_metadata: {
                  usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
                },
              },
            },
          ],
        ],
      }),
    ).toEqual({ inputTokens: 125, outputTokens: 9, inclusive: true, cacheReadTokens: 100, cacheWriteTokens: 20 });
    expect(
      usageFromLLMResult({
        generations: [
          [
            {
              text: 'hi',
              message: {
                usage_metadata: { input_tokens: 125, output_tokens: 9, input_token_details: { cache_read: 100, cache_creation: 20 } },
                response_metadata: { usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 100 } },
              },
            },
          ],
        ],
      }),
    ).toEqual({ inputTokens: 125, outputTokens: 9, inclusive: true, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });

  it('returns undefined when the provider reported nothing', () => {
    expect(usageFromLLMResult({ generations: [[{ text: 'hi' }]], llmOutput: {} })).toBeUndefined();
    expect(usageFromLLMResult(undefined)).toBeUndefined();
  });

  it('concatenates generation text', () => {
    expect(textFromLLMResult({ generations: [[{ text: 'a' }, { text: 'b' }]] })).toBe('ab');
    expect(textFromLLMResult({})).toBe('');
  });
});

describe('LLM output: finish reason and tool calls (C1)', () => {
  const result = (message: Record<string, unknown>, generationInfo?: Record<string, unknown>) => ({
    generations: [[{ text: 'x', message, ...(generationInfo !== undefined ? { generationInfo } : {}) }]],
  });

  it('reads the raw finish reason wherever the provider put it', () => {
    expect(rawFinishReasonFromLLMResult(result({ response_metadata: { finish_reason: 'tool_calls' } }))).toBe('tool_calls');
    expect(rawFinishReasonFromLLMResult(result({ response_metadata: { stop_reason: 'max_tokens' } }))).toBe('max_tokens');
    expect(rawFinishReasonFromLLMResult(result({ response_metadata: { finishReason: 'SAFETY' } }))).toBe('SAFETY');
    expect(rawFinishReasonFromLLMResult(result({}, { finish_reason: 'stop' }))).toBe('stop');
    expect(rawFinishReasonFromLLMResult(result({}))).toBeUndefined();
    expect(rawFinishReasonFromLLMResult(undefined)).toBeUndefined();
  });

  it('lists tool_calls (parsed) and invalid_tool_calls (raw text as inputText)', () => {
    const out = toolCallsFromLLMResult(
      result({
        tool_calls: [
          { id: 'a', name: 'search', args: { q: 'x' }, type: 'tool_call' },
          { id: 'b', args: {} },
        ],
        invalid_tool_calls: [
          { id: 'c', name: 'write', args: '{"path":"a.txt","content":"hel', error: 'bad json' },
          { id: 'd', name: 'weird', args: '{"ok":true}', error: 'schema' },
        ],
      }),
    );
    expect(out).toEqual([
      { id: 'a', name: 'search', input: { q: 'x' } },
      { id: 'c', name: 'write', input: null, inputText: '{"path":"a.txt","content":"hel' },
      { id: 'd', name: 'weird', input: null, inputText: '{"ok":true}' },
    ]);
  });

  it('llmOutput: text, normalized finish reason with raw, tool calls', () => {
    expect(
      llmOutput(
        result({
          response_metadata: { stop_reason: 'end_turn' },
          tool_calls: [{ id: 'a', name: 'search', args: { q: 'x' } }],
        }),
      ),
    ).toEqual({
      text: 'x',
      finishReason: 'tool-calls',
      rawFinishReason: 'end_turn',
      toolCalls: [{ id: 'a', name: 'search', input: { q: 'x' } }],
    });
    expect(llmOutput(result({}))).toEqual({ text: 'x' });
    expect(llmOutput(undefined)).toEqual({ text: '' });
  });

  it('llmStartExtras: allow-listed invocation params and tools by hash, once per run', () => {
    const owner = {};
    const weather = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } };
    const lookup = { name: 'lookup', input_schema: { type: 'object' } };
    const extra = {
      invocation_params: {
        model: 'gpt-5.4',
        temperature: 0.2,
        max_tokens: 50,
        stop: ['X'],
        tool_choice: 'auto',
        tools: [weather, lookup],
        openai_api_key: 'SECRET',
        stream: true,
      },
    };
    const first = llmStartExtras(owner, 'run', extra);
    expect(first).toEqual({
      temperature: 0.2,
      max_tokens: 50,
      stop: ['X'],
      tool_choice: 'auto',
      tools: [
        { name: 'get_weather', schemaHash: schemaHash(weather) },
        { name: 'lookup', schemaHash: schemaHash(lookup) },
      ],
      toolSchemas: { [schemaHash(weather)]: weather, [schemaHash(lookup)]: lookup },
    });
    expect(JSON.stringify(first)).not.toContain('SECRET');
    expect(llmStartExtras(owner, 'run', extra)).not.toHaveProperty('toolSchemas');
    expect(llmStartExtras(owner, 'run', undefined)).toEqual({});
    expect(llmStartExtras(owner, 'run', { invocation_params: 'nope' })).toEqual({});
  });

  it('compactMessages keeps every message whole, with tool_call_id', () => {
    const msg = (type: string, extra: Record<string, unknown>) => ({ _getType: () => type, ...extra });
    const long = 'z'.repeat(30_000);
    const out = compactMessages([
      [
        msg('human', { content: long }),
        msg('ai', { content: '', tool_calls: [{ id: 't1', name: 'f', args: {} }] }),
        msg('tool', { content: 'r', tool_call_id: 't1', name: 'f' }),
      ],
    ]) as Record<string, unknown>[][];
    expect(out[0]).toEqual([
      { role: 'human', content: long },
      { role: 'ai', content: '', tool_calls: [{ id: 't1', name: 'f', args: {} }] },
      { role: 'tool', content: 'r', tool_call_id: 't1', name: 'f' },
    ]);
  });
});

describe('LangChain shape helpers', () => {
  it('takes the last segment of a serialized lc_id', () => {
    expect(serializedName({ id: ['langchain', 'chat_models', 'ChatAnthropic'] })).toBe(
      'ChatAnthropic',
    );
    expect(serializedName({ id: [], name: 'fallback' })).toBe('fallback');
    expect(serializedName(undefined)).toBeUndefined();
  });

  it('decodes JSON tool input but leaves plain strings alone', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput('just text')).toBe('just text');
    expect(parseToolInput('{not json')).toBe('{not json');
    expect(parseToolInput(42)).toBe(42);
  });

  it('unwraps a ToolMessage to its content, keeping artifacts', () => {
    expect(unwrapToolOutput({ content: 'hi', tool_call_id: '1' })).toBe('hi');
    expect(unwrapToolOutput({ content: 'hi', artifact: { a: 1 } })).toEqual({
      content: 'hi',
      artifact: { a: 1 },
    });
    expect(unwrapToolOutput('plain')).toBe('plain');
  });

  it("decodes a ToolMessage's JSON-object content back to the tool's object (ToolNode's ToolCall path)", () => {
    const message = (content: unknown) => ({ content, tool_call_id: 'call_1', status: 'success' });
    expect(unwrapToolOutput(message('{"success":false,"reason":"quota"}'))).toEqual({ success: false, reason: 'quota' });
    expect(unwrapToolOutput(message(' {"a":1} '))).toEqual({ a: 1 });
    // Anything that is not a JSON object stays exactly as LangChain sent it.
    expect(unwrapToolOutput(message('[1,2]'))).toBe('[1,2]');
    expect(unwrapToolOutput(message('{not json'))).toBe('{not json');
    expect(unwrapToolOutput(message('null'))).toBe('null');
    const blocks = [{ type: 'text', text: '{"a":1}' }];
    expect(unwrapToolOutput(message(blocks))).toBe(blocks);
    // Only a real ToolMessage (tool_call_id) is decoded, and never with an artifact.
    expect(unwrapToolOutput({ content: '{"a":1}' })).toBe('{"a":1}');
    expect(unwrapToolOutput({ content: '{"a":1}', tool_call_id: 'c', artifact: 1 })).toEqual({ content: '{"a":1}', artifact: 1 });
  });

  it('compacts message groups to {role, content}', () => {
    const message = { _getType: () => 'human', content: 'hello', extra: 'dropped' };
    expect(compactMessages([[message]])).toEqual([[{ role: 'human', content: 'hello' }]]);
    expect(compactMessages('not a list')).toBe('not a list');
  });

  it('builds node ids per kind', () => {
    expect(nodeIdFor('agent', 'x')).toBe('agent:x');
    expect(nodeIdFor('chain', 'x')).toBe('chain:x');
    expect(nodeIdFor('llm', 'x')).toBe('llm:x');
    expect(nodeIdFor('tool', 'x')).toBe('tool:x');
    expect(nodeIdFor('retriever', 'x')).toBe('retriever:x');
    expect(nodeIdFor('custom', 'x')).toBe('custom:x');
  });
});

describe('safePayload', () => {
  it('passes small values through unchanged', () => {
    expect(safePayload({ a: [1, 2], b: 'x' })).toEqual({ a: [1, 2], b: 'x' });
    expect(safePayload(null)).toBeNull();
    expect(safePayload(undefined)).toBeUndefined();
    expect(safePayload(7)).toBe(7);
  });

  it('records large payloads in full by default (the 512 KB shrink is the bound)', () => {
    const big = { text: 'x'.repeat(60_000) };
    expect(safePayload(big)).toEqual(big);
    expect(safePayload('y'.repeat(60_000))).toBe('y'.repeat(60_000));
  });

  it('truncates oversized payloads to a preview when a cap is asked for', () => {
    const big = { text: 'x'.repeat(5000) };
    const out = safePayload(big, 100) as { __graphmind: string; chars: number; preview: string };
    expect(out.__graphmind).toBe('truncated');
    expect(out.chars).toBeGreaterThan(5000);
    expect(out.preview.length).toBe(100);
  });

  it('survives cycles without claiming shared references are cyclic', () => {
    const shared = { id: 'shared' };
    const cyclic: Record<string, unknown> = { shared, also: shared };
    cyclic['self'] = cyclic;
    const out = safePayload(cyclic) as Record<string, unknown>;
    expect(out['shared']).toEqual({ id: 'shared' });
    expect(out['also']).toEqual({ id: 'shared' }); // NOT '[Circular]'
    expect(out['self']).toBe('[Circular]');
  });

  it('normalizes values JSON cannot carry', () => {
    const out = safePayload({
      fn: () => 1,
      big: 10n,
      err: new Error('nope'),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
    }) as Record<string, unknown>;
    expect(out['fn']).toBeUndefined();
    expect(out['big']).toBe('10n');
    expect(out['err']).toEqual({ name: 'Error', message: 'nope' });
    expect(out['map']).toEqual({ k: 'v' });
    expect(out['set']).toEqual([1, 2]);
  });

  it('degrades instead of throwing on a hostile toJSON', () => {
    const hostile = {
      toJSON() {
        throw new Error('boom');
      },
    };
    expect(safePayload(hostile)).toEqual({ __graphmind: 'unserializable', preview: 'boom' });
  });
});

describe('RunTree', () => {
  const record = (runId: string, parentRunId?: string, rootRunId = runId) => ({
    runId,
    rootRunId,
    parentRunId,
    nodeId: `chain:${runId}`,
    kind: 'chain' as const,
    name: runId,
    instanceId: runId,
    startedAt: 0,
    emitted: true,
    gatedByWrapper: false,
  });

  it('resolves the root of a nested run', () => {
    const tree = new RunTree();
    tree.set(record('root'));
    tree.set(record('child', 'root', 'root'));
    expect(tree.rootFor('grandchild', 'child')).toBe('root');
    expect(tree.rootFor('orphan', undefined)).toBe('orphan');
    // An unknown parent falls back to that parent id, never to nothing.
    expect(tree.rootFor('x', 'unknown')).toBe('unknown');
  });

  it('takes a record once and drops a whole root', () => {
    const tree = new RunTree();
    tree.set(record('root'));
    tree.set(record('child', 'root', 'root'));
    expect(tree.take('child')?.runId).toBe('child');
    expect(tree.take('child')).toBeUndefined();
    tree.clearRoot('root');
    expect(tree.size).toBe(0);
  });

  it('evicts the oldest entry rather than growing without bound', () => {
    const tree = new RunTree(2);
    tree.set(record('a'));
    tree.set(record('b'));
    tree.set(record('c'));
    expect(tree.size).toBe(2);
    expect(tree.get('a')).toBeUndefined();
    expect(tree.get('c')?.runId).toBe('c');
  });
});

describe('RunScope', () => {
  const session = () => createSession({ enabled: true, webSocket: undefined, env: {} });

  it('executes tasks inside the run context (correct currentRun)', async () => {
    const s = session();
    const scope = RunScope.open(s, 'auto');
    const inside = await scope.run(() => s.currentRun()?.name);
    expect(inside).toBe('auto');
    expect(s.currentRun()).toBeUndefined(); // outside the scope, no run
    await scope.end();
    await s.dispose();
  });

  it('runs concurrent tasks without one blocking the other', async () => {
    const s = session();
    const scope = RunScope.open(s, 'auto');
    const order: string[] = [];
    let releaseSlow: () => void = () => undefined;
    const slow = scope.run(async () => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      order.push('slow');
    });
    const fast = scope.run(() => {
      order.push('fast');
    });
    await fast;
    expect(order).toEqual(['fast']); // the held task did not block the queue
    releaseSlow();
    await slow;
    expect(order).toEqual(['fast', 'slow']);
    await scope.end();
    await s.dispose();
  });

  it('still executes tasks after the scope has closed (fail-open)', async () => {
    const s = session();
    const scope = RunScope.open(s, 'auto');
    await scope.end();
    expect(await scope.run(() => 'ran anyway')).toBe('ran anyway');
    await s.dispose();
  });

  it('propagates a task failure to its caller', async () => {
    const s = session();
    const scope = RunScope.open(s, 'auto');
    await expect(
      scope.run(() => {
        throw new Error('task blew up');
      }),
    ).rejects.toThrow('task blew up');
    await scope.end();
    await s.dispose();
  });
});

describe('abort marker', () => {
  it('only recognizes errors it marked', () => {
    const marked = markDeliberate(new Error('abort'));
    expect(isDeliberateAbort(marked)).toBe(true);
    expect(isDeliberateAbort(new Error('other'))).toBe(false);
    expect(isDeliberateAbort('string')).toBe(false);
    expect(isDeliberateAbort(undefined)).toBe(false);
  });

  it('does not serialize into payloads', () => {
    const marked = markDeliberate(new Error('abort'));
    expect(Object.keys(marked)).toEqual([]);
  });
});

describe('TokenBatcher', () => {
  it('coalesces pushes into one batch per node', async () => {
    vi.useFakeTimers();
    try {
      const batches: { nodeId: string; count: number }[] = [];
      const batcher = new TokenBatcher((nodeId, deltas) => {
        batches.push({ nodeId, count: deltas.length });
      }, 10);
      for (const value of ['a', 'b', 'c']) batcher.push('llm:x', { t: 'text', v: value });
      batcher.push('llm:y', { t: 'text', v: 'z' });
      expect(batches).toEqual([]);
      vi.advanceTimersByTime(11);
      expect(batches).toEqual([
        { nodeId: 'llm:x', count: 3 },
        { nodeId: 'llm:y', count: 1 },
      ]);
      batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushNode forces a batch out before a node finishes', () => {
    const batches: string[] = [];
    const batcher = new TokenBatcher((nodeId) => batches.push(nodeId), 10_000);
    batcher.push('llm:x', { t: 'text', v: 'a' });
    batcher.flushNode('llm:x');
    expect(batches).toEqual(['llm:x']);
    batcher.flushNode('llm:x'); // nothing left
    expect(batches).toEqual(['llm:x']);
    batcher.dispose();
  });
});

/**
 * Peer version detection. `@langchain/core` exposes `./package.json` today,
 * so this adapter never showed the `openai@unknown` symptom its sibling did —
 * but it reads the version the same way, and an `exports` map is the
 * package's to change. Both the real reading and the on-disk fallback are
 * pinned so a future LangChain release cannot silently blank the label.
 */
describe('peer version detection', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  function installed(name: string): string {
    const manifest = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
  }

  it('labels the run with the installed @langchain/core and langgraph versions', async () => {
    const viewer = await FakeViewer.start();
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });

    await gm.run('version-check', async () => undefined);
    await waitUntil(() => viewer.ofType('run.started').length > 0, 8000, 'run.started');

    const payload = viewer.ofType('run.started')[0]?.payload as {
      sdk: { name: string; version: string };
      meta: Record<string, unknown>;
    };
    expect(payload.sdk).toEqual({ name: 'langchain', version: installed('@langchain/core') });
    expect(payload.sdk.version).not.toBe('unknown');
    expect(payload.meta['langgraph']).toBe(installed('@langchain/langgraph'));
  });

  it('reads a version through an exports map that hides ./package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, 'node_modules', '@scope', 'hidden-manifest');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@scope/hidden-manifest',
        version: '9.9.9',
        type: 'commonjs',
        exports: { '.': './index.js' },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    const from = pathToFileURL(join(root, 'consumer.js')).href;

    expect(() => createRequire(from)('@scope/hidden-manifest/package.json')).toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
    );
    expect(peerVersion('@scope/hidden-manifest', from)).toBe('9.9.9');
  });

  it('degrades to undefined for a peer that is not installed', () => {
    expect(peerVersion('definitely-not-installed-sdk', import.meta.url)).toBeUndefined();
  });
});
