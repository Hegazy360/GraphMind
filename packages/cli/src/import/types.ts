/**
 * Shared types + attribute helpers for the trace importer.
 *
 * The importer normalizes every supported input file into `RawSpan`s
 * (container-independent), classifies each span into an `ImportedNode`
 * (dialect-dependent: AI SDK legacy / GenAI semconv / OpenInference), and
 * finally synthesizes a schema-valid envelope sequence (convert.ts).
 * Assumptions are documented in README.md next to this file.
 */
import type { ErrorInfo, NodeKind, TokenUsage } from '@graphmind-ai/schema';

/** A user-facing import failure. `message` must say WHAT was unrecognized. */
export class ImportError extends Error {
  override name = 'ImportError';
}

/** One span, normalized out of its container (OTLP tree or flat list). */
export interface RawSpan {
  spanId: string;
  parentSpanId: string | undefined;
  traceId: string | undefined;
  name: string;
  /** Epoch milliseconds (nanosecond precision is dropped). */
  startMs: number;
  endMs: number;
  /** Present when the span's status (or an exception event) marks it failed. */
  error: ErrorInfo | undefined;
  /** Flattened attributes: dotted keys -> plain JS values. */
  attrs: Record<string, unknown>;
}

/** The dialect a span's attributes were recognized as. */
export type Dialect = 'ai-sdk' | 'genai' | 'openinference';

/** A span mapped onto GraphMind node identity (decisions.md #1). */
export interface ImportedNode {
  span: RawSpan;
  dialect: Dialect;
  kind: NodeKind;
  /** Stable logical id: `agent:<name>` / `llm:step` / `tool:<name>` / `custom:<name>`. */
  nodeId: string;
  name: string;
  /** Per-execution id: tool call id when known, else the span id. */
  instanceId: string;
  input: unknown;
  output: unknown;
  usage: TokenUsage | undefined;
  model: string | undefined;
}

// -- attribute helpers -------------------------------------------------------

export function attrString(
  attrs: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function attrNumber(
  attrs: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/**
 * Inputs/outputs are frequently stringified JSON on span attributes
 * (`ai.prompt`, `gen_ai.tool.call.arguments`, OpenInference `input.value`).
 * Parse strings that look like JSON objects/arrays; keep everything else
 * (plain text, numbers, already-structured values) as-is.
 */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Token usage from the first attribute key that resolves for each side.
 * A missing side defaults to 0 (the schema requires both fields); values are
 * rounded and clamped to non-negative integers. Returns undefined when
 * neither side is present.
 */
export function usageFrom(
  attrs: Record<string, unknown>,
  inputKeys: string[],
  outputKeys: string[],
): TokenUsage | undefined {
  const input = attrNumber(attrs, ...inputKeys);
  const output = attrNumber(attrs, ...outputKeys);
  if (input === undefined && output === undefined) return undefined;
  const clamp = (n: number | undefined): number => Math.max(0, Math.round(n ?? 0));
  return { inputTokens: clamp(input), outputTokens: clamp(output) };
}

/**
 * Flatten a nested attribute object into dotted keys
 * (`{llm: {token_count: {prompt: 1}}}` -> `"llm.token_count.prompt": 1`).
 * Keys that are already dotted stay as-is; arrays and non-plain objects are
 * kept whole as values (message lists etc. stay structured).
 */
export function flattenAttrs(
  value: unknown,
  prefix = '',
  into: Record<string, unknown> = {},
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') into[prefix] = value;
    return into;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 && prefix !== '') {
    into[prefix] = value;
    return into;
  }
  for (const [key, child] of entries) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flattenAttrs(child, path, into);
    } else {
      into[path] = child;
    }
  }
  return into;
}

/**
 * Rebuild a nested value from flattened dotted keys under `prefix`
 * (OpenInference flattens message lists: `llm.input_messages.0.message.role`).
 * An exact-match key wins. Objects whose keys are all canonical non-negative
 * integers become arrays. Returns undefined when nothing matches.
 */
export function unflattenPrefix(
  attrs: Record<string, unknown>,
  prefix: string,
): unknown {
  if (prefix in attrs) return attrs[prefix];
  const withDot = `${prefix}.`;
  const root: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith(withDot)) continue;
    found = true;
    const segments = key.slice(withDot.length).split('.');
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      const next = cursor[seg];
      if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        cursor[seg] = created;
        cursor = created;
      }
    }
    cursor[segments[segments.length - 1] as string] = value;
  }
  if (!found) return undefined;
  return arrayify(root);
}

/** Convert integer-keyed objects (recursively) into dense, ordered arrays. */
function arrayify(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const converted: Record<string, unknown> = {};
  for (const key of keys) converted[key] = arrayify(record[key]);
  const allIndexes = keys.length > 0 && keys.every((k) => /^(0|[1-9]\d*)$/.test(k));
  if (!allIndexes) return converted;
  return keys
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((k) => converted[String(k)]);
}
