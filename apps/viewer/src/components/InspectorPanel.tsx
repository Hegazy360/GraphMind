/**
 * The inspector. When a run breaks at 3am this is the panel you read, so it
 * leads with the answer: a "why this failed" block that pins the error, its
 * stack, the exact input that produced it, and what ran around it — then the
 * numbers (duration, tokens, retries, estimated spend), then the payloads.
 *
 * When the node it is describing is *held*, the panel also owns the decision:
 * a pinned footer with the same Continue / Step / Retry / Inject / Abort row
 * that the card carries. That is not duplication for its own sake — the panel
 * is an overlay, and the natural flow (read why it failed, then inject a fix)
 * used to end with the inject button underneath this very panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo } from '@graphmind-ai/schema';
import { copyText, deepLink } from '../lib/commands.js';
import { fmtRanHeld, heldMsOf, ranMs } from '../lib/duration.js';
import { kindMeta } from '../lib/kinds.js';
import {
  fmtClockMs,
  fmtCost,
  fmtDuration,
  fmtExactMs,
  fmtTokens,
} from '../lib/format.js';
import { useTokenSnapshot } from '../hooks/useTokenSnapshot.js';
import { identicalCalls, loopBannerText } from '../store/loop.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useRunStore } from '../store/runStore.js';
import { failureContext, nodeStats } from '../store/stats.js';
import { useUiStore } from '../store/uiStore.js';
import { nodeStatus, resumerLabel, type NodeExecution, type NodeState, type Pause } from '../store/types.js';
import { EditedArgs } from './EditedArgs.js';
import { HoldEvidence, isRepeatLoop } from './HoldEvidence.js';
import { IconAlert, IconClose, IconLink } from './Icons.js';
import { JsonTree } from './JsonTree.js';
import { KindGlyph } from './KindMark.js';
import { PauseActions } from './nodes/PauseActions.js';
import { StatusPill } from './nodes/nodeParts.js';
import { detailCells, inputLabel, inputTitle, usageView } from '../lib/usage.js';

// ── W7: coarse redaction ─────────────────────────────────────────────────────
// Under GRAPHMIND_HIDE_INPUTS / _OUTPUTS / _TOOL_ARGS / _TOOL_RESULTS the
// instrumented app replaces the whole field with this placeholder before it
// leaves the process, so the viewer has nothing to show — say so, instead of
// rendering a JSON tree whose only leaf is the string "__REDACTED__".
const REDACTED_PLACEHOLDER = '__REDACTED__';

/** Which switch(es) can have hidden this field on a node of this kind. */
function hiddenBySwitch(field: 'input' | 'output', kind: NodeState['kind']): string {
  const general = field === 'input' ? 'GRAPHMIND_HIDE_INPUTS' : 'GRAPHMIND_HIDE_OUTPUTS';
  const toolOnly = field === 'input' ? 'GRAPHMIND_HIDE_TOOL_ARGS' : 'GRAPHMIND_HIDE_TOOL_RESULTS';
  return kind === 'tool' ? `${toolOnly} or ${general}` : general;
}

function RedactedChip({ field, kind }: { field: 'input' | 'output'; kind: NodeState['kind'] }) {
  return (
    <span
      className="gm-chip gm-chip--tiny"
      data-testid={`redacted-${field}`}
      // `.gm-chip` is nowrap; the tool variants name two env vars and ran
      // ~30px past the right edge of the inspector at its default width.
      style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%' }}
      title="The instrumented app replaced this value before it left the process. Unset the switch and re-run to record it."
    >
      hidden by {hiddenBySwitch(field, kind)}
    </span>
  );
}
// ── end W7 block ─────────────────────────────────────────────────────────────

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const WIDTH_KEY = 'graphmind.inspectorWidth';

/**
 * Below this the panel stops being a pane and becomes a full-width overlay
 * (index.css owns the other half of this number — keep them in step).
 */
const NARROW_QUERY = '(max-width: 860px)';

function mediaQuery(): MediaQueryList | undefined {
  return typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : undefined;
}

/** True only when the panel is actually sitting on top of the canvas. */
function overlaysCanvas(): boolean {
  return mediaQuery()?.matches === true;
}

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

