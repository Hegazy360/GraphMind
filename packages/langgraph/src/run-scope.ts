/**
 * Auto-run: give one LangChain root run its own GraphMind run.
 *
 * `session.run(name, fn)` is the only way to open a run context, and it does
 * that with AsyncLocalStorage — the store is live for `fn` and for `fn`'s own
 * async continuations. Callback-handler methods are invoked by LangChain from
 * the graph's async context, not from ours, so they can't just "be inside" the
 * run. `RunScope` bridges that: `session.run` parks a pump loop inside the run
 * context, and `scope.run(fn)` hands `fn` to that loop, which starts it from
 * inside the scope. `fn` therefore sees the right `currentRun()` — the right
 * runId on every event and the right AbortController for `abort` gates.
 *
 * Tasks are started, not awaited, by the loop, so two LangGraph branches
 * holding gates at the same time never block each other (proven in
 * test/handler.test.ts).
 *
 * FAIL-OPEN: if the scope never opened or has already closed, `run()` executes
 * the task immediately, outside the run context — attribution degrades to the
 * session's implicit run, execution never stalls. `run()` never rejects.
 */
import type { RunContext, Session } from '@graphmind-ai/client';

export class RunScope {
  /** The run context, once `session.run` has entered it. */
  ctx: RunContext | undefined;

  private readonly pending: (() => void)[] = [];
  private wake: (() => void) | undefined;
  private started = false;
  private ending = false;
  private endError: unknown;
  private closed: Promise<void> | undefined;

  /**
   * Open a run named `name` and park the pump inside it. Returns a scope that
   * is already armed (`session.run` invokes its callback synchronously), or an
   * unarmed one — which is still safe — if the session refused.
   */
  static open(session: Session, name: string): RunScope {
    const scope = new RunScope();
    try {
      scope.closed = session.run(name, async (ctx) => {
        scope.ctx = ctx;
        scope.started = true;
        await scope.pump();
      });
      // `session.run` never rejects on our behalf (our callback cannot throw),
      // but an unhandled rejection must never reach the host.
      scope.closed.catch(() => undefined);
    } catch {
      scope.started = false;
    }
    return scope;
  }

  get open(): boolean {
    return this.started && !this.ending;
  }

  /**
   * Execute `fn` inside the run context and resolve with its result.
   * Resolves with `fallback` if `fn` throws — this is instrumentation, never
   * the host's own work.
   */
  run<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
    if (!this.open) return this.runDetached(fn, fallback);
    return new Promise<T>((resolve) => {
      this.pending.push(() => {
        // Called by the pump, i.e. from inside `session.run`'s ALS scope.
        void (async () => {
          try {
            resolve(await fn());
          } catch {
            resolve(fallback);
          }
        })();
      });
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    });
  }

  /**
   * Close the run: drain queued tasks, then let `session.run` finish.
   * Pass the failure that ended the LangChain root run to have the pump
   * rethrow it inside the run context, so `run.finished` carries
   * `status: 'error'` (or `'aborted'`) and the error info.
   */
  async end(error?: unknown): Promise<void> {
    if (!this.started) return;
    if (!this.ending) {
      this.ending = true;
      if (error !== undefined) this.endError = error;
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
    }
    try {
      await this.closed;
    } catch {
      // `session.run` rethrows the failure we handed it; that is expected.
    }
  }

  private async runDetached<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /** The loop that lives inside the run context. Never throws. */
  private async pump(): Promise<void> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        try {
          next();
        } catch {
          // a task starter cannot break the pump
        }
        continue;
      }
      if (this.ending) {
        if (this.endError !== undefined) throw this.endError;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
