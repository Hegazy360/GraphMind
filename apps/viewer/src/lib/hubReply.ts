/**
 * The HUB's own answer to a resume this tab sent (0.6.0, contract C3) — the
 * pure half. Nothing here touches a store or the DOM.
 *
 * A resume can be answered by two parties. The APP answers with events on the
 * run (`exec.resumed`, or `exec.refused` for an edit its schema turned down),
 * which every viewer sees on the canvas. The HUB answers before or instead of
 * the app, on this socket only:
 *
 *  - right away, as an `error` frame, when it never forwarded the resume:
 *    `pause-taken` (another resume — another tab, `graphmind resume` — is
 *    already being answered: first writer wins), `no-such-pause` (the pause
 *    was released already), `no-owner`, `forbidden` (the credential's level,
 *    or a tokenless tab's inject), `edit-refused` (a tokenless tab,
 *    `--no-edit-input`), `not-editable` (an app or a gate that cannot take an
 *    edit), `placeholder` / `truncated` (the value still carries a recording
 *    marker), `still-resolving` (an earlier resume of the pause, whose
 *    resumer stopped waiting, is still unanswered), `app-disconnected`;
 *  - later, as `resume.result`, when the forwarded resume did not end in
 *    `resumed`: `superseded` (something else released the pause first),
 *    `no-answer`, `run-finished`, `app-disconnected`.
 *
 * Until these reached the editor it waited 10 s and then blamed the app ("No
 * answer from the app yet") for something the hub had already said. Now each
 * one is matched to the request it answers — by `requestId` when the reply
 * carries one (the hub echoes the resumer's own), else by pause and time — and
 * said in plain words where the user pressed the button.
 */
import type { ControlInfo } from '../store/uiStore.js';

export type HubReplyOutcome = 'refused' | 'taken' | 'timeout' | 'no-such-pause';

/** One hub answer about one pause, as the editor and the pause row show it. */
export interface HubReply {
  runId?: string;
  pauseId: string;
  /** The resumer's own requestId, when the hub echoed it. */
  requestId?: string;
  outcome: HubReplyOutcome;
  code: string;
  /** The hub's wording (never quotes values). */
  message?: string;
  /** `Date.now()` when it arrived. */
  at: number;
  /** It came as `resume.result`: the resume DID reach the app, which did not answer it. */
  forwarded?: boolean;
}

const OUTCOMES: readonly HubReplyOutcome[] = ['refused', 'taken', 'timeout', 'no-such-pause'];

/** Which outcome a code means, for a hub that did not say (0.6 pre-release frames). */
export function outcomeForCode(code: string | undefined): HubReplyOutcome {
  switch (code) {
    case 'pause-taken':
    case 'superseded':
      return 'taken';
    case 'no-such-pause':
    case 'no-owner':
    case 'app-disconnected':
    case 'run-finished':
      return 'no-such-pause';
    case 'no-answer':
    case 'send-failed':
    case 'server-closing':
    case 'still-resolving':
      return 'timeout';
    default:
      return 'refused';
  }
}

function isOutcome(value: unknown): value is HubReplyOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * An `error` frame -> a reply, when it is about a pause (`pauseId`). Frames
 * about anything else (a malformed frame, a refused breakpoint change) are
 * not a pause's business and stay with the run bar.
 */
