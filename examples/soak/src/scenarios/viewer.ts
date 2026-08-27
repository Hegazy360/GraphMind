/**
 * Scenario 6 — the viewer, without a browser.
 *
 * The viewer's own modules are imported directly from apps/viewer/src and
 * driven exactly the way `useLiveConnection` drives them: JSON.parse the
 * frame, hand the envelope to `ingestValue`, which validates it against the
 * schema, routes `node.token` to the token-buffer registry and everything
 * else through the one reducer. Then the two things that happen per frame on
 * the canvas: `runStateToFlow` (structure) and `layoutGraph` (positions).
 *
 * Phase 1 uses a real run read back out of a real server, so the bytes are
 * the bytes. The sweeps that follow generate envelopes locally, because what
 * they are measuring is the shape of the curve, not the transport.
 */
import { createEnvelope } from '@graphmind-ai/schema';
import { ingestValue } from '../../../../apps/viewer/src/connection/ingest.ts';
import { useRunStore } from '../../../../apps/viewer/src/store/runStore.ts';
import { runStateToFlow } from '../../../../apps/viewer/src/store/runStateToFlow.ts';
import { layoutGraph } from '../../../../apps/viewer/src/layout/tidyTree.ts';
import {
  appendLayout,
  planLayout,
  type Placed,
} from '../../../../apps/viewer/src/layout/incremental.ts';
import { tokenBuffers } from '../../../../apps/viewer/src/store/tokenBuffers.ts';
import { SoakServer } from '../server-handle.ts';
import { drive, makeSession } from '../driver.ts';
import { buildWorkload, DEFAULT_WORKLOAD, type PlannedEvent } from '../workload.ts';
import { fetchAllEvents } from '../verify.ts';
import { check, finding, row, section, type Section } from '../report.ts';
import { bool, fmtBytes, fmtMs, num, type Flags } from '../util.ts';

function resetStore(): void {
  for (const runId of Object.keys(useRunStore.getState().runs)) tokenBuffers.clearRun(runId);
  useRunStore.setState({ runs: {} });
}

function envelopesFor(plan: readonly PlannedEvent[], runId: string): unknown[] {
  const started = Date.now();
  return plan.map((event, index) =>
    createEnvelope({
      type: event.type,
      payload: event.payload as never,
      seq: index,
      runId,
      ts: started + index,
    }),
  );
}

/** Feed frames through the viewer exactly as the live socket does. */
function ingestFrames(frames: readonly string[]): { parseMs: number; ingestMs: number } {
  let parseMs = 0;
  let ingestMs = 0;
  for (const frame of frames) {
    const t0 = performance.now();
    const value = JSON.parse(frame) as unknown;
    const t1 = performance.now();
    ingestValue(value, 'live');
    const t2 = performance.now();
    parseMs += t1 - t0;
    ingestMs += t2 - t1;
  }
  return { parseMs, ingestMs };
}

interface SweepPoint {
  events: number;
  nodes: number;
  parseMs: number;
  ingestMs: number;
  flowMs: number;
  layoutMs: number;
  totalMs: number;
  perEventUs: number;
  heapBytes: number;
}

function measure(events: number, toolNodes: number, tokenBatches: number): SweepPoint {
  resetStore();
  const plan = buildWorkload({
    ...DEFAULT_WORKLOAD,
    events,
    toolNodes,
    tokenBatchesPerStep: tokenBatches,
  });
  const runId = `sweep-${events}-${toolNodes}`;
  const frames = envelopesFor(plan.events, runId).map((envelope) => JSON.stringify(envelope));
  const heapBefore = process.memoryUsage().heapUsed;
  const { parseMs, ingestMs } = ingestFrames(frames);
  tokenBuffers.flushNow();
  const run = useRunStore.getState().runs[runId];
  if (run === undefined) throw new Error(`viewer store never created run ${runId}`);

  const flowStart = performance.now();
  const graph = runStateToFlow(run);
  const flowMs = performance.now() - flowStart;

  const layoutStart = performance.now();
  layoutGraph(graph.nodes, graph.edges);
  const layoutMs = performance.now() - layoutStart;

  const heapBytes = process.memoryUsage().heapUsed - heapBefore;
  const totalMs = parseMs + ingestMs + flowMs + layoutMs;
  return {
    events: plan.events.length,
    nodes: graph.nodes.length,
    parseMs,
    ingestMs,
    flowMs,
    layoutMs,
    totalMs,
    perEventUs: ((parseMs + ingestMs) / plan.events.length) * 1000,
    heapBytes,
  };
}

