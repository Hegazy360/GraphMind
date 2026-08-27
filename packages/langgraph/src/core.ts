/**
 * AdapterCore: the shared state behind one `graphmind()` instance — the
 * session, token batching, payload limits, one-shot warnings, the registry of
 * wrapper-gated tools, and the emit helpers used by both the callback handler
 * and the tool wrappers.
 *
 * Invariant (inherited from @graphmind-ai/client, re-enforced here): nothing
 * here may throw into the host app. `session.emit` / `session.gate` guard
 * internally; the helpers guard their own bookkeeping.
 */
import {
  GraphMindAbortError,
  toErrorInfo,
  type NodeKind,
  type RunContext,
  type RunStatus,
  type Session,
  type TokenDelta,
  type TokenUsage,
} from '@graphmind-ai/client';
import { DEFAULT_MAX_PAYLOAD_CHARS, safePayload } from './payload.js';
import { TokenBatcher, type TokenBatchSink } from './token-batcher.js';
import { OnceWarner, type WarnSink } from './warn.js';

/** Which chain runs become graph nodes. */
export type ChainPolicy = 'all' | 'langgraph' | 'none';

/** How an `abort` gate decision stops a LangChain run. */
export type AbortMode = 'throw' | 'signal';

export interface CoreOptions {
  logger?: WarnSink | undefined;
  tokenFlushIntervalMs?: number | undefined;
  maxPayloadChars?: number | undefined;
  chains?: ChainPolicy | undefined;
  autoRun?: boolean | undefined;
  abortMode?: AbortMode | undefined;
  waitForAttach?: boolean | number | undefined;
}

export interface StartNodeInput {
  nodeId: string;
  kind: NodeKind;
  name: string;
  instanceId: string;
  parentId?: string | undefined;
  input?: unknown;
  /** Extra payload fields (the wire schema is loose and preserves them). */
  extra?: Record<string, unknown> | undefined;
}

export interface FinishNodeInput {
  nodeId: string;
  instanceId: string;
  output?: unknown;
  usage?: TokenUsage | undefined;
  durationMs: number;
  status: RunStatus;
  extra?: Record<string, unknown> | undefined;
}

/** What a tool wrapper did to a call, merged into the handler's `node.finished`. */
export interface ToolAnnotation {
  injected?: boolean;
  attempts?: number;
  aborted?: boolean;
  recoveredFromError?: boolean;
}

/**
 * What the callback handler knows about a tool run, published for the tool
 * wrapper that is about to execute it: the node identity the handler already
 * announced, and the run scope its events belong to. Without a link (no
 * handler attached) a wrapper owns the node events itself.
 */
export interface ToolRunLink {
  nodeId: string;
  instanceId: string;
  /** Executes instrumentation inside the owning run context. */
  runIn: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

const MAX_TOOL_ANNOTATIONS = 1000;
const MAX_HINTED_RUNS = 1000;

export class AdapterCore {
  readonly warner: OnceWarner;
  readonly batcher: TokenBatcher;
  readonly maxPayloadChars: number;
  readonly chains: ChainPolicy;
  readonly autoRun: boolean;
  readonly abortMode: AbortMode;

  /**
   * Tools wrapped by `wrapStructuredTool` — the wrapper owns their gates (it
   * can inject and retry; a callback cannot), so the handler must not gate
   * them a second time. Keyed by tool name, which is what a callback sees.
   */
  readonly wrapperGatedTools = new Set<string>();

  /** Per-tool-run notes left by a wrapper for the handler to attach. */
  private readonly toolAnnotations = new Map<string, ToolAnnotation>();

  /** Node identity + run scope published by the handler, keyed by tool runId. */
  private readonly toolLinks = new Map<string, ToolRunLink>();

  /** Every run scope currently open, so un-linked wrappers can find the run. */
  private readonly openScopes = new Set<{ runIn: <T>(fn: () => T | Promise<T>) => Promise<T> }>();

  /**
   * Handlers with a run still open. Registered only while a run is in flight,
   * so a long-lived process that creates a handler per invocation does not
   * accumulate them; `gm.dispose()` closes whatever is left.
   */
  readonly openHandlers = new Set<{ close: () => Promise<void> }>();

