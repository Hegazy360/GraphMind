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
 */
import {
  CONTINUE_DECISION,
  isAbortError,
  type GateDecision,
  type NodeKind,
  type RunContext,
} from '@graphmind-ai/client';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { isDeliberateAbort, markDeliberate } from './abort.js';
import type { AdapterCore } from './core.js';
import { nodeIdFor } from './ids.js';
import {
  compactMessages,
  parseToolInput,
  resolveChainStartArgs,
  serializedName,
  textFromLLMResult,
  unwrapToolOutput,
  usageFromLLMResult,
  type LLMResultLike,
  type SerializedLike,
} from './lc-types.js';
import { RunScope } from './run-scope.js';
import { RunTree, type RunRecord } from './run-tree.js';

const HIDDEN_TAG = 'langsmith:hidden';

export interface HandlerOptions {
  /**
   * Name of the auto-created run (and of its agent node) when the graph runs
   * outside `gm.run(...)`. Default: the root runnable's own name.
   */
  runName?: string;
}

interface OpenRoot {
  /** undefined when the run came from an ambient `gm.run()` (no scope needed). */
  scope: RunScope | undefined;
  ctx: RunContext | undefined;
}

export class GraphMindCallbackHandler extends BaseCallbackHandler {
  name = 'graphmind';

  /**
   * Aborted when a gate resolves with `abort`. Pass it as the LangChain
   * config's `signal` (`gm.config()` does) so an abort also cancels work the
   * handler cannot throw into — in-flight provider requests, `interrupt()`
   * waits, the Pregel loop between steps.
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

  /** Close any run still open (called by `gm.dispose()`). */
  async close(): Promise<void> {
    const roots = [...this.roots.values()];
    this.roots.clear();
    this.tree.clear();
    for (const root of roots) await root.scope?.end();
  }

  // -- chains ---------------------------------------------------------------

  override async handleChainStart(
    chain: SerializedLike,
    inputs: unknown,
    runId: string,
    // NOTE: positions 4/7/8 differ between @langchain/core's declaration and
    // its runtime call site; `resolveChainStartArgs` accepts either.
    arg4?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    arg7?: string,
    arg8?: string,
  ): Promise<void> {
    return this.guard('chain-start', async () => {
      const { parentRunId, runName } = resolveChainStartArgs(arg4, arg7, arg8);
      const langgraphNode = readString(metadata?.['langgraph_node']);
      const isRoot = parentRunId === undefined;
      const name = langgraphNode ?? runName ?? serializedName(chain) ?? 'chain';

      if (isRoot) {
        await this.startRoot(runId, this.options.runName ?? name, inputs, metadata, tags);
        return;
      }

      const rootRunId = this.tree.rootFor(runId, parentRunId);
      if (!this.shouldEmitChain(langgraphNode, tags)) {
        this.passthrough(runId, rootRunId, parentRunId);
        return;
      }

      const record = this.open(runId, rootRunId, parentRunId, 'chain', name, runId);
      const extra: Record<string, unknown> = {};
      if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;
      const step = metadata?.['langgraph_step'];
      if (typeof step === 'number') extra['langgraphStep'] = step;
      const threadId = readString(metadata?.['thread_id']);
      if (threadId !== undefined) extra['threadId'] = threadId;
      if (tags !== undefined && tags.length > 0) extra['tags'] = tags;

      this.emitStart(record, inputs, extra);
      await this.gateBefore(record);
    });
  }

