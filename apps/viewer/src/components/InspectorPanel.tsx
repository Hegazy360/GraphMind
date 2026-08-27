/**
 * The inspector. When a run breaks at 3am this is the panel you read, so it
 * leads with the answer: a "why this failed" block that pins the error, its
 * stack, the exact input that produced it, and what ran around it — then the
 * numbers (duration, tokens, retries, estimated spend), then the payloads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText, deepLink } from '../lib/commands.js';
import {
  fmtClockMs,
  fmtCost,
  fmtDuration,
  fmtExactMs,
  fmtTokens,
} from '../lib/format.js';
import { useTokenSnapshot } from '../hooks/useTokenSnapshot.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useRunStore } from '../store/runStore.js';
import { failureContext, nodeStats } from '../store/stats.js';
import { useUiStore } from '../store/uiStore.js';
import { nodeStatus, type NodeExecution, type NodeState } from '../store/types.js';
import { IconAlert, IconClose, IconLink } from './Icons.js';
import { JsonTree } from './JsonTree.js';
import { StatusPill } from './nodes/nodeParts.js';

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const WIDTH_KEY = 'graphmind.inspectorWidth';

function CopyButton({ getText, label = 'copy' }: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="gm-copy"
      onClick={() => {
        void copyText(getText()).then((ok) => {
          if (!ok) return;
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
  tone,
}: {
  label: string;
  copy?: (() => string) | undefined;
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <section className={`gm-inspect-section${tone === 'error' ? ' gm-inspect-section--error' : ''}`}>
      <div className="gm-inspect-section-head">
        <span className="gm-section-label">{label}</span>
        {copy !== undefined && <CopyButton getText={copy} />}
      </div>
      {children}
    </section>
  );
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: 'error' | 'dim' }) {
  return (
    <div className={`gm-inspect-stat${tone !== undefined ? ` gm-inspect-stat--${tone}` : ''}`}>
      <span className="gm-inspect-stat-value">{value}</span>
      <span className="gm-inspect-stat-label">{label}</span>
    </div>
  );
}

function WhyItFailed({
  runId,
  node,
  exec,
  error,
}: {
  runId: string;
  node: NodeState;
  exec: NodeExecution;
  error: { name: string; message: string; stack?: string };
}) {
  const context = useRunStore((s) => {
    const run = s.runs[runId];
    return run === undefined ? { siblings: [] } : failureContext(run, node.nodeId);
  });
  const [showStack, setShowStack] = useState(false);

  return (
    <section className="gm-why">
      <div className="gm-why-head">
        <IconAlert width={13} height={13} />
        <span>Why this failed</span>
        <CopyButton
          label="copy report"
          getText={() =>
            [
              `${error.name}: ${error.message}`,
              '',
              `node: ${node.nodeId} (${node.kind})`,
              `instance: ${exec.instanceId}`,
              `input: ${toJson(exec.input)}`,
              '',
              error.stack ?? '',
            ].join('\n')
          }
        />
      </div>

      <div className="gm-why-error">
        <span className="gm-why-error-name">{error.name}</span>
        <span className="gm-why-error-message">{error.message}</span>
      </div>

      {error.stack !== undefined && (
        <>
          <button className="gm-why-toggle" onClick={() => setShowStack((s) => !s)} aria-expanded={showStack}>
            {showStack ? '▾' : '▸'} stack trace
          </button>
          {showStack && (
            <pre className="gm-why-stack nowheel">{error.stack}</pre>
          )}
        </>
      )}

      <div className="gm-why-label">The input that produced it</div>
      <div className="gm-why-input nowheel">
        <JsonTree value={exec.input} initialDepth={1} rootPath="input" searchable={false} />
      </div>

      {(context.parent !== undefined || context.siblings.length > 0) && (
        <>
          <div className="gm-why-label">Context</div>
          <div className="gm-why-context">
            {context.parent !== undefined && (
              <button
                className="gm-why-chip"
                onClick={() => {
                  const ui = useUiStore.getState();
                  if (context.parent === undefined) return;
                  ui.selectNode(runId, context.parent.nodeId);
                  ui.requestFocus(context.parent.nodeId);
                }}
                title="Jump to the caller"
              >
                ↑ {context.parent.name}
                <span className="gm-node-kind">{context.parent.kind}</span>
              </button>
            )}
            {context.siblings.slice(0, 8).map((sibling) => (
              <button
                key={sibling.nodeId}
                className={`gm-why-chip gm-why-chip--${sibling.status}`}
                onClick={() => {
                  const ui = useUiStore.getState();
                  ui.selectNode(runId, sibling.nodeId);
                  ui.requestFocus(sibling.nodeId);
                }}
                title={`${sibling.nodeId} — ${sibling.status}`}
              >
                {sibling.name}
                {sibling.durationMs !== undefined && (
                  <span className="gm-node-kind">{fmtDuration(sibling.durationMs)}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
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
  const timing = tokenBuffers.getInstanceTiming(runId, node.nodeId, execIndex, node.executions.length);
  // Fall back to the node-level error only when this execution is the one
  // that can own it (it failed, or is still running) — a clean retry must
  // not inherit its predecessor's error.
  const error =
    exec.error ??
    (exec.status === 'error' || exec.status === 'running' ? node.lastError : undefined);
  const stats = nodeStats(node);
  const firstTokenMs = timing === undefined ? undefined : Math.max(0, timing.firstTs - exec.startedTs);

  return (
    <>
      {error !== undefined && (
        <WhyItFailed runId={runId} node={node} exec={exec} error={error} />
      )}

      <Section label="This execution">
        <div className="gm-inspect-stats">
          <StatCell
            label="duration"
            value={exec.durationMs !== undefined ? fmtDuration(exec.durationMs) : exec.status === 'running' ? 'running' : '—'}
          />
          {exec.usage !== undefined && (
            <>
              <StatCell label="tokens in" value={fmtTokens(exec.usage.inputTokens)} />
              <StatCell label="tokens out" value={fmtTokens(exec.usage.outputTokens)} />
            </>
          )}
          {firstTokenMs !== undefined && (
            <StatCell label="first token" value={fmtExactMs(firstTokenMs)} />
          )}
          {exec.chunks !== undefined && <StatCell label="chunks" value={String(exec.chunks)} />}
        </div>
        <div className="gm-inspect-kv">
          <span>started</span>
          <span className="gm-mono">{fmtClockMs(exec.startedTs)}</span>
          {exec.finishedTs !== undefined && (
            <>
              <span>finished</span>
              <span className="gm-mono">{fmtClockMs(exec.finishedTs)}</span>
            </>
          )}
          <span>instance</span>
          <span className="gm-mono">{exec.instanceId}</span>
          {exec.injected === true && (
            <>
              <span>result</span>
              <span className="gm-pill gm-pill--injected">injected from the debugger</span>
            </>
          )}
          {exec.streaming === true && (
            <>
              <span>execute</span>
              <span>streaming (observed, ungated mid-stream)</span>
            </>
          )}
        </div>
      </Section>

      {node.executions.length > 1 && (
        <Section label="Across all executions">
          <div className="gm-inspect-stats">
            <StatCell label="executions" value={String(stats.executions)} />
            <StatCell label="retries" value={String(stats.retries)} tone={stats.retries > 0 ? 'error' : undefined} />
            {stats.errors > 0 && <StatCell label="failed" value={String(stats.errors)} tone="error" />}
            <StatCell label="total" value={fmtDuration(stats.totalMs)} />
            <StatCell label="avg" value={fmtDuration(stats.avgMs)} />
            <StatCell label="slowest" value={fmtDuration(stats.maxMs)} />
            {stats.tokensIn + stats.tokensOut > 0 && (
              <>
                <StatCell label="tokens" value={`${fmtTokens(stats.tokensIn)}→${fmtTokens(stats.tokensOut)}`} />
                <StatCell label="est. cost" value={fmtCost(stats.estCostUsd)} tone="dim" />
              </>
            )}
          </div>
        </Section>
      )}

      <Section label="Input" copy={() => toJson(exec.input)}>
        <JsonTree value={exec.input} rootPath="input" />
      </Section>

      {exec.output !== undefined && (
        <Section label="Output" copy={() => toJson(exec.output)}>
          <JsonTree value={exec.output} rootPath="output" />
        </Section>
      )}

      {streamed !== '' && (
        <Section label="Stream" copy={() => streamed}>
          <pre className="gm-stream nowheel">{streamed}</pre>
        </Section>
      )}

      {tokens.reasoning !== '' && (
        <Section label="Reasoning" copy={() => tokens.reasoning}>
          <pre className="gm-stream gm-stream--reasoning nowheel">{tokens.reasoning}</pre>
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
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(stored) && stored >= MIN_WIDTH ? Math.min(stored, MAX_WIDTH) : 392;
    } catch {
      return 392;
    }
  });
  const dragging = useRef(false);

  const onDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - event.clientX));
      setWidth(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // width is per-session only when storage is blocked
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [width]);

  if (node === undefined) return null;
  const status = nodeStatus(node);
  const idx = Math.max(0, Math.min(instanceIdx ?? node.executions.length - 1, node.executions.length - 1));
  const exec = node.executions[idx];

  return (
    <aside className="gm-panel gm-inspector" style={{ width }} aria-label="Node inspector">
      <div
        className="gm-panel-resize"
        onMouseDown={onDragStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
      />
      <header className="gm-inspect-head">
        <span className={`gm-kind-badge gm-kind-badge--${node.kind}`}>{node.kind}</span>
        <span className="gm-node-title" style={{ fontSize: 14, flex: 1 }}>
          {node.name}
        </span>
        <StatusPill status={status} />
        <button
          className="gm-iconbtn"
          onClick={() => useUiStore.getState().selectNode(runId, undefined)}
          title="Close (esc)"
          aria-label="Close inspector"
        >
          <IconClose />
        </button>
      </header>

      <div className="gm-inspect-id">
        <span className="gm-mono" title={node.nodeId}>
          {node.nodeId}
        </span>
        <button
          className="gm-copy"
          title="Copy a deep link to this node"
          onClick={() => void copyText(deepLink(runId, nodeId))}
        >
          <IconLink width={11} height={11} /> link
        </button>
      </div>

      <div className="gm-inspect-body">
        {node.executions.length > 1 && (
          <div className="gm-inspect-execs">
            <span className="gm-section-label">Execution</span>
            <div className="gm-exec-strip">
              {node.executions.map((e, i) => (
                <button
                  key={`${e.instanceId}-${i}`}
                  className={`gm-exec-chip gm-exec-chip--${e.status}${i === idx ? ' gm-exec-chip--on' : ''}`}
                  title={`${e.instanceId} — ${e.status}${e.durationMs !== undefined ? ` · ${fmtDuration(e.durationMs)}` : ''}`}
                  onClick={() => setInstanceIdx(i)}
                >
                  #{i + 1}
                  {e.durationMs !== undefined && (
                    <span className="gm-exec-chip-ms">{fmtDuration(e.durationMs)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {exec === undefined ? (
          <div className="gm-inspect-empty">
            Not executed yet — this node is known from <code>graph.hint</code>. It will light up
            the moment your agent calls it.
          </div>
        ) : (
          <ExecutionDetails runId={runId} node={node} exec={exec} execIndex={idx} />
        )}
      </div>
    </aside>
  );
}
