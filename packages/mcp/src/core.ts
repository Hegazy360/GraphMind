/**
 * AdapterCore: the shared state behind one `graphmind()` instance — the
 * session, one-shot warnings, the `waitForAttach` gate, the emit helpers, and
 * the run-scoped bookkeeping that lets a sampling call know which request node
 * it belongs under.
 *
 * Invariant (inherited from @graphmind-ai/client, re-enforced here): nothing in
 * this class may throw into the host app. `session.emit` / `session.gate`
 * already guard internally; the helpers here guard their own bookkeeping.
 */
import {
  GraphMindAbortError,
  toErrorInfo,
  type GraphNodeHint,
  type NodeKind,
  type RunContext,
  type RunStatus,
  type Session,
} from '@graphmind-ai/client';
import { chainAbortSignals } from './signals.js';
import { OnceWarner, type WarnSink } from './warn.js';

/** How many runs keep their "which node is the current parent" record. */
const MAX_TRACKED_RUNS = 256;

export interface StartNodeInput {
  nodeId: string;
  kind: NodeKind;
  name: string;
  instanceId: string;
  parentId?: string | undefined;
  input: unknown;
  /** Extra payload fields (the wire schema is loose and preserves them). */
  extra?: Record<string, unknown> | undefined;
}

export interface FinishNodeInput {
  nodeId: string;
  instanceId: string;
  output: unknown;
  durationMs: number;
  status: RunStatus;
  extra?: Record<string, unknown> | undefined;
}

export class AdapterCore {
  readonly warner: OnceWarner;

  /** Shared one-shot attach wait (the `waitForAttach` option). */
  private attachWait: Promise<void> | undefined;
  private attachWaitDone = false;

  /** runId -> the node a nested call (sampling) should hang under. */
  private readonly parentByRun = new Map<string, string>();
  /** runIds whose `graph.hint` has already been sent. */
  private readonly hintedRuns = new Set<string>();

  constructor(
    readonly session: Session,
    logger?: WarnSink,
    private readonly waitForAttach?: boolean | number,
  ) {
    this.warner = new OnceWarner(logger);
  }

  /**
   * The `waitForAttach` gate: on the FIRST `connect()` / instrumented request,
   * await `session.ready()` so the handshake (and armed breakpoints) land
   * before anything executes. One shared attempt; fail-open (a timeout just
   * continues detached). Returns `undefined` on the fast path so steady-state
   * calls cost a single boolean check.
   */
  maybeWaitForAttach(): Promise<void> | undefined {
    if (this.attachWaitDone) return undefined;
    const cfg = this.waitForAttach;
    if (cfg === undefined || cfg === false) {
      this.attachWaitDone = true;
      return undefined;
    }
    if (this.attachWait === undefined) {
      const done = (): void => {
        this.attachWaitDone = true;
      };
      // session.ready() never rejects; the catch is belt-and-braces (the
      // adapter must never throw into the host).
      this.attachWait = this.session
        .ready(typeof cfg === 'number' ? { timeoutMs: cfg } : {})
        .then(done, done);
    }
    return this.attachWait;
  }

  /**
   * Run `fn` inside a run context. An MCP request is a top-level unit of work,
   * so each one opens its own run — unless the caller is ALREADY inside a run
   * (a host that wrapped its own `gm.run`, or a handler invoked directly from
   * a test), in which case the existing run is reused so the graph stays one
   * connected piece instead of splitting into nested runs.
   */
  withRun<T>(name: string, fn: (ctx: RunContext | undefined) => Promise<T>): Promise<T> {
    const existing = this.session.currentRun();
    if (existing !== undefined) return fn(existing);
    return this.session.run(name, (ctx) => fn(ctx));
  }

  // -- events ---------------------------------------------------------------

  startNode(input: StartNodeInput): void {
    this.session.emit('node.started', {
      nodeId: input.nodeId,
      kind: input.kind,
      name: input.name,
      instanceId: input.instanceId,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      input: input.input,
      ...input.extra,
    });
  }

  finishNode(input: FinishNodeInput): void {
    this.session.emit('node.finished', {
      nodeId: input.nodeId,
      instanceId: input.instanceId,
      output: input.output,
      durationMs: input.durationMs,
      status: input.status,
      ...input.extra,
    });
  }

  errorNode(nodeId: string, instanceId: string, error: unknown): void {
    this.session.emit('node.error', { nodeId, instanceId, error: toErrorInfo(error) });
  }

  /**
   * Pre-announce the server's registered surface so the viewer renders the
   * whole graph grey before anything runs. Sent at most once per run (and once
   * for the session at connect time); a run that adds nothing is not re-sent.
   */
  emitGraphHint(nodes: readonly GraphNodeHint[], runId: string | undefined): void {
    try {
      if (nodes.length === 0) return;
      const key = runId ?? 'no-run';
      if (this.hintedRuns.has(key)) return;
      if (this.hintedRuns.size >= MAX_TRACKED_RUNS) this.hintedRuns.clear();
      this.hintedRuns.add(key);
      this.session.emit('graph.hint', { nodes: [...nodes] });
    } catch {
      // never throw into the host
    }
  }

  // -- run-scoped parent tracking (so sampling nests under its request) ------

  setParent(ctx: RunContext | undefined, nodeId: string): void {
    if (ctx === undefined) return;
    if (this.parentByRun.size >= MAX_TRACKED_RUNS) this.parentByRun.clear();
    this.parentByRun.set(ctx.runId, nodeId);
  }

  parentFor(ctx: RunContext | undefined): string | undefined {
    return ctx === undefined ? undefined : this.parentByRun.get(ctx.runId);
  }

  clearParent(ctx: RunContext | undefined, nodeId: string): void {
    if (ctx === undefined) return;
    if (this.parentByRun.get(ctx.runId) === nodeId) this.parentByRun.delete(ctx.runId);
  }

  // -- abort / signal plumbing (decisions.md #3) ----------------------------

  /**
   * The error to throw after an `abort` gate decision: an AbortError-named
   * reason, never a bare Error, so anything downstream that special-cases
   * cancellation treats it as terminal.
   */
  abortError(ctx: RunContext | undefined): Error {
    const reason = ctx !== undefined && ctx.signal.aborted ? ctx.signal.reason : undefined;
    return reason instanceof Error ? reason : new GraphMindAbortError();
  }

  /**
   * Chain the handler's own `extra.signal` with the debugger run's signal,
   * filtering timeout-driven aborts (warned once). Only called while attached.
   */
  chainSignal(
    original: AbortSignal | undefined,
    ctx: RunContext | undefined,
  ): AbortSignal | undefined {
    return (
      chainAbortSignals(original, ctx?.signal, () => this.warnTimeoutNeutralized()) ?? original
    );
  }

  warnTimeoutNeutralized(): void {
    this.warner.warn(
      'timeout-neutralized',
      'a timeout abort was neutralized while the debugger is attached (holds would burn timeout budgets); remove per-request timeouts while debugging. Client cancellations still work.',
    );
  }

  /**
   * Warned the first time a gate is held: MCP clients time out requests (the
   * SDK default is 60s) and cancel them, and no in-process debugger can stop
   * that. Better to say so once than to let someone conclude the tool broke.
   */
  warnHoldTimeout(): void {
    this.warner.warn(
      'hold-vs-client-timeout',
      'execution is held at a gate. MCP clients cancel requests that outlive their timeout (the SDK default is 60s) — a long hold can make the CLIENT give up on this request even though the server resumes correctly.',
    );
  }
}
