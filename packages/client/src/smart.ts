/**
 * Smart breakpoints (0.6.0, contract C4): holds for the failures that do not
 * throw. Each rule is an after-gate detector (session.ts `GateDetector`): it
 * sees the result an adapter passed in `gate('after', node, {result})` and
 * says why the gate should hold. The session consults them only while a
 * debugger is attached, and a hit travels as `reason: 'breakpoint'` +
 * `smart: {rule, detail?}` (a 0.5 hub's reason enum is closed, so a new
 * reason value would make it drop the frame and leave the app held with
 * nothing on screen).
 *
 *   error-result         a TOOL returned an error-shaped result. STRICT
 *                        shape, top level only, no substring matching:
 *                          - `isError === true` (MCP's tool-error result);
 *                          - `success === false`;
 *                          - `exit_code` / `exitCode` / `exitStatus` is a
 *                            number other than 0 (NaN does not count);
 *                          - a plain object whose ONLY own key is `error`,
 *                            with a value other than null / undefined / false
 *                            (`{error: null}` says "no error").
 *                        Env GRAPHMIND_BREAK_ON_ERROR_RESULT, default on.
 *                        Also consulted at a tool's `error` gate when the
 *                        adapter passed the result there (`graphmind
 *                        mcp-proxy` keeps gating `isError` at its error
 *                        point): a returned shape holds with this rule
 *                        rather than as a plain error hold — one hold either
 *                        way (see errorResultAtErrorGate).
 *   truncated-tool-call  an LLM step's normalized output (W1's
 *                        `{finishReason, toolCalls: [{id?, name, input,
 *                        inputText?}]}`) says the model stopped at the token
 *                        limit (`length`) or the content filter
 *                        (`content-filter`) while requesting at least one tool
 *                        call: its arguments are very likely cut off. The
 *                        detail counts the calls whose arguments did not
 *                        parse (`inputText`); such a call under any other
 *                        finish reason does not fire the rule.
 *                        Env GRAPHMIND_BREAK_ON_TRUNCATED, default on.
 *
 * `detail` is short and NEVER quotes a value from the result: it names the
 * rule's own constant (`isError: true`, `a non-zero exitCode`) and counts.
 * The session drops it anyway whenever a HIDE switch covers the node.
 *
 * Both switches are default-on: unset or empty keeps the rule on, and only
 * `0`, `false`, `off`, `no` (any case, surrounding whitespace ignored) turn it
 * off — the killSwitchOn spellings, inverted, so an unexpected spelling
 * errs towards keeping the breakpoint. A session option (`breakOnErrorResult`
 * / `breakOnTruncated`, booleans) beats the environment.
 *
 * Pure functions: nothing here throws, keeps a reference to a result, or
 * reads a property twice.
 */
import type { EnvLike } from './env.js';
import type { AfterGateContext, GateDetector, GateOptions, SmartInfo, UnsupportedAction } from './session.js';

/**
 * The options for an `after` gate that hands the session a call's result for
 * the smart holds — an LLM step's normalized output (`{finishReason,
 * toolCalls, …}`), or a tool's result — or `undefined` while no debugger is
 * attached, so the detached gate call stays option-free: the fast path is
 * exactly what it was. `unsupportedActions`: what the adapter cannot carry
 * out at this gate (see `GateOptions.unsupportedActions`). (Tool wrappers
 * that also offer edits use `toolGateOptions`, which does the same.) Never
 * throws.
 */
export function resultGateOptions(
  session: { readonly attached: boolean },
  result: unknown,
  unsupportedActions?: readonly UnsupportedAction[],
): GateOptions | undefined {
  try {
    if (!session.attached) return undefined;
    return unsupportedActions === undefined ? { result } : { result, unsupportedActions };
  } catch {
    return undefined;
  }
}

/**
 * The options for a gate with no result to inspect whose adapter cannot
 * carry out `unsupportedActions` there (an LLM step's `before` gate cannot
 * `inject`; a LangChain callback gate cannot `retry` or `inject`) — or
 * `undefined` while no debugger is attached, so the detached gate call stays
 * option-free. Never throws.
 */
export function unsupportedGateOptions(
  session: { readonly attached: boolean },
  unsupportedActions: readonly UnsupportedAction[],
): GateOptions | undefined {
  try {
    return session.attached ? { unsupportedActions } : undefined;
  } catch {
    return undefined;
  }
}

