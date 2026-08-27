/**
 * The GraphMind callback handler: LangChain's run tree, mapped onto GraphMind
 * nodes, with real gates.
 *
 * WHY GATES WORK HERE. `CallbackManager` awaits every handler method when the
 * handler sets `awaitHandlers` (`_awaitHandler: true`, which `raiseError: true`
 * also implies), and it does so BEFORE the thing being announced runs:
 * `StructuredTool.call` awaits `handleToolStart` before `_call`, a Pregel node
 * awaits `handleChainStart` before the node body, a chat model awaits
 * `handleChatModelStart` before the provider request. Awaiting a GraphMind gate
 * inside those methods therefore genuinely HOLDS execution — proven by
 * timestamp ordering in test/handler.test.ts, not assumed.
 *
 * WHAT CALLBACKS CANNOT DO. A handler has no return channel into the thing it
 * announced, so `inject` (substitute a result) and `retry` (run it again) are
 * impossible through callbacks alone; they need the tool wrappers in
 * wrap-tools.ts. `abort` works, because a handler that throws while
 * `raiseError` is set propagates into the host run.
 *
 * NEVER THROW. Since a throw does propagate, every handler body runs inside
 * `guard()`, which rethrows ONLY errors marked deliberate (abort.ts) and turns
 * anything else into a one-shot warning.
 *
 * RUN ATTRIBUTION. Every body that emits or gates runs inside `inRoot`, which
 * hands the work to the `RunScope` of its root invocation so events carry that
 * run's id and `abort` reaches that run's AbortController.
 */
import { isAbortError, type NodeKind, type RunContext, type TokenUsage } from '@graphmind-ai/client';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { isDeliberateAbort, markDeliberate } from './abort.js';
import type { AdapterCore } from './core.js';
import { nodeIdFor } from './ids.js';
import {
  compactMessages,
  langgraphTaskKey,
  parseToolInput,
  resolveChainStartArgs,
  serializedName,
  textFromLLMResult,
  toolArgsDeltas,
  unwrapToolOutput,
  usageFromLLMResult,
  type LLMResultLike,
  type NewTokenFieldsLike,
  type SerializedLike,
} from './lc-types.js';
import { RunScope } from './run-scope.js';
import type { TokenBatchSink } from './token-batcher.js';
import { RunTree, type RunRecord } from './run-tree.js';

const HIDDEN_TAG = 'langsmith:hidden';

export interface HandlerOptions {
  /**
   * Name of the auto-created run (and of its agent node) when the graph runs
   * outside `gm.run(...)`. Default: the root runnable's own name.
   */
  runName?: string | undefined;
}

interface OpenRoot {
  /** undefined when the run came from an ambient `gm.run()` (no scope needed). */
  scope: RunScope | undefined;
  ctx: RunContext | undefined;
  /** Stable identity registered with the core so tool wrappers can find it. */
  runner: { runIn: <T>(fn: () => T | Promise<T>) => Promise<T> };
  /** `node.token` emitter bound to this run; built once, used per token. */
  tokenSink: TokenBatchSink;
}

export class GraphMindCallbackHandler extends BaseCallbackHandler {
  name = 'graphmind';

  /**
   * Aborted when a gate resolves with `abort`. Pass it as the LangChain
   * config's `signal` (`gm.config()` does) so an abort also cancels work the
   * handler cannot throw into — in-flight provider requests, the Pregel loop
   * between steps, `interrupt()` waits.
   */
  readonly abortController = new AbortController();

  private readonly tree = new RunTree();
  private readonly roots = new Map<string, OpenRoot>();
  private readonly options: HandlerOptions;

