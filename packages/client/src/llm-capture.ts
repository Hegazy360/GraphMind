/**
 * What every LLM adapter records about a model step (0.6.0+, contract C1),
 * built once here so the adapters agree:
 *
 *  - `makeUsage`: the wire `TokenUsage`. `inputTokens` is the TOTAL prompt,
 *    cached tokens included, and every usage carries `inclusive: true`. The
 *    cache/reasoning counts appear only when the provider reported them (a
 *    reported 0 stays 0; an unreported count is absent, never 0-filled).
 *  - `toolCall`: one entry of `output.toolCalls` — `{id?, name, input,
 *    inputText?}`, where `inputText` keeps the raw argument text only when it
 *    does not parse (the truncated-by-max-tokens case).
 *  - `captureTools`: `tools: [{name, schemaHash}]` for `node.started.input`,
 *    plus `toolSchemas: {hash: definition}` the first time a definition is
 *    seen in a run. The hash is SHA-256 of the canonical JSON (sorted keys,
 *    the loop guard's canon) of the definition, first 16 hex chars. The
 *    per-run memory hangs off the session object (bounded: 256 runs x 1024
 *    hashes), so every adapter sharing a session shares it.
 *  - `pickParams`: the sampling parameters actually sent, under the SDK's own
 *    names, from an allow-list — request bodies also carry things that must
 *    never be recorded (Anthropic `mcp_servers[].authorization_token`, AI
 *    Gateway BYOK keys in `providerOptions`, `metadata.user_id`).
 *  - `withBinaryPlaceholders`: bytes in a prompt (AI SDK file parts) become
 *    `{type: 'binary', bytes}` instead of serialising as `{"0":…,"1":…}`.
 *
 * Everything here is pure bookkeeping and never throws into an adapter.
 */
import { createHash } from 'node:crypto';
import { normalizeFinishReason, type FinishReason, type TokenUsage } from '@graphmind-ai/schema';
import { canonicalize } from './loop-guard.js';

export { normalizeFinishReason, type FinishReason };

// -- usage -------------------------------------------------------------------

/** A token count as reported: a finite, non-negative number (rounded), else undefined. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Sum of the parts that were reported; undefined when none was. */
export function sumReported(...parts: (number | undefined)[]): number | undefined {
  let total: number | undefined;
  for (const part of parts) {
    if (part === undefined) continue;
    total = (total ?? 0) + part;
  }
  return total;
}

/** The counts a provider reported, already normalized; undefined = not reported. */
export interface UsageParts {
  /** TOTAL prompt tokens: cached reads and cache writes included. */
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  /** Output tokens spent reasoning (a subset of `output`). */
  reasoning?: number | undefined;
}

export type WireUsage = TokenUsage & Record<string, unknown>;

/**
 * The wire `TokenUsage` for one step, or undefined when neither the input nor
 * the output count was reported. The schema requires both counts, so the one
 * a provider left out is 0; the optional counts are never invented.
 * `extras` (legacy aliases, `totalTokens`) are appended as reported.
 */
export function makeUsage(
  parts: UsageParts,
  extras?: Record<string, number | undefined>,
): WireUsage | undefined {
  const input = tokenCount(parts.input);
  const output = tokenCount(parts.output);
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = tokenCount(parts.cacheRead);
  const cacheWrite = tokenCount(parts.cacheWrite);
  const reasoning = tokenCount(parts.reasoning);
  const usage: WireUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    inclusive: true,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
  if (extras !== undefined) {
    for (const [key, value] of Object.entries(extras)) {
      const n = tokenCount(value);
      if (n !== undefined) usage[key] = n;
    }
  }
  return usage;
}

// -- tool calls --------------------------------------------------------------

/** One tool call the model requested, as recorded in `output.toolCalls`. */
export interface RecordedToolCall {
  id?: string;
  name: string;
  /** The parsed arguments (`null` when they did not parse — see `inputText`). */
  input: unknown;
  /** The raw argument text, present only when it is not valid JSON. */
  inputText?: string;
}

/**
 * Normalize one requested tool call. `args` is the provider's arguments: a
 * JSON string (OpenAI, AI SDK, streamed deltas) or an already-parsed value
 * (Anthropic `tool_use.input`, LangChain `tool_calls[].args`). An empty
 * string is a call without arguments (`{}`). Undefined when there is no name.
 */
export function toolCall(id: unknown, name: unknown, args: unknown): RecordedToolCall | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const base: { id?: string; name: string } = {
    ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
    name,
  };
  if (args === undefined || args === null) return { ...base, input: {} };
  if (typeof args !== 'string') return { ...base, input: args };
  if (args.trim().length === 0) return { ...base, input: {} };
  try {
    return { ...base, input: JSON.parse(args) as unknown };
  } catch {
    return { ...base, input: null, inputText: args };
  }
}

/** `toolCall` over a list, dropping the unnamed. */
export function toolCalls(
  entries: readonly { id?: unknown; name?: unknown; args?: unknown }[],
): RecordedToolCall[] {
  const out: RecordedToolCall[] = [];
  for (const entry of entries) {
    const call = toolCall(entry.id, entry.name, entry.args);
    if (call !== undefined) out.push(call);
  }
  return out;
}

// -- tool definitions --------------------------------------------------------

/** Hex chars of the SHA-256 kept as a tool schema hash. */
export const SCHEMA_HASH_HEX_CHARS = 16;
/** Runs whose sent schema hashes a session remembers (least recent evicted). */
export const MAX_SCHEMA_RUNS = 256;
/** Hashes remembered per run; past it the run's memory restarts (a re-send is harmless). */
export const MAX_SCHEMA_HASHES_PER_RUN = 1024;

