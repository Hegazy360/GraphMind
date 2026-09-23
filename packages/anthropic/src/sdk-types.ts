/**
 * The slice of the Anthropic TypeScript SDK surface this adapter reads,
 * expressed STRUCTURALLY.
 *
 * The adapter never imports `@anthropic-ai/sdk` at runtime and never names its
 * classes in its own types: everything below is duck typed against the shapes
 * documented in the installed `.d.ts` (validated against 0.121.0). That keeps
 * the adapter working across SDK versions and keeps the peer dependency truly
 * optional at load time.
 */
import { makeUsage, sumReported, tokenCount, type WireUsage } from '@graphmind-ai/client';

/**
 * `client.messages.create(...)` / `client.messages.stream(...)` body. The
 * sampling parameters (`max_tokens`, `temperature`, `top_p`, `top_k`,
 * `stop_sequences`, `tool_choice`, `thinking`, ...) are read by name from the
 * allow-list in @graphmind-ai/client, hence the index signature.
 */
export interface MessageCreateParamsLike {
  model?: unknown;
  messages?: unknown[];
  system?: unknown;
  tools?: ToolDefLike[] | undefined;
  stream?: boolean | undefined;
  max_tokens?: number;
  [param: string]: unknown;
}

/** One entry of `params.tools`: a custom tool or a built-in/server tool. */
export interface ToolDefLike {
  /** `undefined` / `'custom'` for user tools; a dated id for built-ins. */
  type?: string | null | undefined;
  name?: string | undefined;
}

/** Second argument of `create`/`stream` (`RequestOptions`). */
export interface RequestOptionsLike {
  signal?: AbortSignal | undefined | null;
  timeout?: number | undefined;
  [key: string]: unknown;
}

/**
 * `Usage` / `MessageDeltaUsage`. All fields are nullable on the wire.
 * `input_tokens` is the UNCACHED tail of the prompt only; the prompt total is
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 * (platform.claude.com prompt-caching docs). `cache_creation` splits the write
 * by TTL (5 minutes at 1.25x, 1 hour at 2x).
 */
export interface UsageLike {
  input_tokens?: number | null | undefined;
  output_tokens?: number | null | undefined;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
  cache_creation?:
    | {
        ephemeral_5m_input_tokens?: number | null | undefined;
        ephemeral_1h_input_tokens?: number | null | undefined;
      }
    | null
    | undefined;
}

/** Any `ContentBlock` (assistant output) the adapter looks at. */
export interface ContentBlockLike {
  type?: string | undefined;
  text?: string | undefined;
  thinking?: string | undefined;
  /** `tool_use` / `server_tool_use` id. */
  id?: string | undefined;
  name?: string | undefined;
  input?: unknown;
  /** `*_tool_result` blocks point back at the `server_tool_use` id. */
  tool_use_id?: string | undefined;
  content?: unknown;
}

/** A `Message` (the non-streaming result, and `message_start.message`). */
export interface MessageLike {
  id?: string | undefined;
  model?: string | undefined;
  role?: string | undefined;
  content?: ContentBlockLike[] | undefined;
  stop_reason?: string | null | undefined;
  usage?: UsageLike | undefined;
}

/** A `RawMessageStreamEvent`. */
export interface StreamEventLike {
  type?: string | undefined;
  index?: number | undefined;
  message?: MessageLike | undefined;
  content_block?: ContentBlockLike | undefined;
  delta?:
    | {
        type?: string | undefined;
        text?: string | undefined;
        partial_json?: string | undefined;
        thinking?: string | undefined;
        stop_reason?: string | null | undefined;
      }
    | undefined;
  usage?: UsageLike | undefined;
  error?: unknown;
}

/** `Stream<RawMessageStreamEvent>` — only the iteration protocol is used. */
export type MessageStreamLike = AsyncIterable<StreamEventLike>;

/**
 * `APIPromise<T>`: a promise plus the SDK's response helpers. The helpers are
 * optional here so the adapter degrades gracefully on any SDK build that
 * lacks them.
 */
export interface ApiPromiseLike<T> extends PromiseLike<T> {
  asResponse?: () => Promise<Response>;
  withResponse?: () => Promise<ApiResponseEnvelope<T>>;
}

export interface ApiResponseEnvelope<T> {
  data: T;
  response: Response;
  request_id?: string | null | undefined;
  workspace_id?: string | null | undefined;
}

/** Server-side (provider-executed) tool invocations cannot be gated. */
export const SERVER_TOOL_USE_BLOCK = 'server_tool_use';

export function isServerToolResultBlock(block: ContentBlockLike): boolean {
  return typeof block.type === 'string' && block.type.endsWith('_tool_result');
}

export function isToolUseBlock(block: ContentBlockLike): boolean {
  return block.type === 'tool_use';
}

/** A built-in tool definition (`web_search_20250305`, `bash_20250124`, ...). */
export function isBuiltinToolDef(def: ToolDefLike): boolean {
  return typeof def.type === 'string' && def.type.length > 0 && def.type !== 'custom';
}

/**
 * Map an Anthropic `Usage` to the wire `TokenUsage` (contract C1):
 * `inputTokens` = uncached tail + cache reads + cache writes, `inclusive:
 * true`; `cacheWriteTokens` is `cache_creation_input_tokens`, or the sum of
 * the 5m/1h split when only the split was reported. `cacheCreationTokens`
 * stays as a documented alias of `cacheWriteTokens` through 0.6.x (0.5 events
 * carried it next to an UNCACHED `inputTokens` — readers recompute those).
 */
export function mapUsage(usage: UsageLike | undefined | null): WireUsage | undefined {
  if (usage === undefined || usage === null) return undefined;
  const uncached = tokenCount(usage.input_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const split = usage.cache_creation;
  const cacheWrite =
    tokenCount(usage.cache_creation_input_tokens) ??
    (split !== null && typeof split === 'object'
      ? sumReported(tokenCount(split.ephemeral_5m_input_tokens), tokenCount(split.ephemeral_1h_input_tokens))
      : undefined);
  return makeUsage(
    {
      input: sumReported(uncached, cacheRead, cacheWrite),
      output: tokenCount(usage.output_tokens),
      cacheRead,
      cacheWrite,
    },
    { cacheCreationTokens: cacheWrite },
  );
}

/**
 * Merge the usage seen on `message_start` (input + cache counts) with the
 * cumulative usage of `message_delta` (output count; newer API versions repeat
 * the input and cache counts there too). Later reported fields win; both
 * sides may be partial.
 */
export function mergeUsage(
  base: UsageLike | undefined,
  next: UsageLike | undefined,
): UsageLike | undefined {
  if (base === undefined || base === null) return next;
  if (next === undefined || next === null) return base;
  const merged: UsageLike = { ...base };
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ] as const) {
    const value = next[key];
    if (typeof value === 'number') merged[key] = value;
  }
  const split = next.cache_creation;
  if (split !== null && typeof split === 'object') {
    merged.cache_creation = { ...(merged.cache_creation ?? {}) };
    for (const key of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const) {
      const value = split[key];
      if (typeof value === 'number') merged.cache_creation[key] = value;
    }
  }
  return merged;
}

/** Concatenate the `text` blocks of an assistant message. */
export function messageText(message: MessageLike | undefined): string {
  let text = '';
  for (const block of message?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
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
