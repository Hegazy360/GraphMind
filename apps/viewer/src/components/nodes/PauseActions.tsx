/**
 * The resume action row — Continue / Step / Retry / Inject / Abort.
 *
 * This is the frame the whole product exists for, so it is rendered in two
 * places from one implementation:
 *
 *  - `card`  — inside the held node, where the eye already is;
 *  - `panel` — pinned to the bottom of the inspector, where the error, the
 *              input and the sibling context are.
 *
 * The panel copy exists because of a specific papercut: the inspector is an
 * overlay, so the natural flow — read *why* it failed, then inject a fix —
 * ended with the inject button underneath the panel that was explaining the
 * failure. Now the decision and the evidence are in the same column, and the
 * inject editor opens inline where nothing can cover it.
 *
 * Every button carries its single-key shortcut as an `aria-hidden` hint, so
 * the accessible name stays exactly the verb.
 *
 * 0.6.0: an editable pause (`exec.paused.editable`, never an LLM step) adds
 * "Edit arguments…" (e). The editor needs room, so it opens in the panel
 * copy only — the card's button selects the node and asks the panel to open
 * it. A refusal the app sent for this gate (`exec.refused`) is said in plain
 * words under the panel's row whenever the editor is not already showing it. The
 * label names every kind of hold the SDK reports: loop (repeat, cycle,
 * error-repeat) and smart (error-result, truncated-tool-call).
 *
 * The HUB can answer a resume too, before it ever reaches the app: another
 * resume got there first (`pause-taken` — another tab, `graphmind resume`),
 * the pause is no longer held, this tab's credential may not do that. That
 * reply is said under the panel's row, and on the card — where a click from
 * the canvas lands — as a note floating below it (the card's height is fixed
 * by the layout), dismissable. The answer to an edit belongs to the editor:
 * the card leaves it there, and the panel's row says it only while the editor
 * is closed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isExportedRun } from '../../connection/FixtureConnection.js';
import { TOKENLESS_NOTE, controlAllows } from '../../lib/control.js';
import { canEditArgs, latestRefusal, refusalText } from '../../lib/editArgs.js';
import { injectAndResume, pausePointLabel, resumeGate, stepGate } from '../../lib/gate.js';
import { hubReplyText, replyAnswers } from '../../lib/hubReply.js';
import { useEditStore } from '../../store/editStore.js';
import { holdBannerText, holdHint } from '../../store/holds.js';
import { useRunStore } from '../../store/runStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { latestExecution, type NodeState, type Pause } from '../../store/types.js';
import { EditArgsEditor } from './EditArgsEditor.js';

export type PauseVariant = 'card' | 'panel';

export interface PauseActionsProps {
  runId: string;
  node: NodeState;
  pause: Pause;
  variant: PauseVariant;
  /** Move focus to Continue when the gate opens (the card copy does this). */
  autoFocus?: boolean;
  /**
   * Suppress the error line. The inspector already leads with a full "why
   * this failed" block; repeating the same sentence 300px lower is noise,
   * not emphasis.
   */
  hideError?: boolean;
}

/** Why every debugger control is dead in an exported run. */
const RECORDED_HINT =
  'This gate held execution while the run was recorded. An exported run is a frozen record — ' +
  'there is nothing left to resume.';

const LIVE_HINT =
  'Held by the debugger. Note: user-configured totalMs/stepMs/chunkMs timeouts can still abort a ' +
  'run during a long hold (per-tool toolMs is neutralized).';

function Key({ children }: { children: string }) {
  return (
    <span className="gm-kbd gm-kbd--inline" aria-hidden>
      {children}
    </span>
  );
}

