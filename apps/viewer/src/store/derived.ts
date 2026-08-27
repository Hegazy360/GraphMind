/**
 * Cached projections of a run.
 *
 * This module exists because of a real, measured scaling bug. zustand runs
 * every mounted component's selector on *every* store notification — that is
 * once per ingested event. A selector that walks `run.order` therefore costs
 * O(nodes) per node per event: with 300 cards and 5,000 events that is ~450M
 * operations and the UI stops breathing.
 *
 * So the expensive walks happen here, once per version bump, and the card
 * selectors become map lookups. Caches are keyed by `structureVersion` /
 * `statusVersion`, which the reducer already maintains for exactly this kind
 * of "what changed?" question.
 */
import type { RunState } from './types.js';
import { childIndex, summarizeGroup, type GroupSummary } from './collapse.js';

interface StructureEntry {
  version: number;
  children: Map<string, string[]>;
}

interface StatusEntry {
  version: number;
  structureVersion: number;
  /** Steps/tool-calls executed anywhere beneath an agent node. */
  agentCounts: Map<string, { steps: number; tools: number }>;
}

const structureCache = new Map<string, StructureEntry>();
const statusCache = new Map<string, StatusEntry>();

/** parentId → children, rebuilt only when the graph's shape changes. */
export function childrenIndexOf(run: RunState): Map<string, string[]> {
  const cached = structureCache.get(run.runId);
  if (cached !== undefined && cached.version === run.structureVersion) return cached.children;
  const children = childIndex(run);
  structureCache.set(run.runId, { version: run.structureVersion, children });
  return children;
}

export function hasChildren(run: RunState, nodeId: string): boolean {
  return (childrenIndexOf(run).get(nodeId) ?? []).length > 0;
}

const NO_COUNTS = { steps: 0, tools: 0 };

/**
 * Per-agent rollup of everything executed in its subtree. One pass over the
 * run per status change, shared by every agent card on screen.
 */
export function agentCountsOf(run: RunState): Map<string, { steps: number; tools: number }> {
  const cached = statusCache.get(run.runId);
  if (
    cached !== undefined &&
    cached.version === run.statusVersion &&
    cached.structureVersion === run.structureVersion
  ) {
    return cached.agentCounts;
  }

  const children = childrenIndexOf(run);
  const agentCounts = new Map<string, { steps: number; tools: number }>();
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node?.kind === 'agent') agentCounts.set(nodeId, { steps: 0, tools: 0 });
  }

  // Walk each agent's subtree once. Subtrees are small relative to the run
  // (an agent owns its own fan-out), so this stays linear in practice.
  for (const [agentId, counts] of agentCounts) {
    const stack = [...(children.get(agentId) ?? [])];
    const seen = new Set<string>([agentId]);
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const child = run.nodes[id];
      if (child === undefined) continue;
      if (!child.ghost) {
        if (child.kind === 'llm') counts.steps += child.executions.length;
        else if (child.kind === 'tool') counts.tools += child.executions.length;
      }
      for (const grandchild of children.get(id) ?? []) stack.push(grandchild);
    }
  }

  statusCache.set(run.runId, {
    version: run.statusVersion,
    structureVersion: run.structureVersion,
    agentCounts,
  });
  return agentCounts;
}

export function agentCountsFor(run: RunState, nodeId: string): { steps: number; tools: number } {
  return agentCountsOf(run).get(nodeId) ?? NO_COUNTS;
}

interface SummaryEntry {
  version: number;
  structureVersion: number;
  summaries: Map<string, GroupSummary>;
}

const summaryCache = new Map<string, SummaryEntry>();

/**
 * Folded-group rollup, memoized per (run version, root). A collapsed root can
 * own most of the graph, so this must not re-walk on every notification.
 */
export function groupSummaryOf(run: RunState, rootId: string): GroupSummary {
  let entry = summaryCache.get(run.runId);
  if (
    entry === undefined ||
    entry.version !== run.statusVersion ||
    entry.structureVersion !== run.structureVersion
  ) {
    entry = {
      version: run.statusVersion,
      structureVersion: run.structureVersion,
      summaries: new Map(),
    };
    summaryCache.set(run.runId, entry);
  }
  const cached = entry.summaries.get(rootId);
  if (cached !== undefined) return cached;
  const summary = summarizeGroup(run, rootId, childrenIndexOf(run));
  entry.summaries.set(rootId, summary);
  return summary;
}

/** Drop caches for a run that went away (fixture restart, clearRun). */
export function forgetRun(runId: string): void {
  structureCache.delete(runId);
  statusCache.delete(runId);
  summaryCache.delete(runId);
}
