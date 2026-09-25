/**
 * Model middleware, built ONLY on the public `wrapLanguageModel` contract
 * (LanguageModelMiddleware in ai@7 — spec V4 hooks; same hook names on v6).
 *
 * Middleware spec version: the object declares `specificationVersion: 'v3'`.
 * That is the only value both advertised peer majors accept —
 *   - ai@6: `LanguageModelMiddleware = LanguageModelV3Middleware`, which
 *     *requires* `readonly specificationVersion: 'v3'`;
 *   - ai@7: `Omit<LanguageModelV4Middleware,'specificationVersion'> &
 *     { readonly specificationVersion?: string }` — explicitly relaxed to
 *     "any string (including 'v3')" so v3-era middleware keeps working.
 * Neither major reads the field at runtime (`wrapLanguageModel`'s `doWrap`
 * destructures the hooks only), and the hooks below are duck typed through
 * ./sdk-types.js, so they are correct against both hook shapes.
 *
 * Per model step:
 *  1. `transformParams` chains the debugger's abort signal into
 *     `params.abortSignal` (never replacing the user's) and neutralizes
 *     timeout-driven aborts while attached (decisions.md #3).
 *  2. `wrapStream` emits `node.started`, awaits `gate('before')` BEFORE
 *     calling `doStream()` — nothing is in flight while a gate is held —
 *     then tees the provider stream so token deltas / provider-executed
 *     tools are observed without disturbing what the SDK consumes.
 *  3. The observer emits batched `node.token` deltas and `node.finished`
 *     with usage on the finish part.
 *  4. The step's `after` gate hands the session the normalized output
 *     (`{text, finishReason, toolCalls, …}` — what the smart hold
 *     `truncated-tool-call` inspects) while a debugger is attached:
 *       - `wrapGenerate`: post-response, pre-return — the SDK has not seen
 *         the result yet. `continue` returns it; `retry` runs the step again
 *         (the `before` gate fires again); `abort` throws the run's
 *         AbortError; `inject` is not meaningful for a model step here (the
 *         SDK needs a provider result) and continues with a warning.
 *       - `wrapStream`: the SDK's copy of the stream is held at its `finish`
 *         part until the gate is released (the observer gates when it reads
 *         the same part), so the step cannot complete and the next step
 *         cannot start. Tool calls that already streamed in full have been
 *         handed to their tools (each has its own `before` gate). `abort`
 *         errors the SDK's stream with the run's AbortError; `retry` and
 *         `inject` cannot rewrite a stream the SDK has consumed and continue
 *         with a warning. Detached, the SDK gets its branch untouched and no
 *         `after` gate is consulted.
 *
 * What is recorded (contract C1): `node.started.input` is the prompt as the
 * provider receives it (bytes as `{type:'binary', bytes}`), the model, the
 * sampling options actually passed (`temperature`, `maxOutputTokens`, ... —
 * the AI SDK's own names; `providerOptions` and `headers` are never read, they
 * can carry credentials) and `tools: [{name, schemaHash}]` with each tool
 * definition sent once per run as `toolSchemas`. `node.finished.output` has
 * the text, the normalized `finishReason` + the provider's `rawFinishReason`,
 * and `toolCalls` — the client-executed tool calls the model requested
 * (provider-executed ones are their own ungated tool nodes). A tool call cut
 * off mid-arguments (no `tool-call` part arrived) is still listed, with its
 * partial text as `inputText`.
 */
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  captureTools,
  isAbortError,
  pickParams,
  resultGateOptions,
  toolCall,
  unsupportedGateOptions,
  withBinaryPlaceholders,
  withInstanceId,
  type GateDecision,
  type GateNode,
  type RecordedToolCall,
} from '@graphmind-ai/client';
import type { LanguageModelMiddleware } from 'ai';
import type { AdapterCore } from './core.js';
import { LLM_NODE_ID, LLM_NODE_NAME, agentNodeId } from './ids.js';
import {
  finishFields,
  mapUsage,
  type CallParamsLike,
  type GenerateResultLike,
  type StreamPartLike,
  type StreamResultLike,
} from './sdk-types.js';

const LLM_GATE_NODE: GateNode = { nodeId: LLM_NODE_ID, kind: 'llm', name: LLM_NODE_NAME };

/**
 * The one middleware spec version accepted by every peer major the package
 * advertises (`ai >=6 <8`). See the module docblock.
 */
export const MIDDLEWARE_SPEC_VERSION = 'v3';

interface ModelLike {
  modelId?: string;
  provider?: string;
}

