/**
 * The geometry harness.
 *
 * Three of the founder's bugs were visible in a screenshot and invisible to
 * every test: edges drawn straight through the cards above their target,
 * edges that peeled away from the handles they were meant to join, and a
 * held card's action row rendered outside its border. This file makes the
 * first two a pure-function assertion over every shape the canvas ships —
 * the bundled demo recording, the MCP fixture, packed fans of 5/11/30 leaves,
 * three nested levels, and the 300-node stress run — so the routing cannot
 * regress without a red test naming the edge and the card.
 *
 * Invariants, for every fixture:
 *   1. no routed edge segment passes through a card other than its own two
 *      ends (endpoints inset 2px so touching a handle is not a hit);
 *   2. no two cards overlap;
 *   3. every edge into a packed leaf leaves and arrives VERTICALLY — its
 *      first and last segments are the stubs on the handles.
 *
 * Plus the non-vacuity check: the same harness, run over the bezier routing
 * the canvas used before, reports crossings. If it did not, (1) would prove
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { parseEnvelope, type EventEnvelope } from '@graphmind-ai/schema';
import demoRun from '../src/fixtures/demo-run.json';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { autoCollapseRoots } from '../src/store/collapse.js';
import { MCP_NODES, MCP_RUN_ID, generateMcpRun } from '../src/store/mcpFixture.js';
import {
  NODE_DIMENSIONS,
  PAUSE_BANNER_HEIGHT,
  runStateToFlow,
  type FlowEdgeSpec,
  type FlowGraph,
  type FlowNodeSpec,
} from '../src/store/runStateToFlow.js';
import { generateStressRun } from '../src/store/synthetic.js';
import type { RunState } from '../src/store/types.js';
import {
  edgeCrossings,
  insetPolyline,
  isVertical,
  rectsOverlap,
  segmentIntersectsRect,
} from '../src/layout/geometry.js';
import { roundedPath } from '../src/layout/edgePath.js';
import { anchorPositions, appendLayout, planLayout, resizeOnly, type Placed } from '../src/layout/incremental.js';
import { GUTTER_LANE_PX, routeEdges, type Point, type RoutedEdge } from '../src/layout/routeEdges.js';
import { LAYOUT_GAPS, layoutGraph, type PositionedNode } from '../src/layout/tidyTree.js';

// ── fixtures ───────────────────────────────────────────────────────────────

function node(id: string, width = 248, height = 96): FlowNodeSpec {
  return { id, type: 'tool', data: { runId: 'r', nodeId: id }, width, height };
}

function edge(source: string, target: string): FlowEdgeSpec {
  return { id: `e:${source}->${target}`, source, target };
}

/** root (an llm step) → `count` childless tools: the packed-grid shape. */
function fan(count: number): FlowGraph {
  const nodes = [node('llm:step', 300, 164)];
  const edges: FlowEdgeSpec[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(node(`tool:t${i}`));
    edges.push(edge('llm:step', `tool:t${i}`));
  }
  return { nodes, edges };
}

/** root → 3 agents → 2 steps each → 5 tools each: three nested levels, mixed sizes. */
function nested(): FlowGraph {
  const nodes = [node('agent:root', 264, 104)];
  const edges: FlowEdgeSpec[] = [];
  for (let a = 0; a < 3; a++) {
    nodes.push(node(`agent:${a}`, 264, 104));
    edges.push(edge('agent:root', `agent:${a}`));
    for (let s = 0; s < 2; s++) {
      nodes.push(node(`llm:${a}-${s}`, 300, 164));
      edges.push(edge(`agent:${a}`, `llm:${a}-${s}`));
      for (let t = 0; t < 5; t++) {
        nodes.push(node(`tool:${a}-${s}-${t}`));
        edges.push(edge(`llm:${a}-${s}`, `tool:${a}-${s}-${t}`));
      }
    }
  }
  return { nodes, edges };
}

/** The synthetic 301-node shape from layout.test.ts (50 workers × step × 4 tools). */
function stressShape(): FlowGraph {
  const nodes = [node('root', 264, 104)];
  const edges: FlowEdgeSpec[] = [];
  for (let w = 0; w < 50; w++) {
    nodes.push(node(`w${w}`, 264, 104));
    edges.push(edge('root', `w${w}`));
    nodes.push(node(`s${w}`, 300, 164));
    edges.push(edge(`w${w}`, `s${w}`));
    for (let t = 0; t < 4; t++) {
      nodes.push(node(`t${w}-${t}`));
      edges.push(edge(`s${w}`, `t${w}-${t}`));
    }
  }
  return { nodes, edges };
}

function ingest(raw: readonly unknown[], runId: string, upTo = raw.length): RunState {
  let runs: RunsMap = {};
  for (const value of raw.slice(0, upTo)) {
    const parsed = parseEnvelope(value);
    if (parsed.kind !== 'ok') throw new Error(`bad envelope: ${JSON.stringify(parsed)}`);
    const envelope = parsed.envelope as EventEnvelope;
    if (envelope.type === 'node.token') continue;
    runs = applyEvent(runs, envelope, 'fixture');
  }
  const run = runs[runId];
  if (run === undefined) throw new Error(`no run ${runId}`);
  return run;
}

const DEMO = demoRun as unknown as { type: string; runId: string }[];
const DEMO_RUN_ID = DEMO[0]?.runId ?? '';
const MCP = generateMcpRun(1_000_000);

/** The demo, held at its planted error gate (the paused card is 92px taller). */
function demoAtGate(): RunState {
  const at = DEMO.findIndex((e) => e.type === 'exec.paused');
  if (at < 0) throw new Error('demo has no gate');
  return ingest(DEMO, DEMO_RUN_ID, at + 1);
}

function mcpAtGate(): RunState {
  const at = MCP.findIndex((e) => e.type === 'exec.paused');
  if (at < 0) throw new Error('mcp fixture has no gate');
  return ingest(MCP, MCP_RUN_ID, at + 1);
}

