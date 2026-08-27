/**
 * Layout: the tidy tree must never overlap two cards, must pack wide leaf
 * fan-outs, must be deterministic, and must be fast enough that a 300-node
 * run lays out inside one frame. The incremental planner must keep a growing
 * graph still.
 */
import { describe, expect, it } from 'vitest';
import {
  LAYER_GAP,
  SIBLING_GAP,
  leafColumnsFor,
  layoutGraph,
  tidyTreeLayout,
} from '../src/layout/tidyTree.js';
import {
  anchorPositions,
  appendLayout,
  planLayout,
  resizeOnly,
  type Placed,
} from '../src/layout/incremental.js';
import type { FlowEdgeSpec, FlowGraph, FlowNodeSpec } from '../src/store/runStateToFlow.js';

function node(id: string, width = 240, height = 100): FlowNodeSpec {
  return { id, type: 'tool', data: { runId: 'r', nodeId: id }, width, height };
}

function edge(source: string, target: string): FlowEdgeSpec {
  return { id: `e:${source}->${target}`, source, target };
}

/**
 * A laid-out canvas of `size` nodes plus the graph it came from, ready to
 * have more nodes appended onto it — the state a streaming run is in.
 */
function canvasOf(size: number): {
  prev: Map<string, Placed>;
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
} {
  const nodes: FlowNodeSpec[] = [node('agent', 264, 104)];
  const edges: FlowEdgeSpec[] = [];
  let previous = 'agent';
  for (let step = 0; nodes.length < size; step++) {
    const id = `llm:step-${step}`;
    nodes.push(node(id, 300, 164));
    edges.push(edge(previous, id));
    previous = id;
    for (let t = 0; t < 3 && nodes.length < size; t++) {
      nodes.push(node(`tool:t${step}-${t}`));
      edges.push(edge(id, `tool:t${step}-${t}`));
    }
  }
  const prev = new Map<string, Placed>(
    layoutGraph(nodes, edges).map((n) => [
      n.id,
      { id: n.id, position: n.position, width: n.width, height: n.height },
    ]),
  );
  return { prev, nodes: [...nodes], edges: [...edges] };
}

/** A single chain `depth` nodes long — the shape an llm-step chain produces. */
function chain(depth: number): FlowGraph {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];
  for (let i = 0; i < depth; i++) {
    nodes.push(node(`llm:step-${i}`, 300, 164));
    if (i > 0) edges.push(edge(`llm:step-${i - 1}`, `llm:step-${i}`));
  }
  return { nodes, edges };
}

/** root → `children` leaves. */
function star(children: number): FlowGraph {
  const nodes = [node('root')];
  const edges: FlowEdgeSpec[] = [];
  for (let i = 0; i < children; i++) {
    nodes.push(node(`leaf${i}`));
    edges.push(edge('root', `leaf${i}`));
  }
  return { nodes, edges };
}

function overlapping(laid: { position: { x: number; y: number }; width: number; height: number }[]): string[] {
  const clashes: string[] = [];
  for (let i = 0; i < laid.length; i++) {
    for (let j = i + 1; j < laid.length; j++) {
      const a = laid[i];
      const b = laid[j];
      if (a === undefined || b === undefined) continue;
      const hit =
        a.position.x < b.position.x + b.width &&
        a.position.x + a.width > b.position.x &&
        a.position.y < b.position.y + b.height &&
        a.position.y + a.height > b.position.y;
      if (hit) clashes.push(`${i}/${j}`);
    }
  }
  return clashes;
}

