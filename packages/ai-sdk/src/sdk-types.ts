/**
 * The slice of the AI SDK surface this adapter reads, expressed structurally.
 *
 * Primary target is `ai` v7 (provider spec V4); the shapes below are duck
 * typed with optional fields so an `ai` v6 (spec V3) shim only needs to touch
 * this file plus the two runtime imports from 'ai' (`wrapLanguageModel` in
 * graphmind.ts, nothing else). Everything else in the package treats stream
 * parts and call params through these types.
 */

import {
  makeUsage,
  normalizeFinishReason,
  sumReported,
  tokenCount,
  type FinishReason,
  type WireUsage,
} from '@graphmind-ai/client';

/**
 * Subset of LanguageModelV4CallOptions / V3CallOptions the adapter touches.
 * The sampling options (`temperature`, `maxOutputTokens`, `topP`, ...) are
 * read by name through `pickParams` (see middleware.ts), hence the index.
 */
export interface CallParamsLike {
  prompt?: unknown;
  tools?: ToolDefLike[] | undefined;
  abortSignal?: AbortSignal | undefined;
  [option: string]: unknown;
}

/** One entry of `params.tools`: a function tool or a provider tool. */
export interface ToolDefLike {
  /** 'function' | 'provider' on V4; undefined on older specs. */
  type?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
}

/**
 * Usage as the middleware sees it. V3 (ai@6) and V4 (ai@7) use the nested
 * shape `{inputTokens: {total, noCache, cacheRead, cacheWrite}, outputTokens:
 * {total, text, reasoning}}` (verified against @ai-sdk/provider 4.0.8's
 * LanguageModelV3Usage / LanguageModelV4Usage); V2 used plain numbers plus
 * `cachedInputTokens` / `reasoningTokens`. `wrapLanguageModel` converts a V2
 * model to V4 before middleware runs (ai@7 `convertV2UsageToV3`: the number
 * becomes `total`), so the numbers mostly arrive nested — both are accepted.
 */
export interface UsageLike {
  inputTokens?:
    | number
    | {
        total?: number | undefined;
        noCache?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
      }
    | undefined;
  outputTokens?:
    | number
    | { total?: number | undefined; text?: number | undefined; reasoning?: number | undefined }
    | undefined;
  /** V2 only. */
  cachedInputTokens?: number | undefined;
  /** V2 only. */
  reasoningTokens?: number | undefined;
}

/** V3/V4 `{unified, raw}`; V2 a bare (already unified) string. */
export type FinishReasonLike = { unified?: string; raw?: string | undefined } | string | undefined;

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
  finishReason?: FinishReasonLike;
  error?: unknown;
}

export interface GenerateResultLike {
  content?: StreamPartLike[];
  usage?: UsageLike;
  finishReason?: FinishReasonLike;
}

export interface StreamResultLike {
  stream: ReadableStream<unknown>;
}

/** Tool execute options as seen by `ai` v6/v7 (`ToolExecutionOptions`). */
export interface ToolCallOptionsLike {
  toolCallId?: string;
  abortSignal?: AbortSignal | undefined;
}

export function unifiedFinishReason(reason: FinishReasonLike): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason !== undefined && reason !== null && typeof reason.unified === 'string') return reason.unified;
  return undefined;
}

/**
 * `finishReason` (normalized) and `rawFinishReason` (the provider's own
 * string, V3/V4 `raw`, only when reported) for `node.finished.output`.
 */
export function finishFields(
  reason: FinishReasonLike,
  hasToolCalls: boolean,
): { finishReason?: FinishReason; rawFinishReason?: string } {
  const finishReason = normalizeFinishReason(unifiedFinishReason(reason), hasToolCalls);
  const raw =
    reason !== null && typeof reason === 'object' && typeof reason.raw === 'string' && reason.raw.length > 0
      ? reason.raw
      : undefined;
  return {
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(raw !== undefined ? { rawFinishReason: raw } : {}),
  };
}

/**
 * Map SDK usage (V3/V4 nested or V2 numbers) to the wire TokenUsage:
 * `inputTokens` is the total (cache included) — `total`, or the sum of the
 * reported parts when a provider left `total` out.
 */
export function mapUsage(usage: UsageLike | undefined): WireUsage | undefined {
  if (usage === undefined || usage === null) return undefined;
  const side = usage.inputTokens;
  const out = usage.outputTokens;
  let input: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  if (typeof side === 'number') {
    input = tokenCount(side);
    cacheRead = tokenCount(usage.cachedInputTokens);
  } else if (side !== null && typeof side === 'object') {
    cacheRead = tokenCount(side.cacheRead);
    cacheWrite = tokenCount(side.cacheWrite);
    input = tokenCount(side.total) ?? sumReported(tokenCount(side.noCache), cacheRead, cacheWrite);
  }
  let output: number | undefined;
  let reasoning: number | undefined;
  if (typeof out === 'number') {
    output = tokenCount(out);
    reasoning = tokenCount(usage.reasoningTokens);
  } else if (out !== null && typeof out === 'object') {
    reasoning = tokenCount(out.reasoning);
    output = tokenCount(out.total) ?? sumReported(tokenCount(out.text), reasoning);
  }
  return makeUsage({ input, output, cacheRead, cacheWrite, reasoning });
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