  /**
   * The last `gm.hintGraph()` roster, replayed into every run a handler opens.
   *
   * `hintGraph()` is documented to be called BEFORE `graph.invoke(...)`, which
   * means there is no run open yet: emitting at call time would put the hint in
   * the session's IMPLICIT run — which `session.emit` opens (and announces with
   * a `run.started`) on the spot, so the viewer's run list gains an empty
   * placeholder beside the real run, and the run the graph actually opens still
   * never sees the hint. Storing the roster and emitting it as the first event
   * of each run instead is what makes the documented order work; the hint still
   * lands before any node executes, because a handler opens its run from the
   * root `handleChainStart`, ahead of every node body.
   */
  private graphHintNodes: { nodeId: string; kind: 'chain'; name: string }[] | undefined;

  /** Runs this roster has already been emitted into (see `replayGraphHint`). */
  private readonly graphHintRuns = new Set<string>();

  /** Remember a `hintGraph()` roster so new runs can be pre-rendered too. */
  setGraphHint(nodes: { nodeId: string; kind: 'chain'; name: string }[]): void {
    this.graphHintNodes = nodes.length > 0 ? nodes : undefined;
    this.graphHintRuns.clear(); // a new roster deserves re-announcing
  }

  /**
   * Emit the stored roster into the run that is currently open. Never emits
   * outside a run: that is what used to conjure the empty implicit run. At most
   * once per run, so a `hintGraph()` called inside `gm.run(...)` and the replay
   * at run open do not announce the same roster twice.
   */
  replayGraphHint(): void {
    const nodes = this.graphHintNodes;
    if (nodes === undefined) return;
    const runId = this.session.currentRun()?.runId;
    if (runId === undefined) return;
    if (this.graphHintRuns.has(runId)) return;
    if (this.graphHintRuns.size >= MAX_HINTED_RUNS) this.graphHintRuns.clear();
    this.graphHintRuns.add(runId);
    this.session.emit('graph.hint', { nodes });
  }

  /**
   * Errors already gated once. A LangGraph failure surfaces as
   * handleToolError -> handleChainError (node) -> handleChainError (root);
   * pausing three times on one error would be hostile.
   */
  private readonly gatedErrors = new WeakSet<object>();

  private readonly waitForAttach: boolean | number | undefined;
  private attachWait: Promise<void> | undefined;
  private attachWaitDone = false;

  constructor(
    readonly session: Session,
    options: CoreOptions = {},
  ) {
    this.warner = new OnceWarner(options.logger);
    this.batcher = new TokenBatcher(
      (nodeId, deltas) => this.session.emit('node.token', { nodeId, deltas }),
      options.tokenFlushIntervalMs,
    );
    this.maxPayloadChars = options.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS;
    this.chains = options.chains ?? 'all';
    this.autoRun = options.autoRun ?? true;
    this.abortMode = options.abortMode ?? 'throw';
    this.waitForAttach = options.waitForAttach;
  }

  /**
   * The `waitForAttach` gate: on the FIRST run/handler/tool call, await
   * `session.ready()` so the handshake (and armed breakpoints) land before
   * anything executes. One shared attempt; fail-open (a timeout continues
   * detached). Returns `undefined` on the fast path so steady-state calls cost
   * a single boolean check.
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
      // session.ready() never rejects; the catch is belt-and-braces.
      this.attachWait = this.session
        .ready(typeof cfg === 'number' ? { timeoutMs: cfg } : {})
        .then(done, done);
    }
    return this.attachWait;
  }

  // -- events ---------------------------------------------------------------

  startNode(input: StartNodeInput): void {
    this.session.emit('node.started', {
      nodeId: input.nodeId,
      kind: input.kind,
      name: input.name,
      instanceId: input.instanceId,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      input: this.payload(input.input),
      ...input.extra,
    });
  }

  finishNode(input: FinishNodeInput): void {
    // Emit any queued deltas here (synchronously, in the caller's run context)
    // so node.token always precedes the node.finished it belongs to.
    const deltas = this.batcher.take(input.nodeId);
    if (deltas !== undefined) this.session.emit('node.token', { nodeId: input.nodeId, deltas });
    this.session.emit('node.finished', {
      nodeId: input.nodeId,
      instanceId: input.instanceId,
      output: this.payload(input.output),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      durationMs: input.durationMs,
      status: input.status,
      ...input.extra,
    });
  }

  errorNode(nodeId: string, instanceId: string, error: unknown): void {
    this.session.emit('node.error', {
      nodeId,
      instanceId,
      error: toErrorInfo(error),
    });
  }

  /**
   * Queue one streamed delta. `sink` (built once per run by
   * `tokenSinkFor`) is stored with the batch so the interval flush — which
   * fires from a bare timer, outside any run context — still emits into the
   * right run.
   */
  pushToken(nodeId: string, channel: TokenDelta['t'], value: string, sink?: TokenBatchSink): void {
    if (value.length === 0) return;
    this.batcher.push(nodeId, { t: channel, v: value }, sink);
  }