describe('tidyTreeLayout', () => {
  it('places children one layer below their parent', () => {
    const graph = star(2);
    const laid = tidyTreeLayout(graph.nodes, graph.edges);
    const root = laid.find((n) => n.id === 'root');
    const leaf = laid.find((n) => n.id === 'leaf0');
    expect(root?.position.y).toBe(0);
    expect(leaf?.position.y).toBe((root?.height ?? 0) + LAYER_GAP);
  });

  it('centres a parent over its children', () => {
    const graph = star(2);
    const laid = tidyTreeLayout(graph.nodes, graph.edges);
    const root = laid.find((n) => n.id === 'root');
    const a = laid.find((n) => n.id === 'leaf0');
    const b = laid.find((n) => n.id === 'leaf1');
    if (root === undefined || a === undefined || b === undefined) throw new Error('missing');
    const rootCentre = root.position.x + root.width / 2;
    const childrenCentre =
      (a.position.x + a.width / 2 + (b.position.x + b.width / 2)) / 2;
    expect(Math.abs(rootCentre - childrenCentre)).toBeLessThan(1);
  });

  it('never overlaps two cards, at any fan-out', () => {
    for (const count of [1, 3, 5, 12, 40, 200]) {
      const graph = star(count);
      expect(overlapping(tidyTreeLayout(graph.nodes, graph.edges))).toEqual([]);
    }
  });

  it('packs a wide leaf fan-out into a grid instead of one endless row', () => {
    const graph = star(40);
    const laid = tidyTreeLayout(graph.nodes, graph.edges);
    const leaves = laid.filter((n) => n.id !== 'root');
    const rows = new Set(leaves.map((n) => n.position.y));
    const width = Math.max(...leaves.map((n) => n.position.x)) - Math.min(...leaves.map((n) => n.position.x));
    expect(rows.size).toBeGreaterThan(1);
    // 40 leaves in a single row would be ~11,000px wide.
    expect(width).toBeLessThan(40 * (240 + SIBLING_GAP) * 0.4);
  });

  it('keeps leaf columns square-ish and capped', () => {
    expect(leafColumnsFor(3)).toBe(3);
    expect(leafColumnsFor(9)).toBe(4);
    expect(leafColumnsFor(500)).toBeLessThanOrEqual(8);
  });

  it('is deterministic', () => {
    const graph = star(17);
    expect(tidyTreeLayout(graph.nodes, graph.edges)).toEqual(
      tidyTreeLayout(graph.nodes, graph.edges),
    );
  });

  it('tolerates a cycle instead of hanging', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('b', 'a')];
    const laid = tidyTreeLayout(nodes, edges);
    expect(laid).toHaveLength(2);
    expect(overlapping(laid)).toEqual([]);
  });

  it('lays out a deep chain without collisions', () => {
    const nodes: FlowNodeSpec[] = [];
    const edges: FlowEdgeSpec[] = [];
    for (let i = 0; i < 60; i++) {
      nodes.push(node(`n${i}`));
      if (i > 0) edges.push(edge(`n${i - 1}`, `n${i}`));
    }
    const laid = tidyTreeLayout(nodes, edges);
    expect(overlapping(laid)).toEqual([]);
    expect(laid[59]?.position.y).toBeGreaterThan(laid[0]?.position.y ?? 0);
  });

  /**
   * `runStateToFlow` chains consecutive `llm` siblings, so a run whose
   * instrumentation mints a nodeId per step produces a tree whose DEPTH is
   * the node count. Measure and place used to recurse, and the canvas
   * rendered *nothing at all* past ~4–6k: a RangeError from inside layout.
   */
  it('lays out a 20,000-deep chain without overflowing the stack', () => {
    const { nodes, edges } = chain(20_000);
    const laid = layoutGraph(nodes, edges);
    expect(laid).toHaveLength(20_000);
    // Every step sits one layer below the one before it, all the way down.
    expect(laid[19_999]?.position.y).toBeGreaterThan(laid[0]?.position.y ?? 0);
    expect(laid.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(
      true,
    );
  });

  /**
   * Depth used to cost quadratic time: the cycle-break pass walked every
   * node's ancestor chain to the root, so 4x the depth was ~16x the work
   * (8.7ms → 138ms measured). A ratio, not a budget, so a slow machine
   * fails this for the right reason or not at all.
   */
  it('stays linear as the tree gets deeper', () => {
    const time = (depth: number): number => {
      const { nodes, edges } = chain(depth);
      layoutGraph(nodes, edges); // warm, so both sizes are measured JITted
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        layoutGraph(nodes, edges);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    // Both samples are milliseconds, not microseconds, so timer noise cannot
    // manufacture the ratio.
    const shallow = time(1000);
    const deep = time(4000);
    // 4x the depth. Linear is ~4x (measured ~3.5x); the old ancestor-walk
    // cycle check was ~15x, when it did not blow the stack first. 8x is
    // comfortably between the two.
    expect(deep / Math.max(shallow, 0.05)).toBeLessThan(8);
  });

  it('lays out 300 nodes well inside one animation frame', () => {
    // 50 sub-agents, each with a step and four tools — the stress shape.
    const nodes = [node('root')];
    const edges: FlowEdgeSpec[] = [];
    for (let w = 0; w < 50; w++) {
      nodes.push(node(`w${w}`));
      edges.push(edge('root', `w${w}`));
      nodes.push(node(`s${w}`));
      edges.push(edge(`w${w}`, `s${w}`));
      for (let t = 0; t < 4; t++) {
        nodes.push(node(`t${w}-${t}`));
        edges.push(edge(`s${w}`, `t${w}-${t}`));
      }
    }
    expect(nodes).toHaveLength(301);
    const started = performance.now();
    const laid = layoutGraph(nodes, edges);
    const elapsed = performance.now() - started;
    expect(laid).toHaveLength(301);
    expect(overlapping(laid)).toEqual([]);
    expect(elapsed).toBeLessThan(16);
  });
});

