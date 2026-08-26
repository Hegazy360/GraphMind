/**
 * Payload hygiene.
 *
 * LangGraph node inputs/outputs are whole graph states, which can be large,
 * cyclic (checkpointers, runtime handles) or hold class instances. Everything
 * that goes on the wire passes through `safePayload`, which
 *  - drops values it cannot serialize (rather than letting `JSON.stringify`
 *    throw inside `session.emit`, which would silently lose the event), and
 *  - truncates anything bigger than `maxChars` to a preview, so one fat state
 *    object cannot evict a whole replay ring buffer.
 */

export const DEFAULT_MAX_PAYLOAD_CHARS = 20_000;

export interface TruncatedPayload {
  __graphmind: 'truncated';
  preview: string;
  chars: number;
}

export interface UnserializablePayload {
  __graphmind: 'unserializable';
  preview: string;
}

export function safePayload(value: unknown, maxChars = DEFAULT_MAX_PAYLOAD_CHARS): unknown {
  if (value === undefined || value === null) return value;
  const primitive = typeof value;
  if (primitive === 'number' || primitive === 'boolean') return value;
  if (primitive === 'string') {
    const text = value as string;
    return text.length <= maxChars ? text : truncate(text, maxChars);
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value, replacer());
  } catch (error) {
    return { __graphmind: 'unserializable', preview: previewOf(error) } satisfies UnserializablePayload;
  }
  if (json === undefined) {
    return { __graphmind: 'unserializable', preview: typeof value } satisfies UnserializablePayload;
  }
  if (json.length > maxChars) return truncate(json, maxChars);
  try {
    return JSON.parse(json);
  } catch {
    return { __graphmind: 'unserializable', preview: 'parse failed' } satisfies UnserializablePayload;
  }
}

function truncate(text: string, maxChars: number): TruncatedPayload {
  return {
    __graphmind: 'truncated',
    preview: text.slice(0, maxChars),
    chars: text.length,
  };
}

function previewOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replacer that survives cycles (marking them) and normalizes the values
 * `JSON.stringify` would otherwise drop or throw on.
 *
 * Cycles are detected against the ANCESTOR chain, not "every object seen":
 * graph state legitimately repeats the same message object in several
 * channels, and calling that `[Circular]` would be a lie.
 */
function replacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function') return undefined;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value !== 'object' || value === null) return value;

    // Unwind to the current holder: everything after it is a finished branch.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);

    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value instanceof Map) return Object.fromEntries([...value.entries()].slice(0, 200));
    if (value instanceof Set) return [...value.values()].slice(0, 200);
    return value;
  };
}
