/**
 * "Why this held", for the 0.6.0 holds (contract C4) — rendered at the top of
 * the inspector while the gate is held, above the decision row, like the
 * repeat loop's block (InspectorPanel's LoopEvidence) it sits beside:
 *
 *  - cycle         the calls of one lap, in order, each a jump to its node,
 *                  with the arguments it keeps sending;
 *  - error-repeat  the error the calls share (error text is never redacted)
 *                  and the arguments of each failed call — the evidence that
 *                  changing them did not help;
 *  - smart holds   what the rule saw (`smart.detail`, value-free), what each
 *                  verb does here, and how to turn the rule off.
 *
 * Returns nothing for a repeat loop (LoopEvidence owns it) or an ordinary gate.
 */
import { useMemo } from 'react';
import { REDACTED } from '../lib/editArgs.js';
import { useTokenSnapshot } from '../hooks/useTokenSnapshot.js';
import { heldExecOf, holdBannerText, holdHint, truncationCause } from '../store/holds.js';
import { cycleLap, errorStreak, errorStreakArguments } from '../store/loop.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import type { NodeState, Pause } from '../store/types.js';
import { IconAlert } from './Icons.js';
import { JsonTree } from './JsonTree.js';

function HiddenArgs({ kind }: { kind: NodeState['kind'] }) {
  return (
    <span className="gm-chip gm-chip--tiny" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      hidden by {kind === 'tool' ? 'GRAPHMIND_HIDE_TOOL_ARGS or GRAPHMIND_HIDE_INPUTS' : 'GRAPHMIND_HIDE_INPUTS'}
    </span>
  );
}

function Args({ value, kind, path }: { value: unknown; kind: NodeState['kind']; path: string }) {
  return (
    <div className="gm-why-input nowheel">
      {value === REDACTED ? (
        <HiddenArgs kind={kind} />
      ) : (
        <JsonTree value={value} initialDepth={1} rootPath={path} searchable={false} />
      )}
    </div>
  );
}

function jumpTo(runId: string, nodeId: string): void {
  const ui = useUiStore.getState();
  ui.selectNode(runId, nodeId);
  ui.requestFocus(nodeId);
}

