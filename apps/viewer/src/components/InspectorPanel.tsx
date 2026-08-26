/**
 * Right-side inspector: full input/output payloads, error + stack, timings,
 * token usage, per-instance selector, copy buttons.
 */
import { useState } from 'react';
import { fmtClock, fmtDuration, fmtTokens } from '../lib/format.js';
import { useTokenSnapshot } from '../hooks/useTokenSnapshot.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { nodeStatus, type NodeExecution, type NodeState } from '../store/types.js';
import { IconClose } from './Icons.js';
import { JsonTree } from './JsonTree.js';
import { StatusPill } from './nodes/nodeParts.js';

function CopyButton({ getText, label = 'copy' }: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="gm-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(getText()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'copied' : label}
    </button>
  );
}

function Section({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: (() => string) | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="gm-section-label">{label}</span>
        {copy !== undefined && <CopyButton getText={copy} />}
      </div>
      {children}
    </div>
  );
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ExecutionDetails({
  runId,
  node,
  exec,
  execIndex,
}: {
  runId: string;
  node: NodeState;
  exec: NodeExecution;
  execIndex: number;
}) {
  const live = useTokenSnapshot(runId, node.nodeId);
  // Streams are segmented per execution at node.started boundaries: the
  // latest execution reads the live buffer, earlier ones their archive.
  const tokens =
    execIndex >= node.executions.length - 1
      ? live
      : tokenBuffers.getInstanceSnapshot(runId, node.nodeId, execIndex, node.executions.length);
  const streamed = tokens.text;
  // Fall back to the node-level error only when this execution is the one
  // that can own it (it failed, or is still running) — a clean retry must
  // not inherit its predecessor's error.
  const error =
    exec.error ??
    (exec.status === 'error' || exec.status === 'running' ? node.lastError : undefined);

  return (
    <>
      <Section label="Timing">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ fontSize: 12, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          <span>started</span>
          <span style={{ color: 'var(--text)' }}>{fmtClock(exec.startedTs)}</span>
          {exec.finishedTs !== undefined && (
            <>
              <span>finished</span>
              <span style={{ color: 'var(--text)' }}>{fmtClock(exec.finishedTs)}</span>
            </>
          )}
          {exec.durationMs !== undefined && (
            <>
              <span>duration</span>
              <span style={{ color: 'var(--text)' }}>{fmtDuration(exec.durationMs)}</span>
            </>
          )}
          {exec.usage !== undefined && (
            <>
              <span>tokens</span>
              <span style={{ color: 'var(--text)' }}>
                {fmtTokens(exec.usage.inputTokens)} in · {fmtTokens(exec.usage.outputTokens)} out
              </span>
            </>
          )}
          {exec.streaming === true && (
            <>
              <span>streamed</span>
              <span style={{ color: 'var(--text)' }}>
                {exec.chunks !== undefined ? `${exec.chunks} chunks` : 'yes'}
              </span>
            </>
          )}
          {exec.injected === true && (
            <>
              <span>result</span>
              <span className="gm-pill gm-pill--injected">injected</span>
            </>
          )}
        </div>
      </Section>

      {error !== undefined && (
        <Section label="Error" copy={() => `${error.name}: ${error.message}\n${error.stack ?? ''}`}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--err)',
              marginBottom: error.stack !== undefined ? 8 : 0,
            }}
          >
            {error.name}: {error.message}
          </div>
          {error.stack !== undefined && (
            <pre
              className="nowheel"
              style={{
                margin: 0,
                padding: '8px 10px',
                background: 'var(--err-soft)',
                borderRadius: 6,
                fontSize: 10.5,
                lineHeight: 1.55,
                overflowX: 'auto',
                color: 'var(--text-dim)',
              }}
            >
              {error.stack}
            </pre>
          )}
        </Section>
      )}

      <Section label="Input" copy={() => toJson(exec.input)}>
        <JsonTree value={exec.input} />
      </Section>

      {exec.output !== undefined && (
        <Section label="Output" copy={() => toJson(exec.output)}>
          <JsonTree value={exec.output} />
        </Section>
      )}

      {streamed !== '' && (
        <Section label="Stream" copy={() => streamed}>
          <pre
            style={{
              margin: 0,
              padding: '8px 10px',
              background: 'var(--bg-canvas)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-dim)',
              maxHeight: 260,
              overflowY: 'auto',
            }}
          >
            {streamed}
          </pre>
        </Section>
      )}

      {tokens.reasoning !== '' && (
        <Section label="Reasoning" copy={() => tokens.reasoning}>
          <pre
            style={{
              margin: 0,
              fontSize: 11,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-faint)',
              fontStyle: 'italic',
              fontFamily: 'var(--font-mono)',
              maxHeight: 180,
              overflowY: 'auto',
            }}
          >
            {tokens.reasoning}
          </pre>
        </Section>
      )}
    </>
  );
}

export function InspectorPanel() {
  const runId = useUiStore((s) => s.selectedRunId);
  const nodeId = useUiStore((s) => s.selectedNodeId);
  if (runId === undefined || nodeId === undefined) return null;
  return <InspectorInner runId={runId} nodeId={nodeId} />;
}

function InspectorInner({ runId, nodeId }: { runId: string; nodeId: string }) {
  const node = useRunStore((s) => s.runs[runId]?.nodes[nodeId]);
  const instanceIdx = useUiStore((s) => s.selectedInstanceIdx);
  const setInstanceIdx = useUiStore((s) => s.setInstanceIdx);

  if (node === undefined) return null;
  const status = nodeStatus(node);
  const idx = instanceIdx ?? node.executions.length - 1;
  const exec = node.executions[Math.max(0, Math.min(idx, node.executions.length - 1))];

  return (
    <aside
      className="gm-panel absolute top-0 right-0 bottom-0 z-30 flex flex-col"
      style={{ width: 372 }}
    >
      <header
        className="flex items-center gap-8 px-4"
        style={{ height: 52, borderBottom: '1px solid var(--border)', flexShrink: 0, gap: 10 }}
      >
        <span className="gm-node-kind">{node.kind}</span>
        <span className="gm-node-title" style={{ fontSize: 14, flex: 1 }}>
          {node.name}
        </span>
        <StatusPill status={status} />
        <button
          className="gm-iconbtn"
          onClick={() => useUiStore.getState().selectNode(runId, undefined)}
          title="Close (esc)"
        >
          <IconClose />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {node.nodeId}
        </div>

        {node.executions.length > 1 && (
          <div className="px-4 py-3 flex items-center" style={{ borderBottom: '1px solid var(--border)', gap: 10 }}>
            <span className="gm-section-label">Execution</span>
            <div className="gm-seg">
              {node.executions.map((e, i) => (
                <button
                  key={e.instanceId}
                  className={i === idx ? 'gm-seg--on' : ''}
                  title={e.instanceId}
                  onClick={() => setInstanceIdx(i)}
                >
                  #{i + 1}
                </button>
              ))}
            </div>
          </div>
        )}

        {exec === undefined ? (
          <div className="px-4 py-6" style={{ color: 'var(--text-faint)' }}>
            Not executed yet — known from graph.hint.
          </div>
        ) : (
          <ExecutionDetails
            runId={runId}
            node={node}
            exec={exec}
            execIndex={Math.max(0, Math.min(idx, node.executions.length - 1))}
          />
        )}
      </div>
    </aside>
  );
}
