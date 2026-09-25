/**
 * "Edit arguments" (0.6.0, contract C2), the decisions behind the editor:
 * when it is offered, what it opens with, which keys it sends (only the
 * changed ones), which edits it will not send and why, how a refusal reads,
 * and how an answer is matched to the request that caused it.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import {
  EDIT_ANSWER_TIMEOUT_MS,
  REDACTED,
  SCOPE_NOTE,
  answerFor,
  argDiff,
  canEditArgs,
  editAction,
  editPrefill,
  heldExecution,
  latestRefusal,
  markerIn,
  newRequestId,
  planEdit,
  previewValue,
  refusalText,
  runLabel,
  type PendingEdit,
} from '../src/lib/editArgs.js';
import { editAndResume } from '../src/lib/gate.js';
import { sendControl } from '../src/connection/ServerConnection.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { useEditStore } from '../src/store/editStore.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import type { Pause, RunState } from '../src/store/types.js';

vi.mock('../src/connection/ServerConnection.js', () => ({ sendControl: vi.fn() }));

beforeEach(() => {
  resetCounters();
  vi.mocked(sendControl).mockClear();
});

function build(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, e) => applyEvent(acc, e, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('no run');
  return run;
}

const ARGS = { query: 'select 1', limit: 20, filters: { a: 1, b: 2 } };

function heldTool(extra: Record<string, unknown> = {}, input: unknown = ARGS): RunState {
  return build([
    started('tool:sql', 'tool', { instanceId: 'call-1', input }),
    ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'before', ...extra }),
  ]);
}

function nodeAndPause(run: RunState, nodeId = 'tool:sql', pauseId = 'p1') {
  const node = run.nodes[nodeId];
  const pause = run.pauses[pauseId];
  if (node === undefined || pause === undefined) throw new Error('missing');
  return { node, pause };
}

describe('canEditArgs — the editor is offered only where the app said it can apply an edit', () => {
  it('is offered on an editable pause of a tool', () => {
    const { node, pause } = nodeAndPause(heldTool({ editable: true }));
    expect(canEditArgs(node, pause)).toBe(true);
  });

  it('is never offered on a pause without editable, or with editable: false', () => {
    for (const extra of [{}, { editable: false }]) {
      resetCounters();
      const { node, pause } = nodeAndPause(heldTool(extra));
      expect(canEditArgs(node, pause), JSON.stringify(extra)).toBe(false);
    }
  });

  it('is never offered on an LLM step, even if a sender marks it editable', () => {
    const run = build([
      started('llm:step', 'llm', { instanceId: 's1', input: { prompt: 'x' } }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'llm:step', point: 'before', editable: true }),
    ]);
    const { node, pause } = nodeAndPause(run, 'llm:step');
    expect(canEditArgs(node, pause)).toBe(false);
  });

  it('is never offered in an exported run, nor on a released pause', () => {
    const run = heldTool({ editable: true });
    const { node, pause } = nodeAndPause(run);
    expect(canEditArgs(node, pause, true)).toBe(false);
    expect(canEditArgs(node, { ...pause, active: false })).toBe(false);
  });
});

describe('heldExecution — the instance whose arguments are edited', () => {
  it('is the instance the pause holds (heldBy), not merely the latest', () => {
    const run = build([
      started('tool:sql', 'tool', { instanceId: 'a', input: { n: 1 } }),
      started('tool:sql', 'tool', { instanceId: 'b', input: { n: 2 } }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:sql', point: 'after' }),
    ]);
    const { node, pause } = nodeAndPause(run);
    // An `after` gate holds the OLDEST running instance.
    expect(heldExecution(node, pause)?.instanceId).toBe('a');
  });

  it('falls back to the latest execution when the pause names none (gate after node.finished)', () => {
    const run = heldTool({ editable: true });
    const { node, pause } = nodeAndPause(run);
    expect(heldExecution(node, { ...pause, heldBy: [] })?.instanceId).toBe('call-1');
  });
});

describe('editPrefill — what the editor opens with', () => {
  it('opens with the recorded arguments as pretty JSON', () => {
    const prefill = editPrefill(ARGS);
    expect(prefill).toEqual({ ok: true, text: JSON.stringify(ARGS, null, 2), notes: [] });
  });

  it('refuses to open on hidden arguments, and says which switches hide them', () => {
    const prefill = editPrefill(REDACTED);
    expect(prefill.ok).toBe(false);
    if (prefill.ok) return;
    expect(prefill.reason).toBe('redacted');
    expect(prefill.message).toContain('GRAPHMIND_HIDE_TOOL_ARGS or GRAPHMIND_HIDE_INPUTS');
  });

  it('refuses to open on a whole-value preview (shrink, LangGraph) or a truncated string', () => {
    for (const input of [
      { __graphmindTruncated: true, bytes: 900_000, preview: '{"query":"sel' },
      { __graphmindTruncated: true, bytes: 900_000, preview: 'x', fields: ['query'] },
      { __graphmind: 'truncated', preview: '{"a":' },
      { __graphmind: 'unserializable', preview: '[object]' },
      `select *${TRUNCATION_SUFFIX}`,
    ]) {
      const prefill = editPrefill(input);
      expect(prefill.ok, JSON.stringify(input)).toBe(false);
      if (!prefill.ok) expect(prefill.reason === 'truncated' || prefill.reason === 'shape').toBe(true);
    }
  });

  it('refuses to open on arguments that are not a JSON object, or were never recorded', () => {
    for (const input of [[1, 2], 'plain', 42, null]) {
      const prefill = editPrefill(input);
      expect(prefill.ok).toBe(false);
      if (!prefill.ok) expect(prefill.reason).toBe('shape');
    }
    const missing = editPrefill(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('missing');
  });

  it('opens on an object the shrink cut, noting that unrecorded keys keep their live values', () => {
    const prefill = editPrefill({ a: 1, b: 2, __graphmindTruncated: true, keysDropped: 300 });
    expect(prefill.ok).toBe(true);
    if (prefill.ok) expect(prefill.notes.join(' ')).toContain('keep their live values');
  });

  it('opens with a note naming the keys recorded as a preview', () => {
    const prefill = editPrefill({ q: 'x', body: `long${TRUNCATION_SUFFIX}` });
    expect(prefill.ok).toBe(true);
    if (!prefill.ok) return;
    expect(prefill.notes).toHaveLength(1);
    expect(prefill.notes[0]).toContain('"body" was recorded as a preview');
  });
});

describe('planEdit — only the changed top-level keys are sent', () => {
  const text = JSON.stringify(ARGS, null, 2);

  it('an untouched draft has no changes and nothing to send', () => {
    expect(planEdit(ARGS, text)).toEqual({ changes: [], problems: [] });
  });

  it('a changed key is the whole payload — the other keys are not resent', () => {
    const plan = planEdit(ARGS, JSON.stringify({ ...ARGS, limit: 50 }));
    expect(plan.changes).toEqual([{ key: 'limit', kind: 'changed', before: 20, after: 50 }]);
    expect(plan.problems).toEqual([]);
    expect(plan.payload).toEqual({ limit: 50 });
  });

  it('an added key is sent; key order inside a value is not a change', () => {
    const plan = planEdit(ARGS, JSON.stringify({ filters: { b: 2, a: 1 }, limit: 20, query: 'select 1', dryRun: true }));
    expect(plan.changes).toEqual([{ key: 'dryRun', kind: 'added', after: true }]);
    expect(plan.payload).toEqual({ dryRun: true });
  });

  it('a nested change replaces that top-level key whole', () => {
    const plan = planEdit(ARGS, JSON.stringify({ ...ARGS, filters: { a: 1, b: 3 } }));
    expect(plan.payload).toEqual({ filters: { a: 1, b: 3 } });
  });

  it('a removed key blocks Run: unmentioned keys keep their live value, so a removal cannot be applied', () => {
    const { limit: _limit, ...rest } = ARGS;
    const plan = planEdit(ARGS, JSON.stringify({ ...rest, query: 'select 2' }));
    expect(plan.problems).toEqual([
      expect.objectContaining({ key: 'limit', reason: 'removed' }),
    ]);
    expect(plan.problems[0]?.message).toContain('set it to null');
    expect(plan.payload).toBeUndefined();
  });

  it('an unparseable or non-object draft says so and sends nothing', () => {
    const bad = planEdit(ARGS, '{"query": ');
    expect(bad.parseError).toMatch(/^Not valid JSON/);
    expect(bad.payload).toBeUndefined();
    for (const draft of ['[1,2]', '"x"', 'null', '3']) {
      const plan = planEdit(ARGS, draft);
      expect(plan.parseError, draft).toContain('must be a JSON object');
      expect(plan.payload).toBeUndefined();
    }
  });

  describe('markers: a preview may be left alone or replaced whole, never edited inside', () => {
    const recorded = { query: 'select 1', body: `The quick brown fox${TRUNCATION_SUFFIX}`, limit: 5 };
    const draftOf = (patch: Record<string, unknown>) => JSON.stringify({ ...recorded, ...patch });

    it('leaving the truncated key untouched while editing another is allowed and does not send it', () => {
      const plan = planEdit(recorded, draftOf({ limit: 6 }));
      expect(plan.problems).toEqual([]);
      expect(plan.payload).toEqual({ limit: 6 });
    });

    it('editing inside the truncated value is blocked, with the reason and the way out', () => {
      const plan = planEdit(recorded, draftOf({ body: `The quick red fox${TRUNCATION_SUFFIX}` }));
      expect(plan.problems).toEqual([expect.objectContaining({ key: 'body', reason: 'truncated' })]);
      expect(plan.problems[0]?.message).toContain('was recorded as a truncated preview');
      expect(plan.problems[0]?.message).toContain('undo your change');
      expect(plan.payload).toBeUndefined();
    });

    it('replacing the truncated value whole is allowed', () => {
      const plan = planEdit(recorded, draftOf({ body: 'A short new body' }));
      expect(plan.problems).toEqual([]);
      expect(plan.payload).toEqual({ body: 'A short new body' });
    });

    it('a value that still carries the redaction placeholder is blocked', () => {
      const plan = planEdit(recorded, draftOf({ token: REDACTED }));
      expect(plan.problems).toEqual([expect.objectContaining({ key: 'token', reason: 'placeholder' })]);
      expect(plan.payload).toBeUndefined();
      const inside = planEdit(recorded, draftOf({ query: `select ${REDACTED}` }));
      expect(inside.problems[0]?.reason).toBe('placeholder');
    });

    it('the shrink marker keys are never sent: untouched or deleted is fine, changed is blocked', () => {
      const cut = { a: 1, __graphmindTruncated: true, keysDropped: 12 };
      expect(planEdit(cut, JSON.stringify({ ...cut, a: 2 })).payload).toEqual({ a: 2 });
      expect(planEdit(cut, JSON.stringify({ a: 2 })).payload).toEqual({ a: 2 });
      const touched = planEdit(cut, JSON.stringify({ ...cut, keysDropped: 0, a: 2 }));
      expect(touched.problems).toEqual([expect.objectContaining({ key: 'keysDropped', reason: 'marker-key' })]);
      expect(touched.payload).toBeUndefined();
    });

    it('a "__proto__" key anywhere in a sent value is blocked', () => {
      const plan = planEdit(ARGS, '{"query":"select 1","limit":20,"filters":{"__proto__":{"x":1}}}');
      expect(plan.problems).toEqual([expect.objectContaining({ key: 'filters', reason: 'proto' })]);
      expect(plan.payload).toBeUndefined();
    });
  });
});

describe('markerIn', () => {
  it('finds the placeholder and every truncation marker the app refuses, anywhere', () => {
    expect(markerIn(REDACTED)).toBe('placeholder');
    expect(markerIn({ [REDACTED]: 1 })).toBe('placeholder');
    expect(markerIn({ a: [`x${TRUNCATION_SUFFIX}`] })).toBe('truncated');
    expect(markerIn({ a: { __graphmindTruncated: true } })).toBe('truncated');
    expect(markerIn({ a: { __graphmind: 'truncated', preview: '' } })).toBe('truncated');
    expect(markerIn({ note: 'mentions __graphmind truncated in prose' })).toBeUndefined();
    expect(markerIn({ ok: 1 })).toBeUndefined();
  });

  // The viewer flags exactly what the app (and the hub) would refuse, so it
  // never sends an edit that comes back refused for a marker: the shared
  // conformance fixture every SDK port consumes.
  const fixture = JSON.parse(
    readFileSync(new URL('../../../packages/client/test/fixtures/edit-input.json', import.meta.url), 'utf8'),
  ) as { proposedValue: { name: string; value?: unknown; refusal: string | null }[] };

  it.each(fixture.proposedValue.map((c) => [c.name, c] as const))(
    'agrees with the client on the shared fixture: %s',
    (_name, c) => {
      expect(markerIn(c.value) ?? null).toBe(c.refusal);
    },
  );
});

describe('labels', () => {
  it('rides on continue at a before gate and on retry after or on error', () => {
    expect(editAction('before')).toBe('continue');
    expect(editAction('after')).toBe('retry');
    expect(editAction('error')).toBe('retry');
  });

  it('counts the changes: "Run with 2 changes" / "Retry with 1 change"', () => {
    expect(runLabel('before', 2)).toBe('Run with 2 changes');
    expect(runLabel('before', 1)).toBe('Run with 1 change');
    expect(runLabel('error', 1)).toBe('Retry with 1 change');
    expect(runLabel('after', 3)).toBe('Retry with 3 changes');
  });

  it('states the scope of an edit', () => {
    expect(SCOPE_NOTE).toBe('This call only. The model still sees the arguments it asked for.');
  });

  it('previews one value on one line, cut to a width', () => {
    expect(previewValue({ a: 1 })).toBe('{"a":1}');
    expect(previewValue('x'.repeat(100), 10)).toBe(`"${'x'.repeat(8)}…`);
    expect(previewValue(undefined)).toBe('undefined');
  });
});

describe('refusalText — every refusal code in plain words', () => {
  it('schema quotes the tool’s own message', () => {
    expect(refusalText('schema', 'limit: must be at most 100')).toBe(
      "The tool's schema rejected this: limit: must be at most 100",
    );
    expect(refusalText('schema')).toBe("The tool's schema rejected these arguments.");
  });

  it('placeholder, truncated, disabled, unsupported, shape', () => {
    expect(refusalText('placeholder')).toBe(
      'These arguments still contain the redaction placeholder ("__REDACTED__"). Replace it with the real value, or leave that key unchanged to keep the live one.',
    );
    expect(refusalText('truncated')).toBe(
      'These arguments still contain a truncated preview, not the full value. Replace the whole value, or leave that key unchanged to keep the live one.',
    );
    expect(refusalText('disabled', 'input edits are turned off in this app (GRAPHMIND_DISABLE_EDIT_INPUT)')).toBe(
      'Editing arguments is turned off for this run (input edits are turned off in this app (GRAPHMIND_DISABLE_EDIT_INPUT)). Continue, Retry and Inject still work.',
    );
    expect(refusalText('disabled')).toBe(
      'Editing arguments is turned off for this run. Continue, Retry and Inject still work.',
    );
    expect(refusalText('unsupported', 'anything')).toBe(
      'This call cannot run with edited arguments here. Continue, Retry and Inject still work.',
    );
    expect(refusalText('shape', 'the edited arguments must be a JSON object')).toBe(
      'The app could not use these arguments: the edited arguments must be a JSON object',
    );
  });

  it('a refusal that may answer an inject (not our edit) does not talk about arguments', () => {
    expect(refusalText('truncated', undefined, 'value')).toBe(
      'The value still contains a truncated preview, not the full value. Replace the whole value.',
    );
    expect(refusalText('placeholder', undefined, 'value')).toBe(
      'The value still contains the redaction placeholder ("__REDACTED__"). Replace it with the real value.',
    );
    expect(refusalText('shape', 'bad', 'value')).toBe('The app could not use this: bad');
    expect(refusalText('quota', undefined, 'value')).toBe('The app refused this (quota).');
  });

  it('a code from a newer app is still said, not dropped', () => {
    expect(refusalText('quota', 'too many edits')).toBe('The app refused these arguments (quota): too many edits');
    expect(refusalText('quota')).toBe('The app refused these arguments (quota).');
  });
});

describe('answerFor — matching the app’s answer to the request', () => {
  function pauseWith(refusals: Pause['refusals'], active = true): Pause {
    return { pauseId: 'p1', nodeId: 'tool:sql', point: 'error', ts: 0, active, ...(refusals ? { refusals } : {}) };
  }
  const pending: PendingEdit = { runId: RUN, pauseId: 'p1', requestId: 'req-2', sentAt: 1_000, lastRefusalSeq: 5 };

  it('waits while nothing answers it', () => {
    expect(answerFor(pauseWith(undefined), pending, 1_500)).toEqual({ state: 'waiting' });
  });

  it('a refusal echoing our requestId answers it', () => {
    const refusal = { code: 'schema', message: 'm', requestId: 'req-2', ts: 1, seq: 9 };
    expect(answerFor(pauseWith([refusal]), pending, 1_500)).toEqual({ state: 'refused', refusal });
  });

  it('a refusal for another request does not, even when it is newer', () => {
    const other = { code: 'schema', requestId: 'req-agent', ts: 1, seq: 12 };
    expect(answerFor(pauseWith([other]), pending, 1_500)).toEqual({ state: 'waiting' });
    const mine = { code: 'truncated', requestId: 'req-2', ts: 1, seq: 10 };
    expect(answerFor(pauseWith([mine, other]), pending, 1_500)).toEqual({ state: 'refused', refusal: mine });
  });

  it('a refusal without a requestId matches by pause, only if it arrived after the send', () => {
    const old = { code: 'schema', ts: 1, seq: 5 };
    expect(answerFor(pauseWith([old]), pending, 1_500)).toEqual({ state: 'waiting' });
    const fresh = { code: 'shape', ts: 1, seq: 6 };
    expect(answerFor(pauseWith([old, fresh]), pending, 1_500)).toEqual({ state: 'refused', refusal: fresh });
  });

  it('a released pause is answered; silence past the timeout is its own answer', () => {
    expect(answerFor(pauseWith(undefined, false), pending, 1_500)).toEqual({ state: 'resolved' });
    expect(answerFor(pauseWith(undefined), pending, 1_000 + EDIT_ANSWER_TIMEOUT_MS)).toEqual({ state: 'timeout' });
  });

  it('latestRefusal reads the newest', () => {
    expect(latestRefusal(pauseWith(undefined))).toBeUndefined();
    expect(latestRefusal(pauseWith([{ code: 'a', ts: 1, seq: 1 }, { code: 'b', ts: 2, seq: 2 }]))?.code).toBe('b');
  });

  it('request ids are unique and recognisable', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^edit-[0-9a-z]+-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe('argDiff — before (recorded) / after (edited.after) for the inspector', () => {
  it('lists changed and added keys, not the unchanged ones', () => {
    expect(argDiff({ q: 'a', n: 1 }, { q: 'b', n: 1, extra: true })).toEqual([
      { key: 'q', kind: 'changed', before: 'a', after: 'b' },
      { key: 'extra', kind: 'added', after: true },
    ]);
  });

  it('does not call two cuts of one large value an edit, nor keys a cut record never had', () => {
    const before = { body: `aaaa${TRUNCATION_SUFFIX}`, n: 1 };
    const after = { body: `aaaaaaaa${TRUNCATION_SUFFIX}`, n: 2 };
    expect(argDiff(before, after)).toEqual([{ key: 'n', kind: 'changed', before: 1, after: 2 }]);
    const cut = { a: 1, __graphmindTruncated: true, keysDropped: 3 };
    expect(argDiff(cut, { a: 2, b: 5, c: 6 })).toEqual([{ key: 'a', kind: 'changed', before: 1, after: 2 }]);
  });

  it('is empty when after is not an object (e.g. the placeholder)', () => {
    expect(argDiff(ARGS, REDACTED)).toEqual([]);
  });
});

describe('editAndResume — the one new outbound shape', () => {
  it('sends exec.resume with continue at a before gate, only the changed keys, and the requestId', () => {
    const result = editAndResume(RUN, { pauseId: 'p1', point: 'before' }, { limit: 50 }, 'req-1');
    expect(result).toEqual({ ok: true });
    expect(sendControl).toHaveBeenCalledWith(
      'live',
      'exec.resume',
      { pauseId: 'p1', action: 'continue', input: { limit: 50 }, requestId: 'req-1' },
      RUN,
    );
  });

  it('rides on retry at an error or after gate', () => {
    editAndResume(RUN, { pauseId: 'p2', point: 'error' }, { q: 'x' }, 'req-2');
    editAndResume(RUN, { pauseId: 'p3', point: 'after' }, { q: 'y' }, 'req-3');
    const actions = vi.mocked(sendControl).mock.calls.map((call) => (call[2] as { action: string }).action);
    expect(actions).toEqual(['retry', 'retry']);
  });

  it('sends nothing for a marker or an empty edit, and says why', () => {
    const redacted = editAndResume(RUN, { pauseId: 'p1', point: 'before' }, { t: REDACTED }, 'r');
    expect(redacted.ok).toBe(false);
    const truncated = editAndResume(RUN, { pauseId: 'p1', point: 'before' }, { t: `x${TRUNCATION_SUFFIX}` }, 'r');
    expect(truncated.ok).toBe(false);
    expect(editAndResume(RUN, { pauseId: 'p1', point: 'before' }, {}, 'r').ok).toBe(false);
    expect(sendControl).not.toHaveBeenCalled();
  });
});

describe('editStore — drafts survive the panel, requests are consumed once', () => {
  it('keeps a draft and a pending request per pause, and forgets both with the pause', () => {
    const store = useEditStore.getState();
    store.setDraft('px', '{"a":2}');
    store.setPending({ runId: RUN, pauseId: 'px', requestId: 'r', sentAt: 1, lastRefusalSeq: -1 });
    expect(useEditStore.getState().drafts['px']).toBe('{"a":2}');
    expect(useEditStore.getState().pending['px']?.requestId).toBe('r');
    useEditStore.getState().clearPending('px');
    expect(useEditStore.getState().pending['px']).toBeUndefined();
    useEditStore.getState().forgetPause('px');
    expect(useEditStore.getState().drafts['px']).toBeUndefined();
  });

  it('an editor request is consumed by the panel that acts on it, and a stale consume is a no-op', () => {
    useEditStore.getState().requestEditor('p1');
    const first = useEditStore.getState().editorRequest;
    expect(first?.pauseId).toBe('p1');
    useEditStore.getState().requestEditor('p2');
    useEditStore.getState().consumeEditorRequest(first?.nonce ?? -1);
    expect(useEditStore.getState().editorRequest?.pauseId).toBe('p2');
    useEditStore.getState().consumeEditorRequest(useEditStore.getState().editorRequest?.nonce ?? -1);
    expect(useEditStore.getState().editorRequest).toBeUndefined();
  });
});
