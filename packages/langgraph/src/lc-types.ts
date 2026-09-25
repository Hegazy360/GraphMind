/**
 * The LangChain surface this adapter touches, duck-typed.
 *
 * The peer range is wide (`@langchain/core` >=0.3 <2) and the shapes of
 * `LLMResult` / `Serialized` / usage metadata differ across versions and
 * providers. Everything version-sensitive is isolated here so the rest of the
 * adapter deals in plain, checked values.
 *
 * IMPORTANT (`handleChainStart` argument order): `@langchain/core`'s type
 * declaration and its runtime call site disagree. The declaration says
 * `(chain, inputs, runId, runType, tags, metadata, runName, parentRunId)`
 * while `CallbackManager.handleChainStart` actually invokes handlers with
 * `(chain, inputs, runId, parentRunId, tags, metadata, runType, runName)`
 * (verified against @langchain/core 1.2.9). `resolveChainStartArgs` below
 * accepts either order by looking for the uuid.
 */
import {
  captureTools,
  makeUsage,
  normalizeFinishReason,
  pickParams,
  sumReported,
  tokenCount,
  toolCall,
  type RecordedToolCall,
  type TokenUsage,
} from '@graphmind-ai/client';

/** `Serialized` from @langchain/core, reduced to what we read. */
export interface SerializedLike {
  id?: unknown;
  name?: unknown;
  kwargs?: Record<string, unknown>;
}

/** One `Generation` / `ChatGeneration`. */
export interface GenerationLike {
  text?: unknown;
  generationInfo?: Record<string, unknown> | undefined;
  message?: Record<string, unknown> | undefined;
}

/** `LLMResult`, reduced. */
export interface LLMResultLike {
  generations?: GenerationLike[][];
  llmOutput?: Record<string, unknown> | undefined;
}

/**
 * A streamed chunk handed to `handleLLMNewToken` via `fields.chunk`
 * (`GenerationChunk | ChatGenerationChunk`), reduced to what we read. Kept
 * `unknown`-typed so the handler's override stays assignable to
 * @langchain/core's own declaration across its supported range.
 */
export interface NewTokenFieldsLike {
  chunk?: { message?: unknown; text?: unknown } | undefined;
}

/** One entry of `AIMessageChunk.tool_call_chunks`. */
interface ToolCallChunkLike {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  index?: unknown;
}

/**
 * The tool-call argument deltas inside one `handleLLMNewToken` chunk.
 *
 * `token` (the first argument) only ever carries TEXT: while a model streams a
 * tool call, `token` is empty and the JSON arrives as `args` substrings on
 * `fields.chunk.message.tool_call_chunks` (`ToolCallChunk` in
 * @langchain/core). Without reading them the `tool-args` delta channel stays
 * empty here while the Anthropic / OpenAI / AI SDK adapters fill it.
 */
