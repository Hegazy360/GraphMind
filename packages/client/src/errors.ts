/**
 * Abort plumbing.
 *
 * Spike RESULTS.md risk #4: throwing a plain Error out of SDK middleware
 * lands in the SDK's retry logic (retried up to maxRetries before
 * surfacing). The correct abort path is an AbortController: the session
 * aborts the run's controller with an `AbortError`-named reason, and the
 * adapter passes `ctx.signal` to the SDK call (or throws `ctx.signal.reason`
 * itself). AI SDKs treat AbortError as terminal — no retries.
 */
export class GraphMindAbortError extends Error {
  constructor(message = 'Run aborted by GraphMind debugger') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'GraphMindAbortError')
  );
}

export function toErrorInfo(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}
