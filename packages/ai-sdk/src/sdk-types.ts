/**
 * The slice of the AI SDK surface this adapter reads, expressed structurally.
 *
 * Primary target is `ai` v7 (provider spec V4); the shapes below are duck
 * typed with optional fields so an `ai` v6 (spec V3) shim only needs to touch
 * this file plus the two runtime imports from 'ai' (`wrapLanguageModel` in
 * graphmind.ts, nothing else). Everything else in the package treats stream
 * parts and call params through these types.
 */

/** Subset of LanguageModelV4CallOptions / V3CallOptions the adapter touches. */
export interface CallParamsLike {
  prompt?: unknown;
  tools?: ToolDefLike[] | undefined;
  abortSignal?: AbortSignal | undefined;
}

/** One entry of `params.tools`: a function tool or a provider tool. */
export interface ToolDefLike {
  /** 'function' | 'provider' on V4; undefined on older specs. */
  type?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
}

/** V4 usage `{inputTokens:{total}}`; V3/V2 used plain numbers. Both accepted. */
export interface UsageLike {
  inputTokens?: number | { total?: number | undefined } | undefined;
  outputTokens?: number | { total?: number | undefined } | undefined;
}

/** Duck-typed union over the stream/content parts the adapter observes. */
export interface StreamPartLike {
  type: string;
  id?: string;
  delta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
  dynamic?: boolean;
  result?: unknown;
  isError?: boolean;
  usage?: UsageLike;
  finishReason?: { unified?: string } | string | undefined;
  error?: unknown;
}

export interface GenerateResultLike {
  content?: StreamPartLike[];
  usage?: UsageLike;
  finishReason?: { unified?: string } | string | undefined;
}

export interface StreamResultLike {
  stream: ReadableStream<unknown>;
}

/** Tool execute options as seen by `ai` v6/v7 (`ToolExecutionOptions`). */
export interface ToolCallOptionsLike {
  toolCallId?: string;
  abortSignal?: AbortSignal | undefined;
}

export function unifiedFinishReason(reason: StreamPartLike['finishReason']): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason !== undefined && typeof reason.unified === 'string') return reason.unified;
  return undefined;
}

function sideTotal(side: UsageLike['inputTokens']): number | undefined {
  const raw = typeof side === 'number' ? side : side?.total;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : undefined;
}

/** Map SDK usage (V4 object shape or V2/V3 numbers) to the wire TokenUsage. */
export function mapUsage(
  usage: UsageLike | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = sideTotal(usage.inputTokens);
  const outputTokens = sideTotal(usage.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Streaming tools must be declared as `async function*` so the wrapper can
 * return a synchronous AsyncIterable (the SDK type-sniffs execute's DIRECT
 * return value; an async wrapper would hide the iterable inside a promise).
 */
export function isAsyncGeneratorFunction(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  const ctorName = (fn as { constructor?: { name?: string } }).constructor?.name;
  return ctorName === 'AsyncGeneratorFunction';
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
