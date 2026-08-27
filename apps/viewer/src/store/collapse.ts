/**
 * Collapsible groups. A long run is mostly repetition: one sub-agent that
 * fans out twelve tools, a chain that retries. Collapsing a subtree into a
 * single summary node is what keeps a 300-node graph readable.
 *
 * Everything here is a pure projection of `RunState` — the collapsed set
 * itself lives in the UI store (per run), never in the reducer.
 */
import type { NodeKind } from '@graphmind-ai/schema';
import { nodeStatus, type NodeLifeStatus, type RunState } from './types.js';

/** parentId → child nodeIds, in first-seen order. */
export function childIndex(run: RunState): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined || node.parentId === undefined) continue;
    const list = index.get(node.parentId);
    if (list === undefined) index.set(node.parentId, [nodeId]);
    else list.push(nodeId);
  }
  return index;
}

/** Every node under `rootId` (exclusive), depth-first, cycle-safe. */
export function descendantsOf(
  run: RunState,
  rootId: string,
  index: Map<string, string[]> = childIndex(run),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const stack: string[] = [...(index.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of index.get(id) ?? []) stack.push(child);
  }
  return out;
}

/** A node can be collapsed when it actually contains something. */
export function isCollapsible(
  run: RunState,
  nodeId: string,
  index: Map<string, string[]> = childIndex(run),
): boolean {
  return (index.get(nodeId) ?? []).length > 0;
}

/**
 * Nodes hidden by a collapsed set: every descendant of a collapsed root.
 * The roots themselves stay visible (they become the summary card).
 */
export function hiddenByCollapse(
  run: RunState,
  collapsed: readonly string[],
  index: Map<string, string[]> = childIndex(run),
): Map<string, string> {
  /** hidden nodeId → the collapsed ancestor that represents it. */
  const representative = new Map<string, string>();
  for (const rootId of collapsed) {
    if (run.nodes[rootId] === undefined) continue;
    for (const id of descendantsOf(run, rootId, index)) {
      // Outermost collapsed ancestor wins — nested collapses fold together.
      if (!representative.has(id)) representative.set(id, rootId);
    }
  }
  // Resolve chains: a representative that is itself hidden defers upward.
  for (const [id, root] of representative) {
    let target = root;
    for (let hops = 0; hops < 16; hops++) {
      const next = representative.get(target);
      if (next === undefined || next === target) break;
      target = next;
    }
    representative.set(id, target);
  }
  return representative;
}

/** Aggregate of everything inside a collapsed group. */
export interface GroupSummary {
  /** Descendant logical nodes (excluding the root). */
  nodes: number;
  steps: number;
  tools: number;
  executions: number;
  errors: number;
  running: number;
  paused: number;
  /** Sum of descendant execution durations (wall-clock overlaps included). */
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Worst-of aggregate for the card's ring colour. */
  status: NodeLifeStatus;
}

const STATUS_RANK: Record<NodeLifeStatus, number> = {
  ghost: 0,
  ok: 1,
  aborted: 2,
  running: 3,
  error: 4,
  paused: 5,
};

export function summarizeGroup(
  run: RunState,
  rootId: string,
  index: Map<string, string[]> = childIndex(run),
): GroupSummary {
  const summary: GroupSummary = {
    nodes: 0,
    steps: 0,
    tools: 0,
    executions: 0,
    errors: 0,
    running: 0,
    paused: 0,
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    status: 'ghost',
  };
  let rank = -1;
  for (const id of descendantsOf(run, rootId, index)) {
    const node = run.nodes[id];
    if (node === undefined) continue;
    summary.nodes += 1;
    if (node.kind === 'llm') summary.steps += node.executions.length;
    else if (node.kind === 'tool') summary.tools += node.executions.length;
    summary.executions += node.executions.length;
    for (const exec of node.executions) {
      if (exec.status === 'error') summary.errors += 1;
      if (exec.status === 'running') summary.running += 1;
      if (exec.durationMs !== undefined) summary.durationMs += exec.durationMs;
      if (exec.usage !== undefined) {
        summary.tokensIn += exec.usage.inputTokens;
        summary.tokensOut += exec.usage.outputTokens;
      }
    }
    if (node.activePauseId !== undefined) summary.paused += 1;
    const status = nodeStatus(node);
    if (STATUS_RANK[status] > rank) {
      rank = STATUS_RANK[status];
      summary.status = status;
    }
  }
  return summary;
}

/** Depth of every node in the parent forest. */
function depthIndex(run: RunState): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (nodeId: string, guard = 0): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) return cached;
    const parentId = run.nodes[nodeId]?.parentId;
    const value = parentId === undefined || guard > 64 ? 0 : depthOf(parentId, guard + 1) + 1;
    depths.set(nodeId, value);
    return value;
  };
  for (const nodeId of run.order) depthOf(nodeId);
  return depths;
}

/**
 * What to fold when a big run first opens.
 *
 * A hundred sibling sub-agents laid out side by side is technically correct
 * and completely unreadable — the graph ends up 15,000px wide and every card
 * is a dot. So we fold the shallowest level that gets the visible count under
 * `targetVisible`, starting from the deepest (least destructive) level and
 * working up. Collapsing is remembered per run and undone with one keystroke,
 * so this is a starting view, not a decision taken away from the user.
 *
 * Returns an empty array when the run is small enough to show whole.
 */
export function autoCollapseRoots(run: RunState, targetVisible = 60): string[] {
  const total = run.order.length;
  if (total <= targetVisible) return [];
  const index = childIndex(run);
  const depths = depthIndex(run);
  let maxDepth = 0;
  for (const depth of depths.values()) maxDepth = Math.max(maxDepth, depth);

  for (let depth = maxDepth; depth >= 1; depth--) {
    const candidates = run.order.filter(
      (id) => depths.get(id) === depth && (index.get(id) ?? []).length > 0,
    );
    if (candidates.length === 0) continue;
    const hidden = new Set<string>();
    for (const id of candidates) {
      for (const descendant of descendantsOf(run, id, index)) hidden.add(descendant);
    }
    if (total - hidden.size <= targetVisible) return candidates;
  }
  return [];
}

/**
 * Sensible default collapse for a freshly opened large run: every node that
 * owns a subtree of at least `minSize`, outermost first. Used by the
 * "Collapse all" command and the auto-collapse threshold.
 */
export function collapsibleRoots(run: RunState, minSize = 2): string[] {
  const index = childIndex(run);
  const roots: string[] = [];
  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    // Only container-ish kinds group; a tool with children is rare but valid.
    const kind: NodeKind = node.kind;
    if (kind !== 'agent' && kind !== 'chain' && kind !== 'llm') continue;
    if (descendantsOf(run, nodeId, index).length < minSize) continue;
    roots.push(nodeId);
  }
  // Drop roots nested inside another root — collapsing the outermost is enough.
  const outer = new Set(roots);
  for (const rootId of roots) {
    for (const id of descendantsOf(run, rootId, index)) outer.delete(id);
  }
  return roots.filter((id) => outer.has(id));
}
