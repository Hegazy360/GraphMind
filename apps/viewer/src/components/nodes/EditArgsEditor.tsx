/**
 * "Edit arguments" (0.6.0, contract C2): run the held tool call with changed
 * arguments. Lives in the inspector's held-gate footer only — it needs the
 * room, and it belongs next to the error and the input it is fixing; the
 * card's button opens it there.
 *
 * The flow, in the order the user meets it:
 *   1. a JSON editor prefilled with the held instance's LIVE arguments — the
 *      recorded ones, or the last edit the app accepted for it (a retry
 *      re-runs that) — with the scope note: this call only, the model still
 *      sees what it asked for;
 *   2. a live diff of the top-level keys that changed — only those are sent,
 *      so a truncated or hidden value the user did not touch keeps its live
 *      value — and the reasons any change cannot be sent;
 *   3. "Run with 2 changes" (a `before` gate) / "Retry with 2 changes" (after
 *      or on error), separate from the row's plain Continue;
 *   4. the answer: the gate releases (the node gets an `edited` pill), or
 *      `exec.refused` comes back from the app — matched to this request by
 *      requestId — or the HUB answers instead (another resume took the pause
 *      first, it is no longer held, this tab may not edit: lib/hubReply.ts).
 *      Either is shown in plain words with the draft kept, ready to fix and
 *      retry. "No answer from the app yet" is only for real silence.
 *
 * Keyboard: ⌘/ctrl-Enter runs, Escape closes (and only closes — it must not
 * reach the app's Escape, which would close the inspector around it).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  answerFor,
  EDIT_ANSWER_TIMEOUT_MS,
  editBase,
  editPrefill,
  editShape,
  heldExecution,
  latestRefusal,
  newRequestId,
  planEdit,
  previewValue,
  refusalText,
  runLabel,
  SCOPE_NOTE,
  type ArgChange,
} from '../../lib/editArgs.js';
import { editAndResume } from '../../lib/gate.js';
import { hubReplyText } from '../../lib/hubReply.js';
import { useEditStore } from '../../store/editStore.js';
import { useRunStore } from '../../store/runStore.js';
import { useUiStore } from '../../store/uiStore.js';
import type { NodeState, Pause } from '../../store/types.js';

export interface EditArgsEditorProps {
  runId: string;
  node: NodeState;
  pause: Pause;
  onClose: () => void;
}

function ChangeRow({ change }: { change: ArgChange }) {
  const after = previewValue(change.after);
  return (
    <li className="gm-edit-change" data-testid="edit-change">
      <code className="gm-edit-key">{change.key}</code>
      {change.kind === 'added' ? (
        <span className="gm-edit-added">added</span>
      ) : (
        <>
          <span className="gm-edit-before" title={previewValue(change.before, 2000)}>
            {previewValue(change.before)}
          </span>
          <span className="gm-edit-arrow" aria-label="becomes">
            →
          </span>
        </>
      )}
      <span className="gm-edit-after" title={previewValue(change.after, 2000)}>
        {after}
      </span>
    </li>
  );
}

export function EditArgsEditor({ runId, node, pause, onClose }: EditArgsEditorProps) {
  // What the call runs with now (an accepted edit sticks), and where its
  // editable keys are (mcp-proxy: inside `arguments`).
  const { input: recorded, edited } = editBase(heldExecution(node, pause));
  const sdk = useRunStore((s) => s.runs[runId]?.meta.sdk);
  const shape = editShape(sdk, recorded);
  const prefill = useMemo(() => editPrefill(recorded, { edited, shape }), [recorded, edited, shape]);
  const stored = useEditStore((s) => s.drafts[pause.pauseId]);
  const pending = useEditStore((s) => s.pending[pause.pauseId]);
  const reply = useEditStore((s) => s.replies[pause.pauseId]);
  const control = useUiStore((s) => s.control);
  const draft = stored ?? (prefill.ok ? prefill.text : '');
  const plan = useMemo(
    () => (prefill.ok ? planEdit(recorded, draft, shape) : undefined),
    [prefill, recorded, draft, shape],
  );
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const answer = pending === undefined ? undefined : answerFor(pause, pending, now, reply);
  const waiting = answer?.state === 'waiting';

  // Re-render once when the answer is overdue, so "no answer yet" can appear.
  useEffect(() => {
    if (pending === undefined || answer?.state !== 'waiting') return;
    const due = pending.sentAt + EDIT_ANSWER_TIMEOUT_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due) + 20);
    return () => clearTimeout(timer);
  }, [pending, answer?.state]);

  useEffect(() => {
    if (prefill.ok) editorRef.current?.focus({ preventScroll: true });
    else closeRef.current?.focus({ preventScroll: true });
    // Focus once, on open — not on every keystroke's re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = () => {
    if (plan?.payload === undefined || waiting) return;
    const requestId = newRequestId();
    const result = editAndResume(runId, pause, plan.payload, requestId);
    if (!result.ok) {
      setLocalError(result.reason);
      return;
    }
    setLocalError(undefined);
    const last = latestRefusal(pause);
    useEditStore.getState().setPending({
      runId,
      pauseId: pause.pauseId,
      requestId,
      sentAt: Date.now(),
      lastRefusalSeq: last?.seq ?? -1,
    });
    setNow(Date.now());
  };

  // Escape anywhere in the editor (the text, a button) closes the editor and
  // stops there: the app's Escape would close the inspector around it.
  const onGroupKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  const onTextKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  };

  const title = `Edit arguments for ${node.name}`;

  if (!prefill.ok) {
    return (
      <div
        className="gm-inject gm-inject--panel gm-edit nowheel"
        role="group"
        aria-label={title}
        onKeyDown={onGroupKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gm-section-label gm-inject-title">{title}</div>
        <div className="gm-pause-note gm-edit-unavailable" data-testid="edit-unavailable">
          {prefill.message}
        </div>
        <div className="gm-actions gm-inject-actions">
          <button ref={closeRef} className="gm-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const changes = plan?.changes ?? [];
  const problems = plan?.problems ?? [];
  const count = changes.length;
  const canRun = plan?.payload !== undefined && !waiting;
  const runText = waiting ? 'Checking…' : count === 0 ? 'No changes yet' : runLabel(pause.point, count);

  return (
    <div
      className="gm-inject gm-inject--panel gm-edit nowheel"
      role="group"
      aria-label={title}
      onKeyDown={onGroupKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="gm-section-label gm-inject-title">{title}</div>
      <div className="gm-edit-scope" data-testid="edit-scope">
        {SCOPE_NOTE}
      </div>
      {prefill.notes.map((note) => (
        <div key={note} className="gm-pause-note gm-edit-note">
          {note}
        </div>
      ))}
      <textarea
        ref={editorRef}
        className={plan?.parseError !== undefined ? 'gm-invalid' : ''}
        value={draft}
        spellCheck={false}
        aria-label={`Arguments for ${node.name}, as JSON`}
        aria-invalid={plan?.parseError !== undefined}
        aria-describedby={`gm-edit-diff-${pause.pauseId}`}
        onChange={(e) => {
          useEditStore.getState().setDraft(pause.pauseId, e.target.value);
          setLocalError(undefined);
        }}
        onKeyDown={onTextKeyDown}
      />

      <div id={`gm-edit-diff-${pause.pauseId}`} className="gm-edit-diff" data-testid="edit-diff">
        {/* Only the one-line summary is live: announcing the whole diff on
            every keystroke would drown a screen reader. */}
        <div aria-live="polite" aria-atomic="true">
          {plan?.parseError !== undefined ? (
            <div className="gm-edit-parse">{plan.parseError}</div>
          ) : count === 0 ? (
            <div className="gm-edit-empty">No changes yet — edit a value above.</div>
          ) : (
            <div className="gm-edit-diff-head">
              {count} {count === 1 ? 'change' : 'changes'} — only {count === 1 ? 'this key is' : 'these keys are'} sent
            </div>
          )}
        </div>
        {plan?.parseError === undefined && count > 0 && (
          <ul className="gm-edit-changes">
            {changes.map((change) => (
              <ChangeRow key={change.key} change={change} />
            ))}
          </ul>
        )}
        {problems.length > 0 && (
          <ul className="gm-edit-problems" data-testid="edit-problems" aria-live="polite">
            {problems.map((problem) => (
              <li key={`${problem.reason}:${problem.key}`}>{problem.message}</li>
            ))}
          </ul>
        )}
      </div>

      {answer?.state === 'refused' && (
        <div className="gm-pause-note gm-inject-refusal gm-edit-refusal" role="alert" data-testid="edit-refusal">
          {refusalText(answer.refusal.code, answer.refusal.message)}
        </div>
      )}
      {answer?.state === 'hub' && (
        <div className="gm-pause-note gm-inject-refusal gm-edit-refusal" role="alert" data-testid="edit-reply">
          {hubReplyText(answer.reply, control, 'arguments')}
        </div>
      )}
      {answer?.state === 'timeout' && (
        <div className="gm-pause-note gm-inject-refusal" role="alert" data-testid="edit-timeout">
          No answer from the app yet — it may have disconnected. The gate is still held here; you can
          run the edit again.
        </div>
      )}
      {waiting && (
        <div className="gm-edit-waiting" role="status">
          Sent — waiting for the app to check the arguments…
        </div>
      )}
      {localError !== undefined && (
        <div className="gm-pause-note gm-inject-refusal" role="alert">
          {localError}
        </div>
      )}

      <div className="gm-actions gm-inject-actions">
        <button
          className="gm-action gm-action--primary"
          onClick={run}
          disabled={!canRun}
          title={`Run this call with the changed keys only (${
            pause.point === 'before' ? 'continue' : 'retry'
          }; ⌘/ctrl-Enter)`}
        >
          {runText}
        </button>
        <button className="gm-action" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
