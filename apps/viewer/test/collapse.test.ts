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
  hintedCollapseRoots,
  isCollapsible,
  isHintedCollapsed,
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

describe('collapse — the sender\'s `collapsed: true` hint (MCP protocol group)', () => {
  /**
   * The wire shape `graphmind mcp-proxy` emits: work under the session,
   * protocol traffic under `mcp:protocol`. The reducer stores the hint on
   * `NodeState.collapsed`; until that hunk lands (see W2a open_issues) this
   * test sets the field the way the reducer will.
   */
  function proxySession(options: { initializeFails?: boolean; noise?: boolean } = {}): RunState {
    const run = buildRun([
      started('mcp:session', 'custom', { name: 'node server.js' }),
      started('mcp:protocol', 'custom', { name: 'protocol', parentId: 'mcp:session' }),
      started('mcp:initialize', 'custom', { name: 'initialize', parentId: 'mcp:protocol' }),
      ...(options.initializeFails
        ? [
            ev('node.error', {
              nodeId: 'mcp:initialize',
              error: { name: 'JsonRpcError(-32600)', message: 'unsupported protocol version' },
            }),
            ev('node.finished', { nodeId: 'mcp:initialize', output: null, durationMs: 12, status: 'error' }),
          ]
        : [ev('node.finished', { nodeId: 'mcp:initialize', output: {}, durationMs: 318, status: 'ok' })]),
      started('mcp:notifications/initialized', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.finished', { nodeId: 'mcp:notifications/initialized', output: null, durationMs: 1, status: 'ok' }),
      started('mcp:tools/list', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.finished', { nodeId: 'mcp:tools/list', output: {}, durationMs: 142, status: 'ok' }),
      started('mcp:resources/list', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.finished', { nodeId: 'mcp:resources/list', output: {}, durationMs: 96, status: 'ok' }),
      started('mcp:resources/templates/list', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.finished', { nodeId: 'mcp:resources/templates/list', output: {}, durationMs: 61, status: 'ok' }),
      started('mcp:prompts/list', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.finished', { nodeId: 'mcp:prompts/list', output: {}, durationMs: 84, status: 'ok' }),
      ...(options.noise
        ? [
            started('mcp:stdout-noise', 'custom', { name: 'stdout noise', parentId: 'mcp:protocol' }),
            ev('node.error', {
              nodeId: 'mcp:stdout-noise',
              error: { name: 'StdoutNoise', message: 'the MCP server wrote non-JSON to stdout' },
            }),
            ev('node.finished', { nodeId: 'mcp:stdout-noise', output: null, durationMs: 0, status: 'error' }),
          ]
        : []),
      started('tool:search', 'tool', { parentId: 'mcp:session' }),
      ev('node.finished', { nodeId: 'tool:search', output: {}, durationMs: 264, status: 'ok' }),
    ]);
    // What applyEvent will store from `node.started … collapsed: true`.
    (run.nodes['mcp:protocol'] as { collapsed?: boolean }).collapsed = true;
    return run;
  }

  it('reads the hint from NodeState.collapsed and nothing else', () => {
    expect(isHintedCollapsed({ collapsed: true } as unknown as never)).toBe(true);
    expect(isHintedCollapsed({ collapsed: 'true' } as unknown as never)).toBe(false);
    expect(isHintedCollapsed({} as never)).toBe(false);
  });

  it('folds exactly the hinted node, once it has children', () => {
    const run = proxySession();
    expect(hintedCollapseRoots(run)).toEqual(['mcp:protocol']);
    // A hinted node with nothing under it yet is not folded (empty card).
    const bare = buildRun([
      started('mcp:session', 'custom'),
      started('mcp:protocol', 'custom', { parentId: 'mcp:session' }),
    ]);
    (bare.nodes['mcp:protocol'] as { collapsed?: boolean }).collapsed = true;
    expect(hintedCollapseRoots(bare)).toEqual([]);
    // Without the hint, a custom node with children is left alone.
    const plain = proxySession();
    delete (plain.nodes['mcp:protocol'] as { collapsed?: boolean }).collapsed;
    expect(hintedCollapseRoots(plain)).toEqual([]);
  });

  it('shows the folded card as "6 calls · 702ms" and hides the six children', () => {
    const run = proxySession();
    const summary = summarizeGroup(run, 'mcp:protocol');
    expect(summary.nodes).toBe(6);
    expect(summary.tools).toBe(6); // custom nodes render on the tool card → "calls"
    expect(summary.executions).toBe(6);
    expect(summary.durationMs).toBe(702);
    expect(summary.errors).toBe(0);
    expect(summary.status).toBe('ok');

    const { nodes, edges } = runStateToFlow(run, { collapsed: hintedCollapseRoots(run) });
    expect(nodes.map((n) => n.id)).toEqual(['mcp:session', 'mcp:protocol', 'tool:search']);
    expect(nodes.find((n) => n.id === 'mcp:protocol')?.type).toBe('group');
    // The work is untouched and still wired to the session.
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual([
      'mcp:session->mcp:protocol',
      'mcp:session->tool:search',
    ]);
  });

  it('a protocol call that fails (initialize) badges the folded card as an error', () => {
    const run = proxySession({ initializeFails: true });
    const summary = summarizeGroup(run, 'mcp:protocol');
    expect(summary.errors).toBe(1);
    expect(summary.status).toBe('error');
    // …and the held gate on it outranks the error while it is paused.
    const held = buildRun([
      started('mcp:session', 'custom'),
      started('mcp:protocol', 'custom', { parentId: 'mcp:session' }),
      started('mcp:initialize', 'custom', { parentId: 'mcp:protocol' }),
      ev('node.error', { nodeId: 'mcp:initialize', error: { name: 'E', message: 'x' } }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'mcp:initialize', point: 'error' }),
    ]);
    expect(summarizeGroup(held, 'mcp:protocol').status).toBe('paused');
  });

  it('the stdout-noise child badges the group too', () => {
    const run = proxySession({ noise: true });
    const summary = summarizeGroup(run, 'mcp:protocol');
    expect(summary.nodes).toBe(7);
    expect(summary.errors).toBe(1);
    expect(summary.status).toBe('error');
  });

  it('"Collapse all" includes the hinted group even though `custom` is not a container kind', () => {
    const run = proxySession();
    expect(collapsibleRoots(run)).toEqual(['mcp:protocol']);
    const plain = proxySession();
    delete (plain.nodes['mcp:protocol'] as { collapsed?: boolean }).collapsed;
    expect(collapsibleRoots(plain)).toEqual([]);
  });

  it('a large run\'s auto-fold keeps the hinted group folded as well', () => {
    const events = [started('mcp:session', 'custom'), started('mcp:protocol', 'custom', { parentId: 'mcp:session' })];
    for (let i = 0; i < 3; i++) events.push(started(`mcp:p${i}`, 'custom', { parentId: 'mcp:protocol' }));
    for (let w = 0; w < 20; w++) {
      events.push(started(`agent:w${w}`, 'agent', { parentId: 'mcp:session' }));
      for (let t = 0; t < 4; t++) events.push(started(`tool:w${w}-${t}`, 'tool', { parentId: `agent:w${w}` }));
    }
    const run = buildRun(events);
    (run.nodes['mcp:protocol'] as { collapsed?: boolean }).collapsed = true;
    const roots = autoCollapseRoots(run, 60);
    expect(roots).toContain('mcp:protocol');
    expect(roots.filter((id) => id === 'mcp:protocol')).toHaveLength(1);
    expect(runStateToFlow(run, { collapsed: roots }).nodes.length).toBeLessThanOrEqual(60);
  });
});
