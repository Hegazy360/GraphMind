/**
 * The container card: an agent invocation, a chain, or an MCP server session.
 * Name, what it has executed so far, run-state ring.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { fmtDuration } from '../../lib/format.js';
import { latestExecution, nodeStatus as statusOf } from '../../store/types.js';
import { agentCountsFor } from '../../store/derived.js';
import { useRunStore } from '../../store/runStore.js';
import { KindMark } from '../KindMark.js';
import {
  CollapseToggle,
  FlowHandles,
  InstanceBadge,
  StatusDot,
  statusClass,
  useIsSelected,
  useNodeState,
  useStatusFlash,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

/** An MCP session counts requests handled, not "steps" and "tool calls". */
function summaryLine(kind: string, steps: number, tools: number): string {
  const parts: string[] = [];
  if (kind === 'server') {
    const total = steps + tools;
    if (total > 0) parts.push(`${total} request${total === 1 ? '' : 's'}`);
    if (steps > 0) parts.push(`${steps} sampling`);
    return parts.join(' · ');
  }
  if (steps > 0) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
  if (tools > 0) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function InvocationNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);
  const status = node === undefined ? 'ghost' : statusOf(node);
  const flash = useStatusFlash(status);
  // One llm:step node per invocation — its executions are the steps; tool
  // calls count executions too, and either may hang off the agent or off the
  // llm step node. The subtree walk is cached per status version (see
  // store/derived.ts): this selector must stay O(1).
  const counts = useRunStore((s) => {
    const run = s.runs[runId];
    if (run === undefined) return '';
    const { steps, tools } = agentCountsFor(run, nodeId);
    return summaryLine(run.nodes[nodeId]?.kind ?? 'agent', steps, tools);
  });

  if (node === undefined) return null;
  const exec = latestExecution(node);

  return (
    <div className={`${statusClass(status, selected, flash)} gm-kind--${node.kind}`}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        <StatusDot status={status} />
        <span className="gm-node-title">{node.name}</span>
        <InstanceBadge node={node} />
        <KindMark kind={node.kind} className="gm-node-kind--trailing" />
      </div>
      <div className="gm-node-meta">
        <span>{counts === '' ? (status === 'ghost' ? 'not started' : 'starting…') : counts}</span>
        {exec?.durationMs !== undefined && (
          <span className="gm-node-ms">{fmtDuration(exec.durationMs)}</span>
        )}
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const InvocationNode = memo(InvocationNodeImpl);
