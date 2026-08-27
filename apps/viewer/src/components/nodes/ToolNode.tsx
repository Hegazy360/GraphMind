/**
 * Tool call card: name, status pill, duration, breakpoint dot toggle, and —
 * when paused — the resume action banner.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { broadcastControl } from '../../connection/ServerConnection.js';
import { fmtDuration } from '../../lib/format.js';
import { latestExecution } from '../../store/types.js';
import { matcherKey, useUiStore } from '../../store/uiStore.js';
import {
  CollapseToggle,
  FlowHandles,
  InstanceBadge,
  StatusPill,
  nodeStatus,
  statusClass,
  useIsSelected,
  useNodeState,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

function BreakpointDot({ name }: { name: string }) {
  const matcher = { kind: 'tool' as const, name };
  const key = matcherKey(matcher);
  const isSet = useUiStore((s) => s.breakpoints.some((m) => matcherKey(m) === key));
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const ui = useUiStore.getState();
    if (isSet) {
      ui.removeBreakpoint(matcher);
      broadcastControl('breakpoint.clear', { matcher });
    } else {
      ui.addBreakpoint(matcher);
      broadcastControl('breakpoint.set', { matcher });
    }
  };
  return (
    <button
      className={`gm-bp nodrag${isSet ? ' gm-bp--set' : ''}`}
      onClick={toggle}
      title={isSet ? 'Clear breakpoint' : 'Break before this tool'}
      aria-label={isSet ? `Clear breakpoint on ${name}` : `Set breakpoint on ${name}`}
    />
  );
}

function ToolNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);

  if (node === undefined) return null;
  const status = nodeStatus(node);
  const exec = latestExecution(node);

  return (
    <div className={statusClass(status, selected)}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        {node.ungated === true ? (
          <span
            className="gm-ungated"
            title="Provider-executed (ungated) — observed via stream tee; cannot be paused, breakpoints never fire"
            aria-label="ungated"
          >
            ⌁
          </span>
        ) : (
          <BreakpointDot name={node.name} />
        )}
        <span className="gm-node-title">{node.name}</span>
        <InstanceBadge node={node} />
        <span className="gm-node-kind" style={{ marginLeft: 'auto' }}>
          {node.ungated === true ? 'ungated' : node.kind === 'custom' ? 'span' : 'tool'}
        </span>
      </div>
      <div className="gm-node-meta">
        <StatusPill status={status} />
        {exec?.injected === true && (
          <span className="gm-pill gm-pill--injected" title="Result substituted from the debugger">
            injected
          </span>
        )}
        {exec?.durationMs !== undefined && (
          <span style={{ marginLeft: 'auto' }}>{fmtDuration(exec.durationMs)}</span>
        )}
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const ToolNode = memo(ToolNodeImpl);
