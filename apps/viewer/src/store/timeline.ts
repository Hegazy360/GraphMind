/**
 * The waterfall model. For a complex run this view answers questions the
 * graph cannot: what actually ran in parallel, where the wall-clock went,
 * how long the agent sat waiting for the first token, and exactly when the
 * gate held execution.
 *
 * Pure projection of RunState (plus optional stream timings from the token
 * registry) — no React, no DOM, fully unit-testable.
 */
import type { ErrorInfo, NodeKind, RunStatus } from '@graphmind-ai/schema';
import type { RunState } from './types.js';

export interface TimelineBar {
  /** Stable per (node, execution) — React key and selection identity. */
  key: string;
  nodeId: string;
  instanceId: string;
  execIndex: number;
  name: string;
  kind: NodeKind;
  startTs: number;
  /** `now` while the execution is still open. */
  endTs: number;
  running: boolean;
  status: 'running' | RunStatus;
  error?: ErrorInfo;
  injected?: boolean;
  /** The portion of the bar during which tokens were streaming back. */
  streamStartTs?: number;
  streamEndTs?: number;
  /** Sub-lane inside the row, for concurrent instances of one logical node. */
  lane: number;
}

export interface TimelineRow {
  nodeId: string;
  name: string;
  kind: NodeKind;
  /** Depth in the parent chain — drives the label indent. */
  depth: number;
  bars: TimelineBar[];
  /** Number of sub-lanes this row needs (1 unless instances overlap). */
  lanes: number;
  totalMs: number;
  errors: number;
}

export interface TimelineMarker {
  ts: number;
  kind: 'pause' | 'resume' | 'error';
  nodeId: string;
  label: string;
}

export interface TimelineModel {
  rows: TimelineRow[];
  markers: TimelineMarker[];
  /** Time window covered, in epoch ms. */
  t0: number;
  t1: number;
  /** True while at least one execution is still open. */
  live: boolean;
}

export type StreamTimingLookup = (
  nodeId: string,
  execIndex: number,
  execCount: number,
) => { firstTs: number; lastTs: number } | undefined;

function depthOf(run: RunState, nodeId: string): number {
  let depth = 0;
  let current = run.nodes[nodeId]?.parentId;
  for (let hops = 0; current !== undefined && hops < 64; hops++) {
    depth += 1;
    current = run.nodes[current]?.parentId;
  }
  return depth;
}

/** Greedy interval packing: first lane whose last bar ended before this one starts. */
function assignLanes(bars: TimelineBar[]): number {
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let placed = false;
    for (let lane = 0; lane < laneEnds.length; lane++) {
      const end = laneEnds[lane];
      if (end !== undefined && end <= bar.startTs) {
        bar.lane = lane;
        laneEnds[lane] = bar.endTs;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bar.lane = laneEnds.length;
      laneEnds.push(bar.endTs);
    }
  }
  return Math.max(1, laneEnds.length);
}

export function buildTimeline(
  run: RunState,
  now: number = Date.now(),
  streamTiming?: StreamTimingLookup,
): TimelineModel {
  const rows: TimelineRow[] = [];
  const markers: TimelineMarker[] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let live = false;

  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.executions.length === 0) continue;

    const bars: TimelineBar[] = [];
    let totalMs = 0;
    let errors = 0;
    node.executions.forEach((exec, execIndex) => {
      const running = exec.status === 'running';
      // durationMs is authoritative when present (the adapter measures it);
      // fall back to timestamps, and to `now` while still open.
      const endTs =
        exec.finishedTs ??
        (exec.durationMs !== undefined ? exec.startedTs + exec.durationMs : running ? now : exec.startedTs);
      const stream = streamTiming?.(nodeId, execIndex, node.executions.length);
      const bar: TimelineBar = {
        key: `${nodeId}#${execIndex}`,
        nodeId,
        instanceId: exec.instanceId,
        execIndex,
        name: node.name,
        kind: node.kind,
        startTs: exec.startedTs,
        endTs: Math.max(endTs, exec.startedTs),
        running,
        status: exec.status,
        ...(exec.error !== undefined ? { error: exec.error } : {}),
        ...(exec.injected === true ? { injected: true } : {}),
        ...(stream !== undefined
          ? { streamStartTs: stream.firstTs, streamEndTs: Math.max(stream.lastTs, stream.firstTs) }
          : {}),
        lane: 0,
      };
      bars.push(bar);
      totalMs += bar.endTs - bar.startTs;
      if (exec.status === 'error' || exec.error !== undefined) errors += 1;
      if (running) live = true;
      min = Math.min(min, bar.startTs);
      max = Math.max(max, bar.endTs);
    });

    bars.sort((a, b) => a.startTs - b.startTs || a.execIndex - b.execIndex);
    const lanes = assignLanes(bars);
    rows.push({
      nodeId,
      name: node.name,
      kind: node.kind,
      depth: depthOf(run, nodeId),
      bars,
      lanes,
      totalMs,
      errors,
    });
  }

  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined) continue;
    markers.push({
      ts: pause.ts,
      kind: pause.active ? 'pause' : 'resume',
      nodeId: pause.nodeId,
      label: pause.active
        ? `held at ${pause.point}`
        : `${pause.point} → ${pause.resolvedAction ?? 'resumed'}`,
    });
  }
  markers.sort((a, b) => a.ts - b.ts);

  // Rows read top-to-bottom in execution order; ties keep first-seen order.
  rows.sort((a, b) => {
    const aStart = a.bars[0]?.startTs ?? 0;
    const bStart = b.bars[0]?.startTs ?? 0;
    return aStart - bStart || run.order.indexOf(a.nodeId) - run.order.indexOf(b.nodeId);
  });

  const startedTs = run.meta.startedTs;
  const t0 = Math.min(min, startedTs ?? min);
  const finishedTs = run.meta.finishedTs;
  let t1 = Math.max(max, finishedTs ?? max);
  if (live) t1 = Math.max(t1, now);
  const safeT0 = Number.isFinite(t0) ? t0 : now;
  const safeT1 = Number.isFinite(t1) ? t1 : safeT0 + 1;
  return { rows, markers, t0: safeT0, t1: Math.max(safeT1, safeT0 + 1), live };
}

/** Nice round tick spacing for a span, targeting ~6 gridlines. */
export function tickStepMs(spanMs: number, target = 6): number {
  const raw = Math.max(1, spanMs / Math.max(1, target));
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const step = magnitude * factor;
    if (step >= raw) return step;
  }
  return magnitude * 10;
}

/** Gridline offsets (ms from t0) for a span. */
export function ticksFor(spanMs: number, target = 6): number[] {
  const step = tickStepMs(spanMs, target);
  const out: number[] = [];
  for (let t = 0; t <= spanMs + 1; t += step) out.push(t);
  return out;
}
