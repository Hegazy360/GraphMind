/**
 * LLM step card: live token tail (last few lines of the stream), usage and
 * duration. The tail subscribes to the token buffer registry — the React
 * Flow node itself never re-renders per token — and it stops subscribing
 * entirely once the canvas drops to a coarse level of detail, which is what
 * keeps a 300-node graph responsive while twenty steps stream at once.
 */
import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { FlowNodeData } from '../../store/runStateToFlow.js';
import { fmtDuration, fmtTokens } from '../../lib/format.js';
import { useTokenSnapshot } from '../../hooks/useTokenSnapshot.js';
import { latestExecution } from '../../store/types.js';
import {
  CollapseToggle,
  FlowHandles,
  InstanceBadge,
  StatusDot,
  nodeStatus,
  statusClass,
  useIsSelected,
  useLod,
  useNodeState,
} from './nodeParts.js';
import { PauseBanner } from './PauseBanner.js';

const TAIL_CHARS = 220;

function TokenTail({ runId, nodeId, running }: { runId: string; nodeId: string; running: boolean }) {
  const snapshot = useTokenSnapshot(runId, nodeId);
  const showingReasoning = snapshot.text === '' && snapshot.reasoning !== '';
  const full = showingReasoning ? snapshot.reasoning : snapshot.text;
  const tail = full.length > TAIL_CHARS ? `…${full.slice(-TAIL_CHARS)}` : full;

  return (
    <div className={`gm-token-tail${showingReasoning ? ' gm-token-tail--reasoning' : ''}`}>
      {tail === '' ? (
        <span style={{ opacity: 0.55 }}>{running ? 'waiting for tokens' : 'no stream'}</span>
      ) : (
        <span>
          {tail}
          {running && <span className="gm-caret" />}
        </span>
      )}
    </div>
  );
}

function LlmStepNodeImpl({ data }: NodeProps<Node<FlowNodeData>>) {
  const { runId, nodeId } = data;
  const node = useNodeState(runId, nodeId);
  const selected = useIsSelected(runId, nodeId);
  const lod = useLod();

  if (node === undefined) return null;
  const status = nodeStatus(node);
  const exec = latestExecution(node);
  const usage = exec?.usage;

  return (
    <div className={statusClass(status, selected)}>
      <FlowHandles />
      <div className="gm-node-head">
        <CollapseToggle runId={runId} nodeId={nodeId} />
        <StatusDot status={status} />
        <span className="gm-node-title">{node.name}</span>
        <InstanceBadge node={node} />
        <span className="gm-node-kind" style={{ marginLeft: 'auto' }}>
          llm
        </span>
      </div>
      {lod === 'full' ? (
        <TokenTail runId={runId} nodeId={nodeId} running={status === 'running'} />
      ) : (
        <div className="gm-token-tail gm-token-tail--muted" aria-hidden>
          <span style={{ opacity: 0.5 }}>{status === 'running' ? 'streaming…' : 'stream hidden'}</span>
        </div>
      )}
      <div className="gm-node-meta" style={{ marginTop: 7 }}>
        {usage !== undefined ? (
          <span title={`${usage.inputTokens} in · ${usage.outputTokens} out`}>
            {fmtTokens(usage.inputTokens)} → {fmtTokens(usage.outputTokens)} tok
          </span>
        ) : (
          <span>{status === 'running' ? 'streaming…' : status === 'ghost' ? 'not started' : ''}</span>
        )}
        {exec?.durationMs !== undefined && (
          <span style={{ marginLeft: 'auto' }}>{fmtDuration(exec.durationMs)}</span>
        )}
      </div>
      <PauseBanner runId={runId} node={node} />
    </div>
  );
}

export const LlmStepNode = memo(LlmStepNodeImpl);