function stressRun(): RunState {
  const { runId, envelopes } = generateStressRun({ nodes: 300, events: 5000, startTs: 1_000_000 });
  return ingest(envelopes, runId);
}

interface Fixture {
  name: string;
  graph: () => FlowGraph;
}

const FIXTURES: Fixture[] = [
  { name: 'demo run (finished)', graph: () => runStateToFlow(ingest(DEMO, DEMO_RUN_ID)) },
  { name: 'demo run (held at the gate)', graph: () => runStateToFlow(demoAtGate()) },
  { name: 'MCP fixture (finished)', graph: () => runStateToFlow(ingest(MCP, MCP_RUN_ID)) },
  { name: 'MCP fixture (held at the gate)', graph: () => runStateToFlow(mcpAtGate()) },
  { name: '5-leaf fan', graph: () => fan(5) },
  { name: '11-leaf fan', graph: () => fan(11) },
  { name: '30-leaf fan', graph: () => fan(30) },
  { name: '3 nested levels', graph: nested },
  { name: '300-node stress shape', graph: stressShape },
  { name: '300-node stress run (real reducer, unfolded)', graph: () => runStateToFlow(stressRun()) },
  {
    name: '300-node stress run (real reducer, auto-folded)',
    graph: () => {
      const run = stressRun();
      return runStateToFlow(run, { collapsed: autoCollapseRoots(run) });
    },
  },
];

// ── helpers ────────────────────────────────────────────────────────────────

function overlaps(laid: readonly PositionedNode[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < laid.length; i++) {
    for (let j = i + 1; j < laid.length; j++) {
      const a = laid[i] as PositionedNode;
      const b = laid[j] as PositionedNode;
      if (
        rectsOverlap(
          { x: a.position.x, y: a.position.y, width: a.width, height: a.height },
          { x: b.position.x, y: b.position.y, width: b.width, height: b.height },
        )
      ) {
        out.push(`${a.id} × ${b.id}`);
      }
    }
  }
  return out;
}

function describeCrossings(crossings: ReturnType<typeof edgeCrossings>): string {
  return crossings.map((c) => `${c.edgeId} segment ${c.segment} crosses ${c.nodeId}`).join('\n');
}

/** Sample a cubic bezier into a polyline. */
function cubic(p0: Point, p1: Point, p2: Point, p3: Point, steps = 48): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/**
 * The routing the canvas shipped through 0.4.x: React Flow's `type: 'default'`
 * bezier from the bottom handle to the top handle. Control points as in
 * @xyflow/system's `getBezierPath` — `getControlWithCurvature` for
 * Position.Bottom / Position.Top with `calculateControlOffset(distance, 0.25)`,
 * which for a forward edge is half the vertical distance.
 */
function legacyBezierRoutes(laid: readonly PositionedNode[], edges: readonly FlowEdgeSpec[]): Map<string, RoutedEdge> {
  const byId = new Map(laid.map((n) => [n.id, n]));
  const out = new Map<string, RoutedEdge>();
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (s === undefined || t === undefined) continue;
    const p0 = { x: s.position.x + s.width / 2, y: s.position.y + s.height };
    const p3 = { x: t.position.x + t.width / 2, y: t.position.y };
    const distance = p3.y - p0.y;
    const offset = distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance);
    const p1 = { x: p0.x, y: p0.y + offset };
    const p2 = { x: p3.x, y: p3.y - offset };
    out.set(e.id, { source: e.source, target: e.target, points: cubic(p0, p1, p2, p3) });
  }
  return out;
}

// ── the invariants, over every fixture ─────────────────────────────────────

describe('geometry harness — routed edges over every shipped shape', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const graph = fixture.graph();
      const laid = layoutGraph(graph.nodes, graph.edges);
      const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);

      it('routes every edge', () => {
        expect(graph.edges.length).toBeGreaterThan(0);
        expect(routed.size).toBe(graph.edges.length);
      });

      it('(1) no edge segment passes through a card that is not one of its ends', () => {
        const crossings = edgeCrossings(laid, routed);
        expect(crossings, describeCrossings(crossings)).toEqual([]);
      });

      it('(2) no two cards overlap', () => {
        expect(overlaps(laid)).toEqual([]);
      });

      it('(3) every edge into a packed leaf leaves and arrives vertically', () => {
        const packed = laid.filter((n) => n.leafCell !== undefined).map((n) => n.id);
        expect(packed.length).toBeGreaterThan(0);
        for (const [id, route] of routed) {
          if (!packed.includes(route.target)) continue;
          const pts = route.points;
          expect(pts.length, id).toBeGreaterThanOrEqual(2);
          expect(isVertical(pts[0] as Point, pts[1] as Point), `${id} first segment`).toBe(true);
          expect(
            isVertical(pts[pts.length - 2] as Point, pts[pts.length - 1] as Point),
            `${id} last segment`,
          ).toBe(true);
        }
      });

      it('starts on the source bottom-centre and ends on the target top-centre', () => {
        const byId = new Map(laid.map((n) => [n.id, n]));
        for (const [id, route] of routed) {
          const s = byId.get(route.source) as PositionedNode;
          const t = byId.get(route.target) as PositionedNode;
          const first = route.points[0] as Point;
          const last = route.points[route.points.length - 1] as Point;
          expect(first, `${id} start`).toEqual({ x: s.position.x + s.width / 2, y: s.position.y + s.height });
          expect(last, `${id} end`).toEqual({ x: t.position.x + t.width / 2, y: t.position.y });
        }
      });

      it('is axis-aligned end to end (no diagonal segment)', () => {
        for (const [id, route] of routed) {
          for (let i = 0; i + 1 < route.points.length; i++) {
            const p = route.points[i] as Point;
            const q = route.points[i + 1] as Point;
            expect(p.x === q.x || p.y === q.y, `${id} segment ${i} is diagonal`).toBe(true);
          }
        }
      });
    });
  }
});