export async function viewerScenario(flags: Flags): Promise<Section> {
  const sec = section('viewer — reducer and layout, no browser');
  const events = num(flags, 'events', 12_000);
  const toolNodes = num(flags, 'nodes', 300);

  // ---- phase 1: a real run, read back out of a real server ---------------
  const server = await SoakServer.start({ verbose: bool(flags, 'verbose') });
  try {
    const session = makeSession(server.ingestUrl, { bufferSize: 4000 });
    check(sec, 'client attached', await session.ready({ timeoutMs: 5000 }));
    const plan = buildWorkload({ ...DEFAULT_WORKLOAD, events, toolNodes });
    const result = await drive(session, 'viewer-load', plan.events, { yieldEvery: 64 });
    const expected = plan.events.length + 2;
    let stored = await fetchAllEvents(server, result.runId);
    for (let attempt = 0; attempt < 60 && stored.events.length < expected; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      stored = await fetchAllEvents(server, result.runId);
    }
    await session.dispose();

    resetStore();
    const frames = stored.events.map((event) => JSON.stringify(event));
    const heapBefore = process.memoryUsage().heapUsed;
    const { parseMs, ingestMs } = ingestFrames(frames);
    const flushStart = performance.now();
    tokenBuffers.flushNow();
    const flushMs = performance.now() - flushStart;
    const run = useRunStore.getState().runs[result.runId];
    const flowStart = performance.now();
    const graph = run === undefined ? { nodes: [], edges: [] } : runStateToFlow(run);
    const flowMs = performance.now() - flowStart;
    const layoutStart = performance.now();
    const positioned = layoutGraph(graph.nodes, graph.edges);
    const layoutMs = performance.now() - layoutStart;
    const heapBytes = process.memoryUsage().heapUsed - heapBefore;

    row(
      sec,
      'real run replayed into the viewer',
      `${stored.events.length.toLocaleString('en-US')} events -> ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
      `read back from GET /api/runs/:id/events`,
    );
    row(
      sec,
      'apply 10k+ events',
      fmtMs(parseMs + ingestMs),
      `JSON.parse ${fmtMs(parseMs)} + reducer/token routing ${fmtMs(ingestMs)} = ${(((parseMs + ingestMs) / frames.length) * 1000).toFixed(1)}µs/event`,
    );
    row(sec, 'token buffer flush', fmtMs(flushMs));
    row(sec, 'runStateToFlow', fmtMs(flowMs));
    row(sec, 'layoutGraph (tidy tree)', fmtMs(layoutMs), `${positioned.length} positioned nodes`);
    row(
      sec,
      'total time to first frame',
      fmtMs(parseMs + ingestMs + flushMs + flowMs + layoutMs),
      'what a viewer pays to open this run cold',
    );
    row(sec, 'viewer heap for this run', fmtBytes(heapBytes));

    check(
      sec,
      'the whole run applies + lays out in under a second',
      parseMs + ingestMs + flushMs + flowMs + layoutMs < 1000,
      fmtMs(parseMs + ingestMs + flushMs + flowMs + layoutMs),
    );
    check(
      sec,
      'every logical node from the run made it into the graph',
      graph.nodes.length >= plan.stats.logicalNodes,
      `${graph.nodes.length} of ${plan.stats.logicalNodes}`,
    );

    sec.data['viewerRealRun'] = {
      events: stored.events.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      parseMs,
      ingestMs,
      flushMs,
      flowMs,
      layoutMs,
      heapBytes,
    };
  } finally {
    await server.close();
    server.cleanup();
  }

  // ---- phase 2: event-count sweep ---------------------------------------
  const eventSweep: SweepPoint[] = [];
  for (const size of [1500, 3000, 6000, 12_000, 24_000]) {
    eventSweep.push(measure(size, 200, 40));
  }
  for (const point of eventSweep) {
    row(
      sec,
      `apply ${point.events.toLocaleString('en-US')} events`,
      `${fmtMs(point.parseMs + point.ingestMs)}`,
      `${point.perEventUs.toFixed(2)}µs/event, ${point.nodes} nodes`,
    );
  }
  const firstEv = eventSweep[0] as SweepPoint;
  const lastEv = eventSweep[eventSweep.length - 1] as SweepPoint;
  const evRatio = lastEv.perEventUs / firstEv.perEventUs;
  row(
    sec,
    'reducer scaling',
    `${(lastEv.events / firstEv.events).toFixed(0)}x events -> ${evRatio.toFixed(2)}x cost per event`,
    evRatio > 1.6 ? 'SUPERLINEAR' : 'linear',
  );
  check(
    sec,
    'the reducer stays roughly linear in event count',
    evRatio <= 2,
    `${evRatio.toFixed(2)}x per-event cost — applyEvent copies the whole nodes record on every node ` +
      'lifecycle event, so cost per event rises with graph size',
  );

  // ---- phase 3: node-count sweep (layout) --------------------------------
  const nodeSweep: SweepPoint[] = [];
  for (const nodes of [100, 200, 400, 800, 1600]) {
    nodeSweep.push(measure(Math.max(2000, nodes * 12), nodes, 4));
  }
  for (const point of nodeSweep) {
    row(
      sec,
      `layout ${point.nodes} nodes`,
      `${fmtMs(point.layoutMs)}`,
      `runStateToFlow ${fmtMs(point.flowMs)}`,
    );
  }
  const firstNode = nodeSweep[0] as SweepPoint;
  const lastNode = nodeSweep[nodeSweep.length - 1] as SweepPoint;
  const nodeRatio =
    lastNode.layoutMs / Math.max(0.001, firstNode.layoutMs) / (lastNode.nodes / firstNode.nodes);
  row(
    sec,
    'layout scaling',
    `${(lastNode.nodes / firstNode.nodes).toFixed(0)}x nodes -> ${(lastNode.layoutMs / Math.max(0.001, firstNode.layoutMs)).toFixed(1)}x time`,
    nodeRatio > 2 ? 'SUPERLINEAR' : 'linear or better',
  );
  // Gate on the size a shipped adapter can actually produce (node count is
  // bounded by distinct tool names), not on the asymptote.
  const at800 = nodeSweep.find((point) => point.nodes >= 700 && point.nodes <= 900);
  check(
    sec,
    'layout of a realistic canvas (~800 nodes) stays under 50ms',
    at800 !== undefined && at800.layoutMs < 50,
    at800 === undefined ? 'no sample' : `${fmtMs(at800.layoutMs)} at ${at800.nodes} nodes`,
  );
  if (nodeRatio > 2) {
    finding(
      sec,
      `layout is ~O(n^2) in node count once the tree gets deep: ${fmtMs(firstNode.layoutMs)} at ` +
        `${firstNode.nodes} nodes but ${fmtMs(lastNode.layoutMs)} at ${lastNode.nodes}. The shipped ` +
        'adapters keep node counts small (one node per distinct tool name), so this only bites ' +
        'imports and custom instrumentation with per-step node ids.',
    );
  }

  // ---- phase 4: the incremental append path -------------------------------
  // planLayout/appendLayout run once per structural change while a run
  // streams. appendLayout scans every already-placed rectangle for every new
  // node (and re-derives the bounding box each time), so its cost per new
  // node grows with the graph. Measure how that feels at canvas sizes.
  const appendPoints: { nodes: number; ms: number; perNodeUs: number }[] = [];
  const appendBudgetMs = num(flags, 'append-budget', 20_000);
  for (const target of [100, 200, 400, 800]) {
    resetStore();
    const plan = buildWorkload({
      ...DEFAULT_WORKLOAD,
      events: Math.max(2000, target * 12),
      toolNodes: target,
      tokenBatchesPerStep: 2,
    });
    const runId = `append-${target}`;
    const frames = envelopesFor(plan.events, runId).map((envelope) => JSON.stringify(envelope));
    ingestFrames(frames);
    const run = useRunStore.getState().runs[runId];
    if (run === undefined) continue;
    const graph = runStateToFlow(run);

    // Bucket each edge by the step at which both of its endpoints exist, so
    // growing the graph one node at a time stays O(n) in the harness itself.
    const indexOf = new Map<string, number>();
    graph.nodes.forEach((node, index) => indexOf.set(node.id, index));
    const edgesAt: number[][] = graph.nodes.map(() => []);
    graph.edges.forEach((edge, edgeIndex) => {
      const source = indexOf.get(edge.source);
      const target = indexOf.get(edge.target);
      if (source === undefined || target === undefined) return;
      (edgesAt[Math.max(source, target)] as number[]).push(edgeIndex);
    });

    // Grow the canvas one node at a time through the real incremental path.
    let prev = new Map<string, Placed>();
    const liveEdges: typeof graph.edges = [];
    const started = performance.now();
    for (let count = 1; count <= graph.nodes.length; count += 1) {
      for (const edgeIndex of edgesAt[count - 1] as number[]) {
        liveEdges.push(graph.edges[edgeIndex] as (typeof graph.edges)[number]);
      }
      const slice = { nodes: graph.nodes.slice(0, count), edges: liveEdges };
      const mode = planLayout(prev, slice);
      const positioned =
        mode === 'append' ? appendLayout(prev, slice) : layoutGraph(slice.nodes, slice.edges);
      prev = new Map(
        positioned.map((node) => [
          node.id,
          { id: node.id, position: node.position, width: node.width, height: node.height },
        ]),
      );
      if (performance.now() - started > appendBudgetMs) break;
    }
    const ms = performance.now() - started;
    appendPoints.push({
      nodes: graph.nodes.length,
      ms,
      perNodeUs: (ms / graph.nodes.length) * 1000,
    });
    if (ms > appendBudgetMs) break;
  }
  for (const point of appendPoints) {
    row(
      sec,
      `grow canvas to ${point.nodes} nodes`,
      fmtMs(point.ms),
      `${point.perNodeUs.toFixed(0)}µs per added node`,
    );
  }
  const firstAppend = appendPoints[0];
  const lastAppend = appendPoints[appendPoints.length - 1];
  if (firstAppend !== undefined && lastAppend !== undefined) {
    const growth = lastAppend.perNodeUs / Math.max(0.001, firstAppend.perNodeUs);
    row(
      sec,
      'incremental layout scaling',
      `${(lastAppend.nodes / firstAppend.nodes).toFixed(0)}x nodes -> ${growth.toFixed(1)}x cost per added node`,
      growth > 4 ? 'SUPERLINEAR' : 'acceptable',
    );
    check(
      sec,
      'per-node incremental layout cost does not blow up with canvas size',
      growth <= 8,
      `${growth.toFixed(1)}x`,
    );
    if (growth > 4) {
      finding(
        sec,
        `appendLayout costs ${growth.toFixed(0)}x more per added node at ${lastAppend.nodes} nodes than at ` +
          `${firstAppend.nodes}: it linear-scans every placed rectangle (and recomputes the bounding box) ` +
          'for each new node, so a long streaming run pays O(n^2) on the canvas while it is being watched.',
      );
    }
  }

  // ---- phase 5: chain depth ----------------------------------------------
  // runStateToFlow chains consecutive `llm` siblings into a step chain, so
  // the tree's DEPTH is the number of distinct llm nodes in the run. The
  // shipped adapters all use one stable `llm:step` node (packages/*/src/ids.ts)
  // so depth stays at 1 — but the schema lets any instrumentation mint a
  // nodeId per step, and tidyTreeLayout measures/places recursively.
  const chainPoints: { depth: number; ms: number; threw: string | undefined }[] = [];
  for (const depth of [500, 1000, 2000, 4000, 6000]) {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < depth; i += 1) {
      nodes.push({
        id: `llm:step-${i}`,
        type: 'llmStep' as const,
        data: { runId: 'chain', nodeId: `llm:step-${i}` },
        width: 300,
        height: 164,
      });
      if (i > 0) edges.push({ id: `e${i}`, source: `llm:step-${i - 1}`, target: `llm:step-${i}` });
    }
    const started = performance.now();
    let threw: string | undefined;
    try {
      layoutGraph(nodes, edges);
    } catch (error) {
      threw = error instanceof Error ? error.name : String(error);
    }
    chainPoints.push({ depth, ms: performance.now() - started, threw });
  }
  for (const point of chainPoints) {
    row(
      sec,
      `layout a ${point.depth}-deep chain`,
      point.threw === undefined ? fmtMs(point.ms) : `THREW ${point.threw}`,
      point.threw === undefined ? '' : 'after ' + fmtMs(point.ms),
    );
  }
  const crashed = chainPoints.find((point) => point.threw !== undefined);
  const at2000 = chainPoints.find((point) => point.depth === 2000);
  check(
    sec,
    'layout survives a 2000-deep chain (the documented ceiling)',
    at2000 !== undefined && at2000.threw === undefined,
    at2000 === undefined
      ? 'no sample'
      : at2000.threw === undefined
        ? `${fmtMs(at2000.ms)}, crashes at ${crashed === undefined ? '>6000' : String(crashed.depth)}`
        : `threw ${at2000.threw}`,
  );
  if (crashed !== undefined) {
    finding(
      sec,
      `tidyTreeLayout measures and places recursively, so a graph whose tree is deeper than ~${crashed.depth} ` +
        'nodes overflows the stack and the canvas renders nothing. Unreachable with the shipped adapters ' +
        '(they use one stable `llm:step` node) but reachable from any custom instrumentation that mints ' +
        'a nodeId per step, and it degrades long before it crashes: ' +
        `${fmtMs(chainPoints[2]?.ms ?? 0)} per layout at depth 2000.`,
    );
  }

  sec.data['viewerSweeps'] = { eventSweep, nodeSweep, appendPoints, chainPoints };
  return sec;
}
