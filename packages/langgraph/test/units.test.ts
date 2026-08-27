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
import {
  compactMessages,
  parseToolInput,
  resolveChainStartArgs,
  serializedName,
  textFromLLMResult,
  unwrapToolOutput,
  usageFromLLMResult,
} from '../src/lc-types.js';
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
    ).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('reads llmOutput.tokenUsage (OpenAI-style LLMs)', () => {
    expect(
      usageFromLLMResult({
        generations: [[{ text: 'hi' }]],
        llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
      }),
    ).toEqual({ inputTokens: 11, outputTokens: 5 });
  });

  it('reads snake_case llmOutput.usage', () => {
    expect(
      usageFromLLMResult({
        generations: [[{ text: 'hi' }]],
        llmOutput: { usage: { prompt_tokens: 2, completion_tokens: 4 } },
      }),
    ).toEqual({ inputTokens: 2, outputTokens: 4 });
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

  it('truncates oversized payloads to a preview', () => {
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
