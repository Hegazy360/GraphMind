/**
 * Canvas filters. Filtering never removes nodes — a debugger that hides
 * structure lies about the run — it *dims* everything that doesn't match, so
 * the shape of the graph is still readable while the matches pop.
 *
 * "Error path" is the important one: from every failed node, walk up the
 * parent chain and keep only that ancestry lit.
 */
import type { NodeKind } from '@graphmind-ai/schema';
import type { RunState } from './types.js';
import { nodeStatus } from './types.js';

export type StatusFilter = 'all' | 'error' | 'paused' | 'running' | 'slow';

export interface FilterSpec {
  /** null = every kind. */
  kinds: readonly NodeKind[] | null;
  status: StatusFilter;
  /** Dim everything that is not on the ancestry path of a failure. */
  errorPathOnly: boolean;
}

export const EMPTY_FILTER: FilterSpec = { kinds: null, status: 'all', errorPathOnly: false };

export function isFilterActive(spec: FilterSpec): boolean {
  return spec.kinds !== null || spec.status !== 'all' || spec.errorPathOnly;
}

export function filterSummary(spec: FilterSpec): string {
  const parts: string[] = [];
  if (spec.kinds !== null) parts.push(spec.kinds.join('/'));
  if (spec.status !== 'all') parts.push(spec.status);
  if (spec.errorPathOnly) parts.push('error path');
  return parts.join(' · ');
}

/** Every execution duration recorded in the run, ascending. */
function durations(run: RunState): number[] {
  const out: number[] = [];
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    for (const exec of node.executions) {
      if (exec.durationMs !== undefined) out.push(exec.durationMs);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * What counts as "slow" in THIS run: the 90th-percentile execution duration,
 * floored at 200ms so a fast run doesn't flag 3ms calls as slow. Relative,
 * because "slow" for a local tool and for a 30s LLM call are different animals.
 */
export function slowThresholdMs(run: RunState): number {
  const sorted = durations(run);
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))] ?? 0;
  return Math.max(200, p90);
}

/** Nodes that failed, plus every ancestor of one — the path to the failure. */
export function errorPathIds(run: RunState): Set<string> {
  const path = new Set<string>();
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    const failed =
      node.lastError !== undefined || node.executions.some((e) => e.status === 'error');
    if (!failed) continue;
    let current: string | undefined = nodeId;
    for (let hops = 0; current !== undefined && hops < 64; hops++) {
      if (path.has(current)) break;
      path.add(current);
      current = run.nodes[current]?.parentId;
    }
  }
  return path;
}

function matchesStatus(run: RunState, nodeId: string, status: StatusFilter, slowMs: number): boolean {
  const node = run.nodes[nodeId];
  if (node === undefined) return false;
  switch (status) {
    case 'all':
      return true;
    case 'error':
      return node.lastError !== undefined || node.executions.some((e) => e.status === 'error');
    case 'paused':
      return node.activePauseId !== undefined;
    case 'running':
      return nodeStatus(node) === 'running';
    case 'slow':
      return node.executions.some((e) => e.durationMs !== undefined && e.durationMs >= slowMs);
  }
}

/**
 * The lit set. Everything else on the canvas is dimmed, not removed.
 * An inactive filter returns every node (callers can skip the pass).
 */
export function matchingNodeIds(run: RunState, spec: FilterSpec): Set<string> {
  const all = new Set(run.order.filter((id) => run.nodes[id] !== undefined));
  if (!isFilterActive(spec)) return all;

  let result = all;
  if (spec.errorPathOnly) {
    const path = errorPathIds(run);
    result = new Set([...result].filter((id) => path.has(id)));
  }
  if (spec.kinds !== null) {
    const kinds = new Set<NodeKind>(spec.kinds);
    result = new Set([...result].filter((id) => {
      const node = run.nodes[id];
      return node !== undefined && kinds.has(node.kind);
    }));
  }
  if (spec.status !== 'all') {
    const slowMs = slowThresholdMs(run);
    result = new Set([...result].filter((id) => matchesStatus(run, id, spec.status, slowMs)));
  }
  return result;
}
