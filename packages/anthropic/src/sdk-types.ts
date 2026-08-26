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
import type { TokenUsage } from '@graphmind-ai/client';

/** `client.messages.create(...)` / `client.messages.stream(...)` body. */
export interface MessageCreateParamsLike {
  model?: unknown;
  messages?: unknown[];
  system?: unknown;
  tools?: ToolDefLike[] | undefined;
  stream?: boolean | undefined;
  max_tokens?: number;
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

/** `Usage` / `MessageDeltaUsage`. All fields are nullable on the wire. */
export interface UsageLike {
  input_tokens?: number | null | undefined;
  output_tokens?: number | null | undefined;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
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

function count(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Map an Anthropic `Usage` to the wire `TokenUsage`. Cache accounting is
 * carried in extra fields — the wire schema is loose and preserves them.
 */
export function mapUsage(
  usage: UsageLike | undefined,
): (TokenUsage & Record<string, number>) | undefined {
  if (usage === undefined || usage === null) return undefined;
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheCreationTokens = count(usage.cache_creation_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

/**
 * Merge the usage seen on `message_start` (input + cache counts) with the
 * cumulative usage of `message_delta` (output count). Later non-undefined
 * fields win; both sides may be partial.
 */
export function mergeUsage(
  base: UsageLike | undefined,
  next: UsageLike | undefined,
): UsageLike | undefined {
  if (base === undefined) return next;
  if (next === undefined) return base;
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
