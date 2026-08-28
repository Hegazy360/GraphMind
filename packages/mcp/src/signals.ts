/**
 * Abort-signal plumbing (decisions.md #3).
 *
 * When a debugger is attached, the `extra.signal` an MCP request handler is
 * given is CHAINED with the debugger's run signal — never replaced — so an
 * `abort` gate decision reaches a handler that respects its signal, while the
 * client's own cancellation still gets through untouched.
 *
 * Timeout-driven aborts are filtered out of the incoming signal: an abort
 * whose reason is named `TimeoutError` (what `AbortSignal.timeout()` produces)
 * would otherwise burn its budget while a gate is held and kill the request
 * mid-debug. A real client cancellation (`notifications/cancelled`) aborts
 * with an `McpError`, not a `TimeoutError`, so it is passed through: the
 * request really is dead and the handler should stop. When detached, the
 * adapter does not touch signals at all.
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
