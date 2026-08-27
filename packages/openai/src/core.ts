/**
 * AdapterCore: the shared state behind one `graphmind()` instance — the
 * session, token batching, invocation tracking, one-shot warnings, and the
 * emit helpers used by the client wrapper and the tool wrapper.
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
  type TokenDelta,
} from '@graphmind-ai/client';
import { LLM_NODE_ID, LLM_NODE_NAME, agentNodeId, toolNodeId } from './ids.js';
import { InvocationTracker } from './invocation.js';
import { chainAbortSignals } from './signals.js';
import { TokenBatcher } from './token-batcher.js';
import { OnceWarner, type WarnSink } from './warn.js';
import {
  isObject,
  parseToolInput,
  toolRoster,
  type ResponseOutputItemLike,
  type UsageWithExtras,
} from './sdk-types.js';

const MAX_TRACKED_PROVIDER_CALLS = 1000;

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
  usage?: UsageWithExtras | undefined;
  durationMs: number;
  status: RunStatus;
  extra?: Record<string, unknown> | undefined;
}

export class AdapterCore {
  readonly tracker = new InvocationTracker();
  readonly batcher: TokenBatcher;
  readonly warner: OnceWarner;

  /** Names registered via `wrapTools`, merged into `graph.hint`. */
  readonly gatedToolNames = new Set<string>();

  private readonly providerToolStarts = new Map<string, number>();

  /** Shared one-shot attach wait (the `waitForAttach` option). */
  private attachWait: Promise<void> | undefined;
  private attachWaitDone = false;

  constructor(
    readonly session: Session,
    logger?: WarnSink,
    tokenFlushIntervalMs?: number,
    private readonly waitForAttach?: boolean | number,
  ) {
    this.warner = new OnceWarner(logger);
    this.batcher = new TokenBatcher(
      (nodeId, deltas) => this.session.emit('node.token', { nodeId, deltas }),
      tokenFlushIntervalMs,
    );
  }

  /**
   * The `waitForAttach` gate: on the FIRST `gm.run()` / wrapped request /
   * wrapped tool call, await `session.ready()` so the handshake (and armed
   * breakpoints) land before anything executes. One shared attempt; fail-open
   * (a timeout just continues detached). Returns `undefined` on the fast path
   * (option off, or the one-shot wait already settled) so steady-state calls
   * cost a single boolean check.
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
    this.batcher.flushNode(input.nodeId);
    this.session.emit('node.finished', {
      nodeId: input.nodeId,
      instanceId: input.instanceId,
      output: input.output,
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      durationMs: input.durationMs,
      status: input.status,
      ...input.extra,
    });
  }

  errorNode(nodeId: string, instanceId: string, error: unknown): void {
    this.session.emit('node.error', { nodeId, instanceId, error: toErrorInfo(error) });
  }

  pushToken(nodeId: string, channel: TokenDelta['t'], value: string): void {
    if (value.length === 0) return;
    this.batcher.push(nodeId, { t: channel, v: value });
  }

  /**
   * `graph.hint` from the request's tool roster plus every name registered
   * through `wrapTools`, emitted on an invocation's first step so the viewer
   * can pre-render the whole graph grey. Provider-executed (built-in) tools
   * carry `providerExecuted`/`ungated` extra fields.
   */
  emitGraphHint(tools: unknown, ctx: RunContext | undefined): void {
    const nodes: (GraphNodeHint & Record<string, unknown>)[] = [];
    const agentId = ctx !== undefined ? agentNodeId(ctx.name) : undefined;
    if (ctx !== undefined && agentId !== undefined) {
      nodes.push({ nodeId: agentId, kind: 'agent', name: ctx.name });
    }
    nodes.push({
      nodeId: LLM_NODE_ID,
      kind: 'llm',
      name: LLM_NODE_NAME,
      ...(agentId !== undefined ? { parentId: agentId } : {}),
    });
    const seen = new Set<string>();
    for (const entry of toolRoster(tools)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const hint: GraphNodeHint & Record<string, unknown> = {
        nodeId: toolNodeId(entry.name),
        kind: 'tool',
        name: entry.name,
        parentId: LLM_NODE_ID,
      };
      // A tool wrapped with gm.wrapTools is gated locally even if the request
      // body labels it as something else.
      if (entry.providerExecuted && !this.gatedToolNames.has(entry.name)) {
        hint['providerExecuted'] = true;
        hint['ungated'] = true;
      }
      nodes.push(hint);
    }
    for (const name of this.gatedToolNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      nodes.push({ nodeId: toolNodeId(name), kind: 'tool', name, parentId: LLM_NODE_ID });
    }
    this.session.emit('graph.hint', { nodes });
  }

  // -- provider-executed tools (observe-only, decisions.md #4) --------------

  /** A built-in / MCP tool call OpenAI runs on its side: observe, never gate. */
  providerToolStarted(item: ResponseOutputItemLike, name: string): void {
    const instanceId = typeof item.id === 'string' ? item.id : undefined;
    if (instanceId === undefined) return;
    if (this.providerToolStarts.has(instanceId)) return;
    if (this.providerToolStarts.size >= MAX_TRACKED_PROVIDER_CALLS) {
      this.providerToolStarts.clear();
    }
    this.providerToolStarts.set(instanceId, Date.now());
    this.startNode({
      nodeId: toolNodeId(name),
      kind: 'tool',
      name,
      instanceId,
      parentId: LLM_NODE_ID,
      input: parseToolInput(item.arguments ?? item.input),
      extra: { providerExecuted: true, ungated: true },
    });
  }

  providerToolFinished(item: ResponseOutputItemLike, name: string): void {
    const instanceId = typeof item.id === 'string' ? item.id : undefined;
    if (instanceId === undefined) return;
    const startedAt = this.providerToolStarts.get(instanceId);
    // Only calls we observed starting as provider-executed are finished here.
    if (startedAt === undefined) return;
    this.providerToolStarts.delete(instanceId);
    const failed = item.error !== null && item.error !== undefined;
    this.finishNode({
      nodeId: toolNodeId(name),
      instanceId,
      output: item.output ?? item.error ?? { status: item.status },
      durationMs: Date.now() - startedAt,
      status: failed || item.status === 'failed' ? 'error' : 'ok',
      extra: { providerExecuted: true },
    });
  }

  // -- abort / signal plumbing (decisions.md #3) ----------------------------

  /**
   * The error to throw after an `abort` gate decision: an AbortError-named
   * reason so SDK retry logic treats it as terminal (never a bare Error).
   */
  abortError(ctx: RunContext | undefined): Error {
    const reason = ctx !== undefined && ctx.signal.aborted ? ctx.signal.reason : undefined;
    return reason instanceof Error ? reason : new GraphMindAbortError();
  }

  /**
   * Chain a user/SDK signal with the debugger run's signal, filtering
   * timeout-driven aborts (warned once). Only called while attached.
   */
  chainSignal(original: AbortSignal | undefined): AbortSignal | undefined {
    const ctx = this.session.currentRun();
    return (
      chainAbortSignals(original, ctx?.signal, () => this.warnTimeoutNeutralized()) ?? original
    );
  }

  /** Request options with the abort signal chained/neutralized. */
  prepareRequestOptions(options: unknown): unknown {
    try {
      if (!this.session.attached) return options;
      const opts = isObject(options) ? options : undefined;
      const raw = opts?.['signal'];
      const original = raw instanceof AbortSignal ? raw : undefined;
      const chained = this.chainSignal(original);
      if (chained === undefined || chained === original) return options;
      return { ...(opts ?? {}), signal: chained };
    } catch {
      return options;
    }
  }

  warnTimeoutNeutralized(): void {
    this.warner.warn(
      'timeout-neutralized',
      'a timeout abort was neutralized while the debugger is attached (holds would burn timeout budgets); remove `AbortSignal.timeout()` request signals while debugging. User aborts still work.',
    );
  }

  dispose(): void {
    try {
      this.batcher.dispose();
    } catch {
      // never throw into the host
    }
  }
}
