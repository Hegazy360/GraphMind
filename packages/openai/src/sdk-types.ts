/**
 * The slice of the OpenAI Node SDK surface this adapter reads, expressed
 * structurally (duck typing) rather than by importing the SDK's types.
 *
 * Rationale: the adapter must work across `openai` majors and against
 * OpenAI-compatible clients (Azure, together, groq, ollama, ...) that ship the
 * same shapes with different type packages. Everything the adapter touches is
 * declared here with optional fields, so a new major only needs this file
 * revisited — and `openai` stays a peer dependency with NO runtime import.
 *
 * Shapes verified against `openai@6.49.0` type definitions:
 *   resources/chat/completions/completions.d.ts  (ChatCompletion, ChatCompletionChunk)
 *   resources/responses/responses.d.ts           (Response, ResponseStreamEvent, ResponseUsage)
 *   resources/completions.d.ts                   (CompletionUsage)
 *   core/streaming.d.ts                          (Stream<Item>, .tee())
 *   core/api-promise.d.ts                        (APIPromise<T>)
 */
import { makeUsage, tokenCount, type WireUsage } from '@graphmind-ai/client';

// -- request bodies ----------------------------------------------------------

/** The subset of a `chat.completions.create` / `responses.create` body read. */
export interface RequestBodyLike {
  model?: unknown;
  /** chat.completions */
  messages?: unknown;
  /** responses */
  input?: unknown;
  instructions?: unknown;
  previous_response_id?: unknown;
  conversation?: unknown;
  tools?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

/** The subset of `RequestOptions` the adapter rewrites. */
export interface RequestOptionsLike {
  signal?: AbortSignal | null | undefined;
  [key: string]: unknown;
}

// -- results -----------------------------------------------------------------

/** `Stream<Item>` from `openai/core/streaming` — the only bit we depend on. */
export interface StreamLike<Item = unknown> extends AsyncIterable<Item> {
  controller: AbortController;
  tee(): [StreamLike<Item>, StreamLike<Item>];
}

/** An `APIPromise<T>`, or anything else thenable the SDK might hand back. */
export interface ApiPromiseLike {
  then(
    onfulfilled?: ((value: unknown) => unknown) | undefined | null,
    onrejected?: ((reason: unknown) => unknown) | undefined | null,
  ): unknown;
  asResponse?: () => Promise<unknown>;
  withResponse?: () => Promise<{ data: unknown; response: unknown; request_id: string | null }>;
  _thenUnwrap?: (transform: (data: unknown, props: unknown) => unknown) => ApiPromiseLike;
}

/** `chat.completions.create` non-streaming result. */
export interface ChatCompletionLike {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallLike[];
    };
  }[];
  usage?: ChatUsageLike | null;
}

export interface ToolCallLike {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  custom?: { name?: string; input?: string };
}

/** One streamed `chat.completions` chunk. */
export interface ChatChunkLike {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      /** Non-standard but widely used by OpenAI-compatible reasoning models. */
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: ChatUsageLike | null;
}

/** `responses.create` non-streaming result. */
export interface ResponseLike {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: ResponseOutputItemLike[];
  error?: { code?: string | null; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: ResponsesUsageLike | null;
}

export interface ResponseOutputItemLike {
  id?: string;
  type?: string;
  name?: string;
  status?: string;
  arguments?: string;
  call_id?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  content?: { type?: string; text?: string }[];
  summary?: { type?: string; text?: string }[];
}

/** One streamed Responses API event. */
export interface ResponseEventLike {
  type?: string;
  delta?: string;
  item?: ResponseOutputItemLike;
  item_id?: string;
  output_index?: number;
  sequence_number?: number;
  response?: ResponseLike;
  code?: string | null;
  message?: string;
}

// -- usage -------------------------------------------------------------------

export interface ChatUsageLike {
  /** Inclusive: cached tokens are part of it. */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    /** Newer models bill prompt-cache writes (1.25x); reported here. */
    cache_write_tokens?: number;
    audio_tokens?: number;
  } | null;
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number } | null;
  /** OpenAI-compatible servers (DeepSeek) report cache hits here instead. */
  prompt_cache_hit_tokens?: number;
}

