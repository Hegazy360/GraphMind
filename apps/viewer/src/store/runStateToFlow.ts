/**
 * Project a RunState into React Flow nodes + edges (the successor of the
 * legacy `agentsToNodes` serializer). Structure only — positions come from
 * ELK afterwards, and live status is read by node components straight from
 * the store, so the returned `data` payload is nothing but identity. That
 * is what keeps the nodes array referentially stable while tokens stream.
 *
 * Edge derivation:
 *  - parent containment: parent → child for every node with a `parentId`
 *  - step chain: consecutive `llm` siblings under the same parent connect
 *    to each other instead of fanning out of the parent (agent → step 1 →
 *    step 2 → …)
 *  - tools hang off whatever `node.started` named as their parent
 *
 * Collapse: when a node is collapsed its whole subtree disappears and every
 * edge that crossed the boundary is re-pointed at the summary card, so the
 * graph stays connected at any zoom level (see collapse.ts).
 */
import type { NodeKind } from '@graphmind-ai/schema';
import { hiddenByCollapse } from './collapse.js';
import { nodeStatus, type NodeState, type RunState } from './types.js';

export type FlowNodeType = 'invocation' | 'llmStep' | 'tool' | 'group';

export interface FlowNodeData extends Record<string, unknown> {
  runId: string;
  nodeId: string;
}

export interface FlowNodeSpec {
  id: string;
  type: FlowNodeType;
  data: FlowNodeData;
  width: number;
  height: number;
}

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
}

export interface FlowOptions {
  /** nodeIds whose subtree is folded into a summary card. */
  collapsed?: readonly string[];
}

export function flowNodeType(kind: NodeKind): FlowNodeType {
  switch (kind) {
    case 'agent':
      return 'invocation';
    case 'llm':
      return 'llmStep';
    default:
      return 'tool';
  }
}

export const NODE_DIMENSIONS: Record<FlowNodeType, { width: number; height: number }> = {
  invocation: { width: 264, height: 104 },
  llmStep: { width: 300, height: 164 },
  tool: { width: 248, height: 96 },
  group: { width: 264, height: 104 },
};

/**
 * Extra height a node gains while paused (resume action bar). Kept below the
 * inter-layer spacing in elkLayout so a pause never forces a re-layout —
 * the card grows into the gap it already owns.
 */
export const PAUSE_BANNER_HEIGHT = 92;

export function nodeDimensions(
  node: NodeState,
  collapsed = false,
): { width: number; height: number } {
  const base = NODE_DIMENSIONS[collapsed ? 'group' : flowNodeType(node.kind)];
  if (node.activePauseId !== undefined) {
    return { width: base.width, height: base.height + PAUSE_BANNER_HEIGHT };
  }
  return base;
}

export function runStateToFlow(run: RunState, options: FlowOptions = {}): FlowGraph {
  const collapsed = options.collapsed ?? [];
  const hidden = collapsed.length === 0 ? new Map<string, string>() : hiddenByCollapse(run, collapsed);
  const collapsedSet = new Set(collapsed.filter((id) => run.nodes[id] !== undefined && !hidden.has(id)));
  /** A hidden node renders as its collapsed ancestor. */
  const represent = (nodeId: string): string => hidden.get(nodeId) ?? nodeId;

  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];
  const edgeIds = new Set<string>();
  /** Last-seen llm sibling per parentId, for step chaining. */
  const lastLlmSibling = new Map<string, string>();

  const pushEdge = (source: string, target: string): void => {
    const from = represent(source);
    const to = represent(target);
    if (from === to) return; // collapsed away into the same card
    const id = `e:${from}->${to}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, source: from, target: to });
  };

  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    if (!hidden.has(nodeId)) {
      const isGroup = collapsedSet.has(nodeId);
      const type = isGroup ? 'group' : flowNodeType(node.kind);
      const { width, height } = nodeDimensions(node, isGroup);
      nodes.push({ id: nodeId, type, data: { runId: run.runId, nodeId }, width, height });
    }

    if (node.parentId === undefined) continue;
    if (node.kind === 'llm') {
      const prev = lastLlmSibling.get(node.parentId);
      const source = prev ?? node.parentId;
      pushEdge(source, nodeId);
      lastLlmSibling.set(node.parentId, nodeId);
    } else {
      pushEdge(node.parentId, nodeId);
    }
  }

  // Drop edges whose endpoints never materialized (hint referenced an
  // unknown parent, etc.) — React Flow warns loudly otherwise.
  const known = new Set(nodes.map((n) => n.id));
  return { nodes, edges: edges.filter((e) => known.has(e.source) && known.has(e.target)) };
}

export type EdgeVisual = 'idle' | 'active' | 'done' | 'error' | 'paused' | 'ghost';

/** Visual class of an edge, driven by its target node's status. */
export function edgeVisual(run: RunState, targetId: string): EdgeVisual {
  const target = run.nodes[targetId];
  if (target === undefined) return 'idle';
  switch (nodeStatus(target)) {
    case 'running':
      return 'active';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    case 'ok':
      return 'done';
    case 'aborted':
      return 'done';
    case 'ghost':
      return 'ghost';
  }
}
