import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  NODE_DIMENSIONS,
  PAUSE_BANNER_HEIGHT,
  edgeVisual,
  nodeDimensions,
  runStateToFlow,
} from '../src/store/runStateToFlow.js';
import type { RunState } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(resetCounters);

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

describe('runStateToFlow — nodes', () => {
  it('renders one node per logical nodeId, typed by kind', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('llm:s1', 'llm', { parentId: 'agent:a' }),
      started('tool:t', 'tool', { parentId: 'agent:a', instanceId: 'c1' }),
      ev('node.finished', { nodeId: 'tool:t', output: 1, durationMs: 5, status: 'ok' }),
      started('tool:t', 'tool', { parentId: 'agent:a', instanceId: 'c2' }),
    ]);
    const { nodes } = runStateToFlow(run);
    expect(nodes.map((n) => n.id)).toEqual(['agent:a', 'llm:s1', 'tool:t']);
    expect(nodes.map((n) => n.type)).toEqual(['invocation', 'llmStep', 'tool']);
    // two executions still one node
    expect(run.nodes['tool:t']?.executions).toHaveLength(2);
  });

  it('includes graph.hint ghosts', () => {
    const run = buildRun([
      ev('graph.hint', {
        nodes: [
          { nodeId: 'agent:a', kind: 'agent', name: 'a' },
          { nodeId: 'tool:t', kind: 'tool', name: 't', parentId: 'agent:a' },
        ],
      }),
    ]);
    const { nodes, edges } = runStateToFlow(run);
    expect(nodes).toHaveLength(2);
    expect(edges).toEqual([{ id: 'e:agent:a->tool:t', source: 'agent:a', target: 'tool:t' }]);
    expect(edgeVisual(run, 'tool:t')).toBe('ghost');
  });

  it('carries identity-only data (hot path stays in the store)', () => {
    const run = buildRun([started('agent:a', 'agent')]);
    const { nodes } = runStateToFlow(run);
    expect(nodes[0]?.data).toEqual({ runId: RUN, nodeId: 'agent:a' });
  });
});

describe('runStateToFlow — edge derivation', () => {
  it('chains consecutive llm steps and fans tools out of their parent', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('llm:s1', 'llm', { parentId: 'agent:a' }),
      started('tool:t1', 'tool', { parentId: 'agent:a' }),
      started('llm:s2', 'llm', { parentId: 'agent:a' }),
      started('tool:t2', 'tool', { parentId: 'agent:a' }),
      started('llm:s3', 'llm', { parentId: 'agent:a' }),
    ]);
    const { edges } = runStateToFlow(run);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'agent:a->llm:s1', // first step from the agent
      'agent:a->tool:t1', // tool containment
      'llm:s1->llm:s2', // step chain
      'agent:a->tool:t2',
      'llm:s2->llm:s3', // step chain continues
    ]);
  });

  it('drops edges to parents that never materialized', () => {
    const run = buildRun([started('tool:t', 'tool', { parentId: 'agent:missing' })]);
    const { edges } = runStateToFlow(run);
    expect(edges).toHaveLength(0);
  });

  it('keeps separate step chains per parent', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('agent:b', 'agent'),
      started('llm:a1', 'llm', { parentId: 'agent:a' }),
      started('llm:b1', 'llm', { parentId: 'agent:b' }),
      started('llm:a2', 'llm', { parentId: 'agent:a' }),
    ]);
    const { edges } = runStateToFlow(run);
    expect(edges.map((e) => e.id)).toContain('e:llm:a1->llm:a2');
    expect(edges.map((e) => e.id)).toContain('e:agent:b->llm:b1');
  });
});

describe('runStateToFlow — dimensions and edge visuals', () => {
  it('paused nodes reserve space for the action banner (structural)', () => {
    const run = buildRun([
      started('tool:t', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:t', point: 'error' }),
    ]);
    const node = run.nodes['tool:t'];
    expect(node).toBeDefined();
    if (node === undefined) return;
    expect(nodeDimensions(node).height).toBe(NODE_DIMENSIONS.tool.height + PAUSE_BANNER_HEIGHT);
    expect(edgeVisual(run, 'tool:t')).toBe('paused');
  });

  it('edge visuals follow the target node lifecycle', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('tool:t', 'tool', { parentId: 'agent:a' }),
      ev('node.finished', { nodeId: 'tool:t', output: 1, durationMs: 5, status: 'ok' }),
      started('tool:e', 'tool', { parentId: 'agent:a' }),
      ev('node.error', { nodeId: 'tool:e', error: { name: 'E', message: 'x' } }),
      ev('node.finished', { nodeId: 'tool:e', output: null, durationMs: 5, status: 'error' }),
      started('tool:r', 'tool', { parentId: 'agent:a' }),
    ]);
    expect(edgeVisual(run, 'tool:t')).toBe('done');
    expect(edgeVisual(run, 'tool:e')).toBe('error');
    expect(edgeVisual(run, 'tool:r')).toBe('active');
  });
});