function CycleEvidence({ runId, node, pause }: { runId: string; node: NodeState; pause: Pause }) {
  // The lap is fixed once the gate opens: every call in it started before.
  const { lap, title } = useMemo(() => {
    const run = useRunStore.getState().runs[runId];
    return {
      lap: run === undefined ? [] : cycleLap(run, node, pause),
      title: holdBannerText(node, pause, false, run) ?? '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the lap cannot change during the hold
  }, [runId, pause]);
  const loop = pause.loop;
  const laps = loop?.laps ?? loop?.repeats ?? 0;
  const period = loop?.period ?? lap.length;
  return (
    <section className="gm-why gm-loop" aria-label="Loop detected" data-testid="cycle-evidence">
      <div className="gm-why-head gm-why-head--sentence">
        <IconAlert width={13} height={13} />
        <span>{title}</span>
      </div>
      <div className="gm-pause-note gm-loop-note">
        The model went round the same {period > 0 ? `${period} calls` : 'calls'} {laps} times, sending
        the same arguments and getting the same results back every round — it is not getting anywhere.
        Continue runs round {laps + 1} anyway; Inject hands the model a different result; Abort stops
        the run.
      </div>
      {lap.length > 0 && (
        <>
          <div className="gm-why-label">One round</div>
          <ol className="gm-loop-calls">
            {lap.map((call, i) => (
              <li
                key={`${call.node.nodeId}-${call.seq}`}
                className={`gm-loop-call${i === 0 ? ' gm-loop-call--current' : ''}`}
                data-testid="lap-call"
              >
                <div className="gm-inspect-kv gm-loop-kv">
                  <span>{i + 1}</span>
                  <span>
                    <button
                      className="gm-why-chip"
                      onClick={() => jumpTo(runId, call.node.nodeId)}
                      title={`Jump to ${call.node.nodeId}`}
                    >
                      {call.node.name}
                    </button>
                    {i === 0 && <span className="gm-pill gm-pill--paused gm-loop-pill">held here, round {laps + 1}</span>}
                  </span>
                </div>
                <Args value={call.exec.input} kind={call.node.kind} path={`input#${i + 1}`} />
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="gm-pause-note gm-loop-note">
        Polling on purpose? Add {lap.length > 0 ? 'these tools' : 'the tools'} to{' '}
        <code>GRAPHMIND_LOOP_ALLOW</code> (or <code>loopGuard.allowNodes</code>), or set{' '}
        <code>GRAPHMIND_ON_LOOP=warn</code> to log instead of holding.
      </div>
    </section>
  );
}

function ErrorRepeatEvidence({ node, pause }: { node: NodeState; pause: Pause }) {
  const calls = useMemo(() => errorStreak(node, pause.loop), [node, pause.loop]);
  const args = errorStreakArguments(calls);
  const error = [...calls].reverse().find((c) => c.error !== undefined)?.error ?? node.lastError;
  const title = holdBannerText(node, pause) ?? '';
  const editable = pause.editable === true;
  return (
    <section className="gm-why gm-loop" aria-label="Repeated error" data-testid="error-repeat-evidence">
      <div className="gm-why-head gm-why-head--sentence">
        <IconAlert width={13} height={13} />
        <span>{title}</span>
      </div>
      {error !== undefined && (
        <div className="gm-why-error">
          <span className="gm-why-error-name">{error.name}</span>
          <span className="gm-why-error-message">{error.message}</span>
        </div>
      )}
      <div className="gm-pause-note gm-loop-note">
        {node.name} failed {pause.loop?.repeats ?? calls.length} times in a row with the same error
        {args === 'varied' ? ', although the arguments changed' : ''} — trying again the same way is
        unlikely to help. Continue runs it anyway;{' '}
        {editable ? 'Edit arguments or Inject can break the streak' : 'Inject can break the streak'}; Abort
        stops the run.
      </div>
      {calls.length > 0 && (
        <>
          <div className="gm-why-label">The arguments of each failed call</div>
          <ol className="gm-loop-calls">
            {calls.map((call) => {
              const index = node.executions.indexOf(call) + 1;
              return (
                <li key={`${call.instanceId}-${index}`} className="gm-loop-call" data-testid="error-call">
                  <div className="gm-inspect-kv gm-loop-kv">
                    <span>#{index}</span>
                    <span>{call.status}</span>
                  </div>
                  <Args value={call.input} kind={node.kind} path={`input#${index}`} />
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

/** The LLM step's recorded finish reason and cut-off tool calls (C1 output shape), when present. */
function truncatedCalls(output: unknown): { reason?: string; calls: { name: string; text?: string }[] } {
  if (output === null || typeof output !== 'object') return { calls: [] }; // incl. the placeholder string
  const record = output as Record<string, unknown>;
  const raw = record['rawFinishReason'];
  const normalized = record['finishReason'];
  const reason = typeof raw === 'string' ? raw : typeof normalized === 'string' ? normalized : undefined;
  const calls: { name: string; text?: string }[] = [];
  const list = record['toolCalls'];
  if (Array.isArray(list)) {
    for (const item of list.slice(0, 8)) {
      if (item === null || typeof item !== 'object') continue;
      const call = item as Record<string, unknown>;
      const name = typeof call['name'] === 'string' ? call['name'] : '?';
      const text = typeof call['inputText'] === 'string' ? call['inputText'] : undefined;
      calls.push(text !== undefined ? { name, text } : { name });
    }
  }
  return reason !== undefined ? { reason, calls } : { calls };
}

function SmartEvidence({ runId, node, pause }: { runId: string; node: NodeState; pause: Pause }) {
  // Streamed tool-call arguments: while the hold is open the step's result
  // (node.finished) has not arrived yet — every adapter but LangGraph gates
  // before it — so what the model streamed is all there is to show.
  const tokens = useTokenSnapshot(runId, node.nodeId);
  const smart = pause.smart;
  if (smart === undefined) return null;
  const title = holdBannerText(node, pause) ?? '';
  const exec = heldExecOf(node, pause);
  const recorded = exec?.output !== undefined;
  const truncated = smart.rule === 'truncated-tool-call' ? truncatedCalls(exec?.output) : { calls: [] };
  const cause = smart.rule === 'truncated-tool-call' ? truncationCause(node, pause) : undefined;
  const finishReason = truncated.reason ?? cause;
  const isLatest = exec !== undefined && node.executions[node.executions.length - 1] === exec;
  const streamedArgs =
    smart.rule === 'truncated-tool-call' && !recorded && isLatest && tokens.toolArgs !== '' ? tokens.toolArgs : undefined;
  return (
    <section
      className="gm-why gm-loop"
      aria-label="Smart breakpoint"
      data-testid="smart-evidence"
      data-rule={smart.rule}
    >
      <div className="gm-why-head gm-why-head--sentence">
        <IconAlert width={13} height={13} />
        <span>{title}</span>
      </div>
      {smart.detail !== undefined && (
        <div className="gm-inspect-kv gm-loop-kv">
          <span>what it saw</span>
          <span data-testid="smart-detail">{smart.detail}</span>
        </div>
      )}
      {finishReason !== undefined && (
        <div className="gm-inspect-kv gm-loop-kv">
          <span>finish reason</span>
          <span className="gm-mono">{finishReason}</span>
        </div>
      )}
      {truncated.calls.map((call, i) => (
        <div key={`${call.name}-${i}`}>
          <div className="gm-why-label">The tool call it was writing: {call.name}</div>
          {call.text !== undefined && (
            <pre className="gm-why-stack nowheel">{call.text === REDACTED ? 'hidden' : call.text}</pre>
          )}
        </div>
      ))}
      {streamedArgs !== undefined && (
        <div>
          <div className="gm-why-label">The tool call it was writing (arguments streamed so far)</div>
          <pre className="gm-why-stack nowheel">{streamedArgs}</pre>
        </div>
      )}
      {smart.rule === 'truncated-tool-call' && !recorded && streamedArgs === undefined && (
        <div className="gm-pause-note" data-testid="smart-not-recorded">
          The cut-off call is recorded with the step&apos;s result, once the gate is released.
        </div>
      )}
      {smart.rule === 'error-result' && !recorded && (
        <div className="gm-pause-note" data-testid="smart-not-recorded">
          The result itself is not shown yet: the app records it when the gate is released. What it saw
          (above) names its shape.
        </div>
      )}
      <div className="gm-pause-note gm-loop-note">{holdHint(pause, node)}</div>
    </section>
  );
}

export function HoldEvidence({ runId, node, pause }: { runId: string; node: NodeState; pause: Pause }) {
  if (!pause.active) return null;
  if (pause.reason === 'loop') {
    if (pause.loop?.kind === 'cycle') return <CycleEvidence runId={runId} node={node} pause={pause} />;
    if (pause.loop?.kind === 'error-repeat') return <ErrorRepeatEvidence node={node} pause={pause} />;
    return null; // repeat: InspectorPanel's LoopEvidence
  }
  if (pause.smart !== undefined) return <SmartEvidence runId={runId} node={node} pause={pause} />;
  return null;
}

/** Is this the repeat kind (or a 0.5 loop hold), which LoopEvidence renders? */
export function isRepeatLoop(pause: Pause): boolean {
  return pause.reason === 'loop' && (pause.loop?.kind === undefined || pause.loop.kind === 'repeat');
}