/**
 * The declared return type pins `specificationVersion` to the literal ai@6
 * requires. Under ai@7 the field is optional and `string`-typed, so without
 * the intersection a regression that dropped it would only surface in a
 * consumer's ai@6 tree — never in this package's own typecheck.
 */
export function createDebugMiddleware(
  core: AdapterCore,
): LanguageModelMiddleware & { readonly specificationVersion: typeof MIDDLEWARE_SPEC_VERSION } {
  return {
    specificationVersion: MIDDLEWARE_SPEC_VERSION,

    transformParams: async ({ params }) => {
      try {
        if (!core.session.attached) return params;
        const original = (params as CallParamsLike).abortSignal;
        const chained = core.chainSignal(original);
        if (chained === undefined || chained === original) return params;
        return { ...params, abortSignal: chained };
      } catch {
        return params;
      }
    },

    wrapStream: async ({ doStream, params, model }) =>
      instrumentStream(core, params as unknown as CallParamsLike, model as ModelLike, doStream),

    wrapGenerate: async ({ doGenerate, params, model }) =>
      instrumentGenerate(core, params as unknown as CallParamsLike, model as ModelLike, doGenerate),
  };
}

/** `node.started.input` for one model step (see the module comment). */
function stepInput(
  core: AdapterCore,
  params: CallParamsLike,
  model: ModelLike,
  runId: string | undefined,
): Record<string, unknown> {
  const tools = captureTools(core.session, runId ?? 'implicit', params.tools, (def) => {
    const name = (def as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  });
  return {
    prompt: withBinaryPlaceholders(params.prompt),
    modelId: model?.modelId,
    provider: model?.provider,
    ...pickParams(params),
    ...(tools !== undefined ? tools : {}),
  };
}

/**
 * The tool calls a step requested, in stream order: completed `tool-call`
 * parts, then any tool input that started streaming but never completed.
 */
class ToolCallCollector {
  private readonly calls = new Map<string, RecordedToolCall>();
  private readonly partial = new Map<string, { name: string | undefined; text: string }>();

  constructor(private readonly core: AdapterCore) {}

  /**
   * A `tool-call` part (stream or generate). Provider-executed calls are
   * skipped. The model's arguments are also kept for the call's `execute`
   * (see AdapterCore.noteToolInput).
   */
  onCall(part: StreamPartLike): void {
    if (part.providerExecuted === true) return;
    const call = toolCall(part.toolCallId, part.toolName, part.input);
    if (call === undefined) return;
    if (typeof part.toolCallId === 'string' && call.inputText === undefined) {
      this.core.noteToolInput(part.toolCallId, call.input);
    }
    const key = typeof part.toolCallId === 'string' ? part.toolCallId : `#${this.calls.size}`;
    this.partial.delete(key);
    this.calls.set(key, call);
  }

  onInputStart(part: StreamPartLike): void {
    if (part.providerExecuted === true || typeof part.id !== 'string') return;
    if (this.calls.has(part.id)) return;
    this.partial.set(part.id, { name: part.toolName, text: '' });
  }

  onInputDelta(part: StreamPartLike): void {
    if (typeof part.id !== 'string' || typeof part.delta !== 'string') return;
    const entry = this.partial.get(part.id);
    if (entry !== undefined) entry.text += part.delta;
  }

  list(): RecordedToolCall[] {
    const out = [...this.calls.values()];
    for (const [id, entry] of this.partial) {
      // Never completed: record what arrived (unparseable -> inputText).
      const call = toolCall(id, entry.name, entry.text);
      if (call !== undefined) out.push(call);
    }
    return out;
  }
}

/** `node.finished.output` of a completed step. */
function stepOutput(
  text: string,
  finishReason: StreamPartLike['finishReason'],
  calls: RecordedToolCall[],
): Record<string, unknown> {
  return {
    text,
    ...finishFields(finishReason, calls.length > 0),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  };
}

/** Shared step bookkeeping. Returns undefined if instrumentation must bail. */
function beginStep(
  core: AdapterCore,
  params: CallParamsLike,
  model: ModelLike,
): { instanceId: string } | undefined {
  const ctx = core.session.currentRun();
  try {
    const step = core.tracker.next(ctx?.runId ?? 'no-run', params.prompt);
    const instanceId = `${step.invocationId}:s${step.stepIndex}`;
    if (step.isFirstStep) core.emitGraphHint(params, ctx);
    core.startNode({
      nodeId: LLM_NODE_ID,
      kind: 'llm',
      name: LLM_NODE_NAME,
      instanceId,
      parentId: ctx !== undefined ? agentNodeId(ctx.name) : undefined,
      input: stepInput(core, params, model, ctx?.runId),
    });
    return { instanceId };
  } catch {
    // Instrumentation prep must never break the host: caller falls back to
    // an uninstrumented call.
    return undefined;
  }
}

async function instrumentStream<R extends StreamResultLike>(
  core: AdapterCore,
  params: CallParamsLike,
  model: ModelLike,
  doStream: () => PromiseLike<R>,
): Promise<R> {
  const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
  if (attachWait !== undefined) await attachWait;
  const ctx = core.session.currentRun();
  // A run the debugger aborted must not start new steps (terminal, no retries).
  if (ctx?.signal.aborted === true) throw core.abortError(ctx);

  const begun = beginStep(core, params, model);
  if (begun === undefined) return await doStream();
  const { instanceId } = begun;
  const startedAt = monotonicNow();
  // exec.paused names this step's execution (parallel steps stay apart).
  const gateNode = withInstanceId(LLM_GATE_NODE, instanceId);

  // No value can stand in for a streamed step: `inject` is refused (the gate
  // stays held); `retry` before the request runs it, as continue does.
  const decision = await core.session.gate('before', gateNode, unsupportedGateOptions(core.session, ['inject']));
  if (decision.action === 'abort') {
    core.finishNode({
      nodeId: LLM_NODE_ID,
      output: undefined,
      durationMs: elapsedMs(startedAt),
      status: 'aborted',
      extra: { instanceId },
    });
    throw core.abortError(core.session.currentRun());
  }

  let result: R;
  try {
    result = await doStream();
  } catch (error) {
    const aborted = isAbortError(error);
    if (!aborted) core.errorNode(LLM_NODE_ID, instanceId, error);
    core.finishNode({
      nodeId: LLM_NODE_ID,
      output: undefined,
      durationMs: elapsedMs(startedAt),
      status: aborted ? 'aborted' : 'error',
      extra: { instanceId },
    });
    throw error; // the host's own error — always propagates untouched
  }

  try {
    const { stream, ...rest } = result;
    const [forSdk, forObserver] = stream.tee();
    // Attached: the SDK's branch waits at its `finish` part for the step's
    // `after` gate (see holdAtFinish). Detached: its branch, untouched.
    const latch = core.session.attached ? new FinishLatch() : undefined;
    void observeStream(core, forObserver, instanceId, startedAt, latch);
    return { ...rest, stream: latch === undefined ? forSdk : holdAtFinish(forSdk, latch) } as R;
  } catch {
    // tee failed (exotic stream impl): hand the SDK the untouched result.
    return result;
  }
}

/** What the SDK's copy of a stream does at its `finish` part. */
interface FinishVerdict {
  /** Error the SDK's stream with this (the run's AbortError) instead of finishing. */
  abort?: Error;
}

/**
 * The step's `after` gate verdict, handed from the observer (which gates) to
 * the SDK's copy of the stream (which waits at its `finish` part). Released
 * once in effect: by the gate's decision, or — whatever happens to the
 * observer — when the observer stops, so the SDK never waits on a dead one.
 */
class FinishLatch {
  readonly verdict: Promise<FinishVerdict>;
  /** The SDK cancelled its copy: nothing waits at the finish part any more, so do not hold. */
  abandoned = false;
  /**
   * Aborted when the SDK cancels its copy: handed to the after gate as its
   * `signal`, so a hold the observer ALREADY opened is released too (with
   * continue) — the node then finishes instead of waiting on a stream nobody
   * reads.
   */
  private readonly abandonedController = new AbortController();
  private resolve: (verdict: FinishVerdict) => void = () => undefined;

  constructor() {
    this.verdict = new Promise<FinishVerdict>((resolve) => {
      this.resolve = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.abandonedController.signal;
  }

  release(verdict: FinishVerdict = {}): void {
    this.resolve(verdict); // later calls are no-ops: a promise settles once
  }

  /** The SDK cancelled its copy of the stream. Never throws. */
  abandon(): void {
    this.abandoned = true;
    this.release();
    try {
      this.abandonedController.abort();
    } catch {
      // an abort listener threw: the session guards its own
    }
  }
}

function isFinishPart(value: unknown): boolean {
  try {
    return value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'finish';
  } catch {
    return false;
  }
}

/**
 * The SDK's branch of the tee, re-read one part at a time: every part passes
 * through unchanged and in order, except that a `finish` part waits for the
 * latch — the step's `after` gate. Never throws; a stream it cannot wrap is
 * handed back as it is (and the latch released).
 */
function holdAtFinish(source: ReadableStream<unknown>, latch: FinishLatch): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown>;
  try {
    reader = source.getReader();
  } catch {
    latch.release();
    return source;
  }
  try {
    return new ReadableStream<unknown>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          if (isFinishPart(next.value)) {
            const verdict = await latch.verdict;
            if (verdict.abort !== undefined) {
              controller.error(verdict.abort);
              reader.cancel(verdict.abort).catch(() => undefined);
              return;
            }
          }
          controller.enqueue(next.value);
        } catch (error) {
          try {
            controller.error(error); // the provider's own stream error, as before
          } catch {
            // the consumer already cancelled: nothing left to tell
          }
        }
      },
      cancel(reason) {
        latch.abandon();
        return reader.cancel(reason);
      },
    });
  } catch {
    try {
      reader.releaseLock();
    } catch {
      // best effort
    }
    latch.release();
    return source;
  }
}

