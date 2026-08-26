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
 */
import type { NodeKind } from '@graphmind/schema';
import { nodeStatus, type NodeState, type RunState } from './types.js';

export type FlowNodeType = 'invocation' | 'llmStep' | 'tool';

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
  invocation: { width: 264, height: 108 },
  llmStep: { width: 300, height: 168 },
  tool: { width: 248, height: 104 },
};

/** Extra height a tool/step node gains while paused (resume action bar). */
export const PAUSE_BANNER_HEIGHT = 118;

export function nodeDimensions(node: NodeState): { width: number; height: number } {
  const base = NODE_DIMENSIONS[flowNodeType(node.kind)];
  if (node.activePauseId !== undefined) {
    return { width: base.width, height: base.height + PAUSE_BANNER_HEIGHT };
  }
  return base;
}

export function runStateToFlow(run: RunState): FlowGraph {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];
  /** Last-seen llm sibling per parentId, for step chaining. */
  const lastLlmSibling = new Map<string, string>();

  for (const nodeId of run.order) {
    const node = run.nodes[nodeId];
    if (node === undefined) continue;
    const type = flowNodeType(node.kind);
    const { width, height } = nodeDimensions(node);
    nodes.push({ id: nodeId, type, data: { runId: run.runId, nodeId }, width, height });

    if (node.parentId === undefined) continue;
    if (node.kind === 'llm') {
      const prev = lastLlmSibling.get(node.parentId);
      const source = prev ?? node.parentId;
      edges.push({ id: `e:${source}->${nodeId}`, source, target: nodeId });
      lastLlmSibling.set(node.parentId, nodeId);
    } else {
      edges.push({ id: `e:${node.parentId}->${nodeId}`, source: node.parentId, target: nodeId });
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
