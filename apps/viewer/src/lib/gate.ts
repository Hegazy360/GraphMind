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

/** Substitute a result for the held call and carry on. */
export function injectAndResume(runId: string, pauseId: string, output: unknown): void {
  sendControl(sourceOf(runId), 'exec.resume', { pauseId, action: 'inject', output }, runId);
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