/**
 * The streamed step's `after` gate (attached only): hand the session the
 * normalized output, then release the SDK's copy of the stream — errored with
 * the run's AbortError on `abort`. The SDK has already consumed the stream,
 * so `retry` and `inject` are refused there (`exec.refused` `unsupported`,
 * the gate stays held) rather than quietly continued; if the SDK cancels its
 * copy meanwhile, the hold is released with `continue`. Never throws.
 */
async function gateStreamedStep(
  core: AdapterCore,
  latch: FinishLatch,
  output: Record<string, unknown>,
  instanceId: string,
): Promise<GateDecision['action']> {
  let action: GateDecision['action'] = 'continue';
  try {
    const gateNode = withInstanceId(LLM_GATE_NODE, instanceId);
    const options = resultGateOptions(core.session, output, ['retry', 'inject']);
    // The SDK cancelling its copy releases a hold opened here (see FinishLatch).
    const gated = options === undefined ? undefined : { ...options, signal: latch.signal };
    action = (await core.session.gate('after', gateNode, gated)).action;
    if (action === 'abort') {
      latch.release({ abort: core.abortError(core.session.currentRun()) });
      return action;
    }
  } catch {
    action = 'continue';
  }
  latch.release();
  return action;
}

/** Consumes the observer branch of the tee. Never throws. */
async function observeStream(
  core: AdapterCore,
  stream: ReadableStream<unknown>,
  instanceId: string,
  startedAt: number,
  latch: FinishLatch | undefined,
): Promise<void> {
  let text = '';
  let usage: ReturnType<typeof mapUsage>;
  let finishReason: StreamPartLike['finishReason'];
  let errorPart: unknown;
  let sawError = false;
  /** The step's `after` gate decision; undefined = not gated (detached, or no finish part). */
  let afterAction: GateDecision['action'] | undefined;
  const calls = new ToolCallCollector(core);
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value as StreamPartLike;
      switch (part.type) {
        case 'text-delta':
          if (typeof part.delta === 'string') {
            text += part.delta;
            core.pushToken(LLM_NODE_ID, 'text', part.delta);
          }
          break;
        case 'reasoning-delta':
          if (typeof part.delta === 'string') {
            core.pushToken(LLM_NODE_ID, 'reasoning', part.delta);
          }
          break;
        case 'tool-input-start':
          calls.onInputStart(part);
          break;
        case 'tool-input-delta':
          if (typeof part.delta === 'string') {
            core.pushToken(LLM_NODE_ID, 'tool-args', part.delta);
            calls.onInputDelta(part);
          }
          break;
        case 'tool-call':
          if (part.providerExecuted === true) core.providerToolStarted(part);
          else calls.onCall(part);
          break;
        case 'tool-result':
          core.providerToolFinished(part);
          break;
        case 'finish':
          usage = mapUsage(part.usage);
          finishReason = part.finishReason;
          if (latch !== undefined && !latch.abandoned && afterAction === undefined && !sawError) {
            afterAction = await gateStreamedStep(core, latch, stepOutput(text, finishReason, calls.list()), instanceId);
          }
          break;
        case 'error':
          sawError = true;
          errorPart = part.error;
          break;
        default:
          break;
      }
    }
    if (sawError) {
      core.errorNode(LLM_NODE_ID, instanceId, errorPart);
      // What the step reported before (or despite) the error is kept: the
      // usage already billed and the tool calls it requested.
      const requested = calls.list();
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: { text, ...(requested.length > 0 ? { toolCalls: requested } : {}) },
        usage,
        durationMs: elapsedMs(startedAt),
        status: 'error',
        extra: { instanceId },
      });
    } else {
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: stepOutput(text, finishReason, calls.list()),
        usage,
        durationMs: elapsedMs(startedAt),
        status: afterAction === 'abort' ? 'aborted' : 'ok',
        extra: { instanceId },
      });
    }
  } catch (error) {
    try {
      const aborted = isAbortError(error) || afterAction === 'abort';
      if (!aborted) core.errorNode(LLM_NODE_ID, instanceId, error);
      const requested = calls.list();
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: { text, ...(requested.length > 0 ? { toolCalls: requested } : {}) },
        usage,
        durationMs: elapsedMs(startedAt),
        status: aborted ? 'aborted' : 'error',
        extra: { instanceId },
      });
    } catch {
      // the observer must never throw (it runs detached from the host)
    }
  } finally {
    // Whatever happened to the observer, the SDK's copy never waits on it.
    latch?.release();
  }
}

