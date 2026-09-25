/**
 * LLM-step conventions shared by every sender and reader (0.6.0+). Pure
 * functions, no I/O — the schema package is platform-neutral.
 *
 *  - `normalizeFinishReason`: providers spell "why the model stopped" a dozen
 *    ways (`end_turn`, `tool_calls`, `MAX_TOKENS`, ...). Senders write the
 *    normalized value as `output.finishReason` and the provider's own string as
 *    `output.rawFinishReason`; readers normalize legacy events (which carried
 *    the raw string in `finishReason`, or `stopReason` from the Anthropic TS
 *    adapter) with the same function.
 *  - `readUsage`: what a reader should display for a `TokenUsage`. With
 *    `inclusive: true` the numbers are trusted as they are. Without the marker
 *    they are "as reported" by whatever sender wrote them — except events from
 *    the 0.5 Anthropic TS adapter, recognisable by `cacheCreationTokens`,
 *    whose `inputTokens` was the uncached tail and can be recomputed.
 *
 * The same rules are ported to Python (`graphmind.integrations._common`) and
 * Ruby (`Graphmind::Integrations::Support`).
 */

/** The normalized `output.finishReason` values of an LLM node. */
export const FINISH_REASONS = [
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'error',
  'other',
] as const;

export type FinishReason = (typeof FINISH_REASONS)[number];

/**
 * Provider spellings, lower-cased with `-`/space folded to `_`. Anything not
 * listed is `other`. Sources: Anthropic `stop_reason`, OpenAI chat
 * `finish_reason` and Responses `status`/`incomplete_details.reason`, Gemini
 * `finishReason`, Bedrock `stopReason`, the AI SDK's unified values, ruby_llm.
 */
const FINISH_REASON_MAP: Readonly<Record<string, FinishReason>> = Object.freeze({
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  // Anthropic: a long server-tool turn was paused and must be sent back to
  // continue — the model did not finish, so not a `stop`.
  pause_turn: 'other',
  eos: 'stop',
  eos_token: 'stop',
  complete: 'stop',
  completed: 'stop',
  finished: 'stop',
  length: 'length',
  max_tokens: 'length',
  max_output_tokens: 'length',
  max_completion_tokens: 'length',
  model_context_window_exceeded: 'length',
  model_length: 'length',
  tool_calls: 'tool-calls',
  tool_call: 'tool-calls',
  tool_use: 'tool-calls',
  function_call: 'tool-calls',
  content_filter: 'content-filter',
  content_filtered: 'content-filter',
  refusal: 'content-filter',
  safety: 'content-filter',
  recitation: 'content-filter',
  blocklist: 'content-filter',
  prohibited_content: 'content-filter',
  spii: 'content-filter',
  image_safety: 'content-filter',
  guardrail_intervened: 'content-filter',
  error: 'error',
  failed: 'error',
  malformed_function_call: 'error',
  other: 'other',
  unknown: 'other',
});

/**
 * The normalized finish reason for a provider's raw value, or `undefined`
 * when nothing usable was reported. A plain stop on a step that requested
 * tool calls is `tool-calls` (Gemini reports `STOP` there, and OpenAI does
 * when `tool_choice` names a function) — the model stopped to call tools.
 */
export function normalizeFinishReason(raw: unknown, hasToolCalls = false): FinishReason | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (key.length === 0) return undefined;
  const mapped = FINISH_REASON_MAP[key] ?? 'other';
  return mapped === 'stop' && hasToolCalls ? 'tool-calls' : mapped;
}

/** How `UsageView.inputTokens` was obtained. */
export type UsageBasis =
  /** The sender stamped `inclusive: true`: the total prompt, cache included. */
  | 'inclusive'
  /** A 0.5 Anthropic TS event: `inputTokens + cacheReadTokens + cacheCreationTokens`. */
  | 'recomputed'
  /** No marker: whatever the sender's provider reported (may exclude cache). */
  | 'reported';

/** What a reader displays for one `TokenUsage`. */
export interface UsageView {
  /** Prompt tokens — the total, cache included, unless `basis` is `reported`. */
  inputTokens: number;
  outputTokens: number;
  basis: UsageBasis;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read a stored `usage` for display. `undefined` when it is not a usage object
 * (both counts must be non-negative numbers, as the wire schema requires).
 * Never throws.
 */
export function readUsage(usage: unknown): UsageView | undefined {
  try {
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
    const u = usage as Record<string, unknown>;
    const input = count(u['inputTokens']);
    const output = count(u['outputTokens']);
    if (input === undefined || output === undefined) return undefined;
    // New field names first, then the 0.5 aliases (Anthropic TS
    // `cacheCreationTokens`, OpenAI TS `cachedInputTokens`).
    const cacheRead = count(u['cacheReadTokens']) ?? count(u['cachedInputTokens']);
    const legacyWrite = count(u['cacheCreationTokens']);
    const cacheWrite = count(u['cacheWriteTokens']) ?? legacyWrite;
    const reasoning = count(u['reasoningTokens']);
    const extras = {
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    };
    if (u['inclusive'] === true) {
      return { inputTokens: input, outputTokens: output, basis: 'inclusive', ...extras };
    }
    if (legacyWrite !== undefined) {
      // 0.5 Anthropic TS: `inputTokens` was Anthropic's uncached tail.
      const total = input + (count(u['cacheReadTokens']) ?? 0) + legacyWrite;
      return { inputTokens: total, outputTokens: output, basis: 'recomputed', ...extras };
    }
    return { inputTokens: input, outputTokens: output, basis: 'reported', ...extras };
  } catch {
    return undefined;
  }
}
