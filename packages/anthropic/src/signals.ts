/**
 * Abort-signal plumbing (decisions.md #3).
 *
 * When a debugger is attached, user abort signals are CHAINED with the
 * debugger's run signal — never replaced — so the debugger's `abort` action
 * cancels an in-flight HTTP request, while the user's own cancellation still
 * works. Timeout-driven aborts (`AbortSignal.timeout()`, whose reason is named
 * `TimeoutError`) are filtered out while attached and reported once: a held
 * gate must not burn a caller's timeout budget.
 *
 * The Anthropic SDK's own per-request `timeout` option is NOT affected by
 * holds: every GraphMind gate for an LLM step is awaited *before* the SDK call
 * is made, so the request timer only starts once execution resumes.
 */

export function isTimeoutAbortReason(reason: unknown): boolean {
  return (
    (reason instanceof Error ||
      (typeof DOMException !== 'undefined' && reason instanceof DOMException)) &&
    reason.name === 'TimeoutError'
  );
}

/**
 * Chain `original` (the caller's signal) with `debuggerSignal` (the run
 * context's), filtering timeout-driven aborts out of `original`.
 * `onTimeoutNeutralized` fires for every swallowed timeout abort (callers
 * dedupe the warning). Returns `undefined` when there is nothing to chain.
 */
export function chainAbortSignals(
  original: AbortSignal | undefined,
  debuggerSignal: AbortSignal | undefined,
  onTimeoutNeutralized: () => void,
): AbortSignal | undefined {
  if (original === undefined && debuggerSignal === undefined) return undefined;
  const controller = new AbortController();

  const forward = (signal: AbortSignal, filterTimeouts: boolean): void => {
    const relay = (): void => {
      if (filterTimeouts && isTimeoutAbortReason(signal.reason)) {
        try {
          onTimeoutNeutralized();
        } catch {
          // never throw into the host
        }
        return;
      }
      controller.abort(signal.reason);
    };
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
  };

  if (original !== undefined) forward(original, true);
  if (debuggerSignal !== undefined) forward(debuggerSignal, false);
  return controller.signal;
}
