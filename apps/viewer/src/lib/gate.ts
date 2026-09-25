/**
 * Releasing a held gate — one implementation, three surfaces.
 *
 * Continue / Step / Retry / Inject / Abort are reachable from the card banner,
 * from the inspector's held-gate footer, and from the keyboard. They must mean
 * exactly the same thing in all three places: `Step` in particular is *two*
 * controls (`mode.set` then `exec.resume`), and having that sequence written
 * out in more than one component is how a debugger ends up releasing a gate
 * without arming step mode.
 */
import type { MessagePayloadMap, ResumeAction } from '@graphmind-ai/schema';
import { sendControl } from '../connection/ServerConnection.js';
import { editAction, markerIn } from './editArgs.js';
import { useEditStore } from '../store/editStore.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { activePausesOf, type NodeExecution, type Pause, type RunSource, type RunState } from '../store/types.js';

/** The gate currently holding this run, if any. */
export function activePause(run: RunState | undefined): Pause | undefined {
  if (run === undefined) return undefined;
  for (const id of Object.keys(run.pauses)) {
    const pause = run.pauses[id];
    if (pause !== undefined && pause.active) return pause;
  }
  return undefined;
}

/**
 * The gate the viewer shows for `nodeId`. Parallel calls of one tool can
 * hold at once: the execution picked in the inspector (`instanceIdx`) shows
 * its own hold when it has one, otherwise the node shows its newest
 * (`node.activePauseId`). The card banner, the footer's first row and the
 * keyboard all use this, so `c` always releases the pause on screen.
 */
export function shownPause(run: RunState | undefined, nodeId: string, instanceIdx?: number): Pause | undefined {
  const node = run?.nodes[nodeId];
  // Every held node has `activePauseId` (a release falls back to another
  // hold), so a node without one is not held: no scan.
  if (run === undefined || node?.activePauseId === undefined) return undefined;
  const held = activePausesOf(run, nodeId);
  if (held.length === 0) return undefined;
  const picked = instanceIdx !== undefined ? node.executions[instanceIdx] : undefined;
  if (picked !== undefined) {
    const own = held.find(
      (p) => p.heldAmbiguous !== true && p.heldBy?.some((h) => h.nodeId === nodeId && h.instanceId === picked.instanceId),
    );
    if (own !== undefined) return own;
  }
  const primary = node.activePauseId !== undefined ? run.pauses[node.activePauseId] : undefined;
  return primary?.active === true ? primary : held[held.length - 1];
}

/**
 * Which execution the inspector opens on when none is picked: the one the
 * node's shown hold names exactly (so the evidence matches the editor's
 * prefill and the error gate's call), else undefined (the latest).
 */
export function heldExecutionIndex(run: RunState | undefined, nodeId: string): number | undefined {
  const shown = shownPause(run, nodeId);
  const node = run?.nodes[nodeId];
  if (shown === undefined || node === undefined || shown.heldAmbiguous === true) return undefined;
  const held = shown.heldBy?.find((h) => h.nodeId === nodeId);
  if (held === undefined) return undefined;
  const index = node.executions.findIndex((e) => e.instanceId === held.instanceId);
  return index >= 0 ? index : undefined;
}

/**
 * The gate the keyboard acts on in `runId`, read straight from the store:
 * the one shown for the selected node (and selected execution), else the
 * one a card shows for the first held node.
 */
export function heldGate(runId: string | undefined): Pause | undefined {
  if (runId === undefined) return undefined;
  const run = useRunStore.getState().runs[runId];
  const ui = useUiStore.getState();
  if (ui.selectedRunId === runId && ui.selectedNodeId !== undefined) {
    const selected = shownPause(run, ui.selectedNodeId, ui.selectedInstanceIdx);
    if (selected !== undefined) return selected;
  }
  const first = activePause(run);
  return first === undefined ? undefined : shownPause(run, first.nodeId) ?? first;
}

function sourceOf(runId: string): RunSource {
  return useRunStore.getState().runs[runId]?.meta.source ?? 'live';
}

/**
 * Every `exec.resume` this tab sends goes through here. A new resume is a new
 * question, so the hub's answer to the previous one for this pause ("taken",
 * "no longer held", "edit refused" — lib/hubReply.ts) is dropped first:
 * whatever the hub says next is about this one.
 */
function sendResume(runId: string, payload: MessagePayloadMap['exec.resume']): void {
  useEditStore.getState().clearReply(payload.pauseId);
  sendControl(sourceOf(runId), 'exec.resume', payload, runId);
}

/** Release a gate with `continue` / `retry` / `abort`. */
export function resumeGate(runId: string, pauseId: string, action: ResumeAction): void {
  sendResume(runId, { pauseId, action });
}