// ── non-vacuity: the old routing fails this harness ────────────────────────

describe('non-vacuity — the harness catches the 0.4.x bezier routing', () => {
  it('reports the edges that went through the row above (11-leaf fan)', () => {
    const graph = fan(11);
    const laid = layoutGraph(graph.nodes, graph.edges);
    const legacy = legacyBezierRoutes(laid, graph.edges);
    const crossings = edgeCrossings(laid, legacy);
    // 11 leaves pack 5 × 3: every edge to rows 2 and 3 has to get past row 1.
    const rows = new Map(laid.filter((n) => n.leafCell).map((n) => [n.id, n.leafCell?.row ?? 0]));
    const deep = [...rows.values()].filter((r) => r >= 1).length;
    expect(deep).toBe(6);
    const crossingEdges = new Set(crossings.map((c) => c.edgeId));
    expect(crossingEdges.size).toBeGreaterThan(0);
    expect(crossingEdges.size).toBe(deep);
    // …and the same layout, routed through the gutters, is clean.
    expect(edgeCrossings(laid, routeEdges(laid, graph.edges, LAYOUT_GAPS))).toEqual([]);
  });

  it('reports crossings on the MCP fixture the founder screenshotted', () => {
    // The fixture belongs to the MCP workstream and is still growing; assert
    // on the rule, not on a node list: under the bezier, EVERY edge into a
    // row >= 1 packed leaf went through the card above it.
    const graph = runStateToFlow(ingest(MCP, MCP_RUN_ID));
    const laid = layoutGraph(graph.nodes, graph.edges);
    const legacy = edgeCrossings(laid, legacyBezierRoutes(laid, graph.edges));
    const crossingEdges = new Set(legacy.map((c) => c.edgeId));
    const deepLeaves = new Set(laid.filter((n) => (n.leafCell?.row ?? 0) >= 1).map((n) => n.id));
    const deepEdges = graph.edges.filter((e) => deepLeaves.has(e.target)).map((e) => e.id);
    expect(deepEdges.length).toBeGreaterThan(0);
    expect(MCP_NODES.session).toBe(laid[0]?.id); // the session is still the root
    for (const id of deepEdges) expect(crossingEdges.has(id), `${id} crossed under the bezier`).toBe(true);
    // …and gutter routing clears all of them.
    expect(edgeCrossings(laid, routeEdges(laid, graph.edges, LAYOUT_GAPS))).toEqual([]);
  });
});

// ── the resize path a held gate actually takes in the browser ──────────────

