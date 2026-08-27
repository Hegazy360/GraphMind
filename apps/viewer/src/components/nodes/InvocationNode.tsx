/**
 * Agent invocation card: name, step/tool counts, run-state ring.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { fmtDuration } from '../../lib/format.js';
import { latestExecution } from '../../store/types.js';
import { agentCountsFor } from '../../store/derived.js';
import { useRunStore } from '../../store/runStore.js';
import {
  CollapseToggle,
  FlowHandles,
  InstanceBadge,
  StatusDot,
  nodeStatus,
  statusClass,
  useIsSelected,
  useNodeState,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

function InvocationNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);
  // One llm:step node per invocation — its executions are the steps; tool
  // calls count executions too, and either may hang off the agent or off the
  // llm step node. The subtree walk is cached per status version (see
  // store/derived.ts): this selector must stay O(1).
  const counts = useRunStore((s) => {
    const run = s.runs[runId];
    if (run === undefined) return '';
    const { steps, tools } = agentCountsFor(run, nodeId);
    const parts: string[] = [];
    if (steps > 0) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
    if (tools > 0) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
    return parts.join(' · ');
  });

  if (node === undefined) return null;
  const status = nodeStatus(node);
  const exec = latestExecution(node);

  return (
    <div className={statusClass(status, selected)}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        <StatusDot status={status} />
        <span className="gm-node-title">{node.name}</span>
        <InstanceBadge node={node} />
        <span className="gm-node-kind" style={{ marginLeft: 'auto' }}>
          {node.kind}
        </span>
      </div>
      <div className="gm-node-meta">
        <span>{counts === '' ? (status === 'ghost' ? 'not started' : 'starting…') : counts}</span>
        {exec?.durationMs !== undefined && (
          <span style={{ marginLeft: 'auto' }}>{fmtDuration(exec.durationMs)}</span>
        )}
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const InvocationNode = memo(InvocationNodeImpl);
