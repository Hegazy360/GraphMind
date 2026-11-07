/**
 * End-to-end: stored envelopes in, one report out — the same path
 * `graphmind runs --behavior` and the MCP `get_behavior` tool take.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRun, outputFinishReason, sampleFromEvents, type SampleEvent } from '../src/index.js';

class EventLog {
  events: SampleEvent[] = [];
  private seq = 0;
  private instance = 0;

  push(type: string, payload: unknown): this {
    this.seq += 1;
    this.events.push({ seq: this.seq, ts: 1000 + this.seq * 100, type, payload });
    return this;
  }

  start(app = 'demo-app'): this {
    return this.push('run.started', { app, sdk: { name: 'test', version: '0.0.0' } });
  }

  finish(status = 'ok'): this {
    return this.push('run.finished', { status });
  }

  tool(
    name: string,
    input: unknown,
    opts: { status?: string; output?: unknown; error?: string; durationMs?: number; heldMs?: number } = {},
  ): this {
    this.instance += 1;
    const instanceId = `i${this.instance}`;
    const nodeId = `tool:${name}`;
    this.push('node.started', { nodeId, kind: 'tool', name, instanceId, input });
    if (opts.error !== undefined) {
      this.push('node.error', { nodeId, instanceId, error: { name: 'Error', message: opts.error } });
    }
    this.push('node.finished', {
      nodeId,
      instanceId,
      status: opts.status ?? (opts.error !== undefined ? 'error' : 'ok'),
      output: opts.output,
      durationMs: opts.durationMs ?? 10,
      ...(opts.heldMs !== undefined ? { heldMs: opts.heldMs } : {}),
    });
    return this;
  }

  llm(opts: { inputTokens?: number; outputTokens?: number; finishReason?: string } = {}): this {
    this.instance += 1;
    const instanceId = `i${this.instance}`;
    this.push('node.started', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId, input: {} });
    this.push('node.finished', {
      nodeId: 'llm:step',
      instanceId,
      status: 'ok',
      output: { finishReason: opts.finishReason ?? 'stop' },
      usage: {
        inputTokens: opts.inputTokens ?? 100,
        outputTokens: opts.outputTokens ?? 20,
        inclusive: true,
      },
      durationMs: 50,
    });
    return this;
  }
}

describe('sampleFromEvents', () => {
  it('folds starts, completions and errors into executions', () => {
    const log = new EventLog().start().tool('read', { f: 'a' }).tool('flaky', { q: 1 }, { error: 'boom' }).finish('error');
    const sample = sampleFromEvents(log.events, 'run_1');
    expect(sample.runId).toBe('run_1');
    expect(sample.app).toBe('demo-app');
    expect(sample.status).toBe('error');
    expect(sample.executions).toHaveLength(2);
    expect(sample.executions[0]).toMatchObject({ nodeId: 'tool:read', status: 'ok', durationMs: 10 });
    expect(sample.executions[1]).toMatchObject({ status: 'error', errorMessage: 'boom' });
  });

  it('skips garbage payloads instead of failing', () => {
    const sample = sampleFromEvents([
      { seq: 1, ts: 1, type: 'node.started', payload: 'not an object' },
      { seq: 2, ts: 2, type: 'some.future.event', payload: {} },
    ]);
    expect(sample.executions).toHaveLength(0);
  });
});

describe('analyzeRun', () => {
  it('reports a clean run as clean', () => {
    const log = new EventLog().start().llm().tool('read', { f: 'a' }).llm().tool('read', { f: 'b' }).finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.toolCalls).toBe(2);
    expect(report.llmSteps).toBe(2);
    expect(report.waste.wastedCalls).toBe(0);
    expect(report.verdict).toBe('No wasted work detected across 2 tool calls and 2 LLM steps.');
  });

  it('names wasted work, the failing tool, and token-limit stops in one verdict', () => {
    const log = new EventLog().start();
    log.llm({ inputTokens: 100 });
    log.tool('search', { q: 'x' });
    log.llm({ inputTokens: 300 });
    log.tool('search', { q: 'x' });
    log.llm({ inputTokens: 900, finishReason: 'length' });
    log.tool('check', { n: 1 }, { error: 'bad' }).tool('check', { n: 2 }, { error: 'bad' });
    log.finish('error');
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.waste.wastedCalls).toBe(1);
    expect(report.verdict).toContain('1 of 4 tool calls (25%) repeated earlier work (1 repeat)');
    expect(report.verdict).toContain('check failed 2 of 2 calls');
    expect(report.verdict).toContain('1 LLM step stopped at the token limit');
  });

  it('counts silent failures (returned, not thrown) separately', () => {
    const log = new EventLog().start().tool('shell', { cmd: 'ls' }, { output: { exitCode: 1 } }).finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    const shell = report.tools.find((tool) => tool.name === 'shell');
    expect(shell?.silentFailures).toBe(1);
    expect(shell?.failures).toBe(0);
    expect(report.verdict).toContain('returned as a result, not thrown');
  });

  it('tracks recovery: a failure followed by a success of the same tool', () => {
    const log = new EventLog()
      .start()
      .tool('fetch', { u: 1 }, { error: 'ETIMEDOUT' })
      .tool('fetch', { u: 1, retry: true })
      .finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.tools[0]).toMatchObject({ failures: 1, recovered: 1 });
  });

  it('builds the context curve and growth factor from LLM usage', () => {
    const log = new EventLog().start().llm({ inputTokens: 100 }).llm({ inputTokens: 250 }).llm({ inputTokens: 400 }).finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.context.points.map((point) => point.inputTokens)).toEqual([100, 250, 400]);
    expect(report.context.growthFactor).toBe(4);
    expect(report.context.maxInputTokens).toBe(400);
  });

  it('attributes LLM tokens spent inside a waste incident span', () => {
    const log = new EventLog().start();
    log.tool('search', { q: 'x' });
    log.llm({ inputTokens: 500, outputTokens: 50 });
    log.tool('search', { q: 'x' });
    log.finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.waste.spanLlmSteps).toBe(1);
    expect(report.waste.spanInputTokens).toBe(500);
    expect(report.waste.spanOutputTokens).toBe(50);
  });

  it('subtracts debugger hold time from wasted duration', () => {
    const log = new EventLog()
      .start()
      .tool('read', { f: 'a' }, { durationMs: 1000, heldMs: 900 })
      .tool('read', { f: 'a' }, { durationMs: 1000, heldMs: 900 })
      .finish();
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.waste.wastedDurationMs).toBe(100);
  });

  it('notes an unfinished run', () => {
    const log = new EventLog().start().tool('read', { f: 'a' });
    const report = analyzeRun(sampleFromEvents(log.events));
    expect(report.notes.join(' ')).toContain('has not finished');
  });

  it('says so when there is nothing to analyze', () => {
    const report = analyzeRun(sampleFromEvents(new EventLog().start().finish().events));
    expect(report.verdict).toBe('Nothing to analyze: the run recorded no LLM steps and no tool calls.');
  });
});

describe('outputFinishReason', () => {
  it('reads a normalized reason, a raw provider string, and the Anthropic stopReason', () => {
    expect(outputFinishReason({ finishReason: 'length' })).toBe('length');
    expect(outputFinishReason({ finishReason: 'MAX_TOKENS' })).toBe('length');
    expect(outputFinishReason({ stopReason: 'end_turn' })).toBe('stop');
    expect(outputFinishReason({ finishReason: 'stop', toolCalls: [{ name: 't', input: {} }] })).toBe('tool-calls');
    expect(outputFinishReason(undefined)).toBeUndefined();
  });
});