/** The spellings that turn a default-on switch off. */
const BREAK_ON_OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * A default-on switch read from the environment: off only for `0`, `false`,
 * `off`, `no` (case-insensitive, trimmed); unset, empty or anything else ->
 * `fallback` (on, unless a caller says otherwise). Never throws.
 */
export function parseBreakOn(raw: string | undefined, fallback = true): boolean {
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim().toLowerCase();
  if (text === '') return fallback;
  return !BREAK_ON_OFF.has(text);
}

/** The session options these rules read (SessionOptions has both). */
export interface SmartBreakpointOptions {
  /** Hold a tool's `after` gate on an error-shaped result. Env: GRAPHMIND_BREAK_ON_ERROR_RESULT. */
  breakOnErrorResult?: boolean;
  /** Hold an LLM step's `after` gate on a truncated tool call. Env: GRAPHMIND_BREAK_ON_TRUNCATED. */
  breakOnTruncated?: boolean;
}

export interface ResolvedSmartBreakpoints {
  errorResult: boolean;
  truncatedToolCall: boolean;
}

/**
 * Precedence per rule: a boolean option > environment > on. Never throws: an
 * option object whose reads throw is ignored, an unreadable environment
 * leaves both rules on.
 */
export function resolveSmartBreakpoints(
  options: SmartBreakpointOptions | undefined,
  env: EnvLike,
): ResolvedSmartBreakpoints {
  let errorOption: unknown;
  let truncatedOption: unknown;
  try {
    errorOption = options?.breakOnErrorResult;
    truncatedOption = options?.breakOnTruncated;
  } catch {
    errorOption = undefined;
    truncatedOption = undefined;
  }
  let errorEnv: string | undefined;
  let truncatedEnv: string | undefined;
  try {
    errorEnv = env['GRAPHMIND_BREAK_ON_ERROR_RESULT'];
    truncatedEnv = env['GRAPHMIND_BREAK_ON_TRUNCATED'];
  } catch {
    errorEnv = undefined;
    truncatedEnv = undefined;
  }
  return {
    errorResult: typeof errorOption === 'boolean' ? errorOption : parseBreakOn(errorEnv),
    truncatedToolCall: typeof truncatedOption === 'boolean' ? truncatedOption : parseBreakOn(truncatedEnv),
  };
}

// -- error-result ------------------------------------------------------------

/** Which strict shape matched (the detail names it; never a value). */
export type ErrorResultShape = 'isError' | 'success' | 'exit_code' | 'exitCode' | 'exitStatus' | 'error';

const EXIT_KEYS = ['exit_code', 'exitCode', 'exitStatus'] as const;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The strict error-result rule (see the module comment), or `undefined` when
 * the result is not error-shaped — including null, undefined, primitives,
 * strings that merely contain "error", arrays, and any object whose
 * inspection throws (a getter, a Proxy trap). Never throws.
 */
export function errorResultShape(result: unknown): ErrorResultShape | undefined {
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const record = result as Record<string, unknown>;
    if (record['isError'] === true) return 'isError';
    if (record['success'] === false) return 'success';
    for (const key of EXIT_KEYS) {
      const code = record[key];
      if (typeof code === 'number' && !Number.isNaN(code) && code !== 0) return key;
    }
    if (!isPlainObject(record)) return undefined;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== 'error') return undefined;
    const error = record['error'];
    if (error === null || error === undefined || error === false) return undefined;
    return 'error';
  } catch {
    return undefined;
  }
}

const ERROR_RESULT_DETAIL: Readonly<Record<ErrorResultShape, string>> = Object.freeze({
  isError: 'the tool returned a result with isError: true',
  success: 'the tool returned a result with success: false',
  exit_code: 'the tool returned a result with a non-zero exit_code',
  exitCode: 'the tool returned a result with a non-zero exitCode',
  exitStatus: 'the tool returned a result with a non-zero exitStatus',
  error: 'the tool returned an object whose only field is error',
});

/** The `error-result` detector: tool nodes only. */
export const errorResultDetector: GateDetector = (context: AfterGateContext): SmartInfo | undefined => {
  if (context.node.kind !== 'tool') return undefined;
  const shape = errorResultShape(context.result);
  return shape === undefined ? undefined : { rule: 'error-result', detail: ERROR_RESULT_DETAIL[shape] };
};

