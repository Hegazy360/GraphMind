/**
 * `graphmind mcp` reads token usage per contract C1: inclusive usage is
 * trusted and labelled, pre-0.6 usage is "as reported" (0.5 Anthropic TS
 * events recomputed), cache / reasoning counts appear only when recorded,
 * run and LLM-node totals carry a basis, and LLM instances get a normalized
 * finish reason (legacy raw values normalized too).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';
import {
  getNode,
  getRun,
  instanceUsageJson,
  outputFinishReason,
  totalUsageJson,
  type ToolContext,
} from '../src/mcp/tools.js';

const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);
let dir: string;
let storage: SqliteStorage;
let ctx: ToolContext;

const INCLUSIVE = {
  inputTokens: 1205,
  outputTokens: 100,
  inclusive: true,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  reasoningTokens: 12,
  cacheCreationTokens: 200,
};
const LEGACY_ANTHROPIC_TS = { inputTokens: 5, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 200 };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gm-mcp-usage-'));
  storage = new SqliteStorage(join(dir, 'db.sqlite'));
  const put = (seq: number, type: string, payload: unknown, nodeId: string | null = null) =>
    storage.insertEvent({ runId: 'run-u', seq, ts: T0 + seq, type, nodeId, payload });
  storage.ensureRun({ id: 'run-u', app: 'usage', startedAt: T0, schemaVersion: 1, source: 'live' });
  put(0, 'run.started', { app: 'usage', sdk: { name: 't', version: '0.6.0' } });
  put(1, 'node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 's1', input: {} }, 'llm:step');
  put(2, 'node.finished', {
    nodeId: 'llm:step', instanceId: 's1', durationMs: 10, status: 'ok', usage: INCLUSIVE,
    output: { text: '', finishReason: 'length', rawFinishReason: 'max_tokens', toolCalls: [{ name: 'w', input: null, inputText: '{' }] },
  }, 'llm:step');
  put(3, 'node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 's2', input: {} }, 'llm:step');
  put(4, 'node.finished', {
    nodeId: 'llm:step', instanceId: 's2', durationMs: 10, status: 'ok', usage: LEGACY_ANTHROPIC_TS,
    output: { text: 'done', stopReason: 'end_turn' },
  }, 'llm:step');
  put(5, 'node.started', { nodeId: 'tool:w', kind: 'tool', name: 'w', instanceId: 't1', input: {} }, 'tool:w');
  put(6, 'node.finished', { nodeId: 'tool:w', instanceId: 't1', durationMs: 1, status: 'ok', output: 'ok' }, 'tool:w');
  ctx = { storage, viewerBaseUrl: 'http://127.0.0.1:4747' };
});

afterAll(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('usage in get_node', () => {
  it('labels each instance and normalizes the finish reason', () => {
    const node = getNode(ctx, { runId: 'run-u', nodeId: 'llm:step' });
    const [first, second] = node.instances;
    expect(first?.usage).toEqual({
      inputTokens: 1205,
      outputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      reasoningTokens: 12,
      basis: 'inclusive',
    });
    expect(first?.finishReason).toBe('length');
    expect(second?.usage).toMatchObject({ inputTokens: 1205, outputTokens: 50, basis: 'inclusive (recomputed)' });
    expect(second?.usage?.note).toContain('recomputed');
    expect(second?.finishReason).toBe('stop'); // the 0.5 Anthropic `stopReason`, normalized
    const tool = getNode(ctx, { runId: 'run-u', nodeId: 'tool:w' });
    expect(tool.instances[0]).not.toHaveProperty('usage');
    expect(tool.instances[0]).not.toHaveProperty('finishReason');
  });
});

describe('usage in get_run', () => {
  it('run and LLM-node totals carry a basis; nodes without usage have none', () => {
    const run = getRun(ctx, { runId: 'run-u' });
    const total = {
      inputTokens: 2410,
      outputTokens: 150,
      cacheReadTokens: 2000,
      cacheWriteTokens: 400,
      reasoningTokens: 12,
      basis: 'inclusive',
    };
    expect(run.run.tokens).toEqual(total);
    expect(run.nodes.find((n) => n.nodeId === 'llm:step')?.tokens).toEqual(total);
    expect(run.nodes.find((n) => n.nodeId === 'tool:w')).not.toHaveProperty('tokens');
  });
});

describe('helpers', () => {
  it('a mixed total says so', () => {
    const total = totalUsageJson([INCLUSIVE, { inputTokens: 7, outputTokens: 3 }, undefined, 'x']);
    expect(total).toMatchObject({ inputTokens: 1212, outputTokens: 103, basis: 'mixed' });
    expect(total?.note).toContain('before GraphMind 0.6');
    expect(totalUsageJson([undefined])).toBeUndefined();
  });

  it('instance usage passes the 0.5 OpenAI alias through as the cache read', () => {
    expect(instanceUsageJson({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 64 })).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 64,
      basis: 'as reported',
    });
    expect(instanceUsageJson({ inputTokens: -1, outputTokens: 1 })).toBeUndefined();
  });

  it('finish reasons: new, legacy raw, tool calls, garbage', () => {
    expect(outputFinishReason({ finishReason: 'tool-calls' })).toBe('tool-calls');
    expect(outputFinishReason({ finishReason: 'tool_calls' })).toBe('tool-calls');
    expect(outputFinishReason({ finishReason: 'STOP', toolCalls: [{ name: 'x' }] })).toBe('tool-calls');
    expect(outputFinishReason({ status: 'completed' })).toBeUndefined();
    expect(outputFinishReason('text')).toBeUndefined();
    expect(outputFinishReason(null)).toBeUndefined();
  });
});