export function replyFromError(frame: Record<string, unknown>, now: number = Date.now()): HubReply | undefined {
  const pauseId = str(frame['pauseId']);
  if (pauseId === undefined) return undefined;
  const code = str(frame['code']) ?? 'refused';
  const runId = str(frame['runId']);
  const requestId = str(frame['requestId']);
  const message = str(frame['message']);
  return {
    pauseId,
    code,
    outcome: isOutcome(frame['outcome']) ? frame['outcome'] : outcomeForCode(code),
    at: now,
    ...(runId === undefined ? {} : { runId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * A `resume.result` -> a reply, for the outcomes the canvas cannot show by
 * itself. `resumed` arrives as the run's `exec.resumed` event; `refused` is
 * the app's `exec.refused`, which is on the run too (and the editor already
 * reads it from there, so it is not said twice).
 */
export function replyFromResult(frame: Record<string, unknown>, now: number = Date.now()): HubReply | undefined {
  const pauseId = str(frame['pauseId']);
  const outcome = frame['outcome'];
  if (pauseId === undefined || !isOutcome(outcome) || outcome === 'refused') return undefined;
  const runId = str(frame['runId']);
  const requestId = str(frame['requestId']);
  const message = str(frame['message']);
  return {
    pauseId,
    outcome,
    code: str(frame['code']) ?? outcome,
    at: now,
    forwarded: true,
    ...(runId === undefined ? {} : { runId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * Does this reply answer the request `(pauseId, requestId, sentAt)`? A reply
 * that carries a requestId answers exactly that request; one without (a plain
 * Continue carries none, and a 0.6 pre-release hub echoed none) answers the
 * newest request for its pause that was sent before it arrived.
 */
export function replyAnswers(
  reply: HubReply | undefined,
  request: { pauseId: string; requestId?: string; sentAt: number },
): boolean {
  if (reply === undefined || reply.pauseId !== request.pauseId) return false;
  if (reply.requestId !== undefined) return reply.requestId === request.requestId;
  return reply.at >= request.sentAt;
}

/**
 * The run bar's few words for a refused or unanswered control (the whole
 * sentence is at the pause, and in the chip's tooltip).
 */
export function controlNoticeLabel(code: string, message: string): string {
  switch (code) {
    case 'pause-taken':
      return 'pause taken by another resume';
    case 'superseded':
      return 'pause released by another resume';
    case 'no-such-pause':
      return 'pause no longer held';
    case 'edit-refused':
      return 'edit refused by the server';
    case 'not-editable':
      return 'this call cannot take an edit';
    case 'still-resolving':
      return 'an earlier resume is still unanswered';
    case 'forbidden':
      return 'not allowed with this credential';
    case 'no-owner':
    case 'app-disconnected':
      return 'the app disconnected';
    default:
      return message;
  }
}

const TOKENLESS_EDIT =
  'Editing arguments needs the viewer token, and this tab connected without it. Open the viewer from ' +
  'the link `graphmind serve` printed (or its redirect file) to edit. Continue, Retry and Abort still work here.';

const EDITS_OFF =
  'Input edits are turned off on this server (it was started with --no-edit-input). Continue, Retry and ' +
  'Inject still work.';

/**
 * The reply in plain words. `control` is what this socket was told in
 * `welcome.control` — it is what says WHY an edit was refused (no token, or
 * `--no-edit-input`) without parsing the hub's sentence. `subject` is what
 * was sent: the editor's `arguments`, or a plain resume's `resume`.
 */
export function hubReplyText(
  reply: Pick<HubReply, 'code' | 'outcome' | 'message' | 'forwarded'>,
  control?: ControlInfo,
  subject: 'arguments' | 'resume' = 'resume',
): string {
  const detail = reply.message;
  const yours = subject === 'arguments' ? 'Your edit was not sent.' : 'Yours was not sent.';
  switch (reply.code) {
    case 'pause-taken':
      if (reply.forwarded === true) {
        return (
          'Taken — the app did not answer yours in time, the pause reopened, and another resume took it. ' +
          'The gate is released by that one, or stays held if the app refuses it.'
        );
      }
      return (
        'Taken — another resume for this pause got there first (another viewer tab, or `graphmind ' +
        `resume\` from a terminal). ${yours} If the app refuses that one, the gate stays held and you can try again.`
      );
    case 'superseded':
      return (
        'Taken — the pause was released by something else before the app answered (another resume, or ' +
        'the app on its own).'
      );
    case 'no-such-pause':
      return (
        'This pause is no longer held — it was already released (by another tab, the CLI, or the app on ' +
        `its own). ${yours}`
      );
    case 'no-owner':
      return 'No connected app holds this run any more, so there is nothing left to resume.';
    case 'app-disconnected':
      return 'The app disconnected before answering. A detached app releases its gates on its own.';
    case 'run-finished':
      return 'The run finished before the app answered.';
    case 'forbidden':
      return control?.principal === 'agent'
        ? `This tab holds the agent token, not the viewer’s, and ${detail ?? 'its level does not allow this'}.`
        : `Not allowed with this tab’s credential${detail !== undefined ? `: ${detail}.` : '.'}`;
    case 'edit-refused':
      if (control?.principal === 'anonymous') return TOKENLESS_EDIT;
      if (control?.editInput === false) return EDITS_OFF;
      return `The server would not pass this edit to the app${detail !== undefined ? `: ${detail}.` : '.'}`;
    case 'not-editable':
      // The credential was fine; this app or this gate cannot run an edit.
      return (
        `This call cannot run with edited arguments${detail !== undefined ? ` — ${detail}` : ''}. ` +
        'Continue, Retry and Inject still work.'
      );
    case 'still-resolving':
      return (
        'The app has not answered an earlier resume of this pause yet, so this one was not sent. The pause ' +
        'reopens within a few seconds if the app never answers; try again then.'
      );
    case 'placeholder':
    case 'truncated':
      // The hub's own sentence already says it plainly and never quotes values.
      return detail !== undefined
        ? `The server refused this: ${detail.replace(/^(edit|inject) refused: /, '')}.`
        : reply.code === 'placeholder'
          ? 'The server refused this: it still contains the redaction placeholder ("__REDACTED__").'
          : 'The server refused this: it still contains a truncated preview, not the full value.';
    case 'no-answer':
      return 'The app has not answered in 30 s. The gate may still be held; you can try again.';
    case 'send-failed':
      return 'The resume could not be delivered to the app. The gate may still be held; you can try again.';
    case 'server-closing':
      return 'The GraphMind server is shutting down; the app releases its gates when it disconnects.';
    default:
      break;
  }
  const said = detail !== undefined ? `: ${detail}` : '.';
  switch (reply.outcome) {
    case 'taken':
      return `Taken — another resume for this pause got there first (${reply.code}). ${yours}`;
    case 'no-such-pause':
      return `This pause is no longer held (${reply.code})${said}`;
    case 'timeout':
      return `No answer from the app yet (${reply.code})${detail !== undefined ? `: ${detail}.` : '.'} The gate may still be held.`;
    default:
      return `The server refused this (${reply.code})${said}`;
  }
}
