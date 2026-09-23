/**
 * Why a gate held, in words — every kind of hold the SDK names (0.6.0,
 * contract C4), for the banner on the card, the label in the inspector's
 * held-gate footer and the evidence block above it.
 *
 *  - loop holds (`reason: 'loop'`): repeat, cycle, error-repeat — the
 *    sentences live in loop.ts next to the streak helpers they read;
 *  - smart holds (`reason: 'breakpoint'` + `smart.rule`):
 *      error-result         "search returned an error result without throwing"
 *      truncated-tool-call  "The model stopped at the token limit in the
 *                           middle of a tool call"
 *
 * Plus the tooltip that says what each verb does at that hold, and the set of
 * nodes a cycle goes round (highlighted on the canvas).
 */
import { cycleLap, loopBannerText, pastTense } from './loop.js';
import type { NodeState, Pause, RunState } from './types.js';

/** The held execution's normalized LLM finish reason (C1), when it recorded one. */
function finishReasonOf(node: NodeState): string | undefined {
  const output = node.executions[node.executions.length - 1]?.output;
  if (output === null || typeof output !== 'object') return undefined;
  const reason = (output as Record<string, unknown>)['finishReason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** The one line for a smart hold. `undefined` when the pause is not one. */
export function smartBannerText(node: NodeState, pause: Pause, replayed = false): string | undefined {
  const rule = pause.smart?.rule;
  let line: string;
  if (rule === 'error-result') {
    line = `${node.name} returned an error result without throwing`;
  } else if (rule === 'truncated-tool-call') {
    line =
      finishReasonOf(node) === 'content-filter'
        ? 'A content filter stopped the model in the middle of a tool call'
        : 'The model stopped at the token limit in the middle of a tool call';
  } else {
    return undefined;
  }
  return replayed ? pastTense(line) : line;
}

/**
 * The banner line for any named hold — a loop or a smart breakpoint — or
 * `undefined` for an ordinary breakpoint / step / error gate, which keep
 * "Paused before call" and friends. `run` lets a cycle name its lap.
 */
export function holdBannerText(
  node: NodeState,
  pause: Pause,
  replayed = false,
  run?: RunState,
): string | undefined {
  return loopBannerText(node, pause, replayed, run) ?? smartBannerText(node, pause, replayed);
}

const REPEAT_HINT =
  'GraphMind held this call because the model asked for the same tool with the same arguments ' +
  'again and again (GRAPHMIND_LOOP_THRESHOLD, default 3). Continue runs it anyway; Inject ' +
  'substitutes a result; Abort stops the run. Polling on purpose? Add the tool to ' +
  'loopGuard.allowNodes (or GRAPHMIND_LOOP_ALLOW=<tool>, which also works for mcp-proxy), ' +
  'or set GRAPHMIND_ON_LOOP=warn.';

const CYCLE_HINT =
  'GraphMind held this call because the model is going round in circles: the same few calls, ' +
  'with the same arguments and the same results, several rounds in a row. Continue runs the next ' +
  'round anyway; Inject hands the model a different result; Abort stops the run. Polling on ' +
  'purpose? Add the tools to GRAPHMIND_LOOP_ALLOW, or set GRAPHMIND_ON_LOOP=warn.';

const ERROR_REPEAT_HINT =
  'GraphMind held this call because the tool kept failing with the same error, call after call. ' +
  'Continue runs it anyway; fixing the arguments or injecting a result breaks the streak; Abort ' +
  'stops the run. GRAPHMIND_ON_LOOP=warn logs instead of holding.';

const ERROR_RESULT_HINT =
  'The tool returned a result shaped like an error (isError, success: false, a non-zero exit ' +
  'code, or nothing but an error key) instead of throwing, so the model would carry on as if it ' +
  'had worked. Continue hands it over as it is; Retry runs the call again; Inject substitutes a ' +
  'result; Abort stops the run. GRAPHMIND_BREAK_ON_ERROR_RESULT=0 turns this off.';

const TRUNCATED_HINT =
  'The model’s reply was cut off (finish reason: length or content filter) while it was writing ' +
  'a tool call, so that call’s arguments are incomplete. Raise the token limit and Retry, or ' +
  'Abort. GRAPHMIND_BREAK_ON_TRUNCATED=0 turns this off.';

/** What each verb does at this hold — the banner's tooltip. `undefined` for an ordinary gate. */
export function holdHint(pause: Pause): string | undefined {
  if (pause.reason === 'loop') {
    if (pause.loop?.kind === 'cycle') return CYCLE_HINT;
    if (pause.loop?.kind === 'error-repeat') return ERROR_REPEAT_HINT;
    return REPEAT_HINT;
  }
  if (pause.smart?.rule === 'error-result') return ERROR_RESULT_HINT;
  if (pause.smart?.rule === 'truncated-tool-call') return TRUNCATED_HINT;
  return undefined;
}

const NO_LAP: ReadonlySet<string> = new Set();

/**
 * Memo keyed by the run's `pauses` record: the reducer replaces it on every
 * pause / resume / refusal and on nothing else, and the executions of a lap
 * all started before the hold, so this is computed once per hold — not once
 * per card per event.
 */
const lapCache = new WeakMap<Record<string, Pause>, ReadonlySet<string>>();

/**
 * The nodes the active cycle hold goes round — the canvas outlines them so
 * the loop can be seen, not only read. Empty when no cycle hold is active or
 * the stream carries no seqs to place the lap with.
 */
export function heldLapNodeIds(run: RunState): ReadonlySet<string> {
  const cached = lapCache.get(run.pauses);
  if (cached !== undefined) return cached;
  let lap: ReadonlySet<string> = NO_LAP;
  for (const pauseId of Object.keys(run.pauses)) {
    const pause = run.pauses[pauseId];
    if (pause === undefined || !pause.active || pause.loop?.kind !== 'cycle') continue;
    const node = run.nodes[pause.nodeId];
    if (node === undefined) continue;
    const calls = cycleLap(run, node, pause);
    if (calls.length > 0) {
      lap = new Set(calls.map((call) => call.node.nodeId));
      break;
    }
  }
  lapCache.set(run.pauses, lap);
  return lap;
}