function StatCell({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'error' | 'dim' | undefined;
  title?: string | undefined;
}) {
  return (
    <div
      className={`gm-inspect-stat${tone !== undefined ? ` gm-inspect-stat--${tone}` : ''}`}
      {...(title !== undefined && title !== '' ? { title } : {})}
    >
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
  error: ErrorInfo;
}) {
  // Derived per render, not per store notification: `failureContext` builds a
  // fresh object every call, and a zustand selector that never returns a
  // stable reference is an infinite render loop.
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const context = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    return run === undefined ? { siblings: [] } : failureContext(run, node.nodeId);
  }, [runId, node.nodeId, statusVersion]);
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
        {exec.input === REDACTED_PLACEHOLDER ? (
          <RedactedChip field="input" kind={node.kind} />
        ) : (
          <JsonTree value={exec.input} initialDepth={1} rootPath="input" searchable={false} />
        )}
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
                {sibling.ranMs !== undefined && (
                  <span className="gm-why-chip-ms">{fmtDuration(sibling.ranMs)}</span>
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
  const usage = usageView(exec.usage);
  const firstTokenMs = timing === undefined ? undefined : Math.max(0, timing.firstTs - exec.startedTs);

  return (
    <>
      {error !== undefined && (
        <WhyItFailed runId={runId} node={node} exec={exec} error={error} />
      )}

      <Section label="This execution">
        <div className="gm-inspect-stats">
          <StatCell
            label={heldMsOf(exec) > 0 ? 'ran' : 'duration'}
            value={(() => {
              const ran = ranMs(exec);
              return ran !== undefined ? fmtDuration(ran) : exec.status === 'running' ? 'running' : '—';
            })()}
          />
          {heldMsOf(exec) > 0 && (
            <StatCell label="held" value={fmtDuration(heldMsOf(exec))} tone="dim" />
          )}
          {usage !== undefined && (
            <>
              <StatCell
                label={inputLabel(usage.basis)}
                value={fmtTokens(usage.inputTokens)}
                title={inputTitle(usage.basis)}
              />
              <StatCell label="tokens out" value={fmtTokens(usage.outputTokens)} />
              {detailCells(usage).map((cell) => (
                <StatCell key={cell.label} label={cell.label} value={cell.value} title={cell.title} tone="dim" />
              ))}
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
          {exec.edited !== undefined && (
            <>
              <span>arguments</span>
              <span className="gm-pill gm-pill--injected gm-pill--edited">edited from the debugger</span>
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
            <StatCell label="total ran" value={fmtDuration(stats.totalMs)} />
            <StatCell label="avg" value={fmtDuration(stats.avgMs)} />
            <StatCell label="slowest" value={fmtDuration(stats.maxMs)} />
            {stats.heldMs > 0 && <StatCell label="held" value={fmtDuration(stats.heldMs)} tone="dim" />}
            {stats.tokensIn + stats.tokensOut > 0 && (
              <>
                <StatCell
                  label={stats.tokenBasis === 'inclusive' || stats.tokenBasis === undefined ? 'tokens' : 'tokens (as reported)'}
                  value={`${fmtTokens(stats.tokensIn)}→${fmtTokens(stats.tokensOut)}`}
                  title={inputTitle(stats.tokenBasis)}
                />
                {detailCells(stats).map((cell) => (
                  <StatCell key={cell.label} label={cell.label} value={cell.value} title={cell.title} tone="dim" />
                ))}
                <StatCell label="est. cost" value={fmtCost(stats.estCostUsd)} tone="dim" />
              </>
            )}
          </div>
        </Section>
      )}

      {/* 0.6.0: what the model asked for beside what actually ran. */}
      <EditedArgs node={node} exec={exec} />

      <Section label="Input" copy={() => toJson(exec.input)}>
        {exec.input === REDACTED_PLACEHOLDER ? (
          <RedactedChip field="input" kind={node.kind} />
        ) : (
          <JsonTree value={exec.input} rootPath="input" />
        )}
      </Section>

      {exec.output !== undefined && (
        <Section label="Output" copy={() => toJson(exec.output)}>
          {exec.output === REDACTED_PLACEHOLDER ? (
            <RedactedChip field="output" kind={node.kind} />
          ) : (
            <JsonTree value={exec.output} rootPath="output" />
          )}
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

/**
 * Loop hold (W5): the "why this held" block. Rendered only while the held
 * gate's `reason` is `loop`. Lists the identical calls of the streak with
 * their outputs, so the developer sees the model asking the same question
 * and getting the same answer — the evidence that nothing new is being
 * learned — right above the decision row.
 */
/** Most recent releases listed per node. */
const MAX_RESUMES_SHOWN = 3;

/**
 * The audit line (0.6): who released each of this node's pauses — the
 * viewer, a coding agent (`graphmind resume`), or a tokenless socket — as the
 * server stamped it. Nothing here comes from the app.
 */
function ResumeHistory({ runId, nodeId }: { runId: string; nodeId: string }) {
  const pauses = useRunStore((s) => s.runs[runId]?.pauses);
  const resolved = useMemo(() => {
    if (pauses === undefined) return [];
    return Object.values(pauses)
      .filter((p): p is Pause => p !== undefined && p.nodeId === nodeId && !p.active && p.resolvedBy !== undefined)
      .sort((a, b) => (b.resolvedTs ?? 0) - (a.resolvedTs ?? 0))
      .slice(0, MAX_RESUMES_SHOWN);
  }, [pauses, nodeId]);
  if (resolved.length === 0) return null;
  return (
    <div className="gm-inspect-resumes">
      <span className="gm-section-label">Released</span>
      <div className="gm-resumed-list">
        {resolved.map((pause) => (
          <div key={pause.pauseId} data-testid="resumed-by">
            {pause.point} → {pause.resolvedAction ?? 'resumed'}
            {pause.resolvedEdited === true ? ' (edited input)' : ''} · resumed by{' '}
            <span className="gm-resumed-by">{resumerLabel(pause.resolvedBy ?? '')}</span>
            {pause.resolvedOperator !== undefined && <> ({pause.resolvedOperator})</>}
          </div>
        ))}
      </div>
    </div>
  );
}

function LoopEvidence({ node, pause }: { node: NodeState; pause: Pause }) {
  const loop = pause.loop;
  const calls = useMemo(() => identicalCalls(node, loop), [node, loop]);
  if (pause.reason !== 'loop' || loop === undefined) return null;
  const heldExec = calls.find((c) => c.current)?.exec ?? calls[calls.length - 1]?.exec;
  const finished = calls.filter((c) => !c.current && c.exec.output !== undefined);
  const allSame = finished.length > 1 && finished.slice(1).every((c) => c.sameOutputAsPrevious);
  const title = loopBannerText(node, pause) ?? `Loop: ${node.name} with identical arguments`;

  return (
    <section
      className="gm-why gm-loop"
      aria-label="Loop detected"
      data-testid="loop-evidence"
    >
      <div className="gm-why-head">
        <IconAlert width={13} height={13} />
        <span>{title}</span>
      </div>
      <div className="gm-pause-note gm-loop-note">
        The model asked for <strong>{node.name}</strong> with the same arguments {loop.repeats} times in a
        row{allSame ? ' and got the same answer back every time' : ''} — it is not learning anything new.
        Continue runs this call anyway; Inject hands the model a different result; Abort stops the run.
      </div>

      {heldExec !== undefined && (
        <>
          <div className="gm-why-label">The arguments it keeps sending</div>
          <div className="gm-why-input nowheel">
            <JsonTree value={heldExec.input} initialDepth={1} rootPath="input" searchable={false} />
          </div>
        </>
      )}

      <div className="gm-why-label">
        The {calls.length === 1 ? 'call' : `${calls.length} calls`} in this streak
      </div>
      <ol className="gm-loop-calls">
        {calls.map((call) => (
          <li
            key={`${call.exec.instanceId}-${call.index}`}
            className={`gm-loop-call${call.current ? ' gm-loop-call--current' : ''}`}
            data-testid="loop-call"
          >
            <div className="gm-inspect-kv gm-loop-kv">
              <span>#{call.index}</span>
              <span>
                {call.current ? (
                  <span className="gm-pill gm-pill--paused">this call — held</span>
                ) : (
                  <>
                    {call.exec.status}
                    {call.sameOutputAsPrevious && (
                      <span className="gm-pill gm-loop-pill">
                        same output as the call before
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
            {!call.current && call.exec.output !== undefined && (
              <div className="gm-why-input nowheel">
                <JsonTree
                  value={call.exec.output}
                  initialDepth={3}
                  rootPath={`output#${call.index}`}
                  searchable={false}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="gm-pause-note gm-loop-note">
        Polling on purpose? Add <code>{node.name}</code> to <code>loopGuard.allowNodes</code> or set{' '}
        <code>GRAPHMIND_LOOP_ALLOW={node.name}</code> (the only way under <code>graphmind mcp-proxy</code>),
        or set <code>GRAPHMIND_ON_LOOP=warn</code> to log instead of holding.
      </div>
    </section>
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
  const pause = useRunStore((s) => {
    const activeId = s.runs[runId]?.nodes[nodeId]?.activePauseId;
    return activeId === undefined ? undefined : s.runs[runId]?.pauses[activeId];
  });

  const onDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  // Tell the camera how much of the canvas this panel is *covering*.
  //
  // Docked (the normal case) that is nothing at all: the canvas element is
  // already narrower, so an inset would squeeze the frame twice. Only at
  // narrow widths, where the panel goes back to being a full-width overlay,
  // does the camera need to know. Published on open, on close, on a
  // breakpoint change and at the end of a resize drag — never per mousemove,
  // which would re-frame the graph sixty times a second.
  useEffect(() => {
    const publish = (): void => {
      useUiStore.getState().setInspectorWidth(overlaysCanvas() ? width : 0);
    };
    publish();
    const query = mediaQuery();
    query?.addEventListener('change', publish);
    return () => {
      query?.removeEventListener('change', publish);
      useUiStore.getState().setInspectorWidth(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drag end republishes explicitly
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
      useUiStore.getState().setInspectorWidth(overlaysCanvas() ? width : 0);
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
  const held = pause !== undefined && pause.active;

  return (
    <aside
      className={`gm-panel gm-inspector${held ? ' gm-inspector--held' : ''}`}
      style={{ width }}
      aria-label="Node inspector"
    >
      <div
        className="gm-panel-resize"
        onMouseDown={onDragStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
      />
      <header className="gm-inspect-head">
        <span
          className={`gm-kind-badge gm-kind--${node.kind}`}
          title={kindMeta(node.kind).hint}
        >
          <KindGlyph kind={node.kind} size={11} />
          {kindMeta(node.kind).label}
        </span>
        <span className="gm-node-title gm-inspect-name">{node.name}</span>
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
        {held && pause !== undefined && isRepeatLoop(pause) && (
          <LoopEvidence node={node} pause={pause} />
        )}
        <ResumeHistory runId={runId} nodeId={nodeId} />
        {/* 0.6.0 holds: cycle, error-repeat, smart breakpoints. */}
        {held && pause !== undefined && <HoldEvidence runId={runId} node={node} pause={pause} />}
        {node.executions.length > 1 && (
          <div className="gm-inspect-execs">
            <span className="gm-section-label">Execution</span>
            <div className="gm-exec-strip">
              {node.executions.map((e, i) => (
                <button
                  key={`${e.instanceId}-${i}`}
                  className={`gm-exec-chip gm-exec-chip--${e.status}${i === idx ? ' gm-exec-chip--on' : ''}`}
                  title={`${e.instanceId} — ${e.status}${e.durationMs !== undefined ? ` · ${fmtRanHeld(e)}` : ''}`}
                  onClick={() => setInstanceIdx(i)}
                >
                  #{i + 1}
                  {ranMs(e) !== undefined && (
                    <span className="gm-exec-chip-ms">{fmtDuration(ranMs(e) ?? 0)}</span>
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

      {held && pause !== undefined && (
        <footer className="gm-inspect-held" aria-label="Held at a gate">
          <PauseActions
            runId={runId}
            node={node}
            pause={pause}
            variant="panel"
            hideError={exec?.error !== undefined || node.lastError !== undefined}
          />
        </footer>
      )}
    </aside>
  );
}
