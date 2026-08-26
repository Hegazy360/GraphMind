/**
 * AdapterCore: the shared state behind one `graphmind()` instance — the
 * session, token batching, invocation tracking, one-shot warnings, and the
 * emit helpers used by both the model middleware and the tool wrapper.
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
  type TokenUsage,
} from '@graphmind-ai/client';
import { LLM_NODE_ID, LLM_NODE_NAME, agentNodeId, toolNodeId } from './ids.js';
import { InvocationTracker } from './invocation.js';
import { chainAbortSignals } from './signals.js';
import { TokenBatcher } from './token-batcher.js';
import { OnceWarner, type WarnSink } from './warn.js';
import {
  parseToolInput,
  type CallParamsLike,
  type StreamPartLike,
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
  output: unknown;
  usage?: TokenUsage | undefined;
  durationMs: number;
  status: RunStatus;
  extra?: Record<string, unknown> | undefined;
}

export class AdapterCore {
  readonly tracker = new InvocationTracker();
  readonly batcher: TokenBatcher;
  readonly warner: OnceWarner;

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
   * The `waitForAttach` gate: on the FIRST `gm.run()` / wrapped model step /
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
      output: input.output,
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      durationMs: input.durationMs,
      status: input.status,
      ...input.extra,
    });
  }

  errorNode(nodeId: string, error: unknown): void {
    this.session.emit('node.error', { nodeId, error: toErrorInfo(error) });
  }

  pushToken(nodeId: string, channel: TokenDelta['t'], value: string): void {
    if (value.length === 0) return;
    this.batcher.push(nodeId, { t: channel, v: value });
  }

  /**
   * `graph.hint` from the step's tool roster (emitted on an invocation's
   * first step) so the viewer can pre-render the full graph grey.
   * Provider-executed tools carry `providerExecuted`/`ungated` extra fields.
   */
  emitGraphHint(params: CallParamsLike, ctx: RunContext | undefined): void {
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
    for (const def of params.tools ?? []) {
      const name = def?.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const hint: GraphNodeHint & Record<string, unknown> = {
        nodeId: toolNodeId(name),
        kind: 'tool',
        name,
        parentId: LLM_NODE_ID,
      };
      if (def.type === 'provider') {
        hint['providerExecuted'] = true;
        hint['ungated'] = true;
      }
      nodes.push(hint);
    }
    this.session.emit('graph.hint', { nodes });
  }

  // -- provider-executed tools (observe-only, decisions.md #4) --------------

  providerToolStarted(part: StreamPartLike): void {
    const { toolName, toolCallId } = part;
    if (typeof toolName !== 'string' || typeof toolCallId !== 'string') return;
    if (this.providerToolStarts.has(toolCallId)) return;
    if (this.providerToolStarts.size >= MAX_TRACKED_PROVIDER_CALLS) {
      this.providerToolStarts.clear();
    }
    this.providerToolStarts.set(toolCallId, Date.now());
    this.startNode({
      nodeId: toolNodeId(toolName),
      kind: 'tool',
      name: toolName,
      instanceId: toolCallId,
      parentId: LLM_NODE_ID,
      input: parseToolInput(part.input),
      extra: { providerExecuted: true, ungated: true },
    });
  }

  providerToolFinished(part: StreamPartLike & { preliminary?: boolean }): void {
    const { toolName, toolCallId } = part;
    if (typeof toolName !== 'string' || typeof toolCallId !== 'string') return;
    if (part.preliminary === true) return;
    const startedAt = this.providerToolStarts.get(toolCallId);
    // Only calls we observed starting as provider-executed are finished here.
    if (startedAt === undefined) return;
    this.providerToolStarts.delete(toolCallId);
    this.finishNode({
      nodeId: toolNodeId(toolName),
      output: part.result,
      durationMs: Date.now() - startedAt,
      status: part.isError === true ? 'error' : 'ok',
      extra: { providerExecuted: true, instanceId: toolCallId },
    });
  }

  // -- abort / signal plumbing (decisions.md #3) ----------------------------

  /** The error to throw after an `abort` gate decision: an AbortError-named
   * reason so AI SDK retry logic treats it as terminal (never a bare Error). */
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

  /** Tool execute options with the abort signal chained/neutralized. */
  prepareToolOptions(options: unknown): unknown {
    try {
      if (!this.session.attached || options === null || typeof options !== 'object') {
        return options;
      }
      const opts = options as { abortSignal?: AbortSignal | undefined };
      const chained = this.chainSignal(opts.abortSignal);
      if (chained === undefined || chained === opts.abortSignal) return options;
      return { ...opts, abortSignal: chained };
    } catch {
      return options;
    }
  }

  warnTimeoutNeutralized(): void {
    this.warner.warn(
      'timeout-neutralized',
      'a timeout abort was neutralized while the debugger is attached (holds would burn timeout budgets); remove `timeout` configs while debugging. User aborts still work.',
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
