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
import type { TokenUsage } from '@graphmind-ai/client';

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

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function usageFromRecord(record: unknown): TokenUsage | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const source = record as Record<string, unknown>;
  const input =
    readNonNegativeInt(source['input_tokens']) ??
    readNonNegativeInt(source['promptTokens']) ??
    readNonNegativeInt(source['prompt_tokens']) ??
    readNonNegativeInt(source['inputTokens']);
  const output =
    readNonNegativeInt(source['output_tokens']) ??
    readNonNegativeInt(source['completionTokens']) ??
    readNonNegativeInt(source['completion_tokens']) ??
    readNonNegativeInt(source['outputTokens']);
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/**
 * Token usage from an `LLMResult`, checking the shapes real providers use:
 * chat models put `usage_metadata` on the generated message; LLMs report
 * `llmOutput.tokenUsage` / `llmOutput.usage` / `llmOutput.estimatedTokenUsage`;
 * some providers only fill `generationInfo.usage`.
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
    usageFromRecord(message?.['response_metadata'] !== undefined
      ? (message['response_metadata'] as Record<string, unknown>)['usage']
      : undefined)
  );
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
  name?: unknown;
  _getType?: () => string;
  getType?: () => string;
}

/** A compact `{ role, content }` view of a LangChain message list. */
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