export interface ResponsesUsageLike {
  /** Inclusive: cached tokens are part of it. */
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

/**
 * The wire `TokenUsage` (inclusive, contract C1) plus the loose extras this
 * adapter has always sent: `totalTokens` as reported, and `cachedInputTokens`
 * — the 0.5 name of `cacheReadTokens`, a documented alias through 0.6.x.
 */
export type UsageWithExtras = WireUsage;

/** Map `chat.completions` usage (`prompt_tokens`/`completion_tokens`). */
export function mapChatUsage(usage: ChatUsageLike | null | undefined): UsageWithExtras | undefined {
  if (usage === null || usage === undefined) return undefined;
  const details = usage.prompt_tokens_details;
  const cacheRead = tokenCount(details?.cached_tokens) ?? tokenCount(usage.prompt_cache_hit_tokens);
  return makeUsage(
    {
      input: tokenCount(usage.prompt_tokens),
      output: tokenCount(usage.completion_tokens),
      cacheRead,
      cacheWrite: tokenCount(details?.cache_write_tokens),
      reasoning: tokenCount(usage.completion_tokens_details?.reasoning_tokens),
    },
    { totalTokens: tokenCount(usage.total_tokens), cachedInputTokens: cacheRead },
  );
}

/** Map Responses API usage (`input_tokens`/`output_tokens`). */
export function mapResponsesUsage(
  usage: ResponsesUsageLike | null | undefined,
): UsageWithExtras | undefined {
  if (usage === null || usage === undefined) return undefined;
  const details = usage.input_tokens_details;
  const cacheRead = tokenCount(details?.cached_tokens);
  return makeUsage(
    {
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheRead,
      cacheWrite: tokenCount(details?.cache_write_tokens),
      reasoning: tokenCount(usage.output_tokens_details?.reasoning_tokens),
    },
    { totalTokens: tokenCount(usage.total_tokens), cachedInputTokens: cacheRead },
  );
}

// -- tools -------------------------------------------------------------------

export interface ToolDefLike {
  type?: string;
  name?: string;
  function?: { name?: string };
  custom?: { name?: string };
}

/** Tool item types the model runs locally and GraphMind can therefore gate. */
const LOCAL_CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call']);

/**
 * A Responses output item is a PROVIDER-EXECUTED tool call when it is a
 * `*_call` item that is not one of the locally-executed kinds (`function_call`,
 * `custom_tool_call`). These run on OpenAI's side, so they can only be
 * observed, never gated (decisions.md #4).
 */
export function isProviderExecutedItem(type: unknown): boolean {
  return typeof type === 'string' && type.endsWith('_call') && !LOCAL_CALL_ITEM_TYPES.has(type);
}

/** Display name of a Responses output item (`web_search_call` -> `web_search`). */
export function outputItemName(item: ResponseOutputItemLike): string {
  if (typeof item.name === 'string' && item.name.length > 0) return item.name;
  const type = typeof item.type === 'string' ? item.type : 'tool';
  return type.endsWith('_call') ? type.slice(0, -'_call'.length) : type;
}

export interface ToolRosterEntry {
  name: string;
  providerExecuted: boolean;
}

/**
 * The name of one request tool definition, in either API's shape (the same
 * rule `toolRoster` uses): `function.name`, `custom.name`, `name`, or — for a
 * built-in like `{type: 'web_search'}` — its type. Undefined when it has none.
 */
export function toolDefName(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const def = raw as ToolDefLike;
  const name =
    def.function?.name ??
    def.custom?.name ??
    (typeof def.name === 'string' ? def.name : undefined) ??
    (typeof def.type === 'string' ? def.type : undefined);
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Read a request body's `tools` array into a roster for `graph.hint`.
 * Handles both shapes: Chat Completions (`{type:'function', function:{name}}`)
 * and Responses (`{type:'function', name}` / built-ins like `{type:'web_search'}`).
 */
export function toolRoster(tools: unknown): ToolRosterEntry[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolRosterEntry[] = [];
  for (const raw of tools) {
    if (raw === null || typeof raw !== 'object') continue;
    const def = raw as ToolDefLike;
    const name =
      def.function?.name ??
      def.custom?.name ??
      (typeof def.name === 'string' ? def.name : undefined) ??
      (typeof def.type === 'string' ? def.type : undefined);
    if (typeof name !== 'string' || name.length === 0) continue;
    const providerExecuted = def.type !== 'function' && def.type !== 'custom';
    out.push({ name, providerExecuted });
  }
  return out;
}

// -- guards ------------------------------------------------------------------

export function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A `Stream<Item>`: async-iterable, teeable, and carrying an AbortController. */
export function isStreamLike(value: unknown): value is StreamLike {
  if (!isObject(value)) return false;
  return typeof value[Symbol.asyncIterator] === 'function' && typeof value['tee'] === 'function';
}

export function isThenable(value: unknown): value is ApiPromiseLike {
  if (!isObject(value)) return false;
  return typeof value['then'] === 'function';
}

/** Parse a stringified tool input if possible; otherwise pass it through. */
export function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
