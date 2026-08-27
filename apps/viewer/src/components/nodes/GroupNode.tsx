/**
 * A folded subtree. Everything inside a collapsed agent/chain shows up here
 * as one card: how many nodes and calls it contains, whether anything in it
 * failed or is still running, and what it cost. Clicking the card selects the
 * root node; the chevron unfolds it again.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { fmtCount, fmtDuration } from '../../lib/format.js';
import { groupSummaryOf } from '../../store/derived.js';
import { useRunStore } from '../../store/runStore.js';
import {
  CollapseToggle,
  FlowHandles,
  StatusDot,
  statusClass,
  useIsSelected,
  useNodeState,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

function GroupNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);
  const summary = useRunStore((s) => {
    const run = s.runs[runId];
    return run === undefined ? undefined : groupSummaryOf(run, nodeId);
  });

  if (node === undefined || summary === undefined) return null;

  return (
    <div className={`${statusClass(summary.status, selected)} gm-node--group`}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        <StatusDot status={summary.status} />
        <span className="gm-node-title">{node.name}</span>
        <span className="gm-node-kind" style={{ marginLeft: 'auto' }} title={`folded ${node.kind}`}>
          group
        </span>
      </div>

      <div className="gm-group-bars" aria-hidden>
        <span className="gm-group-bar gm-group-bar--ok" style={{ flex: Math.max(1, summary.executions - summary.errors - summary.running) }} />
        {summary.running > 0 && <span className="gm-group-bar gm-group-bar--running" style={{ flex: summary.running }} />}
        {summary.errors > 0 && <span className="gm-group-bar gm-group-bar--error" style={{ flex: summary.errors }} />}
      </div>

      <div className="gm-node-meta">
        <span className="gm-badge-count" title={`${summary.nodes} nodes folded into this card`}>
          {fmtCount(summary.nodes)} nodes
        </span>
        <span>
          {summary.steps > 0 && `${fmtCount(summary.steps)} steps · `}
          {fmtCount(summary.tools)} calls
          {summary.errors > 0 && (
            <span style={{ color: 'var(--err)' }}> · {fmtCount(summary.errors)} failed</span>
          )}
        </span>
        <span style={{ marginLeft: 'auto' }}>{fmtDuration(summary.durationMs)}</span>
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
