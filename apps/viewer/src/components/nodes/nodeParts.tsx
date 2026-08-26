/**
 * Shared building blocks for the three node cards.
 */
import { Handle, Position } from '@xyflow/react';
import { useRunStore } from '../../store/runStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { nodeStatus, type NodeLifeStatus, type NodeState } from '../../store/types.js';

/** Select one node's state; re-renders only that card. */
export function useNodeState(runId: string, nodeId: string): NodeState | undefined {
  return useRunStore((s) => s.runs[runId]?.nodes[nodeId]);
}

export function useIsSelected(runId: string, nodeId: string): boolean {
  return useUiStore((s) => s.selectedRunId === runId && s.selectedNodeId === nodeId);
}

export function statusClass(status: NodeLifeStatus, selected: boolean): string {
  const classes = ['gm-node', `gm-node--${status}`];
  if (selected) classes.push('gm-node--selected');
  return classes.join(' ');
}

export function StatusDot({ status }: { status: NodeLifeStatus }) {
  const variant =
    status === 'running' || status === 'paused' || status === 'error'
      ? status
      : status === 'ok'
        ? 'ok'
        : 'idle';
  return <span className={`gm-dot gm-dot--${variant}`} aria-hidden />;
}

export function StatusPill({ status }: { status: NodeLifeStatus }) {
  const variant =
    status === 'ghost' ? 'idle' : status === 'aborted' ? 'idle' : status;
  const label = status === 'ghost' ? 'idle' : status === 'ok' ? 'done' : status;
  return <span className={`gm-pill gm-pill--${variant}`}>{label}</span>;
}

export function InstanceBadge({ node }: { node: NodeState }) {
  if (node.executions.length <= 1) return null;
  return <span className="gm-badge-count" title={`${node.executions.length} executions`}>×{node.executions.length}</span>;
}

/** Invisible flow handles — edges dock to node borders. */
export function FlowHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export { nodeStatus };
