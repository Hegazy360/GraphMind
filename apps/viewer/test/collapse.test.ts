/**
 * Collapsible groups: what folds, what a folded card summarizes, and what a
 * large run folds by default.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  autoCollapseRoots,
  childIndex,
  collapsibleRoots,
  descendantsOf,
  hiddenByCollapse,
  isCollapsible,
  summarizeGroup,
} from '../src/store/collapse.js';
import { runStateToFlow } from '../src/store/runStateToFlow.js';
import type { RunState } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

beforeEach(resetCounters);

function buildRun(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, event) => applyEvent(acc, event, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('run not built');
  return run;
}

/** agent:a → llm:s → (tool:x, tool:y); agent:b is a lone sibling. */
function nestedRun(): RunState {
  return buildRun([
    started('agent:a', 'agent'),
    started('llm:s', 'llm', { parentId: 'agent:a' }),
    started('tool:x', 'tool', { parentId: 'llm:s' }),
    ev('node.finished', { nodeId: 'tool:x', output: 1, durationMs: 40, status: 'ok' }),
    started('tool:y', 'tool', { parentId: 'llm:s' }),
    ev('node.error', { nodeId: 'tool:y', error: { name: 'Boom', message: 'nope' } }),
    ev('node.finished', { nodeId: 'tool:y', output: null, durationMs: 10, status: 'error' }),
    started('agent:b', 'agent'),
  ]);
}

describe('collapse — structure', () => {
  it('indexes children and walks descendants', () => {
    const run = nestedRun();
    const index = childIndex(run);
    expect(index.get('agent:a')).toEqual(['llm:s']);
    expect(index.get('llm:s')).toEqual(['tool:x', 'tool:y']);
    expect(descendantsOf(run, 'agent:a').sort()).toEqual(['llm:s', 'tool:x', 'tool:y']);
    expect(isCollapsible(run, 'agent:a')).toBe(true);
    expect(isCollapsible(run, 'tool:x')).toBe(false);
    expect(isCollapsible(run, 'agent:b')).toBe(false);
  });

  it('maps hidden nodes to the outermost collapsed ancestor', () => {
    const run = nestedRun();
    const hidden = hiddenByCollapse(run, ['agent:a', 'llm:s']);
    expect(hidden.get('llm:s')).toBe('agent:a');
    expect(hidden.get('tool:x')).toBe('agent:a');
    expect(hidden.get('tool:y')).toBe('agent:a');
    expect(hidden.has('agent:a')).toBe(false); // the root itself stays visible
    expect(hidden.has('agent:b')).toBe(false);
  });
});

describe('collapse — summary', () => {
  it('aggregates executions, failures and worst-of status', () => {
    const run = nestedRun();
    const summary = summarizeGroup(run, 'agent:a');
    expect(summary.nodes).toBe(3);
    expect(summary.tools).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.durationMs).toBe(50);
    // llm:s is still running, but a failure inside is the more urgent signal.
    expect(summary.status).toBe('error');
  });

  it('a paused descendant outranks an error', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('tool:x', 'tool', { parentId: 'agent:a' }),
      ev('node.error', { nodeId: 'tool:x', error: { name: 'E', message: 'x' } }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:x', point: 'error' }),
    ]);
    expect(summarizeGroup(run, 'agent:a').status).toBe('paused');
    expect(summarizeGroup(run, 'agent:a').paused).toBe(1);
  });
});

describe('collapse — projection into the flow graph', () => {
  it('hides the subtree and re-points crossing edges at the summary card', () => {
    const run = nestedRun();
    const { nodes, edges } = runStateToFlow(run, { collapsed: ['agent:a'] });
    expect(nodes.map((n) => n.id)).toEqual(['agent:a', 'agent:b']);
    expect(nodes[0]?.type).toBe('group');
    // agent:a → llm:s and llm:s → tool:* all collapse into the card itself.
    expect(edges).toEqual([]);
  });

  it('keeps an edge that crosses the collapse boundary', () => {
    const run = buildRun([
      started('agent:a', 'agent'),
      started('llm:s', 'llm', { parentId: 'agent:a' }),
      started('tool:x', 'tool', { parentId: 'llm:s' }),
      started('tool:outside', 'tool', { parentId: 'agent:a' }),
    ]);
    const { nodes, edges } = runStateToFlow(run, { collapsed: ['llm:s'] });
    expect(nodes.map((n) => n.id)).toEqual(['agent:a', 'llm:s', 'tool:outside']);
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'agent:a->llm:s',
      'agent:a->tool:outside',
    ]);
  });

  it('collapsing nothing matches the uncollapsed projection', () => {
    const run = nestedRun();
    expect(runStateToFlow(run, { collapsed: [] })).toEqual(runStateToFlow(run));
  });
});

describe('collapse — defaults for large runs', () => {
  /** One root, `workers` sub-agents, each owning `tools` leaves. */
  function fanOut(workers: number, tools: number): RunState {
    const events = [started('agent:root', 'agent')];
    for (let w = 0; w < workers; w++) {
      events.push(started(`agent:w${w}`, 'agent', { parentId: 'agent:root' }));
      for (let t = 0; t < tools; t++) {
        events.push(started(`tool:w${w}-${t}`, 'tool', { parentId: `agent:w${w}` }));
      }
    }
    return buildRun(events);
  }

  it('folds the shallowest level that gets under the target', () => {
    const run = fanOut(20, 4); // 1 + 20 + 80 = 101 nodes
    const roots = autoCollapseRoots(run, 60);
    expect(roots).toHaveLength(20);
    expect(roots[0]).toBe('agent:w0');
    const visible = runStateToFlow(run, { collapsed: roots }).nodes.length;
    expect(visible).toBe(21);
    expect(visible).toBeLessThanOrEqual(60);
  });

  it('leaves a small run alone', () => {
    expect(autoCollapseRoots(fanOut(3, 2), 60)).toEqual([]);
  });

  it('collapsibleRoots picks outermost containers only', () => {
    const run = nestedRun();
    // agent:a contains llm:s — only the outer one is returned.
    expect(collapsibleRoots(run)).toEqual(['agent:a']);
  });
});
