/**
 * Edit tool arguments (0.6.0, contract C2) — the pure half of the editor.
 *
 * A held tool call whose `exec.paused` says `editable` can be run with edited
 * arguments: `exec.resume {pauseId, action, input, requestId}`, `continue` at a
 * `before` gate and `retry` at an `after` / `error` gate. The app merges the
 * edit into the LIVE arguments — the edit's top-level keys replace the live
 * ones, every key it does not mention keeps its live value — validates the
 * result with the tool's own schema, and answers with `exec.resumed
 * {edited: {after}}` or `exec.refused {code, message}` (the gate stays held).
 *
 * The viewer only ever sees the RECORDED arguments, which may be a truncated
 * preview (`…[graphmind: truncated]`, `__graphmindTruncated`) or hidden
 * (`__REDACTED__`). So it sends ONLY the top-level keys the user changed:
 * resending the whole object would hand the app a preview in place of a live
 * value (the app refuses those) or clobber a value the viewer never saw.
 *
 * Everything the editor decides lives here, so the node-environment unit
 * suite can pin it: whether to offer the editor at all, what to prefill, the
 * changed-keys diff and payload, which edits cannot be sent and why, how a
 * refusal reads in plain words, and how an answer is matched to its request.
 * Nothing here throws.
 */
import { TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import type { NodeExecution, NodeState, Pause, RefusalRecord } from '../store/types.js';

/** The redaction placeholder (@graphmind-ai/client `REDACTED`). */
export const REDACTED = '__REDACTED__';

/**
 * Truncation markers as they appear in JSON text — the same list the client
 * refuses an edit for (packages/client/src/edit-input.ts): the shrink's marker
 * key and string suffix, and LangGraph's payload previews.
 */
const TRUNCATION_MARKERS: readonly string[] = [
  '__graphmindTruncated',
  TRUNCATION_SUFFIX,
  '"__graphmind":"truncated"',
  '"__graphmind":"unserializable"',
];

/** Keys the shrink adds to an object it cut. They describe the record, never the call. */
const SHRINK_MARKER_KEYS: ReadonlySet<string> = new Set(['__graphmindTruncated', 'keysDropped']);

/** What the scope note says, everywhere an edit is offered or shown. */
export const SCOPE_NOTE = 'This call only. The model still sees the arguments it asked for.';

/** How long the editor waits for the app's answer before saying it has none. */
export const EDIT_ANSWER_TIMEOUT_MS = 10_000;

export type Marker = 'placeholder' | 'truncated';

function jsonOf(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does this value carry the redaction placeholder or a truncation marker
 * anywhere — as a value, inside a string, or as a key? The same blunt
 * JSON-substring test the app applies to an edit, so the viewer never sends
 * one it would refuse.
 */
export function markerIn(value: unknown): Marker | undefined {
  const json = jsonOf(value);
  if (json === undefined) return undefined;
  if (json.includes(REDACTED)) return 'placeholder';
  if (TRUNCATION_MARKERS.some((marker) => json.includes(marker))) return 'truncated';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonical JSON (keys sorted at every depth), so `{a,b}` equals `{b,a}`. */
function canonical(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value, (_key, v: unknown) => {
      if (isRecord(v)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) sorted[k] = v[k];
        return sorted;
      }
      return v;
    });
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  const left = canonical(a);
  return left !== undefined && left === canonical(b);
}

/**
 * Offer "Edit arguments" here? Only on a pause the app marked `editable`,
 * never on an LLM step (0.6.0 edits tool arguments only), and never in an
 * exported run — a recorded gate cannot be released at all.
 */
export function canEditArgs(node: NodeState, pause: Pause, replayed = false): boolean {
  return pause.active && pause.editable === true && node.kind !== 'llm' && !replayed;
}

/**
 * The execution this gate is holding — the instance whose arguments are being
 * edited. The pause's own `heldBy` entry for the node names it; a gate that
 * fires after `node.finished` (LangGraph) has none, so the latest execution.
 */
export function heldExecution(node: NodeState, pause: Pause): NodeExecution | undefined {
  const held = pause.heldBy?.find((h) => h.nodeId === node.nodeId);
  if (held !== undefined) {
    const exec = node.executions.find((e) => e.instanceId === held.instanceId);
    if (exec !== undefined) return exec;
  }
  return node.executions[node.executions.length - 1];
}

export type Prefill =
  | {
      ok: true;
      /** Pretty JSON the editor opens with. */
      text: string;
      /** Things the user should know before editing (never blocking). */
      notes: string[];
    }
  | { ok: false; reason: 'redacted' | 'truncated' | 'shape' | 'missing'; message: string };

/** A whole-value preview the shrink or LangGraph wrote in place of the arguments. */
function isPreviewObject(value: Record<string, unknown>): boolean {
  if (value['__graphmind'] === 'truncated' || value['__graphmind'] === 'unserializable') return true;
  if (value['__graphmindTruncated'] !== true) return false;
  // The shrink's cut object keeps real keys next to its markers; a preview
  // has nothing but markers and a preview string.
  return Object.keys(value).every(
    (key) => SHRINK_MARKER_KEYS.has(key) || key === 'bytes' || key === 'preview' || key === 'fields',
  );
}

/**
 * What the editor opens with, or why it cannot open. The arguments must be a
 * JSON object the viewer actually saw: hidden arguments (`__REDACTED__`) and
 * a whole-value preview leave nothing to start from.
 */
export function editPrefill(input: unknown): Prefill {
  if (input === undefined) {
    return {
      ok: false,
      reason: 'missing',
      message: 'No arguments were recorded for this call, so there is nothing here to edit.',
    };
  }
  if (input === REDACTED) {
    return {
      ok: false,
      reason: 'redacted',
      message:
        'The arguments were hidden by GRAPHMIND_HIDE_TOOL_ARGS or GRAPHMIND_HIDE_INPUTS before they ' +
        'left the app, so there is nothing here to edit. Continue, Retry and Inject still work.',
    };
  }
  if (typeof input === 'string' && input.includes(TRUNCATION_SUFFIX)) {
    return {
      ok: false,
      reason: 'truncated',
      message:
        'The recorded arguments were too large; only a preview reached the viewer, so they cannot ' +
        'be edited here. Continue, Retry and Inject still work.',
    };
  }
  if (!isRecord(input)) {
    return {
      ok: false,
      reason: 'shape',
      message: 'These arguments are not a JSON object, so they cannot be edited key by key.',
    };
  }
  if (isPreviewObject(input)) {
    return {
      ok: false,
      reason: 'truncated',
      message:
        'The recorded arguments were too large; only a preview reached the viewer, so they cannot ' +
        'be edited here. Continue, Retry and Inject still work.',
    };
  }
  const notes: string[] = [];
  if (Object.keys(input).some((key) => SHRINK_MARKER_KEYS.has(key))) {
    notes.push(
      'Not every key was recorded (the object was cut to fit). Keys you do not change keep their ' +
        'live values.',
    );
  }
  const partial = Object.keys(input).filter(
    (key) => !SHRINK_MARKER_KEYS.has(key) && markerIn(input[key]) !== undefined,
  );
  if (partial.length > 0) {
    notes.push(
      `${quoteList(partial)} ${partial.length === 1 ? 'was' : 'were'} recorded as a preview. Leave ` +
        `${partial.length === 1 ? 'it' : 'them'} unchanged to keep the live value, or replace the ` +
        'whole value.',
    );
  }
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? '{}';
  } catch {
    return {
      ok: false,
      reason: 'shape',
      message: 'These arguments could not be read as JSON, so they cannot be edited here.',
    };
  }
  return { ok: true, text, notes };
}

