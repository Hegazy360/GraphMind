/**
 * The hub's own answers to a resume (0.6.0, contract C3), end to end in the
 * store: an `error` / `resume.result` frame from `/ws/ui` reaches the pause it
 * is about, is matched to the editor's request by requestId (else by pause and
 * time), and reads in plain words — instead of the editor waiting 10 s and
 * blaming the app. The frames are the exact shapes packages/cli/src/hub.ts
 * sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteResumeResult, noteServerError } from '../src/connection/hubReplies.js';
import { answerFor, EDIT_ANSWER_TIMEOUT_MS, type PendingEdit } from '../src/lib/editArgs.js';
import {
  controlNoticeLabel,
  hubReplyText,
  outcomeForCode,
  replyAnswers,
  replyFromError,
  replyFromResult,
  type HubReply,
} from '../src/lib/hubReply.js';
import { useEditStore } from '../src/store/editStore.js';
import { useUiStore, type ControlInfo } from '../src/store/uiStore.js';
import type { Pause } from '../src/store/types.js';

const VIEWER: ControlInfo = { principal: 'viewer', agentLevel: 'off', editInput: true, hubCapabilities: ['edit-input'] };
const TOKENLESS: ControlInfo = { ...VIEWER, principal: 'anonymous' };
const NO_EDITS: ControlInfo = { ...VIEWER, editInput: false };

function heldPause(active = true): Pause {
  return { pauseId: 'p1', nodeId: 'tool:convertCurrency', point: 'error', ts: 0, active, editable: true };
}

const pending: PendingEdit = { runId: 'run-1', pauseId: 'p1', requestId: 'edit-1', sentAt: 1_000, lastRefusalSeq: -1 };

beforeEach(() => {
  useEditStore.setState({ drafts: {}, pending: {}, replies: {}, editorRequest: undefined });
  useUiStore.setState({ controlNotice: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('frames -> replies', () => {
  it('an immediate refusal carries the outcome and, when the resumer gave one, its requestId', () => {
    const reply = replyFromError(
      {
        type: 'error',
        runId: 'run-1',
        pauseId: 'p1',
        code: 'pause-taken',
        outcome: 'taken',
        requestId: 'edit-1',
        message: 'another resume for this pause is already being answered',
      },
      5,
    );
    expect(reply).toEqual({
      runId: 'run-1',
      pauseId: 'p1',
      code: 'pause-taken',
      outcome: 'taken',
      requestId: 'edit-1',
      message: 'another resume for this pause is already being answered',
      at: 5,
    });
  });

  it('an error about no pause is not a pause reply; an older hub without `outcome` is mapped from the code', () => {
    expect(replyFromError({ type: 'error', message: 'frame is not valid JSON' })).toBeUndefined();
    expect(replyFromError({ type: 'error', code: 'forbidden', message: 'x' })).toBeUndefined();
    expect(replyFromError({ type: 'error', pauseId: 'p1', code: 'no-owner', message: 'm' }, 1)?.outcome).toBe('no-such-pause');
    expect(outcomeForCode('pause-taken')).toBe('taken');
    expect(outcomeForCode('edit-refused')).toBe('refused');
    expect(outcomeForCode('no-answer')).toBe('timeout');
    expect(outcomeForCode(undefined)).toBe('refused');
  });

  it('resume.result: resumed and the app’s own refusal are on the run already; the rest are replies', () => {
    const base = { type: 'resume.result', runId: 'run-1', pauseId: 'p1', requestId: 'edit-1' };
    expect(replyFromResult({ ...base, outcome: 'resumed' })).toBeUndefined();
    expect(replyFromResult({ ...base, outcome: 'refused', code: 'schema' })).toBeUndefined();
    expect(replyFromResult({ ...base, outcome: 'taken', code: 'superseded', message: 'm' }, 9)).toEqual({
      runId: 'run-1',
      pauseId: 'p1',
      requestId: 'edit-1',
      outcome: 'taken',
      code: 'superseded',
      message: 'm',
      at: 9,
      forwarded: true,
    });
    expect(replyFromResult({ ...base, outcome: 'timeout' }, 9)?.code).toBe('timeout');
  });
});

describe('matching a reply to a request', () => {
  const reply = (extra: Partial<HubReply>): HubReply => ({ pauseId: 'p1', code: 'pause-taken', outcome: 'taken', at: 1_500, ...extra });

  it('by requestId when the reply has one — another request’s answer is not ours', () => {
    expect(replyAnswers(reply({ requestId: 'edit-1' }), pending)).toBe(true);
    expect(replyAnswers(reply({ requestId: 'edit-0' }), pending)).toBe(false);
  });

  it('else by pause, and only a reply that arrived after the send', () => {
    expect(replyAnswers(reply({}), pending)).toBe(true);
    expect(replyAnswers(reply({ at: 999 }), pending)).toBe(false);
    expect(replyAnswers(reply({ pauseId: 'p2' }), pending)).toBe(false);
    expect(replyAnswers(undefined, pending)).toBe(false);
  });

  it('the editor: a hub reply answers the edit right away — no 10 s wait, no blaming the app', () => {
    const taken = reply({ requestId: 'edit-1' });
    expect(answerFor(heldPause(), pending, 1_500, taken)).toEqual({ state: 'hub', reply: taken });
    // Later, still the hub's answer, never "no answer from the app yet".
    expect(answerFor(heldPause(), pending, 1_000 + EDIT_ANSWER_TIMEOUT_MS + 1, taken)).toEqual({ state: 'hub', reply: taken });
    // An answer to someone else's request leaves this one waiting.
    expect(answerFor(heldPause(), pending, 1_500, reply({ requestId: 'edit-0' }))).toEqual({ state: 'waiting' });
    // The app's own refusal and a released pause still come first.
    const refusal = { code: 'schema', message: 'm', requestId: 'edit-1', ts: 1, seq: 3 };
    expect(answerFor({ ...heldPause(), refusals: [refusal] }, pending, 1_500, taken)).toEqual({ state: 'refused', refusal });
    expect(answerFor(heldPause(false), pending, 1_500, taken)).toEqual({ state: 'resolved' });
  });
});

describe('plain words', () => {
  const said = (code: string, control?: ControlInfo, subject: 'arguments' | 'resume' = 'arguments', message?: string) =>
    hubReplyText({ code, outcome: outcomeForCode(code), ...(message === undefined ? {} : { message }) }, control, subject);

  it('taken / no longer held / superseded', () => {
    expect(said('pause-taken', VIEWER)).toMatch(/^Taken — another resume for this pause got there first/);
    expect(said('pause-taken', VIEWER)).toContain('Your edit was not sent.');
    expect(said('pause-taken', VIEWER, 'resume')).toContain('Yours was not sent.');
    expect(said('no-such-pause', VIEWER)).toMatch(/^This pause is no longer held/);
    expect(said('superseded', VIEWER)).toMatch(/^Taken — the pause was released by something else/);
    // A resume that DID reach the app and lost the pause after it reopened is not "not sent".
    const lost = hubReplyText({ code: 'pause-taken', outcome: 'taken', forwarded: true }, VIEWER, 'arguments');
    expect(lost).toMatch(/^Taken — the app did not answer yours in time/);
    expect(lost).not.toContain('not sent');
    expect(said('no-owner')).toContain('No connected app holds this run');
    expect(said('app-disconnected')).toContain('releases its gates on its own');
  });

  it('edit refused: says WHY from what the socket was told, not by parsing the sentence', () => {
    const hubSays = 'input edits need a credential: open the viewer from the link `graphmind serve` prints';
    expect(said('edit-refused', TOKENLESS, 'arguments', hubSays)).toMatch(/^Editing arguments needs the viewer token/);
    expect(said('edit-refused', NO_EDITS, 'arguments', 'input edits are disabled')).toMatch(/--no-edit-input/);
    // Neither: the hub's own (value-free) reason — the app or the gate cannot take an edit.
    expect(
      said('edit-refused', VIEWER, 'arguments', 'this pause is not editable (the adapter cannot apply an edited input at this gate)'),
    ).toBe(
      'The server would not pass this edit to the app: this pause is not editable (the adapter cannot apply an edited input at this gate).',
    );
  });

  it('forbidden names the credential; placeholder/truncated drop the hub’s "edit refused:" prefix', () => {
    expect(
      said('forbidden', { ...VIEWER, principal: 'agent' }, 'resume', 'agent control is off on this server; restart it with --allow-control=resume to allow resuming pauses'),
    ).toMatch(/^This tab holds the agent token, not the viewer’s, and agent control is off/);
    expect(said('placeholder', VIEWER, 'arguments', 'edit refused: this input contains redacted content ("__REDACTED__"); edit it before running')).toBe(
      'The server refused this: this input contains redacted content ("__REDACTED__"); edit it before running.',
    );
    expect(said('truncated', VIEWER)).toContain('truncated preview');
  });

  it('the run bar keeps it to a few words (the sentence is at the pause)', () => {
    expect(controlNoticeLabel('pause-taken', 'another resume for this pause is already being answered')).toBe(
      'pause taken by another resume',
    );
    expect(controlNoticeLabel('edit-refused', 'input edits need a credential: …')).toBe('edit refused by the server');
    expect(controlNoticeLabel('no-such-pause', 'x')).toBe('pause no longer held');
    expect(controlNoticeLabel('quota', 'too many resumes')).toBe('too many resumes');
  });

  it('an unknown code is still said, by its outcome', () => {
    expect(hubReplyText({ code: 'rate-limited', outcome: 'refused', message: 'slow down' })).toBe(
      'The server refused this (rate-limited): slow down',
    );
    expect(hubReplyText({ code: 'x', outcome: 'taken' }, undefined, 'resume')).toContain('Yours was not sent.');
  });
});

describe('routing from the socket (connection/hubReplies.ts)', () => {
  it('an error about a pause goes to that pause (and flashes the run bar); nothing is console-warned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteServerError(
      { type: 'error', runId: 'run-1', pauseId: 'p1', code: 'pause-taken', outcome: 'taken', message: 'taken' },
      2_000,
    );
    expect(useEditStore.getState().replies['p1']).toMatchObject({ code: 'pause-taken', outcome: 'taken', at: 2_000 });
    expect(useUiStore.getState().controlNotice).toMatchObject({ code: 'pause-taken' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an error about nothing in particular stays with the run bar and the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteServerError({ type: 'error', code: 'forbidden', message: 'agent control is off' });
    expect(useEditStore.getState().replies).toEqual({});
    expect(useUiStore.getState().controlNotice).toMatchObject({ code: 'forbidden' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resume.result: taken reaches the pause; resumed and refused do not', () => {
    noteResumeResult({ type: 'resume.result', runId: 'run-1', pauseId: 'p1', requestId: 'r', outcome: 'resumed' });
    expect(useEditStore.getState().replies).toEqual({});
    expect(useUiStore.getState().controlNotice).toBeUndefined();
    noteResumeResult({ type: 'resume.result', runId: 'run-1', pauseId: 'p1', requestId: 'r', outcome: 'refused', code: 'schema' });
    expect(useEditStore.getState().replies).toEqual({});
    noteResumeResult({ type: 'resume.result', runId: 'run-1', pauseId: 'p1', requestId: 'r', outcome: 'taken', code: 'superseded' });
    expect(useEditStore.getState().replies['p1']).toMatchObject({ code: 'superseded', requestId: 'r' });
  });

  it('the next resume from this tab clears the previous reply; releasing the pause forgets it', async () => {
    noteServerError({ type: 'error', runId: 'run-1', pauseId: 'p1', code: 'no-such-pause', message: 'gone' });
    const { resumeGate } = await import('../src/lib/gate.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // no connection registered in this suite
    resumeGate('run-1', 'p1', 'continue');
    expect(useEditStore.getState().replies['p1']).toBeUndefined();
    noteServerError({ type: 'error', runId: 'run-1', pauseId: 'p1', code: 'no-such-pause', message: 'gone' });
    useEditStore.getState().forgetPause('p1');
    expect(useEditStore.getState().replies['p1']).toBeUndefined();
  });
});
