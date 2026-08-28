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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isExportedRun } from '../../connection/FixtureConnection.js';
import { injectAndResume, pausePointLabel, resumeGate, stepGate } from '../../lib/gate.js';
import { useUiStore } from '../../store/uiStore.js';
import { latestExecution, type NodeState, type Pause } from '../../store/types.js';

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
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const injectRequest = useUiStore((s) => s.injectRequest);

  const exec = latestExecution(node);
  const error = exec?.error ?? node.lastError;
  const replayed = isExportedRun();

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
    setInjecting(true);
  };

  // `i` from anywhere opens the editor on whichever copy of the row is the
  // one the user is looking at: the panel when the inspector is open, the
  // card otherwise. The store carries the nonce so a repeat press re-opens.
  useEffect(() => {
    if (injectRequest === undefined) return;
    if (injectRequest.pauseId !== pause.pauseId) return;
    if (injectRequest.variant !== variant) return;
    setDraft(prefill);
    setInvalid(false);
    setInjecting(true);
  }, [injectRequest, pause.pauseId, variant, prefill]);

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
    injectAndResume(runId, pause.pauseId, output);
    setInjecting(false);
  };

  const where = pausePointLabel(pause.point);
  const pointLabel = replayed ? `Was held ${where}` : `Paused ${where}`;

  return (
    <>
      <div
        className="gm-pause-label"
        title={replayed ? RECORDED_HINT : LIVE_HINT}
      >
        <span className="gm-dot gm-dot--paused" />
        {pointLabel}
      </div>
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
          <button
            className="gm-action"
            onClick={() => stepGate(runId, pause.pauseId)}
            title="Resume and pause at the next gate (s)"
          >
            Step
            <Key>s</Key>
          </button>
          <button
            className="gm-action"
            onClick={() => resumeGate(runId, pause.pauseId, 'retry')}
            title="Run this call again (r)"
          >
            Retry
            <Key>r</Key>
          </button>
          <button
            className="gm-action"
            onClick={openInject}
            title="Substitute a result and continue (i)"
            aria-expanded={injecting}
          >
            Inject…
            <Key>i</Key>
          </button>
          <button
            className="gm-action gm-action--danger"
            onClick={() => resumeGate(runId, pause.pauseId, 'abort')}
            title="Abort the run — deliberately has no shortcut"
          >
            Abort
          </button>
        </div>
      )}

      {injecting && (
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