/** `a`, `a` and `b`, `a`, `b` and `c` — each quoted as code-ish text. */
function quoteList(keys: readonly string[]): string {
  const quoted = keys.map((k) => `"${k}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1] ?? ''}`;
}

export interface ArgChange {
  key: string;
  kind: 'added' | 'changed';
  /** The recorded value (absent for an added key). */
  before?: unknown;
  after: unknown;
}

export type KeyProblemReason = 'removed' | 'placeholder' | 'truncated' | 'marker-key' | 'proto';

/** A change that cannot be sent, in words that say what to do instead. */
export interface KeyProblem {
  key: string;
  reason: KeyProblemReason;
  message: string;
}

export interface EditPlan {
  /** The draft is not a JSON object; nothing else is computed. */
  parseError?: string;
  /** Changed and added top-level keys, in draft order. */
  changes: ArgChange[];
  /** Changes that cannot be sent. Any problem disables Run. */
  problems: KeyProblem[];
  /** `exec.resume.input`: only the changed keys. Present only when it may be sent. */
  payload?: Record<string, unknown>;
}

function hasProtoKey(value: unknown): boolean {
  const json = jsonOf(value);
  return json !== undefined && json.includes('"__proto__":');
}

function problemFor(key: string, value: unknown, recorded: unknown): KeyProblem | undefined {
  if (key === '__proto__' || hasProtoKey(value)) {
    return {
      key,
      reason: 'proto',
      message: `"${key}": a "__proto__" key cannot be sent to the app.`,
    };
  }
  const marker = markerIn(value);
  if (marker === undefined) return undefined;
  const wasPreview = markerIn(recorded) === marker;
  if (marker === 'placeholder') {
    return {
      key,
      reason: 'placeholder',
      message: wasPreview
        ? `"${key}" was hidden ("__REDACTED__") and the real value never reached the viewer. ` +
          'Replace the whole value, or undo your change to keep the live one.'
        : `"${key}" contains the redaction placeholder ("__REDACTED__"). Replace it with a real value.`,
    };
  }
  return {
    key,
    reason: 'truncated',
    message: wasPreview
      ? `"${key}" was recorded as a truncated preview; the full value never reached the viewer. ` +
        'Replace the whole value, or undo your change to keep the live one.'
      : `"${key}" contains a truncation marker. Replace it with the full value.`,
  };
}

/**
 * The changed-keys diff of a draft against the recorded arguments, and the
 * payload to send. A key counts as changed when its value differs as
 * canonical JSON (key order inside a value is not a change). Blocked:
 *   - a removed key: keys the edit does not mention keep their live value, so
 *     a removal cannot be expressed (put it back, or set it to null);
 *   - a changed or added value still carrying `__REDACTED__` or a truncation
 *     marker — editing inside a preview; the app would refuse it anyway;
 *   - a changed shrink marker key (`__graphmindTruncated`, `keysDropped`);
 *   - a `__proto__` key anywhere in a sent value.
 * Unchanged keys are never sent, which is what keeps a truncated or hidden
 * value the user did not touch at its live value.
 */
export function planEdit(recorded: unknown, draft: string): EditPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft) as unknown;
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? `: ${error.message}` : '';
    return { parseError: `Not valid JSON${detail}`, changes: [], problems: [] };
  }
  if (!isRecord(parsed)) {
    return {
      parseError: 'The arguments must be a JSON object ({ … }): its keys replace the call’s arguments.',
      changes: [],
      problems: [],
    };
  }
  const base = isRecord(recorded) ? recorded : {};
  const has = (obj: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);
  const changes: ArgChange[] = [];
  const problems: KeyProblem[] = [];

  for (const key of Object.keys(parsed)) {
    const after = parsed[key];
    if (SHRINK_MARKER_KEYS.has(key)) {
      if (has(base, key) && sameValue(base[key], after)) continue;
      problems.push({
        key,
        reason: 'marker-key',
        message: `"${key}" is GraphMind's truncation marker, not an argument. Leave it as it was, or delete it.`,
      });
      continue;
    }
    if (has(base, key)) {
      if (sameValue(base[key], after)) continue;
      changes.push({ key, kind: 'changed', before: base[key], after });
    } else {
      changes.push({ key, kind: 'added', after });
    }
    const problem = problemFor(key, after, has(base, key) ? base[key] : undefined);
    if (problem !== undefined) problems.push(problem);
  }
  for (const key of Object.keys(base)) {
    if (SHRINK_MARKER_KEYS.has(key) || has(parsed, key)) continue;
    problems.push({
      key,
      reason: 'removed',
      message:
        `"${key}" was removed, but keys you leave out keep their live value. Put it back, or set it ` +
        'to null if the tool accepts that.',
    });
  }

  const plan: EditPlan = { changes, problems };
  if (changes.length > 0 && problems.length === 0) {
    const payload: Record<string, unknown> = {};
    for (const change of changes) payload[change.key] = change.after;
    plan.payload = payload;
  }
  return plan;
}

