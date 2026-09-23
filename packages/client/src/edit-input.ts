/**
 * Edited input (0.6.0, contract C2 in internal/research/phase7-plan-2026-09.md):
 * the pure pieces of running a held call with an input the debugger edited
 * (`exec.resume.input`).
 *
 * The session decides WHETHER an edit may be honoured — it announced
 * `edit-input`, the debugger listed it in `hello.ack.hubCapabilities`, the
 * adapter marked the pause `editable`, `GRAPHMIND_DISABLE_EDIT_INPUT` is off,
 * and the action fits the point (`continue` at `before`, `retry` at `after` /
 * `error`). This module holds what it checks the edit itself with:
 *
 *   - `proposedValueRefusal`: an input carrying the redaction placeholder or a
 *     truncation marker (the shrink's, LangGraph's, or the MCP server's
 *     `get_node` preview) is a pre-filled copy of a value its sender never
 *     saw in full, not an argument anyone meant to run with. Refused
 *     (`placeholder` / `truncated`) wherever it appears — a value, a key, or
 *     inside a string — by the same blunt JSON-substring test the debugger's
 *     inject guard uses.
 *   - `prototypeKeyRefusal`: the two standard deep-merge pollution payloads
 *     (an own `__proto__` key, a `constructor.prototype` path), refused
 *     (`shape`) at any depth on every edit, whatever the adapter validates.
 *   - `normalizeValidation`: the adapter's validator is host code. It may
 *     throw, return garbage, or quote a value in a long message; what reaches
 *     the wire is always one of the two documented shapes, with a message of
 *     at most MAX_REFUSAL_MESSAGE printable characters.
 *   - `mergeToolInput`: the default rule for tool arguments, for adapters to
 *     call from their validator — the edit's top-level keys replace the live
 *     ones and every key it does not mention keeps its LIVE value (the
 *     recorded copy may be truncated or a repr, the live one is exact) —
 *     unless a switch hides the input, when only a full replacement counts.
 *
 * Nothing here throws.
 */
import { MCP_PREVIEW_NOTE_PREFIX, TRUNCATION_SUFFIX, type EventPayloadMap } from '@graphmind-ai/schema';
import { REDACTED } from './redaction.js';

/** Why an edit was refused (`exec.refused.code`). */
export type RefusalCode = EventPayloadMap['exec.refused']['code'];

/**
 * A validator's verdict on a proposed input. `value` is the input the call
 * will run with (for tools: the merged, schema-checked arguments).
 */
export type InputValidation =
  | { ok: true; value: unknown }
  | { ok: false; code: RefusalCode; message?: string };

/** What the session tells a validator about the edit it is checking. */
export interface ValidateInputContext {
  /**
   * A GRAPHMIND_HIDE_* switch hides this call's input from the record
   * (`HIDE_INPUTS`, or `HIDE_TOOL_ARGS` on a tool). The debugger never saw
   * the live input, so the edit is judged on its own, as a FULL replacement:
   * never merged onto, completed from or compared with the hidden live
   * values — otherwise the answer to a guess (refused, or run), repeatable
   * while the gate stays held, would reveal them. `mergeToolInput` does this
   * when passed the context.
   */
  readonly inputHidden: boolean;
}

/**
 * Supplied by an adapter that can apply an edit at a gate: checks (and
 * completes) the proposed input. May return a promise (any thenable); the
 * validator and its promise run in the host's async context (the gated
 * call's), never in the transport's. A throw, a rejection or a malformed
 * result is a refusal with code `shape`. Pass `context` on to
 * `mergeToolInput`.
 */
export type ValidateInput = (
  proposed: unknown,
  context: ValidateInputContext,
) => InputValidation | PromiseLike<InputValidation>;

/** `exec.refused.message` is cut to this many characters. */
export const MAX_REFUSAL_MESSAGE = 200;

/** A refusal the client itself decided (codes and messages never quote values). */
export interface Refusal {
  code: RefusalCode;
  message?: string;
}

const REFUSAL_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'schema',
  'shape',
  'placeholder',
  'truncated',
  'disabled',
  'unsupported',
]);