  override async handleChainEnd(outputs: unknown, runId: string): Promise<void> {
    return this.guard('chain-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      if (record.emitted) this.emitFinish(record, outputs, 'ok');
      await this.endRootIfNeeded(record);
    });
  }

  override async handleChainError(error: unknown, runId: string): Promise<void> {
    return this.guard('chain-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.failRun(record, error);
      await this.endRootIfNeeded(record, error);
    });
  }

  // -- language models ------------------------------------------------------

  override async handleChatModelStart(
    llm: SerializedLike,
    messages: unknown,
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
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
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.guard('llm-start', () =>
      this.startLlm(llm, { prompts }, runId, parentRunId, metadata, runName),
    );
  }

  override handleLLMNewToken(token: string, _idx: unknown, runId: string): void {
    void this.guard('llm-token', () => {
      const record = this.tree.get(runId);
      if (record === undefined || !record.emitted) return;
      if (typeof token === 'string') this.core.pushToken(record.nodeId, 'text', token);
    });
  }

  override async handleLLMEnd(output: LLMResultLike, runId: string): Promise<void> {
    return this.guard('llm-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      this.emitFinish(record, { text: textFromLLMResult(output) }, 'ok', {
        usage: usageFromLLMResult(output),
      });
    });
  }

  override async handleLLMError(error: unknown, runId: string): Promise<void> {
    return this.guard('llm-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.failRun(record, error);
    });
  }

  // -- tools ----------------------------------------------------------------

  override async handleToolStart(
    tool: SerializedLike,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): Promise<void> {
    return this.guard('tool-start', async () => {
      const name = runName ?? serializedName(tool) ?? 'tool';
      const rootRunId = this.tree.rootFor(runId, parentRunId);
      const record = this.open(
        runId,
        rootRunId,
        parentRunId,
        'tool',
        name,
        toolCallId ?? runId,
      );
      // A wrapped tool gates in its own wrapper, where inject/retry are
      // possible; gating here too would pause twice for one call.
      record.gatedByWrapper = this.core.wrapperGatedTools.has(name);

      const extra: Record<string, unknown> = { runId };
      if (toolCallId !== undefined) extra['toolCallId'] = toolCallId;
      if (record.gatedByWrapper) extra['gates'] = 'full';
      const langgraphNode = readString(metadata?.['langgraph_node']);
      if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;

      this.emitStart(record, parseToolInput(input), extra);
      if (!record.gatedByWrapper) await this.gateBefore(record);
    });
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    return this.guard('tool-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      const annotation = this.core.takeToolAnnotation(runId);
      this.emitFinish(record, unwrapToolOutput(output), 'ok', {
        extra: annotation as Record<string, unknown> | undefined,
      });
    });
  }

  override async handleToolError(error: unknown, runId: string): Promise<void> {
    return this.guard('tool-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      const annotation = this.core.takeToolAnnotation(runId);
      await this.failRun(record, error, annotation as Record<string, unknown> | undefined);
    });
  }

  // -- retrievers -----------------------------------------------------------

  override async handleRetrieverStart(
    retriever: SerializedLike,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.guard('retriever-start', async () => {
      const name = runName ?? serializedName(retriever) ?? 'retriever';
      const rootRunId = this.tree.rootFor(runId, parentRunId);
      const record = this.open(runId, rootRunId, parentRunId, 'retriever', name, runId);
      this.emitStart(record, { query });
      await this.gateBefore(record);
    });
  }

  override async handleRetrieverEnd(documents: unknown, runId: string): Promise<void> {
    return this.guard('retriever-end', async () => {
      const record = this.tree.take(runId);
      if (record === undefined || !record.emitted) return;
      const docs = Array.isArray(documents) ? documents : [];
      this.emitFinish(record, { documents: docs, count: docs.length }, 'ok');
    });
  }

  override async handleRetrieverError(error: unknown, runId: string): Promise<void> {
    return this.guard('retriever-error', async () => {
      const record = this.tree.take(runId);
      if (record === undefined) return;
      await this.failRun(record, error);
    });
  }

  // -- internals ------------------------------------------------------------

  /**
   * Run one handler body. Only a deliberate abort escapes; every other failure
   * degrades to a one-shot warning so the host graph is never broken by the
   * debugger.
   */
  private async guard(key: string, body: () => Promise<void> | void): Promise<void> {
    try {
      await body();
    } catch (error) {
      if (isDeliberateAbort(error)) throw error;
      this.core.warner.warn(
        `handler:${key}`,
        `internal error in the LangChain callback handler (${key}); GraphMind is degrading to observe-only for this event (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  private shouldEmitChain(langgraphNode: string | undefined, tags: string[] | undefined): boolean {
    if (tags?.includes(HIDDEN_TAG) === true) return false;
    if (this.core.chains === 'none') return false;
    if (this.core.chains === 'langgraph') return langgraphNode !== undefined;
    return true;
  }

  private async startRoot(
    runId: string,
    name: string,
    inputs: unknown,
    metadata: Record<string, unknown> | undefined,
    tags: string[] | undefined,
  ): Promise<void> {
    const attachWait = this.core.maybeWaitForAttach();
    if (attachWait !== undefined) await attachWait;

    const ambient = this.core.session.currentRun();
    const scope =
      ambient === undefined && this.core.autoRun
        ? RunScope.open(this.core.session, name)
        : undefined;
    const ctx = ambient ?? scope?.ctx;
    this.roots.set(runId, { scope, ctx });
    this.linkAbort(ctx);

    const record = this.open(runId, runId, undefined, 'agent', name, runId);
    const extra: Record<string, unknown> = {};
    const threadId = readString(metadata?.['thread_id']);
    if (threadId !== undefined) extra['threadId'] = threadId;
    if (tags !== undefined && tags.length > 0) extra['tags'] = tags;
    this.emitStart(record, inputs, extra);
    await this.gateBefore(record);
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

  private async endRootIfNeeded(record: RunRecord, error?: unknown): Promise<void> {
    if (record.parentRunId !== undefined) return;
    const root = this.roots.get(record.runId);
    this.roots.delete(record.runId);
    this.tree.clearRoot(record.runId);
    this.core.batcher.flushAll();
    if (root?.scope !== undefined) await root.scope.end(error);
  }

  /** Record a run we do not render, so its children keep correct parentage. */
  private passthrough(runId: string, rootRunId: string, parentRunId: string | undefined): void {
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
    });
  }

  private open(
    runId: string,
    rootRunId: string,
    parentRunId: string | undefined,
    kind: NodeKind,
    name: string,
    instanceId: string,
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
    const rootRunId = this.tree.rootFor(runId, parentRunId);
    const record = this.open(runId, rootRunId, parentRunId, 'llm', name, runId);

    const extra: Record<string, unknown> = {};
    const provider = readString(metadata?.['ls_provider']);
    if (provider !== undefined) extra['provider'] = provider;
    if (modelName !== undefined) extra['modelId'] = modelName;
    const langgraphNode = readString(metadata?.['langgraph_node']);
    if (langgraphNode !== undefined) extra['langgraphNode'] = langgraphNode;

    this.emitStart(record, input, extra);
    await this.gateBefore(record);
  }

  private emitStart(record: RunRecord, input: unknown, extra?: Record<string, unknown>): void {
    const parent = this.tree.get(record.parentRunId);
    this.core.startNode({
      nodeId: record.nodeId,
      kind: record.kind,
      name: record.name,
      instanceId: record.instanceId,
      parentId: parent?.nodeId === '' ? undefined : parent?.nodeId,
      input,
      extra,
    });
  }

  private emitFinish(
    record: RunRecord,
    output: unknown,
    status: 'ok' | 'error' | 'aborted',
    opts: { usage?: ReturnType<typeof usageFromLLMResult>; extra?: Record<string, unknown> } = {},
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
    // One pause per error: the same failure bubbles through every ancestor.
    if (!this.core.claimError(error)) return;
    const decision = await this.gate('error', record);
    if (decision.action === 'abort') await this.performAbort(record, 'error-gate');
  }

  private async gateBefore(record: RunRecord): Promise<void> {
    const decision = await this.gate('before', record);
    if (decision.action === 'abort') {
      await this.performAbort(record, 'before-gate');
      return;
    }
    if (decision.action === 'inject' || decision.action === 'retry') {
      this.core.warner.warn(
        `callback-${decision.action}`,
        `the debugger asked to ${decision.action} at "${record.name}", but LangChain callbacks ` +
          'have no return channel — a handler cannot substitute or re-run what it observes. ' +
          'Execution continued. Wrap that tool with gm.wrapStructuredTool()/gm.tool() to get ' +
          'inject and retry.',
      );
    }
  }

  private gate(point: 'before' | 'error', record: RunRecord): Promise<GateDecision> {
    const node = { nodeId: record.nodeId, kind: record.kind, name: record.name };
    return this.runInRoot(
      record.rootRunId,
      () => this.core.session.gate(point, node),
      CONTINUE_DECISION,
    );
  }

  /**
   * Execute instrumentation inside the run context that owns `rootRunId`, so
   * events carry that run's id and `abort` hits that run's controller.
   */
  private runInRoot<T>(rootRunId: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const scope = this.roots.get(rootRunId)?.scope;
    if (scope === undefined) return fn().catch(() => fallback);
    return scope.run(fn, fallback);
  }

  /**
   * Carry out an `abort` decision: close the node, cancel the run's signal
   * (which `gm.config()` wires into LangChain), and — in `throw` mode — raise
   * an AbortError-named error that LangChain propagates into the host graph.
   */
  private async performAbort(record: RunRecord, at: string): Promise<never | void> {
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
      // Nothing downstream will report the root's failure: close it here.
      await this.endRootIfNeeded(record, error);
    }
    if (this.core.abortMode === 'throw') throw error;
    this.core.warner.warn(
      'abort-signal-only',
      'abortMode is "signal": GraphMind cancelled the run signal but did not throw. ' +
        'Pass gm.config() (or handler.signal) as the LangChain config `signal` so the abort ' +
        'actually stops the graph.',
    );
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
