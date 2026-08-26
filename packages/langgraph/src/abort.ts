/**
 * Deliberate aborts.
 *
 * The callback handler runs with `raiseError: true` so a throw out of a
 * handler method reaches the host — that is the only way a *callback* can stop
 * a LangChain run. That makes it critical to distinguish the one error we mean
 * to raise (an `abort` gate decision) from any accidental internal failure,
 * which must stay invisible to the host. Every handler body is wrapped in a
 * guard that rethrows only errors marked here.
 */

const DELIBERATE = Symbol.for('graphmind.deliberateAbort');

/** Mark an error as "GraphMind meant to throw this". */
export function markDeliberate<E extends Error>(error: E): E {
  try {
    Object.defineProperty(error, DELIBERATE, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // frozen error object: the guard falls back to swallowing it, which is
    // the safe direction (fail-open).
  }
  return error;
}

export function isDeliberateAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[DELIBERATE] === true
  );
}