describe('a gate opening (resize mode) keeps the geometry clean', () => {
  const heldCases: { name: string; before: () => RunState; held: () => RunState }[] = [
    {
      name: 'demo run',
      before: () => {
        const at = DEMO.findIndex((e) => e.type === 'exec.paused');
        return ingest(DEMO, DEMO_RUN_ID, at);
      },
      held: demoAtGate,
    },
    {
      name: 'MCP fixture',
      before: () => {
        const at = MCP.findIndex((e) => e.type === 'exec.paused');
        return ingest(MCP, MCP_RUN_ID, at);
      },
      held: mcpAtGate,
    },
  ];

  for (const c of heldCases) {
    it(`${c.name}: positions stand, the card grows, edges stay clear`, () => {
      const beforeGraph = runStateToFlow(c.before());
      const laidBefore = layoutGraph(beforeGraph.nodes, beforeGraph.edges);
      const prev = new Map<string, Placed>(
        laidBefore.map((n) => [
          n.id,
          { id: n.id, position: n.position, width: n.width, height: n.height, ...(n.leafCell ? { leafCell: n.leafCell } : {}) },
        ]),
      );
      const heldGraph = runStateToFlow(c.held());
      // Exactly one card grew, by the action row.
      const grown = heldGraph.nodes.filter((n) => n.height !== prev.get(n.id)?.height);
      expect(grown.map((n) => n.id)).toHaveLength(1);
      expect(grown[0]?.height).toBe((prev.get(grown[0]?.id ?? '')?.height ?? 0) + PAUSE_BANNER_HEIGHT);

      const mode = planLayout(prev, heldGraph);
      // 'resize' when it grew into free space, 'full' when it would have
      // overlapped the row below — either way the result must be clean.
      expect(['resize', 'full']).toContain(mode);
      const laid = mode === 'resize' ? resizeOnly(prev, heldGraph) : layoutGraph(heldGraph.nodes, heldGraph.edges);
      const routed = routeEdges(laid, heldGraph.edges, LAYOUT_GAPS);
      expect(overlaps(laid)).toEqual([]);
      const crossings = edgeCrossings(laid, routed);
      expect(crossings, describeCrossings(crossings)).toEqual([]);
      // The packed cells survived the resize: row >= 1 edges still use the gutter.
      expect(laid.filter((n) => n.leafCell !== undefined).length).toBe(
        laidBefore.filter((n) => n.leafCell !== undefined).length,
      );
    });
  }

  it('a row-0 leaf growing into the row below forces a full, anchored pass instead of overlapping', () => {
    const graph = fan(8); // 4 × 2
    const laid = layoutGraph(graph.nodes, graph.edges);
    const prev = new Map<string, Placed>(
      laid.map((n) => [n.id, { id: n.id, position: n.position, width: n.width, height: n.height }]),
    );
    const grownGraph: FlowGraph = {
      nodes: graph.nodes.map((n) => (n.id === 'tool:t0' ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n)),
      edges: graph.edges,
    };
    // The card it would have grown into:
    const below = laid.find((n) => n.id === 'tool:t4') as PositionedNode;
    const t0 = laid.find((n) => n.id === 'tool:t0') as PositionedNode;
    expect(t0.position.y + t0.height + PAUSE_BANNER_HEIGHT).toBeGreaterThan(below.position.y);
    expect(planLayout(prev, grownGraph)).toBe('full');
    // A bottom-row leaf growing has nothing under it and stays a resize.
    const bottomGrown: FlowGraph = {
      nodes: graph.nodes.map((n) => (n.id === 'tool:t7' ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n)),
      edges: graph.edges,
    };
    expect(planLayout(prev, bottomGrown)).toBe('resize');
    // And the full pass it asked for is clean.
    const relaid = layoutGraph(grownGraph.nodes, grownGraph.edges);
    expect(overlaps(relaid)).toEqual([]);
    expect(edgeCrossings(relaid, routeEdges(relaid, grownGraph.edges, LAYOUT_GAPS))).toEqual([]);
  });

  it('a shorter leaf in a mixed-height block that pauses above another row re-lays out instead of growing under the jog', () => {
    // A childless llm step (164 tall) packed beside tools (96): rows are
    // spaced for the tallest card, so a tool has 68px of slack below it —
    // less than the 92px banner, but MORE than the 62px at which it would
    // touch the card below. Growing in place therefore overlaps nothing, and
    // yet the edge into the row-1 card jogs through the row gap at
    // `top - leafRowGap/2`, i.e. straight through the paused card.
    const nodes = [node('agent:root', 264, 104), node('llm:last', 300, 164)];
    const edges = [edge('agent:root', 'llm:last')];
    for (let i = 0; i < 7; i++) {
      nodes.push(node(`tool:t${i}`));
      edges.push(edge('agent:root', `tool:t${i}`));
    }
    const laid = layoutGraph(nodes, edges);
    const prev = new Map<string, Placed>(
      laid.map((n) => [
        n.id,
        { id: n.id, position: n.position, width: n.width, height: n.height, ...(n.leafCell ? { leafCell: n.leafCell } : {}) },
      ]),
    );
    const t0 = laid.find((n) => n.id === 'tool:t0') as PositionedNode;
    expect(t0.leafCell).toMatchObject({ row: 0 });
    const below = laid.find(
      (n) => n.leafCell?.column === t0.leafCell?.column && n.leafCell?.row === 1,
    ) as PositionedNode;
    expect(below).toBeDefined();
    const grownBottom = t0.position.y + t0.height + PAUSE_BANNER_HEIGHT;
    // Inside the row gap: clear of the card below, but not of the jog above it.
    expect(grownBottom).toBeLessThan(below.position.y);
    expect(grownBottom).toBeGreaterThan(below.position.y - LAYOUT_GAPS.leafRowGap);

    const grown: FlowGraph = {
      nodes: nodes.map((n) => (n.id === 'tool:t0' ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n)),
      edges,
    };
    // Documentation: the in-place resize would draw the row-1 edge through the paused card.
    const inPlace = resizeOnly(prev, grown);
    const inPlaceCrossings = edgeCrossings(inPlace, routeEdges(inPlace, edges, LAYOUT_GAPS));
    expect(inPlaceCrossings.map((c) => c.nodeId)).toContain('tool:t0');
    // So the planner must not take that path.
    expect(planLayout(prev, grown)).toBe('full');
    const relaid = layoutGraph(grown.nodes, grown.edges);
    expect(overlaps(relaid)).toEqual([]);
    expect(edgeCrossings(relaid, routeEdges(relaid, edges, LAYOUT_GAPS))).toEqual([]);
  });

  it('a last-row leaf and a branch node still grow in place (no re-layout for the common gate)', () => {
    const graph = nested();
    const laid = layoutGraph(graph.nodes, graph.edges);
    const prev = new Map<string, Placed>(
      laid.map((n) => [
        n.id,
        { id: n.id, position: n.position, width: n.width, height: n.height, ...(n.leafCell ? { leafCell: n.leafCell } : {}) },
      ]),
    );
    const grow = (id: string): FlowGraph => ({
      nodes: graph.nodes.map((n) => (n.id === id ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n)),
      edges: graph.edges,
    });
    // 5 tools pack 3 + 2: tool 3 and 4 are the last row.
    expect(laid.find((n) => n.id === 'tool:0-0-4')?.leafCell?.row).toBe(1);
    expect(planLayout(prev, grow('tool:0-0-4'))).toBe('resize');
    expect(planLayout(prev, grow('llm:0-0'))).toBe('resize');
    expect(planLayout(prev, grow('agent:1'))).toBe('resize');
    for (const id of ['tool:0-0-4', 'llm:0-0', 'agent:1']) {
      const g = grow(id);
      const laidHeld = resizeOnly(prev, g);
      expect(overlaps(laidHeld), id).toEqual([]);
      expect(edgeCrossings(laidHeld, routeEdges(laidHeld, g.edges, LAYOUT_GAPS)), id).toEqual([]);
    }
  });

  it('over 150 seeded random forests, a gate opening at any card leaves zero crossings and zero overlaps', () => {
    // The verifier's fuzz that found the mixed-height case above, kept as a
    // guard. Real card sizes only, so every shape here is one the reducer
    // can produce; seeds are fixed so a failure names a reproducible graph.
    const dims = Object.entries(NODE_DIMENSIONS) as [FlowNodeSpec['type'], { width: number; height: number }][];
    const failures: string[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      const rand = mulberry32(1000 + seed);
      const graph = randomForest(rand, dims, 20 + Math.floor(rand() * 100));
      const laid = layoutGraph(graph.nodes, graph.edges);
      const prev = new Map<string, Placed>(
        laid.map((n) => [
          n.id,
          { id: n.id, position: n.position, width: n.width, height: n.height, ...(n.leafCell ? { leafCell: n.leafCell } : {}) },
        ]),
      );
      const grow = new Set<string>();
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) grow.add((graph.nodes[Math.floor(rand() * graph.nodes.length)] as FlowNodeSpec).id);
      const held: FlowGraph = {
        nodes: graph.nodes.map((n) => (grow.has(n.id) ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n)),
        edges: graph.edges,
      };
      const mode = planLayout(prev, held);
      const laidHeld =
        mode === 'resize'
          ? resizeOnly(prev, held)
          : mode === 'full'
            ? layoutGraph(held.nodes, held.edges)
            : undefined;
      if (laidHeld === undefined) {
        failures.push(`seed ${seed}: mode ${mode}`);
        continue;
      }
      const ov = overlaps(laidHeld);
      const cr = edgeCrossings(laidHeld, routeEdges(laidHeld, held.edges, LAYOUT_GAPS));
      if (ov.length > 0 || cr.length > 0) {
        failures.push(`seed ${seed} (${mode}, grew ${[...grow].join(',')}): ${ov.join(' ')} ${describeCrossings(cr)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ── seeded fuzz helpers ─────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random forest of real cards: 1–2 roots, fan-outs of 0–13 (packed grids up to 5 × 3), some children grow subtrees. */
function randomForest(
  rand: () => number,
  dims: readonly [FlowNodeSpec['type'], { width: number; height: number }][],
  maxNodes: number,
): FlowGraph {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];
  let counter = 0;
  const make = (parent?: string): string => {
    const id = `n${counter++}`;
    const [type, size] = dims[Math.floor(rand() * dims.length)] as (typeof dims)[number];
    nodes.push({ id, type, data: { runId: 'r', nodeId: id }, width: size.width, height: size.height });
    if (parent !== undefined) edges.push(edge(parent, id));
    return id;
  };
  const frontier: string[] = [];
  const roots = 1 + Math.floor(rand() * 2);
  for (let r = 0; r < roots; r++) frontier.push(make());
  while (nodes.length < maxNodes && frontier.length > 0) {
    const parent = frontier.splice(Math.floor(rand() * frontier.length), 1)[0] as string;
    const kids = Math.floor(rand() * 14);
    for (let k = 0; k < kids && nodes.length < maxNodes; k++) {
      const id = make(parent);
      if (rand() < 0.3) frontier.push(id);
    }
  }
  return { nodes, edges };
}

// ── the append path a streaming run takes past 24 cards ────────────────────

describe('append mode (streaming arrivals) keeps the geometry clean', () => {
  const placedOf = (laid: readonly PositionedNode[]): Map<string, Placed> =>
    new Map(
      laid.map((n) => [
        n.id,
        { id: n.id, position: n.position, width: n.width, height: n.height, ...(n.leafCell ? { leafCell: n.leafCell } : {}) },
      ]),
    );

  it('an arrival never parks on a column gutter (the drops to a block\'s lower rows run there)', () => {
    // root → B (a narrow tool, placed first, so it sits left of A's subtree)
    //      → A with five tools packed 3 × 2.
    // A wide card arriving under B is centred on B, which puts its right
    // edge 20px short of A's block: clear of the cards, but on top of the
    // gutter line 23px left of column 0 that carries the row-1 drops.
    const nodes = [node('root', 264, 104), node('B', 248, 96), node('A', 264, 104)];
    const edges = [edge('root', 'B'), edge('root', 'A')];
    for (let i = 0; i < 5; i++) {
      nodes.push(node(`tool:${i}`));
      edges.push(edge('A', `tool:${i}`));
    }
    const laid = layoutGraph(nodes, edges);
    const prev = placedOf(laid);
    const next: FlowGraph = { nodes: [...nodes, node('C', 300, 164)], edges: [...edges, edge('B', 'C')] };
    const appended = appendLayout(prev, next);
    const c = appended.find((n) => n.id === 'C') as PositionedNode;
    const block = laid.find((n) => n.id === 'tool:0')?.leafCell;
    if (block === undefined) throw new Error('no block');
    // It landed on the leaves' band, left of the block by at least the sibling gap.
    expect(c.position.y).toBe(laid.find((n) => n.id === 'tool:0')?.position.y);
    expect(c.position.x + c.width).toBeLessThanOrEqual(block.blockLeft - LAYOUT_GAPS.siblingGap);
    const crossings = edgeCrossings(appended, routeEdges(appended, next.edges, LAYOUT_GAPS));
    expect(crossings, describeCrossings(crossings)).toEqual([]);
    expect(overlaps(appended)).toEqual([]);
  });

  it('a packed leaf with rows beneath it cannot gain a child in place: the planner asks for a full pass', () => {
    // 30 cards on screen so the planner is in append territory.
    const graph = fan(29); // 8 columns × 4 rows
    const laid = layoutGraph(graph.nodes, graph.edges);
    const prev = placedOf(laid);
    expect(prev.size).toBeGreaterThanOrEqual(24);
    const t0 = laid.find((n) => n.id === 'tool:t0') as PositionedNode;
    expect(t0.leafCell?.row).toBe(0);
    const underT0: FlowGraph = { nodes: [...graph.nodes, node('tool:child')], edges: [...graph.edges, edge('tool:t0', 'tool:child')] };
    expect(planLayout(prev, underT0)).toBe('full');
    // Documentation: appending it would have drawn the edge through the block.
    const appended = appendLayout(prev, underT0);
    expect(edgeCrossings(appended, routeEdges(appended, underT0.edges, LAYOUT_GAPS)).length).toBeGreaterThan(0);
    // The full pass is clean, and anchored.
    const relaid = anchorPositions(prev, layoutGraph(underT0.nodes, underT0.edges));
    expect(overlaps(relaid)).toEqual([]);
    expect(edgeCrossings(relaid, routeEdges(relaid, underT0.edges, LAYOUT_GAPS))).toEqual([]);

    // A leaf on the LAST row has nothing beneath it: it appends, and cleanly.
    const last = laid.find((n) => n.id === 'tool:t28') as PositionedNode;
    expect(last.leafCell?.row).toBe(3);
    const underLast: FlowGraph = { nodes: [...graph.nodes, node('tool:child')], edges: [...graph.edges, edge('tool:t28', 'tool:child')] };
    expect(planLayout(prev, underLast)).toBe('append');
    const appendedLast = appendLayout(prev, underLast);
    const crossings = edgeCrossings(appendedLast, routeEdges(appendedLast, underLast.edges, LAYOUT_GAPS));
    expect(crossings, describeCrossings(crossings)).toEqual([]);
    expect(overlaps(appendedLast)).toEqual([]);
  });

  it('a tool arriving under a card shorter than its layer lands on the layer\'s band, under every bus', () => {
    // root → agent (104) with one tool, and → step (164) with three tools.
    // Both children share a top; the band below is 118 under the STEP.
    const nodes = [node('root', 264, 104), node('agent', 264, 104), node('step', 300, 164), node('tool:a0')];
    const edges = [edge('root', 'agent'), edge('root', 'step'), edge('agent', 'tool:a0')];
    for (let i = 0; i < 3; i++) {
      nodes.push(node(`tool:s${i}`));
      edges.push(edge('step', `tool:s${i}`));
    }
    const laid = layoutGraph(nodes, edges);
    const prev = placedOf(laid);
    const next: FlowGraph = { nodes: [...nodes, node('tool:a1')], edges: [...edges, edge('agent', 'tool:a1')] };
    const appended = appendLayout(prev, next);
    const a1 = appended.find((n) => n.id === 'tool:a1') as PositionedNode;
    const band = laid.find((n) => n.id === 'tool:a0')?.position.y;
    expect(a1.position.y).toBe(band);
    const routed = routeEdges(appended, next.edges, LAYOUT_GAPS);
    const crossings = edgeCrossings(appended, routed);
    expect(crossings, describeCrossings(crossings)).toEqual([]);
    expect(overlaps(appended)).toEqual([]);
  });

  it('over 100 seeded random forests, arrivals under branch cards leave zero crossings after the planner\'s choice', () => {
    // Arrivals under packed leaves are the planner's business (above); this
    // holds the append placement itself to the router's corridors. One
    // documented residue is excluded: a card TALLER than every card on its
    // band can protrude into a sibling's bus by up to 60px — that needs the
    // band to move, which only a full pass does (see limitations).
    const dims = Object.entries(NODE_DIMENSIONS) as [FlowNodeSpec['type'], { width: number; height: number }][];
    const failures: string[] = [];
    let appends = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rand = mulberry32(2000 + seed);
      const graph = randomForest(rand, dims, 24 + Math.floor(rand() * 100));
      if (graph.nodes.length < 24) continue;
      const laid = layoutGraph(graph.nodes, graph.edges);
      const prev = placedOf(laid);
      const branches = graph.nodes.filter((n) => graph.edges.some((e) => e.source === n.id));
      const nodes = [...graph.nodes];
      const edges = [...graph.edges];
      const arriving = 1 + Math.floor(rand() * 30);
      for (let i = 0; i < arriving; i++) {
        const parent = branches[Math.floor(rand() * branches.length)] as FlowNodeSpec;
        // Never taller than the tallest card already on the parent's band.
        const siblings = graph.edges.filter((e) => e.source === parent.id).map((e) => laid.find((n) => n.id === e.target) as PositionedNode);
        const cap = Math.max(...siblings.map((s) => s.height));
        const fitting = dims.filter(([, d]) => d.height <= cap);
        const [type, size] = fitting[Math.floor(rand() * fitting.length)] as (typeof dims)[number];
        const id = `new${i}`;
        nodes.push({ id, type, data: { runId: 'r', nodeId: id }, width: size.width, height: size.height });
        edges.push(edge(parent.id, id));
      }
      const next: FlowGraph = { nodes, edges };
      const mode = planLayout(prev, next);
      const placed = mode === 'append' ? appendLayout(prev, next) : anchorPositions(prev, layoutGraph(nodes, edges));
      if (mode === 'append') appends += 1;
      const ov = overlaps(placed);
      const cr = edgeCrossings(placed, routeEdges(placed, edges, LAYOUT_GAPS));
      if (ov.length > 0 || cr.length > 0) failures.push(`seed ${seed} (${mode}, +${arriving}): ${ov.join(' ')} ${describeCrossings(cr)}`);
    }
    expect(appends).toBeGreaterThan(50); // the append path is what is under test
    expect(failures).toEqual([]);
  });
});

// ── router behaviour ───────────────────────────────────────────────────────

describe('routeEdges', () => {
  it('all edges of one parent share one bus line', () => {
    const graph = fan(11);
    const laid = layoutGraph(graph.nodes, graph.edges);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    const buses = new Set<number>();
    for (const route of routed.values()) {
      if (route.points.length >= 3) buses.add((route.points[1] as Point).y);
    }
    expect(buses.size).toBe(1);
    const parent = laid.find((n) => n.id === 'llm:step') as PositionedNode;
    const child = laid.find((n) => n.leafCell?.row === 0) as PositionedNode;
    const bus = [...buses][0] as number;
    expect(bus).toBeGreaterThan(parent.position.y + parent.height);
    expect(bus).toBeLessThan(child.position.y);
    expect(bus).toBe(child.position.y - LAYOUT_GAPS.layerGap / 2);
  });

  it('descends to a row >= 1 leaf through the gutter left of its column, then jogs in at half the row gap', () => {
    const graph = fan(11); // 5 × 3, left-aligned rows
    const laid = layoutGraph(graph.nodes, graph.edges);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    const t6 = laid.find((n) => n.id === 'tool:t6') as PositionedNode; // row 1, column 1
    expect(t6.leafCell).toMatchObject({ row: 1, column: 1 });
    const route = routed.get('e:llm:step->tool:t6') as RoutedEdge;
    expect(route.points).toHaveLength(6);
    const [, , gutterTop, gutterBottom, jogEnd] = route.points as [Point, Point, Point, Point, Point, Point];
    const cell = t6.leafCell as NonNullable<PositionedNode['leafCell']>;
    const expectedGutter = cell.blockLeft + cell.column * (cell.columnWidth + LAYOUT_GAPS.siblingGap) - LAYOUT_GAPS.siblingGap / 2;
    expect(gutterTop.x).toBe(expectedGutter);
    expect(gutterBottom.x).toBe(expectedGutter);
    expect(gutterBottom.y).toBe(t6.position.y - LAYOUT_GAPS.leafRowGap / 2);
    expect(jogEnd.x).toBe(t6.position.x + t6.width / 2);
    // The gutter really is between the two columns' cards.
    const t5 = laid.find((n) => n.id === 'tool:t5') as PositionedNode; // row 1, column 0
    expect(expectedGutter).toBeGreaterThan(t5.position.x + t5.width);
    expect(expectedGutter).toBeLessThan(t6.position.x);
  });

  it('uses the block left margin for column 0 and spreads deeper rows leftwards by 3px', () => {
    const graph = fan(11);
    const laid = layoutGraph(graph.nodes, graph.edges);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    const row1 = routed.get('e:llm:step->tool:t5') as RoutedEdge; // row 1 col 0
    const row2 = routed.get('e:llm:step->tool:t10') as RoutedEdge; // row 2 col 0
    const t5 = laid.find((n) => n.id === 'tool:t5') as PositionedNode;
    const g1 = (row1.points[2] as Point).x;
    const g2 = (row2.points[2] as Point).x;
    expect(g1).toBe((t5.leafCell?.blockLeft ?? 0) - LAYOUT_GAPS.siblingGap / 2);
    expect(g1 - g2).toBe(GUTTER_LANE_PX);
    // Deeper is further left, so row 1's jog (rightwards from g1) never meets row 2's drop.
    expect(g2).toBeLessThan(g1);
  });

  it('caps the lane offset inside the gutter on a very deep block', () => {
    const graph = fan(200); // 8 columns, 25 rows
    const laid = layoutGraph(graph.nodes, graph.edges);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    expect(edgeCrossings(laid, routed)).toEqual([]);
    const col0 = laid.filter((n) => n.leafCell?.column === 0 && (n.leafCell?.row ?? 0) >= 1);
    const blockLeft = col0[0]?.leafCell?.blockLeft ?? 0;
    for (const leaf of col0) {
      const gx = (routed.get(`e:llm:step->${leaf.id}`)?.points[2] as Point).x;
      expect(gx).toBeLessThanOrEqual(blockLeft - LAYOUT_GAPS.siblingGap / 2);
      expect(gx).toBeGreaterThan(blockLeft - LAYOUT_GAPS.siblingGap + 2);
    }
  });

  it('routes a branch child straight down-across-down', () => {
    const graph = nested();
    const laid = layoutGraph(graph.nodes, graph.edges);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    const route = routed.get('e:agent:root->agent:0') as RoutedEdge;
    expect(route.points).toHaveLength(4);
    const [a, b, c, d] = route.points as [Point, Point, Point, Point];
    expect(isVertical(a, b)).toBe(true);
    expect(b.y).toBe(c.y);
    expect(isVertical(c, d)).toBe(true);
  });

  it('collapses to a single vertical line when the child is directly below', () => {
    const graph: FlowGraph = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };
    const laid = layoutGraph(graph.nodes, graph.edges);
    const route = routeEdges(laid, graph.edges, LAYOUT_GAPS).get('e:a->b') as RoutedEdge;
    expect(route.points).toHaveLength(2);
    expect(isVertical(route.points[0] as Point, route.points[1] as Point)).toBe(true);
  });

  it('draws a plain straight line for an edge whose target is not below its source', () => {
    const laid: PositionedNode[] = [
      { ...node('a'), position: { x: 0, y: 500 } },
      { ...node('b'), position: { x: 400, y: 0 } },
    ];
    const route = routeEdges(laid, [edge('a', 'b')], LAYOUT_GAPS).get('e:a->b') as RoutedEdge;
    expect(route.points).toEqual([
      { x: 124, y: 596 },
      { x: 524, y: 0 },
    ]);
  });

  it('keeps the bus below a parent that grew into the gap (paused card)', () => {
    const graph = fan(3);
    const laid = layoutGraph(graph.nodes, graph.edges).map((n) =>
      n.id === 'llm:step' ? { ...n, height: n.height + PAUSE_BANNER_HEIGHT } : n,
    );
    const parent = laid.find((n) => n.id === 'llm:step') as PositionedNode;
    const child = laid.find((n) => n.id === 'tool:t0') as PositionedNode;
    expect(child.position.y - (parent.position.y + parent.height)).toBe(LAYOUT_GAPS.layerGap - PAUSE_BANNER_HEIGHT);
    const routed = routeEdges(laid, graph.edges, LAYOUT_GAPS);
    let busses = 0;
    for (const route of routed.values()) {
      // The middle child is straight below: a 2-point vertical, no bus.
      if (route.points.length === 2) continue;
      busses += 1;
      const bus = (route.points[1] as Point).y;
      expect(bus).toBeGreaterThan(parent.position.y + parent.height);
      expect(bus).toBeLessThan(child.position.y);
    }
    expect(busses).toBe(2);
    expect(edgeCrossings(laid, routed)).toEqual([]);
  });

  it('stops trusting a leaf cell once the card has been dragged out of it', () => {
    const graph = fan(11);
    const laid = layoutGraph(graph.nodes, graph.edges);
    const moved = laid.map((n) =>
      n.id === 'tool:t6' ? { ...n, position: { x: n.position.x + 900, y: n.position.y + 300 } } : n,
    );
    const route = routeEdges(moved, graph.edges, LAYOUT_GAPS).get('e:llm:step->tool:t6') as RoutedEdge;
    // Generic down-across-down, not a gutter descent to a cell it no longer occupies.
    expect(route.points).toHaveLength(4);
    const dragged = moved.find((n) => n.id === 'tool:t6') as PositionedNode;
    expect(route.points[route.points.length - 1]).toEqual({
      x: dragged.position.x + dragged.width / 2,
      y: dragged.position.y,
    });
  });

  it('skips edges whose ends are not on the canvas, and handles empty input', () => {
    expect(routeEdges([], [], LAYOUT_GAPS).size).toBe(0);
    const laid = layoutGraph([node('a')], []);
    expect(routeEdges(laid, [edge('a', 'ghost'), edge('ghost', 'a')], LAYOUT_GAPS).size).toBe(0);
  });

  it('is deterministic', () => {
    const graph = fan(30);
    const laid = layoutGraph(graph.nodes, graph.edges);
    expect(routeEdges(laid, graph.edges, LAYOUT_GAPS)).toEqual(routeEdges(laid, graph.edges, LAYOUT_GAPS));
  });

  it('routes 300 nodes in well under 2ms (best of five)', () => {
    const graph = stressShape();
    const laid = layoutGraph(graph.nodes, graph.edges);
    routeEdges(laid, graph.edges, LAYOUT_GAPS); // warm
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      routeEdges(laid, graph.edges, LAYOUT_GAPS);
      best = Math.min(best, performance.now() - started);
    }
    // Same style as layout.test.ts: a budget, best-of-five so one preempted
    // sample on a loaded runner cannot fail it. Observed ~0.15ms.
    expect(best).toBeLessThan(2);
  });

  it('is linear in the number of edges (4x the edges is ~4x the time, not 16x)', () => {
    const small = fan(300);
    const big = fan(1200);
    const laidSmall = layoutGraph(small.nodes, small.edges);
    const laidBig = layoutGraph(big.nodes, big.edges);
    const once = (laid: PositionedNode[], edges: FlowEdgeSpec[]): number => {
      const started = performance.now();
      routeEdges(laid, edges, LAYOUT_GAPS);
      return performance.now() - started;
    };
    once(laidSmall, small.edges);
    once(laidBig, big.edges);
    let bestRatio = Infinity;
    for (let i = 0; i < 7; i++) {
      const s = once(laidSmall, small.edges);
      const b = once(laidBig, big.edges);
      bestRatio = Math.min(bestRatio, b / Math.max(s, 0.05));
    }
    expect(bestRatio).toBeLessThan(8);
  });
});

// ── the predicates themselves ──────────────────────────────────────────────

describe('segmentIntersectsRect', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 }; // 100..300 × 100..200

  it('detects a segment passing straight through', () => {
    expect(segmentIntersectsRect({ x: 150, y: 0 }, { x: 150, y: 400 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 150 }, { x: 400, y: 150 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 400, y: 300 }, rect)).toBe(true);
  });

  it('detects a segment that ends inside', () => {
    expect(segmentIntersectsRect({ x: 150, y: 0 }, { x: 150, y: 150 }, rect)).toBe(true);
    expect(segmentIntersectsRect({ x: 120, y: 120 }, { x: 280, y: 180 }, rect)).toBe(true); // fully inside
  });

  it('does not count touching the boundary', () => {
    expect(segmentIntersectsRect({ x: 150, y: 0 }, { x: 150, y: 100 }, rect)).toBe(false); // ends ON the top edge
    expect(segmentIntersectsRect({ x: 0, y: 100 }, { x: 400, y: 100 }, rect)).toBe(false); // runs along the top edge
    expect(segmentIntersectsRect({ x: 100, y: 0 }, { x: 100, y: 400 }, rect)).toBe(false); // runs along the left edge
    expect(segmentIntersectsRect({ x: 0, y: 200 }, { x: 200, y: 0 }, rect)).toBe(false); // grazes the corner
  });

  it('misses a segment that stays outside', () => {
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 50, y: 400 }, rect)).toBe(false);
    expect(segmentIntersectsRect({ x: 0, y: 250 }, { x: 400, y: 250 }, rect)).toBe(false);
    expect(segmentIntersectsRect({ x: 50, y: 150 }, { x: 50, y: 160 }, rect)).toBe(false); // parallel, outside
    expect(segmentIntersectsRect({ x: 350, y: 0 }, { x: 350, y: 400 }, rect)).toBe(false);
  });
});

describe('rectsOverlap', () => {
  it('is strict: sharing an edge is not overlapping', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectsOverlap(a, { x: 100, y: 0, width: 100, height: 100 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 100, width: 100, height: 100 })).toBe(false);
    expect(rectsOverlap(a, { x: 99, y: 99, width: 100, height: 100 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 10, width: 10, height: 10 })).toBe(true);
  });
});

describe('insetPolyline', () => {
  it('pulls both ends in along their segments and leaves the middle alone', () => {
    expect(insetPolyline([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }], 2)).toEqual([
      { x: 0, y: 2 },
      { x: 0, y: 10 },
      { x: 8, y: 10 },
    ]);
  });
  it('leaves a segment shorter than the inset untouched', () => {
    expect(insetPolyline([{ x: 0, y: 0 }, { x: 0, y: 1 }], 2)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }]);
  });
});

// ── path building (what the renderer does with a route) ───────────────────

describe('roundedPath', () => {
  it('rounds every interior corner with a quadratic arc and stays on the endpoints', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }], 8);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('L 100 100')).toBe(true);
    expect(d.match(/Q/g)?.length).toBe(2);
    expect(d).toBe('M 0 0 L 0 42 Q 0 50 8 50 L 92 50 Q 100 50 100 58 L 100 100');
  });
  it('shrinks the radius on a segment too short for it', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 100, y: 6 }], 8);
    expect(d).toBe('M 0 0 L 0 3 Q 0 6 3 6 L 100 6');
  });
  it('draws a straight two-point path with no arc', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 30 }])).toBe('M 0 0 L 0 30');
    expect(roundedPath([])).toBe('');
  });
  it('never emits NaN', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 }]);
    expect(d.includes('NaN')).toBe(false);
  });
});