export function toolArgsDeltas(fields: NewTokenFieldsLike | undefined): string[] {
  const message = fields?.chunk?.message;
  if (message === null || typeof message !== 'object') return [];
  const chunks = (message as { tool_call_chunks?: unknown }).tool_call_chunks;
  if (!Array.isArray(chunks)) return [];
  const out: string[] = [];
  for (const chunk of chunks as ToolCallChunkLike[]) {
    const args = chunk?.args;
    if (typeof args === 'string' && args.length > 0) out.push(args);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface ChainStartArgs {
  parentRunId: string | undefined;
  runName: string | undefined;
  runType: string | undefined;
}

/**
 * Normalize `handleChainStart`'s 4th/7th/8th positional arguments across the
 * declared and the actual (runtime) orders. See the note at the top.
 */
export function resolveChainStartArgs(
  arg4: string | undefined,
  arg7: string | undefined,
  arg8: string | undefined,
): ChainStartArgs {
  // Runtime order (@langchain/core 0.3 – 1.x): arg4=parentRunId, arg7=runType, arg8=runName.
  if (isRunId(arg4)) return { parentRunId: arg4, runName: arg8, runType: arg7 };
  // Declared order: arg4=runType, arg7=runName, arg8=parentRunId.
  if (isRunId(arg8)) return { parentRunId: arg8, runName: arg7, runType: arg4 };
  return { parentRunId: undefined, runName: arg8 ?? arg7, runType: arg4 };
}

/**
 * Identity of the LangGraph *task* a run belongs to: its node name plus the
 * checkpoint namespace of that particular task execution.
 *
 * LangGraph runs a node body inside an inner runnable (a `RunnableLambda`
 * nested in the task's `RunnableSequence` — reproducible on any graph whose
 * node has conditional edges), and that inner run inherits the task's
 * metadata verbatim. Two runs sharing this key are therefore the SAME
 * LangGraph node execution, not a node inside a node: a subgraph's node, or
 * the same node on a later step, gets its own `langgraph_checkpoint_ns`.
 *
 * `undefined` for anything that is not a LangGraph node run (the compiled
 * graph's own root run, plain LCEL chains).
 */
export function langgraphTaskKey(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const node = metadata?.['langgraph_node'];
  if (typeof node !== 'string' || node.length === 0) return undefined;
  const ns = metadata?.['langgraph_checkpoint_ns'] ?? metadata?.['checkpoint_ns'];
  const step = metadata?.['langgraph_step'];
  const scope =
    typeof ns === 'string' && ns.length > 0
      ? ns
      : typeof step === 'number'
        ? `step:${step}`
        : '';
  // Length-prefixed so a node name containing the separator cannot collide
  // with a different node/namespace pair.
  return `${node.length}:${node}:${scope}`;
}

/** Last meaningful segment of a serialized `lc_id` (e.g. `ChatAnthropic`). */
export function serializedName(serialized: SerializedLike | undefined): string | undefined {
  if (serialized === undefined || serialized === null) return undefined;
  const id = serialized.id;
  if (Array.isArray(id)) {
    for (let i = id.length - 1; i >= 0; i -= 1) {
      const part = id[i];
      if (typeof part === 'string' && part.length > 0) return part;
    }
  }
  if (typeof serialized.name === 'string' && serialized.name.length > 0) return serialized.name;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One usage record, in whichever shape it arrived, to the wire TokenUsage
 * (contract C1: `inputTokens` is the TOTAL prompt, `inclusive: true`, cache
 * and reasoning counts only when reported). The shapes:
 *
 *  - LangChain `usage_metadata` (`UsageMetadata`): `input_tokens` INCLUDES
 *    cached tokens by LangChain's definition, detail in `input_token_details
 *    {cache_read, cache_creation}` / `output_token_details {reasoning}`. An
 *    integration that still reports Anthropic's uncached tail there is
 *    recognisable when the cache counts exceed `input_tokens`; then they are
 *    added.
 *  - raw Anthropic `usage` (`response_metadata.usage`, `llmOutput.usage`):
 *    recognised by `cache_read_input_tokens` / `cache_creation_input_tokens`
 *    / `cache_creation` / `output_tokens_details.thinking_tokens`;
 *    `input_tokens` is the uncached tail, so the cache counts are added (the
 *    5m/1h split summed when the total is absent), and the thinking count is
 *    `reasoningTokens`.
 *  - raw OpenAI `token_usage` / `usage`: `prompt_tokens` is inclusive, cache
 *    reads in `prompt_tokens_details.cached_tokens`.
 *  - LangChain JS `llmOutput.tokenUsage`: `promptTokens` / `completionTokens`.
 */
export function usageFromRecord(record: unknown): TokenUsage | undefined {
  const source = asRecord(record);
  if (source === undefined) return undefined;
  const thinking = asRecord(source['output_tokens_details'])?.['thinking_tokens'];
  const anthropicRaw =
    'cache_read_input_tokens' in source ||
    'cache_creation_input_tokens' in source ||
    asRecord(source['cache_creation']) !== undefined ||
    typeof thinking === 'number';
  if (anthropicRaw) {
    const cacheRead = tokenCount(source['cache_read_input_tokens']);
    const split = asRecord(source['cache_creation']);
    const cacheWrite =
      tokenCount(source['cache_creation_input_tokens']) ??
      (split !== undefined
        ? sumReported(tokenCount(split['ephemeral_5m_input_tokens']), tokenCount(split['ephemeral_1h_input_tokens']))
        : undefined);
    return makeUsage({
      input: sumReported(tokenCount(source['input_tokens']), cacheRead, cacheWrite),
      output: tokenCount(source['output_tokens']),
      cacheRead,
      cacheWrite,
      reasoning: tokenCount(thinking),
    });
  }
  if ('input_token_details' in source || 'output_token_details' in source || 'input_tokens' in source) {
    const inDetails = asRecord(source['input_token_details']);
    const outDetails = asRecord(source['output_token_details']);
    const cacheRead = tokenCount(inDetails?.['cache_read']);
    const cacheWrite =
      tokenCount(inDetails?.['cache_creation']) ??
      (inDetails !== undefined
        ? sumReported(
            tokenCount(inDetails['ephemeral_5m_input_tokens']),
            tokenCount(inDetails['ephemeral_1h_input_tokens']),
          )
        : undefined);
    let input = tokenCount(source['input_tokens']);
    const cached = sumReported(cacheRead, cacheWrite);
    if (input !== undefined && cached !== undefined && cached > input) input += cached;
    return makeUsage({
      input,
      output: tokenCount(source['output_tokens']),
      cacheRead,
      cacheWrite,
      reasoning: tokenCount(outDetails?.['reasoning']),
    });
  }
  if ('prompt_tokens' in source || 'completion_tokens' in source) {
    const details = asRecord(source['prompt_tokens_details']);
    return makeUsage({
      input: tokenCount(source['prompt_tokens']),
      output: tokenCount(source['completion_tokens']),
      cacheRead: tokenCount(details?.['cached_tokens']) ?? tokenCount(source['prompt_cache_hit_tokens']),
      cacheWrite: tokenCount(details?.['cache_write_tokens']),
      reasoning: tokenCount(asRecord(source['completion_tokens_details'])?.['reasoning_tokens']),
    });
  }
  return makeUsage({
    input: tokenCount(source['promptTokens']) ?? tokenCount(source['inputTokens']),
    output: tokenCount(source['completionTokens']) ?? tokenCount(source['outputTokens']),
  });
}

/**
 * Token usage from an `LLMResult`, checking the shapes real providers use:
 * chat models put `usage_metadata` on the generated message; LLMs report
 * `llmOutput.tokenUsage` / `llmOutput.usage` / `llmOutput.estimatedTokenUsage`;
 * some providers only fill `generationInfo.usage`, and the raw provider usage
 * sits in `response_metadata.usage` (Anthropic — exclusive, see above).
 */
export function usageFromLLMResult(output: LLMResultLike | undefined): TokenUsage | undefined {
  if (output === undefined || output === null) return undefined;
  const generation = output.generations?.[0]?.[0];
  const message = generation?.message as Record<string, unknown> | undefined;
  return (
    usageFromRecord(message?.['usage_metadata']) ??
    usageFromRecord(output.llmOutput?.['tokenUsage']) ??
    usageFromRecord(output.llmOutput?.['usage']) ??
    usageFromRecord(output.llmOutput?.['estimatedTokenUsage']) ??
    usageFromRecord(generation?.generationInfo?.['usage']) ??
    usageFromRecord(asRecord(message?.['response_metadata'])?.['usage'])
  );
}

/**
 * The provider's own finish reason for an `LLMResult`: OpenAI puts
 * `finish_reason` in `response_metadata` / `generationInfo`, Anthropic
 * `stop_reason`, Gemini `finishReason`.
 */
export function rawFinishReasonFromLLMResult(output: LLMResultLike | undefined): string | undefined {
  const generation = output?.generations?.[0]?.[0];
  const metadata = asRecord(asRecord(generation?.message)?.['response_metadata']);
  const info = generation?.generationInfo;
  for (const value of [
    metadata?.['finish_reason'],
    metadata?.['stop_reason'],
    metadata?.['finishReason'],
    info?.['finish_reason'],
    info?.['stop_reason'],
    info?.['finishReason'],
  ]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The tool calls the model requested (`AIMessage.tool_calls`, args already
 * parsed by LangChain) plus the ones LangChain could not parse
 * (`invalid_tool_calls`, args the raw text — recorded as `inputText`).
 */
export function toolCallsFromLLMResult(output: LLMResultLike | undefined): RecordedToolCall[] {
  const message = asRecord(output?.generations?.[0]?.[0]?.message);
  if (message === undefined) return [];
  const calls: RecordedToolCall[] = [];
  const valid = message['tool_calls'];
  if (Array.isArray(valid)) {
    for (const raw of valid as unknown[]) {
      const call = asRecord(raw);
      const recorded = call !== undefined ? toolCall(call['id'], call['name'], call['args']) : undefined;
      if (recorded !== undefined) calls.push(recorded);
    }
  }
  const invalid = message['invalid_tool_calls'];
  if (Array.isArray(invalid)) {
    for (const raw of invalid as unknown[]) {
      const call = asRecord(raw);
      if (call === undefined) continue;
      const args = call['args'];
      const recorded = toolCall(call['id'], call['name'], typeof args === 'string' ? args : undefined);
      if (recorded === undefined) continue;
      // Invalid by LangChain's judgement even when the text happens to parse.
      if (recorded.inputText === undefined && typeof args === 'string' && args.length > 0) {
        calls.push({ ...recorded, input: null, inputText: args });
      } else {
        calls.push(recorded);
      }
    }
  }
  return calls;
}

/**
 * `node.finished.output` of an LLM run: the text, the normalized finish
 * reason with the provider's own string, and the requested tool calls.
 */
export function llmOutput(output: LLMResultLike | undefined): Record<string, unknown> {
  const text = textFromLLMResult(output);
  let calls: RecordedToolCall[] = [];
  let raw: string | undefined;
  try {
    calls = toolCallsFromLLMResult(output);
    raw = rawFinishReasonFromLLMResult(output);
  } catch {
    // an exotic result object: text only
  }
  const finishReason = normalizeFinishReason(raw, calls.length > 0);
  return {
    text,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(raw !== undefined ? { rawFinishReason: raw } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  };
}

/**
 * What `node.started.input` of an LLM run records besides the prompt (C1):
 * the sampling parameters from LangChain's `invocation_params` (the model's
 * own names: `temperature`, `max_tokens`, `top_p`, `stop`, `tool_choice`, ...
 * — allow-listed; API keys and client config never are), and the bound tools
 * as `{name, schemaHash}` with each definition sent once per run.
 */
export function llmStartExtras(
  owner: object,
  runKey: string,
  extraParams: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const invocation = asRecord(extraParams?.['invocation_params']);
  if (invocation === undefined) return {};
  const tools = captureTools(owner, runKey, invocation['tools'] ?? asRecord(extraParams?.['options'])?.['tools'], (def) => {
    const d = asRecord(def);
    const fn = asRecord(d?.['function']);
    const name = fn?.['name'] ?? d?.['name'];
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  });
  return { ...pickParams(invocation), ...(tools !== undefined ? tools : {}) };
}

/** Concatenated text of an `LLMResult`'s first completion set. */
export function textFromLLMResult(output: LLMResultLike | undefined): string {
  const generations = output?.generations?.[0];
  if (!Array.isArray(generations)) return '';
  let text = '';
  for (const generation of generations) {
    if (typeof generation?.text === 'string') text += generation.text;
  }
  return text;
}

interface MessageLike {
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
  _getType?: () => string;
  getType?: () => string;
}

/**
 * A `{ role, content }` view of a LangChain message list: every message, the
 * content whole, plus `tool_calls` (an AI turn's requests), `tool_call_id`
 * (which request a tool message answers) and `name`. Class internals
 * (`lc_kwargs`, `additional_kwargs`, `response_metadata`) are left out.
 */
export function compactMessages(groups: unknown): unknown {
  if (!Array.isArray(groups)) return groups;
  return groups.map((group) => {
    if (!Array.isArray(group)) return group;
    return group.map((message: MessageLike) => {
      try {
        const role =
          typeof message?._getType === 'function'
            ? message._getType()
            : typeof message?.getType === 'function'
              ? message.getType()
              : 'message';
        const compact: Record<string, unknown> = { role, content: message?.content };
        if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          compact['tool_calls'] = message.tool_calls;
        }
        if (typeof message?.tool_call_id === 'string') compact['tool_call_id'] = message.tool_call_id;
        if (typeof message?.name === 'string') compact['name'] = message.name;
        return compact;
      } catch {
        return message;
      }
    });
  });
}

/** Tool inputs arrive JSON-encoded; decode when possible, else keep the text. */
export function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return input;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return input;
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

/** A `ToolMessage` output unwrapped to its content (plus artifact if present). */
export function unwrapToolOutput(output: unknown): unknown {
  if (output === null || typeof output !== 'object') return output;
  const record = output as Record<string, unknown>;
  if (!('content' in record)) return output;
  const artifact = record['artifact'];
  if (artifact !== undefined) return { content: record['content'], artifact };
  return record['content'];
}
