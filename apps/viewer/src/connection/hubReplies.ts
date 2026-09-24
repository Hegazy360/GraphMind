/**
 * Where the hub's replies on `/ws/ui` go (0.6.0). Split out of
 * useLiveConnection so the routing can be pinned without a socket.
 *
 *  - An `error` frame about a pause (it names one) is the hub's answer to a
 *    resume this tab sent — `pause-taken`, `no-such-pause`, `edit-refused`,
 *    `forbidden`, … It goes to the pause: the argument editor waiting on it,
 *    and the pause row (lib/hubReply.ts says it in plain words). The run bar
 *    still flashes it, for a click whose row is scrolled out of sight.
 *  - Any other `error` (a malformed frame, a refused breakpoint change) goes
 *    to the run bar alone, as before.
 *  - A `resume.result` that did not end in `resumed` goes to the pause too,
 *    unless it is the app's own refusal, which is on the run already as
 *    `exec.refused` and read from there.
 */
import { replyFromError, replyFromResult } from '../lib/hubReply.js';
import { useEditStore } from '../store/editStore.js';
import { useUiStore } from '../store/uiStore.js';
import type { ErrorFrame, ResumeResultFrame } from './protocol.js';

export function noteServerError(frame: ErrorFrame, now: number = Date.now()): void {
  const reply = replyFromError(frame as unknown as Record<string, unknown>, now);
  if (reply !== undefined) useEditStore.getState().noteReply(reply);
  else console.warn('[graphmind] server error:', frame.message);
  if (frame.code !== undefined) useUiStore.getState().noteControl(frame.code, frame.message);
}

export function noteResumeResult(frame: ResumeResultFrame, now: number = Date.now()): void {
  // `resumed` shows up on the canvas by itself (the exec.resumed event);
  // everything else means the click did not do what it said.
  if (frame.outcome === 'resumed') return;
  const reply = replyFromResult(frame as unknown as Record<string, unknown>, now);
  if (reply !== undefined) useEditStore.getState().noteReply(reply);
  useUiStore.getState().noteControl(frame.code ?? frame.outcome, frame.message ?? `resume ${frame.outcome}`);
}
