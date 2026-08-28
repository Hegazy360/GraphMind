/**
 * The leaf card: a tool call, an MCP resources/read or prompts/get, a
 * retriever lookup, a custom span. Name, kind mark, status pill, duration,
 * breakpoint dot — and, when a gate holds it, the resume action row.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { NodeKind } from '@graphmind-ai/schema';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { isExportedRun } from '../../connection/FixtureConnection.js';
import { broadcastControl } from '../../connection/ServerConnection.js';
import { fmtDuration } from '../../lib/format.js';
import { kindLabel } from '../../lib/kinds.js';
import { latestExecution, nodeStatus as statusOf } from '../../store/types.js';
import { matcherKey, useUiStore } from '../../store/uiStore.js';
import { KindMark } from '../KindMark.js';
import {
  CollapseToggle,
  FlowHandles,
  InstanceBadge,
  StatusPill,
  statusClass,
  useIsSelected,
  useNodeState,
  useStatusFlash,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

/**
 * The gutter dot that arms a breakpoint on this node.
 *
 * In a run exported by `graphmind record --html` there is no server to arm
 * it on and nothing left to break before: the recording already happened.
 * The dot stays — it is part of how the card reads — but it is disabled and
 * says why, rather than lighting up red on a control the FixtureConnection
 * silently drops.
 */
function BreakpointDot({ name, kind }: { name: string; kind: NodeKind }) {
  const matcher = { kind, name };
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
      title={isSet ? 'Clear breakpoint' : `Break before this ${kindLabel(kind)}`}
      aria-label={isSet ? `Clear breakpoint on ${name}` : `Set breakpoint on ${name}`}
    />
  );
}

function ToolNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);
  const status = node === undefined ? 'ghost' : statusOf(node);
  const flash = useStatusFlash(status);

  if (node === undefined) return null;
  const exec = latestExecution(node);
  const ungated = node.ungated === true;

  return (
    <div className={`${statusClass(status, selected, flash)} gm-kind--${node.kind}`}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        {ungated ? (
          <span
            className="gm-ungated"
            title="Provider-executed (ungated) — observed via stream tee; cannot be paused, breakpoints never fire"
            aria-label="ungated"
          >
            ⌁
          </span>
        ) : (
          <BreakpointDot name={node.name} kind={node.kind} />
        )}
        <span className="gm-node-title">{node.name}</span>
        <InstanceBadge node={node} />
        <KindMark
          kind={node.kind}
          {...(ungated ? { label: 'ungated' } : {})}
          {...(ungated
            ? { title: 'Provider-executed — observed, never gated' }
            : {})}
          className="gm-node-kind--trailing"
        />
      </div>
      <div className="gm-node-meta">
        <StatusPill status={status} />
        {exec?.injected === true && (
          <span className="gm-pill gm-pill--injected" title="Result substituted from the debugger">
            injected
          </span>
        )}
        {exec?.durationMs !== undefined && (
          <span className="gm-node-ms">{fmtDuration(exec.durationMs)}</span>
        )}
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const ToolNode = memo(ToolNodeImpl);