/**
 * The placeholder the instrumented app writes in place of a hidden value
 * (GRAPHMIND_HIDE_INPUTS / _OUTPUTS / _TOOL_ARGS / _TOOL_RESULTS). Identical
 * to @graphmind-ai/client's `REDACTED` by contract.
 */
export const REDACTED_PLACEHOLDER = '__REDACTED__';

/**
 * Why an inject must be refused, or `undefined` when it may go. The inject
 * editor pre-fills with the held node's recorded output/input, and under a
 * kill switch that is the placeholder: pressing "Inject & resume" without
 * editing would hand the app the string "__REDACTED__" as a tool result.
 * Anything whose JSON form still contains the placeholder — as a value,
 * inside a string, or as a key — is refused in plain words. The server
 * applies the same rule (packages/cli/src/hub.ts) as defence in depth.
 */
export function injectRefusal(output: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    json = undefined;
  }
  if (typeof json === 'string' && json.includes(REDACTED_PLACEHOLDER)) {
    return 'this value contains redacted content; edit it before injecting';
  }
  return undefined;
}

/**
 * What the inject editor opens with: the recorded result when there is one.
 * At an `after` gate there may be none yet — every adapter but LangGraph
 * holds BEFORE it emits node.finished — and pre-filling the arguments there
 * handed the model the tool's own arguments as its result on an unedited
 * "Inject & resume". So it starts empty, and says why. Elsewhere (before the
 * call, on an error) the arguments stay the template, as before.
 */
export function injectPrefill(
  exec: Pick<NodeExecution, 'input' | 'output'> | undefined,
  point: Pause['point'],
): { text: string; note?: string } {
  const recorded = exec?.output !== undefined && exec.output !== null;
  if (!recorded && point === 'after') {
    return {
      text: '{}',
      note: 'The call’s own result is not recorded yet (the app records it after the hold), so this starts empty: write the result the model should get.',
    };
  }
  const shape = recorded ? exec?.output : exec?.input;
  try {
    return { text: JSON.stringify(shape ?? {}, null, 2) ?? '{}' };
  } catch {
    return { text: '{}' };
  }
}

export type InjectResult = { ok: true } | { ok: false; reason: string };

/**
 * Substitute a result for the held call and carry on. Returns `{ok:false,
 * reason}` — and sends nothing — when the value contains redacted content.
 */
export function injectAndResume(runId: string, pauseId: string, output: unknown): InjectResult {
  const reason = injectRefusal(output);
  if (reason !== undefined) return { ok: false, reason };
  sendResume(runId, { pauseId, action: 'inject', output });
  return { ok: true };
}

/**
 * Run the held call with edited arguments (0.6.0, contract C2) — the one new
 * outbound shape the editor needs, sent next to the other resumes through the
 * same `sendControl` path: `exec.resume {pauseId, action, input, requestId}`,
 * where `action` is `continue` at a `before` gate and `retry` after or on
 * error, and `input` holds ONLY the top-level keys the user changed (the app
 * keeps every other key at its live value). The app answers with
 * `exec.resumed {edited, requestId}` or `exec.refused {code, requestId}`.
 *
 * Sends nothing — and says why — when an argument still carries the
 * redaction placeholder or a truncation marker, or when there is nothing to
 * change: the editor already blocks both, this is the last line.
 */
export function editAndResume(
  runId: string,
  pause: Pick<Pause, 'pauseId' | 'point'>,
  input: Record<string, unknown>,
  requestId: string,
): InjectResult {
  if (Object.keys(input).length === 0) return { ok: false, reason: 'nothing was changed' };
  const marker = markerIn(input);
  if (marker !== undefined) {
    return {
      ok: false,
      reason:
        marker === 'placeholder'
          ? 'an argument still contains redacted content; replace it before running'
          : 'an argument still contains a truncated preview; replace it before running',
    };
  }
  sendResume(runId, { pauseId: pause.pauseId, action: editAction(pause.point), input, requestId });
  return { ok: true };
}

/**
 * Resume, but stop again at the next gate. Arms step mode first so the client
 * is already in step mode when it wakes up — the reverse order races the very
 * next gate the run reaches.
 */
export function stepGate(runId: string, pauseId: string): void {
  const source = sourceOf(runId);
  useUiStore.getState().setMode('step');
  sendControl(source, 'mode.set', { mode: 'step' });
  sendResume(runId, { pauseId, action: 'continue' });
}

/** Where a gate sits, in the words the UI uses for it. */
export function pausePointLabel(point: Pause['point']): string {
  return point === 'error' ? 'on error' : point === 'before' ? 'before call' : 'after call';
}
