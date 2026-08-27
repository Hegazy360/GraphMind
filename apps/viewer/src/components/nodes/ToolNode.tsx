/**
 * Tool call card: name, status pill, duration, breakpoint dot toggle, and —
 * when paused — the resume action banner.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { isExportedRun } from '../../connection/FixtureConnection.js';
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

/**
 * The gutter dot that arms a breakpoint on this tool.
 *
 * In a run exported by `graphmind record --html` there is no server to arm
 * it on and nothing left to break before: the recording already happened.
 * The dot stays — it is part of how the card reads — but it is disabled and
 * says why, rather than lighting up red on a control the FixtureConnection
 * silently drops.
 */
function BreakpointDot({ name }: { name: string }) {
  const matcher = { kind: 'tool' as const, name };
  const key = matcherKey(matcher);
  const isSet = useUiStore((s) => s.breakpoints.some((m) => matcherKey(m) === key));
  const recorded = isExportedRun();
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (recorded) return;
    const ui = useUiStore.getState();
    if (isSet) {
      ui.removeBreakpoint(matcher);
      broadcastControl('breakpoint.clear', { matcher });
    } else {
      ui.addBreakpoint(matcher);
      broadcastControl('breakpoint.set', { matcher });
    }
  };
  if (recorded) {
    return (
      <span
        className="gm-bp gm-bp--dead"
        title={`This is a recorded run — ${name} already ran, and there is no server to set a breakpoint on.`}
        aria-label={`Breakpoints unavailable in a recorded run`}
      />
    );
  }
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
