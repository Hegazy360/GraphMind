/**
 * The viewer's bridge to @graphmind-ai/analyze: the RunState → RunSample
 * mapping must agree with what the events-based fold would have produced
 * (ordering, held time, errors), because the whole point of the shared
 * package is that the viewer, the CLI and MCP never disagree.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRun } from '@graphmind-ai/analyze';
import { sampleFromRunState, wasteSpanExecutions } from '../src/lib/behavior.js';
import type { NodeExecution, NodeState, RunState } from '../src/store/types.js';

function node(
  nodeId: string,
  kind: NodeState['kind'],
  executions: Partial<NodeExecution>[],
): NodeState {
  return {
    nodeId,
    kind,
    name: nodeId.split(':')[1] ?? nodeId,
    ghost: false,
    executions: executions.map((partial, index) => ({
      instanceId: `${nodeId}#${index}`,
      input: {},
      status: 'ok',
      startedTs: 1000 + index,
      ...partial,
    })) as NodeExecution[],
  };
}

function run(nodes: NodeState[], status: RunState['meta']['status'] = 'ok'): RunState {
  const record: Record<string, NodeState> = {};
  for (const entry of nodes) record[entry.nodeId] = entry;
  return {
    runId: 'run-1',
    meta: { runId: 'run-1', app: 'demo', status, source: 'live' },
    nodes: record,
    order: nodes.map((entry) => entry.nodeId),
    pauses: {},
  } as RunState;
}

describe('sampleFromRunState', () => {
  it('orders executions by envelope seq across nodes', () => {
    const state = run([
      node('tool:b', 'tool', [{ seq: 5, startedTs: 2000 }]),
      node('tool:a', 'tool', [{ seq: 2, startedTs: 1000 }, { seq: 8, startedTs: 3000 }]),
    ]);
    const sample = sampleFromRunState(state);
    expect(sample.executions.map((execution) => execution.seq)).toEqual([2, 5, 8]);
    expect(sample.app).toBe('demo');
    expect(sample.status).toBe('ok');
  });

  it('falls back to start time when seqs are missing, and maps pending to running', () => {
    const state = run(
      [node('tool:b', 'tool', [{ startedTs: 2000 }]), node('tool:a', 'tool', [{ startedTs: 1000 }])],
      'pending',
    );
    const sample = sampleFromRunState(state);
    expect(sample.executions.map((execution) => execution.nodeId)).toEqual(['tool:a', 'tool:b']);
    expect(sample.status).toBe('running');
  });

  it('carries errors, usage and held time (derived included) into the sample', () => {
    const state = run([
      node('tool:x', 'tool', [
        {
          status: 'error',
          error: { name: 'E', message: 'boom' },
          durationMs: 500,
          derivedHeldMs: 400,
        },
      ]),
    ]);
    const sample = sampleFromRunState(state);
    expect(sample.executions[0]).toMatchObject({ errorMessage: 'boom', durationMs: 500, heldMs: 400 });
  });

  it('feeds analyzeRun the same way the event fold does: a repeat is found', () => {
    const state = run([
      node('tool:read', 'tool', [
        { seq: 1, input: { f: 'a' } },
        { seq: 3, input: { f: 'a' } },
      ]),
      node('llm:step', 'llm', [
        { seq: 2, usage: { inputTokens: 500, outputTokens: 20, inclusive: true } },
      ]),
    ]);
    const report = analyzeRun(sampleFromRunState(state));
    expect(report.waste.wastedCalls).toBe(1);
    expect(report.waste.incidents[0]).toMatchObject({ kind: 'repeat', firstSeq: 1, lastSeq: 3 });
    expect(report.waste.spanInputTokens).toBe(500);
  });
});

describe('wasteSpanExecutions', () => {
  it('returns the LLM executions inside incident seq spans', () => {
    const inside: Partial<NodeExecution> = { seq: 2, usage: { inputTokens: 1, outputTokens: 1 } };
    const outside: Partial<NodeExecution> = { seq: 9, usage: { inputTokens: 1, outputTokens: 1 } };
    const state = run([node('llm:step', 'llm', [inside, outside]), node('tool:read', 'tool', [{ seq: 1 }, { seq: 3 }])]);
    const execs = wasteSpanExecutions(state, [
      {
        kind: 'repeat',
        nodeIds: ['tool:read'],
        names: ['read'],
        count: 2,
        wasted: 1,
        firstSeq: 1,
        lastSeq: 3,
        firstIndex: 0,
        lastIndex: 1,
        fingerprint: 'abcd1234',
      },
    ]);
    expect(execs.map((execution) => execution.seq)).toEqual([2]);
  });

  it('prices nothing when the incidents carry no seqs', () => {
    const state = run([node('llm:step', 'llm', [{ seq: 2 }])]);
    expect(
      wasteSpanExecutions(state, [
        {
          kind: 'repeat',
          nodeIds: ['t'],
          names: ['t'],
          count: 2,
          wasted: 1,
          firstIndex: 0,
          lastIndex: 1,
          fingerprint: 'abcd1234',
        },
      ]),
    ).toEqual([]);
  });
});