/**
 * The before/after of an edited call, key by key, for the inspector. `before`
 * is the recorded input and `after` is `exec.resumed.edited.after` — either
 * may be the redaction placeholder, which the caller shows as hidden.
 *
 * `after` is the EFFECTIVE input: keys the user never touched carry their
 * live value. When both sides of a key are truncated previews (a large value
 * shrunk once in `node.started`, once in `exec.resumed`) they cannot be
 * compared, and two different cuts of one value are not an edit — skipped.
 * The shrink's own marker keys are never arguments.
 */
export function argDiff(before: unknown, after: unknown): ArgChange[] {
  if (!isRecord(after)) return [];
  const base = isRecord(before) ? before : {};
  // A recorded object the shrink cut to its first keys cannot tell a key the
  // user added from one it never recorded; only changes to known keys show.
  const cut = Object.prototype.hasOwnProperty.call(base, '__graphmindTruncated');
  const out: ArgChange[] = [];
  for (const key of Object.keys(after)) {
    if (SHRINK_MARKER_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(base, key)) {
      if (sameValue(base[key], after[key])) continue;
      if (markerIn(base[key]) === 'truncated' && markerIn(after[key]) === 'truncated') continue;
      out.push({ key, kind: 'changed', before: base[key], after: after[key] });
    } else if (!cut) {
      out.push({ key, kind: 'added', after: after[key] });
    }
  }
  return out;
}

/** The action an edit rides on: `continue` at a `before` gate, `retry` after or on error. */
export function editAction(point: Pause['point']): 'continue' | 'retry' {
  return point === 'before' ? 'continue' : 'retry';
}