async function instrumentGenerate<R extends GenerateResultLike>(
  core: AdapterCore,
  params: CallParamsLike,
  model: ModelLike,
  doGenerate: () => PromiseLike<R>,
): Promise<R> {
  const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-call gate
  if (attachWait !== undefined) await attachWait;
  const ctx = core.session.currentRun();
  if (ctx?.signal.aborted === true) throw core.abortError(ctx);

  const begun = beginStep(core, params, model);
  if (begun === undefined) return await doGenerate();
  const { instanceId } = begun;
  const startedAt = monotonicNow();
  // One doGenerate() call is ONE execution of the llm node even when the
  // debugger retries it at the after gate; the attempt count rides along.
  let attempt = 0;
  const extra = (): Record<string, unknown> => (attempt > 1 ? { instanceId, attempts: attempt } : { instanceId });
  // exec.paused names this step's execution (parallel steps stay apart).
  const gateNode = withInstanceId(LLM_GATE_NODE, instanceId);

  for (;;) {
    attempt += 1;
    // `inject` is refused before a generated step (the SDK needs the
    // provider's own result); `retry` before the request runs it.
    const decision = await core.session.gate('before', gateNode, unsupportedGateOptions(core.session, ['inject']));
    if (decision.action === 'abort') {
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: undefined,
        durationMs: elapsedMs(startedAt),
        status: 'aborted',
        extra: extra(),
      });
      throw core.abortError(core.session.currentRun());
    }

    let result: R;
    try {
      result = await doGenerate();
    } catch (error) {
      const aborted = isAbortError(error);
      if (!aborted) core.errorNode(LLM_NODE_ID, instanceId, error);
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: undefined,
        durationMs: elapsedMs(startedAt),
        status: aborted ? 'aborted' : 'error',
        extra: extra(),
      });
      throw error;
    }

    const step = summarizeGenerate(core, result);
    // Post-response, pre-return: the SDK has not seen this result yet, so
    // `retry` re-runs the request; `inject` is refused (no value can stand in
    // for the provider's result).
    const post = await core.session.gate('after', gateNode, resultGateOptions(core.session, step?.output, ['inject']));
    if (post.action === 'retry') continue;
    if (post.action === 'abort') {
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: step?.output,
        usage: step?.usage,
        durationMs: elapsedMs(startedAt),
        status: 'aborted',
        extra: extra(),
      });
      throw core.abortError(core.session.currentRun());
    }
    core.finishNode({
      nodeId: LLM_NODE_ID,
      output: step?.output,
      usage: step?.usage,
      durationMs: elapsedMs(startedAt),
      status: 'ok',
      extra: extra(),
    });
    return result;
  }
}

/**
 * A generated step's normalized output and usage; provider-executed tools in
 * its content are reported as their own (ungated) nodes on the way. Undefined
 * when the result cannot be read — reporting never affects the host's result.
 */
function summarizeGenerate(
  core: AdapterCore,
  result: GenerateResultLike,
): { output: Record<string, unknown>; usage: ReturnType<typeof mapUsage> } | undefined {
  try {
    let text = '';
    const calls = new ToolCallCollector(core);
    for (const part of result.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part.type === 'tool-call' && part.providerExecuted === true) {
        core.providerToolStarted(part);
      } else if (part.type === 'tool-call') calls.onCall(part);
      else if (part.type === 'tool-result') core.providerToolFinished(part);
    }
    return { output: stepOutput(text, result.finishReason, calls.list()), usage: mapUsage(result.usage) };
  } catch {
    return undefined;
  }
}