/**
 * Truncation markers, as they appear in JSON text: the shrink's own marker
 * key and string suffix, LangGraph's payload previews
 * (`{__graphmind: 'truncated' | 'unserializable', preview}`) and the read-only
 * MCP server's `get_node` preview (`{truncated: true, note: "payload
 * truncated: showing first …", preview}`). The last three are written with
 * their quotes, so they match a real key/value pair and never the escaped
 * text of a string that merely mentions them; a plain `truncated: true` field
 * with a note of its own is not a marker.
 */
const TRUNCATION_MARKERS: readonly string[] = [
  '__graphmindTruncated',
  TRUNCATION_SUFFIX,
  '"__graphmind":"truncated"',
  '"__graphmind":"unserializable"',
  `"note":"${MCP_PREVIEW_NOTE_PREFIX}`,
];

/**
 * Refusal for a proposed input (or inject output) that must never run:
 * `placeholder` when it contains "__REDACTED__", `truncated` when it contains
 * a truncation marker, `shape` when it cannot be serialised to be checked.
 * Undefined when it is clean.
 */
export function proposedValueRefusal(value: unknown): Refusal | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { code: 'shape', message: 'the value could not be read as JSON' };
  }
  if (typeof json !== 'string') return undefined;
  if (json.includes(REDACTED)) {
    return {
      code: 'placeholder',
      message: 'the value contains redacted content ("__REDACTED__"); replace it before running',
    };
  }
  if (TRUNCATION_MARKERS.some((marker) => json.includes(marker))) {
    return {
      code: 'truncated',
      message: 'the value contains a truncated preview, not the full value; replace it before running',
    };
  }
  return undefined;
}

/** C0/C1 controls and the bidi marks/overrides/isolates: never rendered or printed. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/**
 * Short free text fit for the wire (a refusal message, a smart hold's
 * detail): a string, unprintable characters turned into spaces, whitespace
 * collapsed, at most MAX_REFUSAL_MESSAGE characters (never splitting a
 * surrogate pair). Undefined when nothing is left.
 */
export function sanitizeShortText(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  let text = message.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_REFUSAL_MESSAGE) {
    let cut = MAX_REFUSAL_MESSAGE - 1;
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // a lone high surrogate
    text = `${text.slice(0, cut)}…`;
  }
  return text.length > 0 ? text : undefined;
}

const MALFORMED: InputValidation = Object.freeze({
  ok: false,
  code: 'shape',
  message: 'the input could not be validated',
});

/** What a validator that throws, rejects or returns garbage amounts to. */
export const VALIDATOR_FAILED: InputValidation = MALFORMED;

/**
 * One read of a validator's result into a documented shape. Anything that is
 * not `{ok: true, value}` or `{ok: false, code}` with a known code — or whose
 * fields cannot be read — is a `shape` refusal with a generic message.
 */
export function normalizeValidation(result: unknown): InputValidation {
  try {
    if (typeof result !== 'object' || result === null) return MALFORMED;
    const record = result as Record<string, unknown>;
    const ok = record['ok'];
    if (ok === true) {
      if (!('value' in record)) return MALFORMED;
      return { ok: true, value: record['value'] };
    }
    if (ok !== false) return MALFORMED;
    const code = record['code'];
    if (typeof code !== 'string' || !REFUSAL_CODES.has(code)) return MALFORMED;
    const message = sanitizeShortText(record['message']);
    return message === undefined
      ? { ok: false, code: code as RefusalCode }
      : { ok: false, code: code as RefusalCode, message };
  } catch {
    return MALFORMED;
  }
}

/**
 * The effective input as it goes on the wire: a JSON round trip, so the
 * record shows exactly what JSON can say about it. Undefined when it has no
 * JSON form (a cycle, a BigInt, a throwing getter, `undefined`) — an edit
 * that cannot be recorded is refused rather than run unrecorded.
 */
