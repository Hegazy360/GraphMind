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
import type { Pause, RunSource, RunState } from '../store/types.js';

/** The gate currently holding this run, if any. */
export function activePause(run: RunState | undefined): Pause | undefined {
  if (run === undefined) return undefined;
  for (const id of Object.keys(run.pauses)) {
    const pause = run.pauses[id];
    if (pause !== undefined && pause.active) return pause;
  }
  return undefined;
}

/** The gate holding `runId`, read straight from the store. */
export function heldGate(runId: string | undefined): Pause | undefined {
  if (runId === undefined) return undefined;
  return activePause(useRunStore.getState().runs[runId]);
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