export function PauseActions({
  runId,
  node,
  pause,
  variant,
  autoFocus,
  hideError,
}: PauseActionsProps) {
  const [injecting, setInjecting] = useState(false);
  /** The argument editor (panel copy only). */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  /** Why the last inject was refused (e.g. it still contained the redaction placeholder). */
  const [injectRefused, setRefusal] = useState<string | undefined>(undefined);
  const continueRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const injectRequest = useUiStore((s) => s.injectRequest);
  const editorRequest = useEditStore((s) => s.editorRequest);
  const reply = useEditStore((s) => s.replies[pause.pauseId]);
  const pendingEdit = useEditStore((s) => s.pending[pause.pauseId]);
  const control = useUiStore((s) => s.control);

  const exec = latestExecution(node);
  const error = exec?.error ?? node.lastError;
  const replayed = isExportedRun();
  const editable = canEditArgs(node, pause, replayed, control);
  // Offer only what the server accepts from this tab (no token: continue,
  // retry and abort — inject and step would come back refused).
  const canInject = controlAllows(control, 'inject');
  const canStep = controlAllows(control, 'debug');
  const refusal = latestRefusal(pause);
  // The hub's answer to this tab's latest resume for this pause. When it
  // answers the edit in flight, the open editor says it (in its own words).
  const replyToEdit = pendingEdit !== undefined && replyAnswers(reply, pendingEdit);
  const shownReply =
    !replayed &&
    reply !== undefined &&
    (reply.runId === undefined || reply.runId === runId) &&
    !(replyToEdit && (variant === 'card' || (editing && editable))) &&
    !(variant === 'card' && injecting)
      ? reply
      : undefined;

  const prefill = useMemo(() => {
    const shape = exec?.output !== undefined && exec.output !== null ? exec.output : exec?.input;
    try {
      return JSON.stringify(shape ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [exec]);

  const openInject = () => {
    setDraft(prefill);
    setInvalid(false);
    setRefusal(undefined);
    setEditing(false);
    setInjecting(true);
  };

  // The card has no room for the editor: its button opens the panel's copy,
  // exactly like `e` from the keyboard does.
  const openEditor = () => {
    if (variant === 'card') {
      useUiStore.getState().selectNode(runId, node.nodeId);
      useEditStore.getState().requestEditor(pause.pauseId);
      return;
    }
    setInjecting(false);
    setEditing((open) => !open);
  };

  // A released gate's draft and pending request are history: drop them when
  // the row goes away with the pause (a pauseId is never reused).
  useEffect(() => {
    const pauseId = pause.pauseId;
    return () => {
      const current = useRunStore.getState().runs[runId]?.pauses[pauseId];
      if (current === undefined || !current.active) useEditStore.getState().forgetPause(pauseId);
    };
  }, [runId, pause.pauseId]);

  // `e` / the card's button: the panel for this pause opens its editor and
  // consumes the request, so a later remount of the panel does not reopen it.
  useEffect(() => {
    if (variant !== 'panel' || editorRequest === undefined) return;
    if (editorRequest.pauseId !== pause.pauseId) return;
    useEditStore.getState().consumeEditorRequest(editorRequest.nonce);
    if (!editable) return;
    setInjecting(false);
    setEditing(true);
  }, [editorRequest, pause.pauseId, variant, editable]);

  // `i` from anywhere opens the editor on whichever copy of the row is the
  // one the user is looking at: the panel when the inspector is open, the
  // card otherwise. The store carries the nonce so a repeat press re-opens.
  useEffect(() => {
    if (injectRequest === undefined) return;
    if (injectRequest.pauseId !== pause.pauseId) return;
    if (injectRequest.variant !== variant) return;
    if (!canInject) return;
    setDraft(prefill);
    setInvalid(false);
    setRefusal(undefined);
    setEditing(false);
    setInjecting(true);
  }, [injectRequest, pause.pauseId, variant, prefill, canInject]);

  useEffect(() => {
    if (injecting) editorRef.current?.focus({ preventScroll: true });
  }, [injecting]);

  // A gate opening should leave the keyboard on the decision, not wherever it
  // happened to be — but never steal a text field or an open palette.
  useEffect(() => {
    if (autoFocus !== true || replayed) return;
    const active = document.activeElement as HTMLElement | null;
    const busy =
      useUiStore.getState().paletteOpen ||
      (active !== null &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable));
    if (busy) return;
    continueRef.current?.focus({ preventScroll: true });
  }, [autoFocus, pause.pauseId, replayed]);

  const applyInject = () => {
    let output: unknown;
    try {
      output = JSON.parse(draft);
    } catch {
      setInvalid(true);
      return;
    }
    const result = injectAndResume(runId, pause.pauseId, output);
    if (!result.ok) {
      // Keep the editor open and say why — closing it silently is how a
      // refused inject used to look exactly like a successful one.
      setRefusal(result.reason);
      return;
    }
    setRefusal(undefined);
    setInjecting(false);
  };

  const where = pausePointLabel(pause.point);
  const pointLabel = replayed ? `Was held ${where}` : `Paused ${where}`;
  // A named hold (loop, smart breakpoint) says why it held — the label
  // becomes the reason, in normal case because it carries the tool's name.
  // A cycle names its lap, read off the run once per hold: the calls of a
  // lap all started before the gate opened.
  const holdLabel = useMemo(
    () => holdBannerText(node, pause, replayed, useRunStore.getState().runs[runId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- node identity changes per event; the lap does not
    [pause, node.name, node.executions.length, replayed, runId],
  );

  return (
    <>
      {holdLabel !== undefined ? (
        <div
          className={`gm-pause-label gm-pause-label--loop${
            variant === 'card' ? ' gm-pause-label--clamp' : ''
          }`}
          title={replayed ? RECORDED_HINT : holdHint(pause) ?? LIVE_HINT}
          data-testid="hold-label"
        >
          <span className="gm-dot gm-dot--paused" />
          <span className="gm-pause-label-text">{holdLabel}</span>
        </div>
      ) : (
        <div
          className="gm-pause-label"
          title={replayed ? RECORDED_HINT : LIVE_HINT}
        >
          <span className="gm-dot gm-dot--paused" />
          {pointLabel}
        </div>
      )}
      {pause.point === 'error' && error !== undefined && hideError !== true && (
        <div className="gm-pause-error" title={`${error.name}: ${error.message}`}>
          {error.name}: {error.message}
        </div>
      )}
      {replayed ? (
        <div className="gm-pause-note">Recorded hold — an exported run cannot be resumed.</div>
      ) : (
        <div className={variant === 'card' ? 'gm-actions' : 'gm-actions gm-actions--wrap'}>
          <button
            ref={continueRef}
            className="gm-action gm-action--primary"
            onClick={() => resumeGate(runId, pause.pauseId, 'continue')}
            title="Release this gate and run on (c)"
          >
            Continue
            <Key>c</Key>
          </button>
          {canStep && (
            <button
              className="gm-action"
              onClick={() => stepGate(runId, pause.pauseId)}
              title="Resume and pause at the next gate (s)"
            >
              Step
              <Key>s</Key>
            </button>
          )}
          <button
            className="gm-action"
            onClick={() => resumeGate(runId, pause.pauseId, 'retry')}
            title="Run this call again (r)"
          >
            Retry
            <Key>r</Key>
          </button>
          {canInject && (
            <button
              className="gm-action"
              onClick={openInject}
              title="Substitute a result and continue (i)"
              aria-expanded={injecting}
            >
              Inject…
              <Key>i</Key>
            </button>
          )}
          {editable && (
            <button
              className="gm-action"
              onClick={openEditor}
              title={
                variant === 'card'
                  ? 'Run this call with changed arguments — opens the editor in the inspector (e)'
                  : 'Run this call with changed arguments (e)'
              }
              {...(variant === 'panel' ? { 'aria-expanded': editing } : {})}
            >
              {/* The card's row has room for two lines of verbs, not three. */}
              {variant === 'card' ? 'Edit args…' : 'Edit arguments…'}
              <Key>e</Key>
            </button>
          )}
          <button
            className="gm-action gm-action--danger"
            onClick={() => resumeGate(runId, pause.pauseId, 'abort')}
            title="Abort the run — deliberately has no shortcut"
          >
            Abort
          </button>
        </div>
      )}

      {!replayed && variant === 'panel' && control?.principal === 'anonymous' && (
        <div className="gm-pause-note" data-testid="pause-tokenless">
          {TOKENLESS_NOTE}
        </div>
      )}

      {!replayed && variant === 'panel' && pause.editable === true && pause.heldAmbiguous === true && (
        <div className="gm-pause-note" data-testid="pause-edit-ambiguous">
          More than one {node.name} call is running and the app did not say which one is held, so its
          arguments cannot be edited here. Continue, Retry and Inject still work.
        </div>
      )}

      {shownReply !== undefined &&
        (variant === 'card' ? (
          <div
            className="gm-pause-note gm-inject-refusal gm-pause-reply--float nowheel"
            role="status"
            data-testid="pause-reply"
            onClick={(e) => e.stopPropagation()}
          >
            <span>{hubReplyText(shownReply, control, 'resume')}</span>
            <button
              className="gm-pause-reply-close"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => useEditStore.getState().clearReply(pause.pauseId)}
            >
              ×
            </button>
          </div>
        ) : (
          <div className="gm-pause-note gm-inject-refusal" role="status" data-testid="pause-reply">
            {hubReplyText(shownReply, control, replyToEdit ? 'arguments' : 'resume')}
          </div>
        ))}

      {!replayed && variant === 'panel' && refusal !== undefined && !editing && (
        <div className="gm-pause-note gm-inject-refusal" role="status" data-testid="pause-refusal">
          Refused — the gate is still held.{' '}
          {refusalText(
            refusal.code,
            refusal.message,
            refusal.requestId?.startsWith('edit-') === true ? 'arguments' : 'value',
          )}
        </div>
      )}

      {editing && editable && variant === 'panel' && (
        <EditArgsEditor runId={runId} node={node} pause={pause} onClose={() => setEditing(false)} />
      )}

      {injecting && canInject && (
        <div
          className={variant === 'card' ? 'gm-inject nowheel' : 'gm-inject gm-inject--panel nowheel'}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="gm-section-label gm-inject-title">Inject output for {node.name}</div>
          <textarea
            ref={editorRef}
            className={invalid ? 'gm-invalid' : ''}
            value={draft}
            spellCheck={false}
            aria-label={`Replacement output for ${node.name}, as JSON`}
            aria-invalid={invalid}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
              setRefusal(undefined);
            }}
            onKeyDown={(e) => {
              // Escape belongs to the editor — the app's Escape would clear
              // the node selection and close the panel out from under it.
              // Everything else is allowed through: the app's own handler
              // already ignores single-key shortcuts while a text field has
              // focus, and swallowing the lot here is what used to make ⌘K
              // do nothing while the inject editor was open.
              if (e.key === 'Escape') {
                e.stopPropagation();
                setInjecting(false);
                return;
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                applyInject();
              }
            }}
          />
          {injectRefused !== undefined && (
            <div className="gm-pause-note gm-inject-refusal" role="alert">
              {injectRefused}
            </div>
          )}
          <div className="gm-actions gm-inject-actions">
            <button className="gm-action gm-action--primary" onClick={applyInject}>
              {invalid ? 'Invalid JSON' : 'Inject & resume'}
            </button>
            <button className="gm-action" onClick={() => setInjecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
