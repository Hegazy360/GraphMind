/**
 * Flat span-list parsing: OpenInference span exports as produced around
 * Arize Phoenix — a JSON array (or `{spans: [...]}` / `{data: [...]}`, or
 * JSONL) of span objects like
 *
 *   { "name": "...", "context": {"trace_id": "...", "span_id": "..."},
 *     "span_kind": "LLM", "parent_id": "...", "start_time": "<ISO8601>",
 *     "end_time": "<ISO8601>", "status_code": "OK", "status_message": "",
 *     "attributes": {"llm.token_count.prompt": 10, ...}, "events": [...] }
 *
 * Tolerated variations (see README.md): camelCase field names, ids at the
 * top level instead of under `context`, numeric epoch timestamps
 * (s/ms/us/ns, decided by magnitude), nested attribute objects (flattened
 * to dotted keys), and pandas-dataframe records with top-level
 * `attributes.*` columns.
 */
import type { ErrorInfo } from '@graphmind-ai/schema';
import { flattenAttrs, type RawSpan } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Timestamp -> epoch ms. Strings parse as ISO 8601; numbers are epoch values
 * whose unit is decided by magnitude (>=1e17 ns, >=1e14 us, >=1e11 ms, else s).
 */
function toMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const abs = Math.abs(value);
  if (abs >= 1e17) return Math.round(value / 1e6);
  if (abs >= 1e14) return Math.round(value / 1e3);
  if (abs >= 1e11) return Math.round(value);
  return Math.round(value * 1000);
}

const ERROR_STATUS_CODES = new Set<unknown>(['ERROR', 'Error', 'STATUS_CODE_ERROR', 2, '2']);

/** First `exception` event; attributes may be a dict or an OTLP kv-list. */
function exceptionEvent(events: unknown): ErrorInfo | undefined {
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (!isRecord(event) || event['name'] !== 'exception') continue;
    let attrs: Record<string, unknown> = {};
    if (isRecord(event['attributes'])) {
      attrs = flattenAttrs(event['attributes']);
    } else if (Array.isArray(event['attributes'])) {
      for (const entry of event['attributes'] as unknown[]) {
        if (isRecord(entry) && typeof entry['key'] === 'string') {
          attrs[entry['key']] = isRecord(entry['value'])
            ? ((entry['value'] as Record<string, unknown>)['stringValue'] ?? entry['value'])
            : entry['value'];
        }
      }
    }
    return {
      name: firstString(attrs['exception.type']) ?? 'Error',
      message: firstString(attrs['exception.message']) ?? 'exception',
      ...(typeof attrs['exception.stacktrace'] === 'string'
        ? { stack: attrs['exception.stacktrace'] }
        : {}),
    };
  }
  return undefined;
}

/**
 * Parse a flat span export. Returns null when the value is not a span list
 * at all (not an array and no `spans`/`data` array property).
 */
export function parseFlatSpans(root: unknown): RawSpan[] | null {
  let items: unknown[];
  if (Array.isArray(root)) {
    items = root;
  } else if (isRecord(root) && Array.isArray(root['spans'])) {
    items = root['spans'] as unknown[];
  } else if (isRecord(root) && Array.isArray(root['data'])) {
    items = root['data'] as unknown[];
  } else {
    return null;
  }

  const spans: RawSpan[] = [];
  let anonymous = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const context = isRecord(item['context']) ? item['context'] : {};

    // Attributes: `attributes` object (flattened) + dataframe-style
    // top-level `attributes.*` columns.
    const attrs = flattenAttrs(isRecord(item['attributes']) ? item['attributes'] : {});
    for (const [key, value] of Object.entries(item)) {
      if (key.startsWith('attributes.')) attrs[key.slice('attributes.'.length)] = value;
    }
    const spanKind = firstString(
      item['span_kind'],
      item['spanKind'],
      item['kind'],
      attrs['openinference.span.kind'],
    );
    if (spanKind !== undefined) attrs['openinference.span.kind'] = spanKind;

    const startMs = toMs(item['start_time'] ?? item['startTime'] ?? item['start_time_unix_nano']);
    const endMs = toMs(item['end_time'] ?? item['endTime'] ?? item['end_time_unix_nano']);

    const statusCode = item['status_code'] ?? item['statusCode'];
    const statusMessage = firstString(item['status_message'], item['statusMessage']);
    let error: ErrorInfo | undefined;
    if (ERROR_STATUS_CODES.has(statusCode)) {
      const exception = exceptionEvent(item['events']);
      error = {
        name: exception?.name ?? 'Error',
        message:
          exception?.message ?? statusMessage ?? 'imported span reported an error status',
        ...(exception?.stack !== undefined ? { stack: exception.stack } : {}),
      };
    }

    const start = startMs ?? endMs ?? 0;
    spans.push({
      spanId:
        firstString(context['span_id'], context['spanId'], item['span_id'], item['spanId'], item['id']) ??
        `span_${(anonymous += 1)}`,
      parentSpanId: firstString(item['parent_id'], item['parentId'], item['parent_span_id']),
      traceId: firstString(context['trace_id'], context['traceId'], item['trace_id']),
      name: typeof item['name'] === 'string' ? item['name'] : '',
      startMs: start,
      endMs: Math.max(start, endMs ?? start),
      error,
      attrs,
    });
  }
  return spans;
}