describe('planLayout', () => {
  const placed = (ids: string[]): Map<string, Placed> =>
    new Map(
      ids.map((id) => [id, { id, position: { x: 0, y: 0 }, width: 240, height: 100 }] as const),
    );

  it('needs a full pass for the first layout', () => {
    expect(planLayout(new Map(), star(2))).toBe('full');
  });

  it('does nothing when nothing changed', () => {
    const prev = placed(['root', 'leaf0']);
    expect(planLayout(prev, { nodes: [node('root'), node('leaf0')], edges: [] })).toBe('none');
  });

  it('treats a card growing in place as a resize, not a re-layout', () => {
    const prev = placed(['root']);
    const grown = { nodes: [node('root', 240, 192)], edges: [] };
    expect(planLayout(prev, grown)).toBe('resize');
    expect(resizeOnly(prev, grown)[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it('appends when a big graph gains a few nodes', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const prev = placed(ids);
    const next: FlowGraph = {
      nodes: [...ids.map((id) => node(id)), node('fresh')],
      edges: [edge('n0', 'fresh')],
    };
    expect(planLayout(prev, next)).toBe('append');
  });

  it('re-lays out when a node disappears (a collapse)', () => {
    const prev = placed(Array.from({ length: 30 }, (_, i) => `n${i}`));
    expect(planLayout(prev, { nodes: [node('n0')], edges: [] })).toBe('full');
  });

  it('re-lays out rather than appending a whole burst', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const prev = placed(ids);
    const nodes = [...ids.map((id) => node(id)), ...Array.from({ length: 60 }, (_, i) => node(`x${i}`))];
    expect(planLayout(prev, { nodes, edges: [] })).toBe('full');
  });

  it('always re-lays out when forced (auto-arrange)', () => {
    const prev = placed(['a']);
    expect(planLayout(prev, { nodes: [node('a')], edges: [] }, { force: true })).toBe('full');
  });
});

describe('appendLayout', () => {
  it('leaves every existing node exactly where it was', () => {
    const prev = new Map<string, Placed>([
      ['root', { id: 'root', position: { x: 100, y: 100 }, width: 240, height: 100 }],
    ]);
    const next: FlowGraph = { nodes: [node('root'), node('child')], edges: [edge('root', 'child')] };
    const laid = appendLayout(prev, next);
    expect(laid.find((n) => n.id === 'root')?.position).toEqual({ x: 100, y: 100 });
    const child = laid.find((n) => n.id === 'child');
    expect(child?.position.y).toBe(100 + 100 + LAYER_GAP);
    expect(child?.position.x).toBe(100); // centred under a same-width parent
  });

  it('slides siblings sideways instead of stacking them', () => {
    const prev = new Map<string, Placed>([
      ['root', { id: 'root', position: { x: 0, y: 0 }, width: 240, height: 100 }],
    ]);
    const next: FlowGraph = {
      nodes: [node('root'), node('a'), node('b'), node('c')],
      edges: [edge('root', 'a'), edge('root', 'b'), edge('root', 'c')],
    };
    const laid = appendLayout(prev, next);
    expect(overlapping(laid.map((n) => ({ position: n.position, width: n.width, height: n.height })))).toEqual([]);
  });

  it('never overlaps an existing card, at any burst size', () => {
    const { prev, nodes, edges } = canvasOf(600);
    // A step calling forty tools: every arrival anchors on the same parent.
    const parent = nodes[nodes.length - 1] as FlowNodeSpec;
    for (let i = 0; i < 40; i++) {
      nodes.push(node(`fan${i}`));
      edges.push(edge(parent.id, `fan${i}`));
    }
    const laid = appendLayout(prev, { nodes, edges });
    expect(laid).toHaveLength(nodes.length);
    expect(overlapping(laid)).toEqual([]);
    // Nothing that was on screen moved.
    for (const [id, before] of prev) {
      expect(laid.find((n) => n.id === id)?.position).toEqual(before.position);
    }
  });

  /**
   * A burst used to cost O(new × placed): every arrival re-scanned every
   * placed rectangle for each collision probe, and re-derived the bounding
   * box on top. Forty tools fanning out under one step on a 3,000-node
   * canvas was ~8x the cost of a single arrival (4.4ms vs 0.55ms); it is now
   * one pass plus a constant per arrival. A ratio, not a budget, so machine
   * speed cancels out.
   */
  it('a whole burst costs about what one arrival costs', () => {
    const measure = (burst: number): number => {
      const { prev, nodes, edges } = canvasOf(3000);
      const parent = nodes[nodes.length - 1] as FlowNodeSpec;
      for (let i = 0; i < burst; i++) {
        nodes.push(node(`fan${i}`));
        edges.push(edge(parent.id, `fan${i}`));
      }
      const next = { nodes, edges };
      appendLayout(prev, next); // warm
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        appendLayout(prev, next);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const one = measure(1);
    const forty = measure(40);
    expect(forty / Math.max(one, 0.02)).toBeLessThan(4);
  });
});

describe('anchorPositions', () => {
  it('translates a fresh layout so shared nodes keep their centroid', () => {
    const prev = new Map<string, Placed>([
      ['a', { id: 'a', position: { x: 500, y: 300 }, width: 240, height: 100 }],
    ]);
    const laid = [
      { ...node('a'), position: { x: 0, y: 0 } },
      { ...node('b'), position: { x: 260, y: 0 } },
    ];
    const anchored = anchorPositions(prev, laid);
    expect(anchored[0]?.position).toEqual({ x: 500, y: 300 });
    expect(anchored[1]?.position).toEqual({ x: 760, y: 300 });
  });

  it('is a no-op when nothing is shared', () => {
    const laid = [{ ...node('a'), position: { x: 5, y: 5 } }];
    expect(anchorPositions(new Map(), laid)).toEqual(laid);
  });
});
