/**
 * Held time is not run time.
 *
 * `durationMs` on the wire is wall-clock end minus start INCLUDING any time
 * the debugger held the node at a gate — a developer who thinks for 40 s at
 * a breakpoint would otherwise see a 40 s tool call, and the slow filter
 * would agree. `heldMs` is the debugger's share; "ran" is the difference.
 *
 * Two sources for held time, in order of preference:
 *   1. `heldMs` emitted by the SDK on `node.finished` / `node.error`
 *      (0.5+ clients) — exact, measured on the app's own clock;
 *   2. derived here from `exec.paused` / `exec.resumed` envelope timestamps,
 *      for streams and recordings that predate `heldMs`. Each pause is
 *      attributed to the node instance it held (plus its open ancestors and
 *      the run's root node, as the SDK does), clamped to that instance's own
 *      lifetime — a fixture replay's synthetic resume carries real wall time
 *      while its `durationMs` is recorded, and the clamp keeps the two
 *      coherent — and overlapping holds count once (union, not sum).
 *
 * Everything the viewer shows, filters, sums or exports as a duration goes
 * through `ranMs` / `heldMsOf` here. Pure functions; no React, no store.
 */
import { fmtDuration } from './format.js';
import type { NodeExecution, RunState } from '../store/types.js';

export interface HeldInterval {
  start: number;
  end: number;
}

/** Total length of the union of intervals (overlaps counted once). */
export function unionMs(intervals: readonly HeldInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current: HeldInterval | undefined;
  for (const interval of sorted) {
    if (current === undefined || interval.start > current.end) {
      if (current !== undefined) total += current.end - current.start;
      current = { start: interval.start, end: interval.end };
    } else if (interval.end > current.end) {
      current.end = interval.end;
    }
  }
  if (current !== undefined) total += current.end - current.start;
  return total;
}

/** Raw (unclamped) pause intervals per execution, keyed by `nodeId\0instanceId`. */
export type HeldIndex = ReadonlyMap<string, readonly HeldInterval[]>;

const indexKey = (nodeId: string, instanceId: string): string => `${nodeId}\u0000${instanceId}`;

/**
 * One pass over the run's pauses → the intervals pinned to each execution.
 * Build it once per projection (the timeline) instead of scanning every
 * pause for every bar: a 300-node stress run has hundreds of both.
 */
export function buildHeldIndex(run: RunState, now: number): HeldIndex {
  const index = new Map<string, HeldInterval[]>();
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined || pause.heldBy === undefined) continue;
    const interval = { start: pause.ts, end: pause.resolvedTs ?? now };
    for (const h of pause.heldBy) {
      const key = indexKey(h.nodeId, h.instanceId);
      const list = index.get(key);
      if (list === undefined) index.set(key, [interval]);
      else list.push(interval);
    }
  }
  return index;
}

/**
 * The pause intervals attributed to one execution, clamped to the window the
 * execution was actually alive: `[startedTs, finishedTs ?? now]`. A pause
 * still open runs to `now`. Pass a prebuilt `index` when calling in a loop.
 */
export function heldIntervalsFor(
  run: RunState,
  nodeId: string,
  exec: NodeExecution,
  now: number,
  index: HeldIndex = buildHeldIndex(run, now),
): HeldInterval[] {
  const raw = index.get(indexKey(nodeId, exec.instanceId));
  if (raw === undefined) return [];
  const out: HeldInterval[] = [];
  const windowEnd = exec.finishedTs ?? now;
  for (const interval of raw) {
    const start = Math.max(interval.start, exec.startedTs);
    const end = Math.min(interval.end, windowEnd);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Held time derived from pause/resume timestamps for one execution. */
export function derivedHeldMs(
  run: RunState,
  nodeId: string,
  exec: NodeExecution,
  now: number,
  index?: HeldIndex,
): number {
  return unionMs(heldIntervalsFor(run, nodeId, exec, now, index));
}

/** The debugger's share of an execution's duration (emitted value first). */
export function heldMsOf(exec: NodeExecution): number {
  const held = exec.heldMs ?? exec.derivedHeldMs ?? 0;
  return Number.isFinite(held) && held > 0 ? held : 0;
}

/** What the node itself took: `durationMs - heldMs`, clamped >= 0. Undefined while running. */
export function ranMs(exec: NodeExecution): number | undefined {
  if (exec.durationMs === undefined) return undefined;
  return Math.max(0, exec.durationMs - heldMsOf(exec));
}

/** `ran 2.4ms · held 38.1s` — the held part only when there was one. */
export function fmtRanHeld(exec: NodeExecution): string {
  const ran = ranMs(exec);
  if (ran === undefined) return exec.status === 'running' ? 'running' : '—';
  const held = heldMsOf(exec);
  return held > 0 ? `ran ${fmtDuration(ran)} · held ${fmtDuration(held)}` : fmtDuration(ran);
}

/** Wall time during which ANY gate in the run was held (union of all pauses). */
export function runHeldMs(run: RunState, now: number): number {
  const intervals: HeldInterval[] = [];
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined) continue;
    intervals.push({ start: pause.ts, end: pause.resolvedTs ?? now });
  }
  return unionMs(intervals);
}
