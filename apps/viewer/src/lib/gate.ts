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
import type { ResumeAction } from '@graphmind-ai/schema';
import { sendControl } from '../connection/ServerConnection.js';
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

/** Release a gate with `continue` / `retry` / `abort`. */
export function resumeGate(runId: string, pauseId: string, action: ResumeAction): void {
  sendControl(sourceOf(runId), 'exec.resume', { pauseId, action }, runId);
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
  sendControl(sourceOf(runId), 'exec.resume', { pauseId, action: 'inject', output }, runId);
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
  sendControl(source, 'exec.resume', { pauseId, action: 'continue' }, runId);
}

/** Where a gate sits, in the words the UI uses for it. */
export function pausePointLabel(point: Pause['point']): string {
  return point === 'error' ? 'on error' : point === 'before' ? 'before call' : 'after call';
}