/** Stable hash of a tool definition: sha256(canonical JSON)[0:16]. */
export function schemaHash(definition: unknown): string {
  return createHash('sha256')
    .update(canonicalize(definition), 'utf8')
    .digest('hex')
    .slice(0, SCHEMA_HASH_HEX_CHARS);
}

export interface ToolRef {
  name: string;
  schemaHash: string;
}

export interface CapturedTools {
  tools: ToolRef[];
  /** Definitions this run has not been sent yet, keyed by hash. */
  toolSchemas?: Record<string, unknown>;
}

/** session -> runKey -> hashes already sent. Insertion order = recency. */
const sentByRun = new WeakMap<object, Map<string, Set<string>>>();

function runMemory(owner: object, runKey: string): Set<string> {
  let runs = sentByRun.get(owner);
  if (runs === undefined) {
    runs = new Map();
    sentByRun.set(owner, runs);
  }
  let hashes = runs.get(runKey);
  if (hashes !== undefined) {
    runs.delete(runKey); // re-insert: most recently used last
  } else {
    hashes = new Set();
    while (runs.size >= MAX_SCHEMA_RUNS) {
      const oldest = runs.keys().next();
      if (oldest.done === true) break;
      runs.delete(oldest.value);
    }
  }
  runs.set(runKey, hashes);
  return hashes;
}

/**
 * The `tools` / `toolSchemas` fields for one LLM step. `describe` names a
 * definition (undefined skips it); the whole definition is what is hashed and
 * sent. `owner` is the session (the memory's scope) and `runKey` the run the
 * step belongs to. Undefined when there is nothing to record. Never throws.
 */
export function captureTools(
  owner: object,
  runKey: string,
  definitions: unknown,
  describe: (definition: unknown) => string | undefined,
): CapturedTools | undefined {
  try {
    if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
    const sent = runMemory(owner, runKey);
    const tools: ToolRef[] = [];
    let toolSchemas: Record<string, unknown> | undefined;
    for (const definition of definitions as unknown[]) {
      let name: string | undefined;
      try {
        name = describe(definition);
      } catch {
        name = undefined;
      }
      if (name === undefined) continue;
      const hash = schemaHash(definition);
      tools.push({ name, schemaHash: hash });
      if (sent.has(hash)) continue;
      if (sent.size >= MAX_SCHEMA_HASHES_PER_RUN) sent.clear();
      sent.add(hash);
      toolSchemas ??= {};
      toolSchemas[hash] = definition;
    }
    if (tools.length === 0) return undefined;
    return toolSchemas === undefined ? { tools } : { tools, toolSchemas };
  } catch {
    return undefined;
  }
}

/** Forget what a session was sent (tests). */
export function resetToolSchemaMemory(owner: object): void {
  sentByRun.delete(owner);
}

// -- sampling parameters -----------------------------------------------------

/**
 * Request parameters recorded on `node.started.input` under the SDK's own
 * names: the AI SDK's call options (camelCase) and the provider bodies /
 * LangChain invocation params (snake_case). An allow-list on purpose — see
 * the module comment.
 */
export const SAMPLING_PARAM_KEYS: readonly string[] = Object.freeze([
  // AI SDK LanguageModelV3/V4 call options; also LangChain JS / Gemini spellings.
  'maxOutputTokens',
  'maxTokens',
  'temperature',
  'topP',
  'topK',
  'stopSequences',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
  'toolChoice',
  'responseFormat',
  'reasoning',
  // Anthropic / OpenAI bodies, LangChain invocation params, Python kwargs.
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'top_p',
  'top_k',
  'stop',
  'stop_sequences',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'n',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'reasoning_effort',
  'thinking',
  'service_tier',
  'truncation',
  'text',
  'verbosity',
  'prompt_cache_key',
  'max_tool_calls',
  'context_management',
  // Anthropic (2026): effort / structured output, and request-level caching.
  'output_config',
  'cache_control',
]);

/** The allow-listed keys of `source` whose value is not undefined, in `keys` order. */
export function pickParams(
  source: unknown,
  keys: readonly string[] = SAMPLING_PARAM_KEYS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null || typeof source !== 'object') return out;
  for (const key of keys) {
    try {
      const value = (source as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = value;
    } catch {
      // an unreadable parameter is simply not recorded
    }
  }
  return out;
}

// -- binary ------------------------------------------------------------------

const MAX_BINARY_WALK_DEPTH = 64;

/**
 * A copy of `value` with every byte buffer (`Uint8Array`, `Buffer`, any
 * ArrayBuffer view, `ArrayBuffer`) replaced by `{type: 'binary', bytes}`.
 * Containers without binary inside are returned as they are (no copy), class
 * instances are left to their own `toJSON`, and the host's objects are never
 * mutated.
 */
export function withBinaryPlaceholders(value: unknown): unknown {
  try {
    return replaceBinary(value, 0, new WeakSet());
  } catch {
    return value;
  }
}

function replaceBinary(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return { type: 'binary', bytes: value.byteLength };
  if (value instanceof ArrayBuffer) return { type: 'binary', bytes: value.byteLength };
  if (depth >= MAX_BINARY_WALK_DEPTH || seen.has(value)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < value.length; i += 1) {
        const item: unknown = value[i];
        const next = replaceBinary(item, depth + 1, seen);
        if (next !== item) {
          copy ??= value.slice();
          copy[i] = next;
        }
      }
      return copy ?? value;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let copy: Record<string, unknown> | undefined;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      const next = replaceBinary(item, depth + 1, seen);
      if (next !== item) {
        copy ??= { ...record };
        copy[key] = next;
      }
    }
    return copy ?? value;
  } finally {
    seen.delete(value);
  }
}
