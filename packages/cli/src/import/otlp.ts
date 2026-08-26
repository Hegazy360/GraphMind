/**
 * OTLP/JSON container parsing: `{resourceSpans: [{resource, scopeSpans:
 * [{spans: [...]}]}]}` as written by the OTel collector file exporter and
 * SDK JSON exporters. Both camelCase (proto3 JSON mapping, the norm) and
 * snake_case field names are tolerated. Attribute values arrive as OTLP
 * `AnyValue` objects and are converted to plain JS values.
 */
import type { ErrorInfo } from '@graphmind-ai/schema';
import type { RawSpan } from './types.js';

interface OtlpParsed {
  spans: RawSpan[];
  /** Resource attributes of the first resource (e.g. `service.name`). */
  resourceAttrs: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

/** OTLP AnyValue -> plain JS value. */
function anyValueToJs(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (typeof value['stringValue'] === 'string') return value['stringValue'];
  const int = field(value, 'intValue', 'int_value');
  if (int !== undefined) return Number(int); // OTLP/JSON encodes int64 as string
  const double = field(value, 'doubleValue', 'double_value');
  if (double !== undefined) return Number(double);
  const bool = field(value, 'boolValue', 'bool_value');
  if (bool !== undefined) return bool === true;
  const arr = field(value, 'arrayValue', 'array_value');
  if (isRecord(arr) && Array.isArray(arr['values'])) {
    return (arr['values'] as unknown[]).map(anyValueToJs);
  }
  const kvlist = field(value, 'kvlistValue', 'kvlist_value');
  if (isRecord(kvlist) && Array.isArray(kvlist['values'])) {
    return kvListToRecord(kvlist['values'] as unknown[]);
  }
  const bytes = field(value, 'bytesValue', 'bytes_value');
  if (bytes !== undefined) return bytes;
  return value;
}

/** OTLP `[{key, value: AnyValue}]` -> record. Malformed entries are skipped. */
function kvListToRecord(entries: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (!Array.isArray(entries)) return record;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry['key'] !== 'string') continue;
    record[entry['key']] = anyValueToJs(entry['value']);
  }
  return record;
}

/** Unix-nano timestamp (string or number) -> epoch ms (sub-ms dropped). */
function nanoToMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const nano = Number(value);
  if (!Number.isFinite(nano)) return undefined;
  return Math.round(nano / 1_000_000);
}

const ERROR_STATUS_CODES = new Set<unknown>([2, '2', 'STATUS_CODE_ERROR', 'ERROR', 'Error']);

function statusError(
  status: unknown,
  events: unknown,
): ErrorInfo | undefined {
  const record = isRecord(status) ? status : {};
  if (!ERROR_STATUS_CODES.has(record['code'])) return undefined;
  const message = typeof record['message'] === 'string' ? record['message'] : undefined;
  const exception = exceptionEvent(events);
  return {
    name: exception?.name ?? 'Error',
    message: exception?.message ?? message ?? 'imported span reported an error status',
    ...(exception?.stack !== undefined ? { stack: exception.stack } : {}),
  };
}

/** First OTel `exception` event on the span, if any. */
function exceptionEvent(events: unknown): ErrorInfo | undefined {
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (!isRecord(event) || event['name'] !== 'exception') continue;
    const attrs = kvListToRecord(event['attributes']);
    const type = attrs['exception.type'];
    const message = attrs['exception.message'];
    const stack = attrs['exception.stacktrace'];
    return {
      name: typeof type === 'string' ? type : 'Error',
      message: typeof message === 'string' ? message : 'exception',
      ...(typeof stack === 'string' ? { stack } : {}),
    };
  }
  return undefined;
}

/**
 * Parse an OTLP/JSON export. Returns null when the value is not OTLP-shaped
 * (no `resourceSpans`/`resource_spans` array) so the caller can try the flat
 * OpenInference shape instead.
 */
export function parseOtlpJson(root: unknown): OtlpParsed | null {
  if (!isRecord(root)) return null;
  const resourceSpans = field(root, 'resourceSpans', 'resource_spans');
  if (!Array.isArray(resourceSpans)) return null;

  const spans: RawSpan[] = [];
  let resourceAttrs: Record<string, unknown> = {};
  let anonymous = 0;

  for (const rs of resourceSpans) {
    if (!isRecord(rs)) continue;
    const resource = rs['resource'];
    if (isRecord(resource) && Object.keys(resourceAttrs).length === 0) {
      resourceAttrs = kvListToRecord(resource['attributes']);
    }
    const scopeSpans =
      field(rs, 'scopeSpans', 'scope_spans') ??
      field(rs, 'instrumentationLibrarySpans', 'instrumentation_library_spans');
    if (!Array.isArray(scopeSpans)) continue;
    for (const scope of scopeSpans) {
      if (!isRecord(scope) || !Array.isArray(scope['spans'])) continue;
      for (const span of scope['spans'] as unknown[]) {
        if (!isRecord(span)) continue;
        const startMs = nanoToMs(field(span, 'startTimeUnixNano', 'start_time_unix_nano')) ?? 0;
        const endMsRaw = nanoToMs(field(span, 'endTimeUnixNano', 'end_time_unix_nano')) ?? startMs;
        const spanId = typeof span['spanId'] === 'string'
          ? span['spanId']
          : typeof span['span_id'] === 'string'
            ? span['span_id']
            : `span_${(anonymous += 1)}`;
        const parent = field(span, 'parentSpanId', 'parent_span_id');
        const traceId = field(span, 'traceId', 'trace_id');
        spans.push({
          spanId,
          parentSpanId:
            typeof parent === 'string' && parent.length > 0 ? parent : undefined,
          traceId: typeof traceId === 'string' ? traceId : undefined,
          name: typeof span['name'] === 'string' ? span['name'] : '',
          startMs,
          endMs: Math.max(startMs, endMsRaw),
          error: statusError(span['status'], span['events']),
          attrs: kvListToRecord(span['attributes']),
        });
      }
    }
  }
  return { spans, resourceAttrs };
}