/** "Run with 2 changes" at a `before` gate, "Retry with 1 change" after or on error. */
export function runLabel(point: Pause['point'], changes: number): string {
  const verb = point === 'before' ? 'Run' : 'Retry';
  return `${verb} with ${changes} ${changes === 1 ? 'change' : 'changes'}`;
}

/** One value on one line for the diff: compact JSON, cut to `max` characters. */
export function previewValue(value: unknown, max = 80): string {
  const json = value === undefined ? 'undefined' : (jsonOf(value) ?? String(value));
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

/**
 * `exec.refused` in plain words. The app's message is short and never quotes
 * values (contract C2); it is shown where it adds something the code cannot
 * say — which part of the schema failed, what shape was wrong.
 *
 * `subject` is what was refused: `arguments` for an edit this viewer sent;
 * `value` when the refusal may answer something else — an inject the app
 * turned down, an edit sent from another debugger or the CLI.
 */
export function refusalText(code: string, message?: string, subject: 'arguments' | 'value' = 'arguments'): string {
  const detail = message !== undefined && message !== '' ? message : undefined;
  const these = subject === 'arguments' ? 'These arguments still contain' : 'The value still contains';
  switch (code) {
    case 'schema':
      return detail !== undefined
        ? `The tool's schema rejected this: ${detail}`
        : "The tool's schema rejected these arguments.";
    case 'placeholder':
      return (
        `${these} the redaction placeholder ("__REDACTED__"). Replace it with the real value` +
        (subject === 'arguments' ? ', or leave that key unchanged to keep the live one.' : '.')
      );
    case 'truncated':
      return (
        `${these} a truncated preview, not the full value. Replace the whole value` +
        (subject === 'arguments' ? ', or leave that key unchanged to keep the live one.' : '.')
      );
    case 'disabled':
      return (
        'Editing arguments is turned off for this run' +
        (detail !== undefined ? ` (${detail})` : '') +
        '. Continue, Retry and Inject still work.'
      );
    case 'unsupported':
      return (
        'This call cannot run with edited arguments here. Continue, Retry and Inject still work.'
      );
    case 'shape': {
      const what = subject === 'arguments' ? 'these arguments' : 'this';
      return detail !== undefined
        ? `The app could not use ${what}: ${detail}`
        : subject === 'arguments'
          ? 'The app could not use these arguments: they must be a JSON object whose keys replace the call’s arguments.'
          : 'The app could not use this.';
    }
    default:
      return `The app refused ${subject === 'arguments' ? 'these arguments' : 'this'} (${code})${
        detail !== undefined ? `: ${detail}` : '.'
      }`;
  }
}

/**
 * A fresh `exec.resume.requestId`. `crypto.getRandomValues` works in every
 * browsing context (unlike `randomUUID`, which needs a secure one — a viewer
 * opened over plain HTTP on a LAN address is not).
 */
export function newRequestId(): string {
  let random = '';
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    random = Math.random().toString(16).slice(2).padEnd(16, '0');
  }
  return `edit-${Date.now().toString(36)}-${random}`;
}

/** An edit the viewer sent and is waiting to hear about. */
export interface PendingEdit {
  runId: string;
  pauseId: string;
  requestId: string;
  /** `Date.now()` at send. */
  sentAt: number;
  /** Seq of the newest refusal the pause carried at send (-1: none). */
  lastRefusalSeq: number;
}

export type EditAnswer =
  | { state: 'waiting' }
  | { state: 'refused'; refusal: RefusalRecord }
  | { state: 'resolved' }
  | { state: 'timeout' };

/** The newest refusal a pause carries, if any. */
export function latestRefusal(pause: Pause): RefusalRecord | undefined {
  const list = pause.refusals;
  return list === undefined ? undefined : list[list.length - 1];
}

/**
 * Has the app answered this edit? A released pause answered it (the edited
 * pill follows); a refusal answers it when its `requestId` echoes ours — or,
 * from a sender that echoes none, when it arrived after we sent. Silence past
 * EDIT_ANSWER_TIMEOUT_MS is its own answer: the gate is still held here, the
 * user may try again.
 */
export function answerFor(pause: Pause, pending: PendingEdit, now: number = Date.now()): EditAnswer {
  if (!pause.active) return { state: 'resolved' };
  const refusals = pause.refusals ?? [];
  for (let i = refusals.length - 1; i >= 0; i--) {
    const refusal = refusals[i];
    if (refusal === undefined) continue;
    if (refusal.requestId === pending.requestId) return { state: 'refused', refusal };
    if (refusal.requestId === undefined && refusal.seq > pending.lastRefusalSeq) {
      return { state: 'refused', refusal };
    }
  }
  if (now - pending.sentAt >= EDIT_ANSWER_TIMEOUT_MS) return { state: 'timeout' };
  return { state: 'waiting' };
}
