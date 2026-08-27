/**
 * The scaling budget, enforced.
 *
 * A 300-node / ~5,000-event run is the shape this viewer claims to handle, so
 * the claim is measured here rather than asserted in a README: the reducer,
 * the graph projection, the timeline model and the layout all have to finish
 * a full pass over that run in single-digit milliseconds — otherwise the
 * canvas cannot keep 60fps while a live agent streams into it.
 *
 * Thresholds are deliberately loose (~10x the numbers observed on a laptop)
 * so this catches genuine regressions, not CI weather.
 */
import { describe, expect, it } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { autoCollapseRoots } from '../src/store/collapse.js';
import { layoutGraph } from '../src/layout/tidyTree.js';
import { runStateToFlow } from '../src/store/runStateToFlow.js';
import { generateStressRun } from '../src/store/synthetic.js';
import { buildTimeline } from '../src/store/timeline.js';
import { TokenBufferRegistry } from '../src/store/tokenBuffers.js';
import { agentCountsOf } from '../src/store/derived.js';
import type { RunState } from '../src/store/types.js';

const NODES = 300;
const EVENTS = 5000;

function ingest(): { run: RunState; ingestMs: number; envelopes: number } {
  const { runId, envelopes } = generateStressRun({ nodes: NODES, events: EVENTS, startTs: 1_000_000 });
  const tokens = new TokenBufferRegistry();
  const started = performance.now();
  let runs: RunsMap = {};
  for (const envelope of envelopes) {
    if (envelope.type === 'node.token') {
      tokens.push(envelope.runId, envelope.seq, envelope.payload.nodeId, envelope.payload.deltas, envelope.ts);
      continue;
    }
    runs = applyEvent(runs, envelope, 'live');
  }
  const ingestMs = performance.now() - started;
  const run = runs[runId];
  if (run === undefined) throw new Error('stress run not built');
  return { run, ingestMs, envelopes: envelopes.length };
}

describe('300-node stress run', () => {
  it('generates the shape it promises', () => {
    const { envelopes, nodeCount, runId } = generateStressRun({ nodes: NODES, events: EVENTS });
    expect(nodeCount).toBeGreaterThanOrEqual(NODES - 6);
    expect(envelopes.length).toBeGreaterThan(EVENTS * 0.8);
    expect(new Set(envelopes.map((e) => e.seq)).size).toBe(envelopes.length); // seqs unique
    expect(envelopes.every((e) => e.runId === runId)).toBe(true);
    expect(envelopes.some((e) => e.type === 'exec.paused')).toBe(true);
    expect(envelopes.some((e) => e.type === 'node.error')).toBe(true);
  });

  it('ingests every event through the real reducer, fast', () => {
    const { run, ingestMs, envelopes } = ingest();
    expect(run.order.length).toBeGreaterThanOrEqual(NODES - 6);
    expect(run.meta.status).toBe('ok');
    // Observed: ~25ms for 4,759 events (≈190k events/s) in the browser.
    expect(ingestMs).toBeLessThan(1500);
    expect(envelopes / (ingestMs / 1000)).toBeGreaterThan(3000);
  });

  it('projects, folds and lays out a 300-node graph inside a frame', () => {
    const { run } = ingest();

    const projectStart = performance.now();
    const graph = runStateToFlow(run);
    const projectMs = performance.now() - projectStart;

    const layoutStart = performance.now();
    const laid = layoutGraph(graph.nodes, graph.edges);
    const layoutMs = performance.now() - layoutStart;

    expect(graph.nodes.length).toBe(run.order.length);
    expect(laid.length).toBe(graph.nodes.length);
    expect(projectMs).toBeLessThan(50);
    expect(layoutMs).toBeLessThan(50);

    // Folded, the same run is small enough to take in at a glance.
    const collapsed = autoCollapseRoots(run);
    const folded = runStateToFlow(run, { collapsed });
    expect(folded.nodes.length).toBeLessThanOrEqual(60);
    expect(layoutGraph(folded.nodes, folded.edges)).toHaveLength(folded.nodes.length);
  });

  it('builds the whole waterfall in one pass', () => {
    const { run } = ingest();
    const started = performance.now();
    const model = buildTimeline(run, 2_000_000);
    const elapsed = performance.now() - started;
    expect(model.rows.length).toBeGreaterThan(200);
    expect(model.markers.length).toBeGreaterThan(0);
    expect(model.t1).toBeGreaterThan(model.t0);
    expect(elapsed).toBeLessThan(100);
  });

  it('keeps per-card selectors O(1) via the derived cache', () => {
    const { run } = ingest();
    const first = performance.now();
    agentCountsOf(run);
    const cold = performance.now() - first;
    const second = performance.now();
    // What every mounted agent card pays on every store notification.
    for (let i = 0; i < 1000; i++) agentCountsOf(run);
    const warm = performance.now() - second;
    expect(warm).toBeLessThan(Math.max(5, cold * 2));
  });
});
