/**
 * Abort-signal plumbing (decisions.md #3).
 *
 * When a debugger is attached, user/SDK abort signals are CHAINED with the
 * debugger's run signal — never replaced — and timeout-driven aborts are
 * neutralized: an `AbortSignal.timeout()` handed to the OpenAI SDK through
 * `options.signal` aborts with a reason named `TimeoutError`, and a held gate
 * would otherwise burn that budget and kill the run mid-debug. Aborts with any
 * other reason (user aborts) pass through untouched. When detached, the
 * adapter does not touch signals at all.
 *
 * NB: the OpenAI SDK's own per-request `timeout` (milliseconds) is NOT
 * affected — it starts when the HTTP request is dispatched, which happens
 * after the `before` gate is released, so holds never eat into it.
 */

export function isTimeoutAbortReason(reason: unknown): boolean {
  return (
    (reason instanceof Error ||
      (typeof DOMException !== 'undefined' && reason instanceof DOMException)) &&
    reason.name === 'TimeoutError'
  );
}

/**
 * Chain `original` (the user's / SDK's signal) with `debuggerSignal` (the run
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