  /** A `node.token` emitter bound to one run's context. Build once per run. */
  tokenSinkFor(runIn: <T>(fn: () => T | Promise<T>) => Promise<T>): TokenBatchSink {
    return (nodeId, deltas) => {
      void runIn(() => this.session.emit('node.token', { nodeId, deltas })).catch(() => undefined);
    };
  }

  payload(value: unknown): unknown {
    return safePayload(value, this.maxPayloadChars);
  }

  // -- tool wrapper handshake ----------------------------------------------

  annotateTool(runId: string | undefined, annotation: ToolAnnotation & Record<string, unknown>): void {
    if (runId === undefined) return;
    if (this.toolAnnotations.size >= MAX_TOOL_ANNOTATIONS) this.toolAnnotations.clear();
    this.toolAnnotations.set(runId, { ...this.toolAnnotations.get(runId), ...annotation });
  }

  takeToolAnnotation(runId: string): ToolAnnotation | undefined {
    const annotation = this.toolAnnotations.get(runId);
    if (annotation !== undefined) this.toolAnnotations.delete(runId);
    return annotation;
  }

  linkToolRun(runId: string, link: ToolRunLink): void {
    if (this.toolLinks.size >= MAX_TOOL_ANNOTATIONS) this.toolLinks.clear();
    this.toolLinks.set(runId, link);
  }

  unlinkToolRun(runId: string): void {
    this.toolLinks.delete(runId);
  }

  toolLink(runId: string | undefined): ToolRunLink | undefined {
    return runId === undefined ? undefined : this.toolLinks.get(runId);
  }

  openScope(scope: { runIn: <T>(fn: () => T | Promise<T>) => Promise<T> }): void {
    this.openScopes.add(scope);
  }

  closeScope(scope: { runIn: <T>(fn: () => T | Promise<T>) => Promise<T> }): void {
    this.openScopes.delete(scope);
  }

  /**
   * The run scope to attribute un-linked instrumentation to (a plain wrapped
   * function called from inside an auto-run graph). Unambiguous only while a
   * single run is open; with several concurrent runs the caller falls back to
   * the ambient AsyncLocalStorage context, which is what `gm.run()` provides.
   */
  soleScope(): { runIn: <T>(fn: () => T | Promise<T>) => Promise<T> } | undefined {
    if (this.openScopes.size !== 1) return undefined;
    return this.openScopes.values().next().value;
  }

  /** Run instrumentation in the right run context for a (maybe) tool runId. */
  runIn<T>(runId: string | undefined, fn: () => T | Promise<T>): Promise<T> {
    const target = this.toolLink(runId) ?? this.soleScope();
    if (target === undefined) return (async () => fn())();
    return target.runIn(fn);
  }

  // -- error gate de-duplication -------------------------------------------

  /** True the first time an error object reaches a gate; false afterwards. */
  claimError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return true;
    if (this.gatedErrors.has(error)) return false;
    this.gatedErrors.add(error);
    return true;
  }

  // -- abort ----------------------------------------------------------------

  /**
   * The error thrown after an `abort` gate decision: AbortError-named so
   * LangChain/LangGraph treat it as terminal rather than a retryable failure.
   */
  abortError(ctx: RunContext | undefined): Error {
    const reason = ctx !== undefined && ctx.signal.aborted ? ctx.signal.reason : undefined;
    return reason instanceof Error ? reason : new GraphMindAbortError();
  }

  dispose(): void {
    try {
      this.batcher.dispose();
    } catch {
      // never throw into the host
    }
    this.toolAnnotations.clear();
    this.toolLinks.clear();
    this.openScopes.clear();
  }
}
