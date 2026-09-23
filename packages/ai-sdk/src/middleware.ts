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
  toolCall,
  withBinaryPlaceholders,
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

  /** A `tool-call` part (stream or generate). Provider-executed calls are skipped. */
  onCall(part: StreamPartLike): void {
    if (part.providerExecuted === true) return;
    const call = toolCall(part.toolCallId, part.toolName, part.input);
    if (call === undefined) return;
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

  const decision = await core.session.gate('before', LLM_GATE_NODE);
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
  // 'inject'/'retry' are not meaningful before a model step: continue.

  let result: R;
  try {
    result = await doStream();
  } catch (error) {
    const aborted = isAbortError(error);
    if (!aborted) core.errorNode(LLM_NODE_ID, error);
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
    void observeStream(core, forObserver, instanceId, startedAt);
    return { ...rest, stream: forSdk } as R;
  } catch {
    // tee failed (exotic stream impl): hand the SDK the untouched result.
    return result;
  }
}

/** Consumes the observer branch of the tee. Never throws. */
async function observeStream(
  core: AdapterCore,
  stream: ReadableStream<unknown>,
  instanceId: string,
  startedAt: number,
): Promise<void> {
  let text = '';
  let usage: ReturnType<typeof mapUsage>;
  let finishReason: StreamPartLike['finishReason'];
  let errorPart: unknown;
  let sawError = false;
  const calls = new ToolCallCollector();
  const reader = stream.getReader();
  try {
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
      core.errorNode(LLM_NODE_ID, errorPart);
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: { text },
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
        status: 'ok',
        extra: { instanceId },
      });
    }
  } catch (error) {
    try {
      const aborted = isAbortError(error);
      if (!aborted) core.errorNode(LLM_NODE_ID, error);
      core.finishNode({
        nodeId: LLM_NODE_ID,
        output: { text },
        durationMs: elapsedMs(startedAt),
        status: aborted ? 'aborted' : 'error',
        extra: { instanceId },
      });
    } catch {
      // the observer must never throw (it runs detached from the host)
    }
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

  const decision = await core.session.gate('before', LLM_GATE_NODE);
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
    result = await doGenerate();
  } catch (error) {
    const aborted = isAbortError(error);
    if (!aborted) core.errorNode(LLM_NODE_ID, error);
    core.finishNode({
      nodeId: LLM_NODE_ID,
      output: undefined,
      durationMs: elapsedMs(startedAt),
      status: aborted ? 'aborted' : 'error',
      extra: { instanceId },
    });
    throw error;
  }

  try {
    let text = '';
    const calls = new ToolCallCollector();
    for (const part of result.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part.type === 'tool-call' && part.providerExecuted === true) {
        core.providerToolStarted(part);
      } else if (part.type === 'tool-call') calls.onCall(part);
      else if (part.type === 'tool-result') core.providerToolFinished(part);
    }
    core.finishNode({
      nodeId: LLM_NODE_ID,
      output: stepOutput(text, result.finishReason, calls.list()),
      usage: mapUsage(result.usage),
      durationMs: elapsedMs(startedAt),
      status: 'ok',
      extra: { instanceId },
    });
  } catch {
    // reporting failures never affect the host's result
  }
  return result;
}
