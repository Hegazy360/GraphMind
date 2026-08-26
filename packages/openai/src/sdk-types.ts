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
import type { TokenUsage } from '@graphmind-ai/client';

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
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number } | null;
}

export interface ResponsesUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

/**
 * The wire `TokenUsage` plus the loose extras GraphMind viewers render when
 * present. `TokenUsageSchema` is a loose object, so unknown fields survive.
 */
export type UsageWithExtras = TokenUsage & {
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function assemble(
  input: number | undefined,
  output: number | undefined,
  total: number | undefined,
  cached: number | undefined,
  reasoning: number | undefined,
): UsageWithExtras | undefined {
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** Map `chat.completions` usage (`prompt_tokens`/`completion_tokens`). */
export function mapChatUsage(usage: ChatUsageLike | null | undefined): UsageWithExtras | undefined {
  if (usage === null || usage === undefined) return undefined;
  return assemble(
    count(usage.prompt_tokens),
    count(usage.completion_tokens),
    count(usage.total_tokens),
    count(usage.prompt_tokens_details?.cached_tokens),
    count(usage.completion_tokens_details?.reasoning_tokens),
  );
}

/** Map Responses API usage (`input_tokens`/`output_tokens`). */
export function mapResponsesUsage(
  usage: ResponsesUsageLike | null | undefined,
): UsageWithExtras | undefined {
  if (usage === null || usage === undefined) return undefined;
  return assemble(
    count(usage.input_tokens),
    count(usage.output_tokens),
    count(usage.total_tokens),
    count(usage.input_tokens_details?.cached_tokens),
    count(usage.output_tokens_details?.reasoning_tokens),
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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A `Stream<Item>`: async-iterable, teeable, and carrying an AbortController. */
export function isStreamLike(value: unknown): value is StreamLike {
  return (
    isObject(value) &&
    typeof (value as StreamLike)[Symbol.asyncIterator] === 'function' &&
    typeof (value as StreamLike).tee === 'function'
  );
}

export function isThenable(value: unknown): value is ApiPromiseLike {
  return isObject(value) && typeof (value as ApiPromiseLike).then === 'function';
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
