/**
 * Building a tape from stored events, and comparing two trajectories.
 * The runtime half (what a loaded tape does to a running agent) is proved
 * in packages/ai-sdk/test/replay.test.ts against a real agent.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_BYTES } from '@graphmind-ai/schema';
import { compareTrajectories } from '../src/replay/compare.js';
import { buildTape, trajectoryOf } from '../src/replay/tape.js';
import type { StoredEvent } from '../src/storage.js';

class Events {
  readonly list: StoredEvent[] = [];
  private seq = 0;
  private instance = 0;

  push(type: string, payload: unknown): this {
    this.seq += 1;
    this.list.push({
      runId: 'run_1',
      seq: this.seq,
      ts: 1000 + this.seq,
      type,
      nodeId: (payload as { nodeId?: string }).nodeId ?? null,
      payload,
    });
    return this;
  }

  start(app = 'demo'): this {
    return this.push('run.started', { app, sdk: { name: 'ai', version: '7.0.0' } });
  }

  call(
    kind: 'tool' | 'llm' | 'agent',
    name: string,
    input: unknown,
    opts: { output?: unknown; error?: string; unfinished?: boolean; usage?: unknown } = {},
  ): this {
    this.instance += 1;
    const instanceId = `i${this.instance}`;
    const nodeId = `${kind}:${name}`;
    this.push('node.started', { nodeId, kind, name, instanceId, input });
    if (opts.unfinished === true) return this;
    if (opts.error !== undefined) {
      this.push('node.error', { nodeId, instanceId, error: { name: 'Error', message: opts.error } });
    }
    this.push('node.finished', {
      nodeId,
      instanceId,
      status: opts.error === undefined ? 'ok' : 'error',
      ...(opts.output !== undefined ? { output: opts.output } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
      durationMs: 5,
    });
    return this;
  }
}

describe('buildTape', () => {
  it('records one entry per completed call, in order, with its key', () => {
    const events = new Events().start().call('tool', 'read', { f: 'a' }, { output: { text: 'hi' } });
    const { tape } = buildTape('run_1', events.list);
    expect(tape.runId).toBe('run_1');
    expect(tape.app).toBe('demo');
    expect(tape.entries).toHaveLength(1);
    expect(tape.entries[0]).toMatchObject({
      nodeId: 'tool:read',
      kind: 'tool',
      name: 'read',
      ordinal: 0,
      status: 'ok',
      output: { text: 'hi' },
    });
    expect(tape.entries[0]?.key).toContain('tool:read');
  });

  it('numbers repeated calls of one node', () => {
    const events = new Events()
      .start()
      .call('tool', 'read', { f: 'a' }, { output: 1 })
      .call('tool', 'read', { f: 'b' }, { output: 2 });
    const { tape } = buildTape('run_1', events.list);
    expect(tape.entries.map((entry) => entry.ordinal)).toEqual([0, 1]);
    expect(tape.entries.map((entry) => entry.output)).toEqual([1, 2]);
  });

  it('keeps a call that threw, with its error', () => {
    const events = new Events().start().call('tool', 'charge', {}, { error: 'card declined' });
    const { tape } = buildTape('run_1', events.list);
    expect(tape.entries[0]).toMatchObject({ status: 'error' });
    expect(tape.entries[0]?.error?.message).toBe('card declined');
  });

  it('omits calls that never completed, and counts them', () => {
    const events = new Events()
      .start()
      .call('tool', 'read', {}, { output: 1 })
      .call('tool', 'hang', {}, { unfinished: true });
    const result = buildTape('run_1', events.list);
    expect(result.tape.entries).toHaveLength(1);
    expect(result.unfinished).toBe(1);
  });

  it('skips agent spans — they are shape, not answerable calls', () => {
    const events = new Events().start().call('agent', 'planner', {}, { output: 'done' });
    expect(buildTape('run_1', events.list).tape.entries).toHaveLength(0);
  });

  it('keeps LLM steps with their usage, for the replay model', () => {
    const events = new Events().start().call('llm', 'step', { prompt: [] }, {
      output: { text: 'hi', finishReason: 'stop' },
      usage: { inputTokens: 10, outputTokens: 2, inclusive: true },
    });
    const { tape } = buildTape('run_1', events.list);
    expect(tape.entries[0]).toMatchObject({ kind: 'llm', usage: { inputTokens: 10 } });
  });

  it('flags a value the recorder had to shrink', () => {
    const events = new Events().start().call('tool', 'scrape', {}, {
      output: { __graphmindTruncated: true, bytes: MAX_PAYLOAD_BYTES + 1, preview: 'xxx' },
    });
    const result = buildTape('run_1', events.list);
    expect(result.lossy).toBe(1);
    expect(result.tape.entries[0]?.lossy).toBe(true);
  });

  it('finds a shrink marker nested inside a recorded value', () => {
    const events = new Events().start().call('tool', 'scrape', {}, {
      output: { page: { body: { __graphmindTruncated: true, bytes: 1, preview: 'x' } } },
    });
    expect(buildTape('run_1', events.list).lossy).toBe(1);
  });

  it('survives malformed payloads instead of failing the build', () => {
    const events = new Events().start();
    events.push('node.started', 'not an object');
    events.push('node.finished', { nodeId: 'tool:ghost', status: 'ok', durationMs: 1 });
    expect(() => buildTape('run_1', events.list)).not.toThrow();
  });
});

describe('trajectoryOf', () => {
  it('includes model steps as positions, so a lost turn is visible', () => {
    const events = new Events()
      .start()
      .call('llm', 'step', { prompt: [] }, { output: { text: 'x' } })
      .call('tool', 'read', { f: 'a' }, { output: 1 });
    const steps = trajectoryOf(buildTape('run_1', events.list).tape.entries);
    expect(steps.map((step) => step.nodeId)).toEqual(['llm:step', 'tool:read']);
  });

  it('gives model steps no key: their "arguments" are the whole conversation', () => {
    const events = new Events().start().call('llm', 'step', { prompt: ['a'] }, { output: { text: 'x' } });
    const steps = trajectoryOf(buildTape('run_1', events.list).tape.entries);
    expect(steps[0]?.key).toBeUndefined();
  });

  it('a run that lost its final model step diverges from one that kept it', () => {
    const full = new Events()
      .start()
      .call('llm', 'step', {}, { output: { text: 'a' } })
      .call('tool', 'read', { f: 'a' }, { output: 1 })
      .call('llm', 'step', {}, { output: { text: 'done' } });
    const truncated = new Events()
      .start()
      .call('llm', 'step', {}, { output: { text: 'a' } })
      .call('tool', 'read', { f: 'a' }, { output: 1 });
    const result = compareTrajectories(
      trajectoryOf(buildTape('r', full.list).tape.entries),
      trajectoryOf(buildTape('r', truncated.list).tape.entries),
    );
    expect(result.ok).toBe(false);
    expect(result.divergences[0]?.kind).toBe('regression');
  });
});

describe('compareTrajectories', () => {
  const step = (nodeId: string, key: string, status: 'ok' | 'error' = 'ok') => ({
    nodeId,
    name: nodeId.split(':')[1] ?? nodeId,
    kind: 'tool' as const,
    ordinal: 0,
    status,
    key,
  });

  it('an identical trajectory is a clean pass', () => {
    const recorded = [step('tool:a', 'ka'), step('tool:b', 'kb')];
    const result = compareTrajectories(recorded, [...recorded]);
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.divergences).toHaveLength(0);
  });

  it('a pure reordering is an acceptable alternative, named once', () => {
    const recorded = [step('tool:a', 'ka'), step('tool:b', 'kb')];
    const actual = [step('tool:b', 'kb'), step('tool:a', 'ka')];
    const result = compareTrajectories(recorded, actual);
    expect(result.ok).toBe(true);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.kind).toBe('alternative');
  });

  it('a missing call is a regression', () => {
    const result = compareTrajectories([step('tool:a', 'ka'), step('tool:b', 'kb')], [step('tool:a', 'ka')]);
    expect(result.ok).toBe(false);
    expect(result.divergences[0]?.kind).toBe('regression');
  });

  it('an unexpected call is extra', () => {
    const result = compareTrajectories([step('tool:a', 'ka')], [step('tool:a', 'ka'), step('tool:b', 'kb')]);
    expect(result.ok).toBe(false);
    expect(result.divergences[0]).toMatchObject({ kind: 'extra', name: 'b' });
  });

  it('the same call with different arguments is its own class', () => {
    const result = compareTrajectories([step('tool:a', 'ka')], [step('tool:a', 'DIFFERENT')]);
    expect(result.ok).toBe(false);
    expect(result.divergences[0]?.kind).toBe('arguments');
  });

  it('a call that newly fails is a regression', () => {
    const result = compareTrajectories([step('tool:a', 'ka', 'ok')], [step('tool:a', 'ka', 'error')]);
    expect(result.ok).toBe(false);
    expect(result.divergences[0]?.kind).toBe('regression');
    expect(result.divergences[0]?.message).toContain('failed');
  });

  it('a different tool in the same slot is a regression, not two findings', () => {
    const result = compareTrajectories([step('tool:a', 'ka')], [step('tool:z', 'kz')]);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.message).toContain('expected a, got z');
  });
});