  constructor(
    private readonly core: AdapterCore,
    options: HandlerOptions = {},
  ) {
    super({
      _awaitHandler: true,
      // `throw` mode needs LangChain to propagate the abort we raise. Every
      // body is guarded, so nothing else can escape.
      raiseError: core.abortMode === 'throw',
    });
    this.options = options;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Close any run still open (called by `gm.dispose()`). Idempotent. */
  async close(): Promise<void> {
    const roots = [...this.roots.values()];
    this.roots.clear();
    this.tree.clear();
    this.core.openHandlers.delete(this);
    for (const root of roots) {
      this.core.closeScope(root.runner);
      try {
        await root.scope?.end();
      } catch {
        // never throw into the host
      }
    }
  }

  // -- chains ---------------------------------------------------------------

  override async handleChainStart(
    chain: SerializedLike,
    inputs: unknown,
    runId: string,
    // NOTE: positions 4/7/8 differ between @langchain/core's type declaration
    // and its runtime call site; `resolveChainStartArgs` accepts either.
    arg4?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    arg7?: string,
    arg8?: string,
  ): Promise<void> {
    return this.guard('chain-start', async () => {
      const { parentRunId, runName } = resolveChainStartArgs(arg4, arg7, arg8);
      const langgraphNode = readString(metadata?.['langgraph_node']);
      const name = langgraphNode ?? runName ?? serializedName(chain) ?? 'chain';

      if (parentRunId === undefined) {
        await this.startRoot(runId, this.options.runName ?? name, inputs, metadata, tags);
        return;
      }

      const rootRunId = this.tree.rootFor(runId, parentRunId);
      const task = langgraphTaskKey(metadata);
      // LangGraph wraps a node body in an INNER run that inherits the task's
      // metadata verbatim, so naming it from `langgraph_node` would emit a
      // second chain node with the same nodeId as its parent — a self-loop on
      // any viewer laying the run out as a DAG, and a doubled step count.
      // It is one of "LangGraph's own internals" the `chains` policy already
      // excludes; folding it into the task run keeps its children (the model
      // call, nested tools) attached to the node they really belong to.
      if (task !== undefined && this.tree.get(parentRunId)?.langgraphTask === task) {
        this.passthrough(runId, rootRunId, parentRunId, task);
        return;
      }
      if (!this.shouldEmitChain(langgraphNode, tags)) {
        this.passthrough(runId, rootRunId, parentRunId, task);
        return;
      }

      const record = this.open(runId, rootRunId, parentRunId, 'chain', name, runId, task);
      const extra: Record<string, unknown> = {};
      if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;
      const step = metadata?.['langgraph_step'];
      if (typeof step === 'number') extra['langgraphStep'] = step;
      const threadId = readString(metadata?.['thread_id']);
      if (threadId !== undefined) extra['threadId'] = threadId;
      if (tags !== undefined && tags.length > 0) extra['tags'] = tags;

      await this.inRoot(rootRunId, async () => {
        this.emitStart(record, inputs, extra);
        await this.gateBefore(record);
      });
    });
  }

  override async handleChainEnd(outputs: unknown, runId: string): Promise<void> {
    return this.guard('chain-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      if (record.emitted) {
        await this.inRoot(record.rootRunId, async () => {
          this.emitFinish(record, outputs, 'ok');
          await this.gateAfter(record);
        });
      }
      await this.closeRoot(record);
    });
  }

  override async handleChainError(error: unknown, runId: string): Promise<void> {
    return this.guard('chain-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.inRoot(record.rootRunId, () => this.failRun(record, error));
      await this.closeRoot(record, error);
    });
  }

  // -- language models ------------------------------------------------------

  override async handleChatModelStart(
    llm: SerializedLike,
    messages: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.guard('llm-start', () =>
      this.startLlm(
        llm,
        { messages: compactMessages(messages) },
        runId,
        parentRunId,
        metadata,
        runName,
      ),
    );
  }

  override async handleLLMStart(
    llm: SerializedLike,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.guard('llm-start', () =>
      this.startLlm(llm, { prompts }, runId, parentRunId, metadata, runName),
    );
  }

  override async handleLLMNewToken(
    token: string,
    _idx: unknown,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    // LangChain hands the whole streamed chunk here; `token` is only its text.
    fields?: NewTokenFieldsLike,
  ): Promise<void> {
    return this.guard('llm-token', async () => {
      const record = this.tree.get(runId);
      if (record === undefined || !record.emitted) return;
      const sink = this.roots.get(record.rootRunId)?.tokenSink;
      if (typeof token === 'string') this.core.pushToken(record.nodeId, 'text', token, sink);
      // While a tool call streams, `token` is empty and the JSON arguments
      // arrive as `tool_call_chunks[].args` substrings on the chunk's message.
      for (const delta of toolArgsDeltas(fields)) {
        this.core.pushToken(record.nodeId, 'tool-args', delta, sink);
      }
    });
  }

  override async handleLLMEnd(output: LLMResultLike, runId: string): Promise<void> {
    return this.guard('llm-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      const usage = usageFromLLMResult(output);
      const text = textFromLLMResult(output);
      await this.inRoot(record.rootRunId, () =>
        this.emitFinish(record, { text }, 'ok', { usage }),
      );
      await this.closeRoot(record);
    });
  }

  override async handleLLMError(error: unknown, runId: string): Promise<void> {
    return this.guard('llm-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.inRoot(record.rootRunId, () => this.failRun(record, error));
      await this.closeRoot(record, error);
    });
  }

  // -- tools ----------------------------------------------------------------

  override async handleToolStart(
    tool: SerializedLike,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): Promise<void> {
    return this.guard('tool-start', async () => {
      const name = runName ?? serializedName(tool) ?? 'tool';
      if (parentRunId === undefined) await this.openRoot(runId, name);
      const rootRunId = this.tree.rootFor(runId, parentRunId);
      const record = this.open(runId, rootRunId, parentRunId, 'tool', name, toolCallId ?? runId);
      // A wrapped tool gates in its own wrapper, where inject/retry ARE
      // possible; gating here too would pause twice for one call.
      record.gatedByWrapper = this.core.wrapperGatedTools.has(name);

      const extra: Record<string, unknown> = { runId };
      if (toolCallId !== undefined) extra['toolCallId'] = toolCallId;
      extra['gates'] = record.gatedByWrapper ? 'full' : 'before+error';
      const langgraphNode = readString(metadata?.['langgraph_node']);
      if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;

      // Publish the node identity + run scope for a wrapper about to execute
      // this same run (see wrap-tools.ts).
      const runner = this.roots.get(rootRunId)?.runner;
      this.core.linkToolRun(runId, {
        nodeId: record.nodeId,
        instanceId: record.instanceId,
        runIn: runner?.runIn ?? (<T>(fn: () => T | Promise<T>) => (async () => fn())()),
      });

      await this.inRoot(rootRunId, async () => {
        this.emitStart(record, parseToolInput(input), extra);
        if (!record.gatedByWrapper) await this.gateBefore(record);
      });
    });
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    return this.guard('tool-end', async () => {
      this.core.unlinkToolRun(runId);
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      const annotation = this.core.takeToolAnnotation(runId) as
        | Record<string, unknown>
        | undefined;
      await this.inRoot(record.rootRunId, async () => {
        this.emitFinish(record, unwrapToolOutput(output), 'ok', { extra: annotation });
        await this.gateAfter(record);
      });
      await this.closeRoot(record);
    });
  }

  override async handleToolError(error: unknown, runId: string): Promise<void> {
    return this.guard('tool-error', async () => {
      this.core.unlinkToolRun(runId);
      const record = this.tree.take(runId);
      if (record === undefined) return;
      const annotation = this.core.takeToolAnnotation(runId) as
        | Record<string, unknown>
        | undefined;
      await this.inRoot(record.rootRunId, () => this.failRun(record, error, annotation));
      await this.closeRoot(record, error);
    });
  }

  // -- retrievers -----------------------------------------------------------

  override async handleRetrieverStart(
    retriever: SerializedLike,
    query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.guard('retriever-start', async () => {
      const name = runName ?? serializedName(retriever) ?? 'retriever';
      if (parentRunId === undefined) await this.openRoot(runId, name);
      const rootRunId = this.tree.rootFor(runId, parentRunId);
      const record = this.open(runId, rootRunId, parentRunId, 'retriever', name, runId);
      await this.inRoot(rootRunId, async () => {
        this.emitStart(record, { query });
        await this.gateBefore(record);
      });
    });
  }

  override async handleRetrieverEnd(documents: unknown, runId: string): Promise<void> {
    return this.guard('retriever-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      const docs = Array.isArray(documents) ? documents : [];
      await this.inRoot(record.rootRunId, async () => {
        this.emitFinish(record, { documents: docs, count: docs.length }, 'ok');
        await this.gateAfter(record);
      });
      await this.closeRoot(record);
    });
  }

  override async handleRetrieverError(error: unknown, runId: string): Promise<void> {
    return this.guard('retriever-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.inRoot(record.rootRunId, () => this.failRun(record, error));
      await this.closeRoot(record, error);
    });
  }

  // -- internals ------------------------------------------------------------

  /**
   * Run one handler body. Only a deliberate abort escapes; every other failure
   * degrades to a one-shot warning so the host graph is never broken by the
   * debugger.
   */
  private async guard(key: string, body: () => Promise<void> | void): Promise<void> {
    // Disabled session: the handler is inert, so attaching it costs nothing.
    if (!this.core.session.enabled) return;
    try {
      await body();
    } catch (error) {
      if (isDeliberateAbort(error)) throw error;
      this.core.warner.warn(
        `handler:${key}`,
        `internal error in the LangChain callback handler (${key}); GraphMind is degrading to ` +
          `observe-only for this event (${
            error instanceof Error ? error.message : String(error)
          })`,
      );
    }
  }

  /** Execute instrumentation inside the run context that owns `rootRunId`. */
  private inRoot<T>(rootRunId: string, body: () => T | Promise<T>): Promise<T> {
    const runner = this.roots.get(rootRunId)?.runner;
    if (runner === undefined) return (async () => body())();
    return runner.runIn(body);
  }

  private shouldEmitChain(langgraphNode: string | undefined, tags: string[] | undefined): boolean {
    if (tags?.includes(HIDDEN_TAG) === true) return false;
    if (this.core.chains === 'none') return false;
    if (this.core.chains === 'langgraph') return langgraphNode !== undefined;
    return true;
  }

  /**
   * Open the GraphMind run for a LangChain run that has no parent. Called for
   * whatever starts first — usually the graph's own chain run, but a directly
   * invoked model, tool or retriever is a root too.
   */
  private async openRoot(runId: string, name: string): Promise<void> {
    if (this.roots.has(runId)) return;
    const attachWait = this.core.maybeWaitForAttach();
    if (attachWait !== undefined) await attachWait;

    const ambient = this.core.session.currentRun();
    const scope =
      ambient === undefined && this.core.autoRun
        ? RunScope.open(this.core.session, name)
        : undefined;
    const runner = {
      runIn: <T>(fn: () => T | Promise<T>): Promise<T> =>
        scope === undefined ? (async () => fn())() : scope.run(fn),
    };
    this.roots.set(runId, {
      scope,
      ctx: ambient ?? scope?.ctx,
      runner,
      tokenSink: this.core.tokenSinkFor(runner.runIn),
    });
    this.core.openScope(runner);
    this.core.openHandlers.add(this);
    this.linkAbort(ambient ?? scope?.ctx);
    // A `gm.hintGraph()` from before this run existed belongs to THIS run.
    await this.inRoot(runId, () => {
      this.core.replayGraphHint();
    });
  }

  private async startRoot(
    runId: string,
    name: string,
    inputs: unknown,
    metadata: Record<string, unknown> | undefined,
    tags: string[] | undefined,
  ): Promise<void> {
    await this.openRoot(runId, name);
    const record = this.open(runId, runId, undefined, 'agent', name, runId);
    const extra: Record<string, unknown> = {};
    const threadId = readString(metadata?.['thread_id']);
    if (threadId !== undefined) extra['threadId'] = threadId;
    if (tags !== undefined && tags.length > 0) extra['tags'] = tags;

    await this.inRoot(runId, async () => {
      this.emitStart(record, inputs, extra);
      await this.gateBefore(record);
    });
  }

  /** Mirror the run's abort into ours, so `config.signal` consumers stop too. */
  private linkAbort(ctx: RunContext | undefined): void {
    if (ctx === undefined || this.abortController.signal.aborted) return;
    const propagate = (): void => {
      try {
        if (!this.abortController.signal.aborted) this.abortController.abort(ctx.signal.reason);
      } catch {
        // never throw into the host
      }
    };
    if (ctx.signal.aborted) propagate();
    else ctx.signal.addEventListener('abort', propagate, { once: true });
  }

  /** Finish the GraphMind run when its LangChain root run ends. */
  private async closeRoot(record: RunRecord, error?: unknown): Promise<void> {
    if (record.parentRunId !== undefined) return;
    const root = this.roots.get(record.runId);
    this.roots.delete(record.runId);
    this.tree.clearRoot(record.runId);
    if (this.roots.size === 0) this.core.openHandlers.delete(this);
    if (root === undefined) {
      this.core.batcher.flushAll();
      return;
    }
    // Each pending batch carries its own emit path, so this cannot leak one
    // run's tokens into another.
    this.core.batcher.flushAll();
    this.core.closeScope(root.runner);
    await root.scope?.end(error);
  }

  /** Record a run we do not render, so its children keep correct parentage. */
  private passthrough(
    runId: string,
    rootRunId: string,
    parentRunId: string | undefined,
    langgraphTask?: string | undefined,
  ): void {
    const parent = this.tree.get(parentRunId);
    this.tree.set({
      runId,
      rootRunId,
      parentRunId,
      nodeId: parent?.nodeId ?? '',
      kind: parent?.kind ?? 'chain',
      name: parent?.name ?? '',
      instanceId: parent?.instanceId ?? runId,
      startedAt: Date.now(),
      emitted: false,
      gatedByWrapper: false,
      langgraphTask: langgraphTask ?? parent?.langgraphTask,
    });
  }

  private open(
    runId: string,
    rootRunId: string,
    parentRunId: string | undefined,
    kind: NodeKind,
    name: string,
    instanceId: string,
    langgraphTask?: string | undefined,
  ): RunRecord {
    return this.tree.set({
      runId,
      rootRunId,
      parentRunId,
      nodeId: nodeIdFor(kind, name),
      kind,
      name,
      instanceId,
      startedAt: Date.now(),
      emitted: true,
      gatedByWrapper: false,
      langgraphTask,
    });
  }

  private async startLlm(
    llm: SerializedLike,
    input: unknown,
    runId: string,
    parentRunId: string | undefined,
    metadata: Record<string, unknown> | undefined,
    runName: string | undefined,
  ): Promise<void> {
    const modelName = readString(metadata?.['ls_model_name']);
    const name = runName ?? modelName ?? serializedName(llm) ?? 'llm';
    if (parentRunId === undefined) await this.openRoot(runId, name);
    const rootRunId = this.tree.rootFor(runId, parentRunId);
    const record = this.open(runId, rootRunId, parentRunId, 'llm', name, runId);

    const extra: Record<string, unknown> = {};
    const provider = readString(metadata?.['ls_provider']);
    if (provider !== undefined) extra['provider'] = provider;
    if (modelName !== undefined) extra['modelId'] = modelName;
    const langgraphNode = readString(metadata?.['langgraph_node']);
    if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;

    await this.inRoot(rootRunId, async () => {
      this.emitStart(record, input, extra);
      await this.gateBefore(record);
    });
  }

  private emitStart(record: RunRecord, input: unknown, extra?: Record<string, unknown>): void {
    const parentNodeId = this.tree.get(record.parentRunId)?.nodeId;
    this.core.startNode({
      nodeId: record.nodeId,
      kind: record.kind,
      name: record.name,
      instanceId: record.instanceId,
      parentId: parentNodeId === undefined || parentNodeId === '' ? undefined : parentNodeId,
      input,
      extra,
    });
  }

  private emitFinish(
    record: RunRecord,
    output: unknown,
    status: 'ok' | 'error' | 'aborted',
    opts: { usage?: TokenUsage | undefined; extra?: Record<string, unknown> | undefined } = {},
  ): void {
    this.core.finishNode({
      nodeId: record.nodeId,
      instanceId: record.instanceId,
      output,
      usage: opts.usage,
      durationMs: Date.now() - record.startedAt,
      status,
      extra: opts.extra,
    });
  }

  /** node.error + node.finished + the `error` gate for one failed run. */
  private async failRun(
    record: RunRecord,
    error: unknown,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const aborted = isAbortError(error) || this.abortController.signal.aborted;
    if (record.emitted) {
      if (!aborted) this.core.errorNode(record.nodeId, record.instanceId, error);
      this.emitFinish(record, undefined, aborted ? 'aborted' : 'error', { extra });
    }
    if (aborted || record.gatedByWrapper) return;
    // One pause per failure: the same error bubbles through every ancestor.
    if (!this.core.claimError(error)) return;
    const decision = await this.core.session.gate('error', gateNode(record));
    if (decision.action === 'abort') await this.performAbort(record, 'error-gate');
  }

  private async gateBefore(record: RunRecord): Promise<void> {
    const decision = await this.core.session.gate('before', gateNode(record));
    if (decision.action === 'abort') {
      await this.performAbort(record, 'before-gate');
      return;
    }
    this.warnUnsupported(decision.action, record);
  }

  /**
   * The `after` gate: inspect a finished node before the graph moves on.
   * Only fires on an explicit `after` breakpoint (step mode does not stop at
   * `after` — see the client's gate engine), and is observe-only: the result
   * has already been handed back to LangChain by the time we are told.
   */
  private async gateAfter(record: RunRecord): Promise<void> {
    if (record.gatedByWrapper) return; // the wrapper owns a real `after` gate
    const decision = await this.core.session.gate('after', gateNode(record));
    if (decision.action === 'abort') {
      await this.performAbort(record, 'after-gate');
      return;
    }
    this.warnUnsupported(decision.action, record);
  }

  private warnUnsupported(action: string, record: RunRecord): void {
    if (action !== 'inject' && action !== 'retry') return;
    this.core.warner.warn(
      `callback-${action}`,
      `the debugger asked to ${action} at "${record.name}", but LangChain callbacks have no ` +
        'return channel — a handler cannot substitute or re-run what it observes, so execution ' +
        'continued. Wrap that tool with gm.wrapStructuredTool() / gm.tool() to get inject and ' +
        'retry.',
    );
  }

  /**
   * Carry out an `abort` decision: close the node, cancel the run's signal
   * (which `gm.config()` wires into LangChain), and — in `throw` mode — raise
   * an AbortError-named error that LangChain propagates into the host graph.
   */
  private async performAbort(record: RunRecord, at: string): Promise<void> {
    const ctx = this.roots.get(record.rootRunId)?.ctx;
    const error = markDeliberate(this.core.abortError(ctx));
    try {
      if (!this.abortController.signal.aborted) this.abortController.abort(error);
    } catch {
      // never throw into the host
    }
    if (record.emitted) this.emitFinish(record, undefined, 'aborted', { extra: { abortedAt: at } });
    this.tree.take(record.runId);

    if (record.parentRunId === undefined) {
      // Aborting the root's own gate means nothing downstream will report it.
      await this.closeRoot(record, error);
    }
    if (this.core.abortMode === 'throw') throw error;
    this.core.warner.warn(
      'abort-signal-only',
      'abortMode is "signal": GraphMind cancelled the run signal but did not throw. Pass ' +
        'gm.config() (or handler.signal) as the LangChain config `signal` so the abort actually ' +
        'stops the graph.',
    );
  }
}

function gateNode(record: RunRecord): { nodeId: string; kind: NodeKind; name: string } {
  return { nodeId: record.nodeId, kind: record.kind, name: record.name };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