export function wireCopy(value: unknown): { value: unknown } | undefined {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return undefined;
    return { value: JSON.parse(json) as unknown };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first deep-merge pollution path in this tree, if any: an own
 * `__proto__` key (JSON makes it an own key), or a `constructor` key holding
 * an object with a `prototype` key — the two payloads that let tool code
 * which deep-merges its arguments rewrite `Object.prototype` (lodash
 * defaultsDeep CVE-2019-10744; the minimist CVE-2020-7598 bypass of
 * `__proto__`-only fixes). Iterative, cycle-safe; throws only when the value
 * cannot be read.
 */
function pollutionPath(root: object): '__proto__' | 'constructor.prototype' | undefined {
  const hasOwn = (node: object, key: string): boolean => Object.prototype.hasOwnProperty.call(node, key);
  const seen = new Set<object>();
  const stack: object[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as object;
    if (seen.has(node)) continue;
    seen.add(node);
    if (hasOwn(node, '__proto__')) return '__proto__';
    if (hasOwn(node, 'constructor')) {
      const ctor = (node as Record<string, unknown>)['constructor'];
      if (typeof ctor === 'object' && ctor !== null && hasOwn(ctor, 'prototype')) return 'constructor.prototype';
    }
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (typeof child === 'object' && child !== null) stack.push(child);
    }
  }
  return undefined;
}

function pollutionMessage(subject: string, path: '__proto__' | 'constructor.prototype'): string {
  return path === '__proto__'
    ? `${subject} may not contain a "__proto__" key`
    : `${subject} may not contain a "constructor.prototype" path`;
}

/**
 * Refusal (`shape`) for an edited input holding a deep-merge pollution path
 * at any depth (see `pollutionPath`). The session applies it to EVERY edit,
 * with or without an adapter validator — one that accepts values as they
 * are (a pass-through or record schema) would otherwise hand them to the
 * tool. Undefined when clean or not an object.
 */
export function prototypeKeyRefusal(value: unknown): Refusal | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const path = pollutionPath(value);
    return path === undefined ? undefined : { code: 'shape', message: pollutionMessage('the edited input', path) };
  } catch {
    return { code: 'shape', message: 'the edited input could not be read' };
  }
}

/**
 * The default edit rule for tool arguments (C2): `proposed` must be a plain
 * JSON object; its top-level keys replace the live ones, and every key it
 * does not mention keeps its LIVE value (nested values are replaced whole,
 * never merged). Returns a new object; neither argument is modified. A live
 * input that is not an object (an array, a string, nothing) contributes no
 * keys.
 *
 * With the validator's `context` and `context.inputHidden` (a switch hides
 * this input from the record), the live input contributes no keys either:
 * the edit must be a full replacement, so what the tool's schema says about
 * it never depends on the hidden values (refute-security S4 / C2.5).
 *
 * Refused with code `shape`: a proposed value that is not a plain object
 * (arrays, strings, null…), or one with a `__proto__` key or a
 * `constructor.prototype` path at any depth — harmless here, but tool code
 * that deep-merges its arguments would let it rewrite `Object.prototype`.
 *
 * Adapters call it from their `validateInput`, passing the context on, then
 * check the result with the tool's own schema.
 */
export function mergeToolInput(
  live: unknown,
  proposed: unknown,
  context?: Partial<ValidateInputContext>,
): InputValidation {
  try {
    if (!isRecord(proposed)) {
      return { ok: false, code: 'shape', message: 'the edited arguments must be a JSON object' };
    }
    const proto = Object.getPrototypeOf(proposed) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, code: 'shape', message: 'the edited arguments must be a plain JSON object' };
    }
    const path = pollutionPath(proposed);
    if (path !== undefined) {
      return { ok: false, code: 'shape', message: pollutionMessage('the edited arguments', path) };
    }
    // Spread defines own data properties (it never invokes a `__proto__`
    // setter), so even a live object with an own `__proto__` key stays inert.
    const base = context?.inputHidden !== true && isRecord(live) ? live : {};
    return { ok: true, value: { ...base, ...proposed } };
  } catch {
    return { ok: false, code: 'shape', message: 'the edited arguments could not be read' };
  }
}