/**
 * A shape by which a tool RETURNED a failure (it did not throw): every strict
 * shape except the object whose only key is `error` — which is also how an
 * adapter describes a thrown or protocol error it caught (`graphmind
 * mcp-proxy` records a JSON-RPC error as `{error}`).
 */
export function isReturnedErrorShape(shape: ErrorResultShape | undefined): boolean {
  return shape !== undefined && shape !== 'error';
}

/**
 * The `error-result` rule at an `error` gate (`graphmind mcp-proxy` gates a
 * tool's `isError: true` result at its error point, and keeps doing so): a
 * tool result that is error-shaped by a RETURNED shape is reported with this
 * rule (`reason: 'breakpoint'` + `smart`) instead of as a plain error hold.
 * The `{error}`-only shape is not: at an error gate it is the adapter's
 * wrapping of a thrown or JSON-RPC error, which stays `reason: 'error'` (the
 * pause-on-error breakpoint's hold). Never throws.
 */
export function errorResultAtErrorGate(context: AfterGateContext): SmartInfo | undefined {
  if (context.node.kind !== 'tool') return undefined;
  const shape = errorResultShape(context.result);
  if (shape === undefined || !isReturnedErrorShape(shape)) return undefined;
  return { rule: 'error-result', detail: ERROR_RESULT_DETAIL[shape] };
}

// -- truncated-tool-call -----------------------------------------------------

/** What the truncated-tool-call rule found: why the model stopped, and counts. */
export interface TruncatedToolCall {
  finishReason: 'length' | 'content-filter';
  /** Tool calls the step requested. */
  toolCalls: number;
  /** Of those, calls whose arguments did not parse (`inputText` present). */
  unparsed: number;
}

/** Tool calls inspected for `inputText`; `toolCalls` itself is the array's length. */
const MAX_INSPECTED_TOOL_CALLS = 256;

/**
 * The truncated-tool-call rule over W1's normalized LLM output, or
 * `undefined`. Anything that is not that shape — no `finishReason`, another
 * finish reason, no tool calls, a non-array `toolCalls`, a throwing getter —
 * is `undefined`. Never throws.
 */
export function truncatedToolCall(result: unknown): TruncatedToolCall | undefined {
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const record = result as Record<string, unknown>;
    const finishReason = record['finishReason'];
    if (finishReason !== 'length' && finishReason !== 'content-filter') return undefined;
    const calls = record['toolCalls'];
    if (!Array.isArray(calls)) return undefined;
    const toolCalls = calls.length;
    if (toolCalls < 1) return undefined;
    let unparsed = 0;
    const inspect = Math.min(toolCalls, MAX_INSPECTED_TOOL_CALLS);
    for (let i = 0; i < inspect; i += 1) {
      const call: unknown = calls[i];
      if (call !== null && typeof call === 'object' && typeof (call as { inputText?: unknown }).inputText === 'string') {
        unparsed += 1;
      }
    }
    return { finishReason, toolCalls, unparsed };
  } catch {
    return undefined;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Value-free: the stop cause as our own words, and counts. */
export function truncatedDetail(found: TruncatedToolCall): string {
  const cause = found.finishReason === 'length' ? 'at the token limit' : 'by the content filter';
  const unparsed =
    found.unparsed > 0 ? `; ${plural(found.unparsed, 'call has', 'calls have')} arguments that did not parse` : '';
  return `the model was stopped ${cause} with ${plural(found.toolCalls, 'tool call', 'tool calls')} requested${unparsed}`;
}

/** The `truncated-tool-call` detector: LLM nodes only. */
export const truncatedToolCallDetector: GateDetector = (context: AfterGateContext): SmartInfo | undefined => {
  if (context.node.kind !== 'llm') return undefined;
  const found = truncatedToolCall(context.result);
  return found === undefined ? undefined : { rule: 'truncated-tool-call', detail: truncatedDetail(found) };
};

/** The detectors a session registers by default, in consultation order. */
export function defaultDetectors(resolved: ResolvedSmartBreakpoints): GateDetector[] {
  const detectors: GateDetector[] = [];
  if (resolved.errorResult) detectors.push(errorResultDetector);
  if (resolved.truncatedToolCall) detectors.push(truncatedToolCallDetector);
  return detectors;
}
