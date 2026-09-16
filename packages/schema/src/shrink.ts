/**
 * The payload budget of the GraphMind protocol, and the one algorithm that
 * enforces it.
 *
 * Payloads are developer data (prompts, tool results) and are usually small,
 * but a single embedding array or scraped page can be enormous. Anything past
 * `MAX_PAYLOAD_BYTES` is degraded to a type-preserving preview so one event
 * cannot bloat the database, wedge the viewer, or — the reason this lives in
 * the schema package — blow the server's WebSocket frame cap and vanish
 * before it arrives.
 *
 * It started life inside the server's storage (packages/cli/src/storage.ts)
 * and moved here unchanged in behaviour so the client can apply the SAME
 * shrink at emit: what a client buffers and sends is then exactly what the
 * server stores, and the live view and a reload agree. The Python and Ruby
 * clients port it against test/fixtures/shrink.json.
 *
 * Platform-neutral on purpose: no `Buffer`, no Node APIs.
 *
 * UNITS — ports must match these exactly (they are pinned by the fixture):
 *  - `serializePayload` measures the whole payload JSON in UTF-8 BYTES, both
 *    for the budget check and for the top-level marker's `bytes`.
 *  - The field-trimming pass sizes each field by its JSON text LENGTH in
 *    UTF-16 code units, and subtracts those from the payload's UTF-8 byte
 *    total while deciding how many fields to shrink (mixed units, kept
 *    verbatim from the server this came from).
 *  - Its final fit check is UTF-8 BYTES again.
 *  - Every `preview` and every shortened string is a prefix of
 *    `PREVIEW_CHARS` UTF-16 code units (which can split a surrogate pair —
 *    JSON.stringify then writes the lone half as a `\udXXX` escape).
 *  - A shrunk object field's own marker `bytes` is its JSON text LENGTH in
 *    UTF-16 code units, not bytes.
 *  - Key caps (MAX_SHRINK_KEYS) count own enumerable keys in JavaScript key
 *    order: integer-like keys ascending first, then the rest in insertion
 *    order. The fixture avoids mixing the two in one capped object.
 *  - Skeleton strings are prefixes of SKELETON_CHARS (then
 *    SKELETON_MIN_CHARS) UTF-16 code units.
 *
 * TIERS of `serializePayload(payload, maxBytes, type?)`, in order:
 *  1. JSON within maxBytes (UTF-8) -> returned unchanged, same reference.
 *  2. A plain object with at most MAX_SHRINK_KEYS top-level fields -> the
 *     field trim (`truncateFields`). With a known event `type` its result
 *     must also validate against that type's schema.
 *  3. Known event `type` and a plain object -> the skeleton
 *     (`skeletonPayload`): only the schema's required fields (and optional
 *     ones holding a string, number or boolean), hard-shrunk.
 *  4. Otherwise -> the whole-payload marker {__graphmindTruncated, bytes,
 *     preview} (not a valid event of any known type).
 */

import { EventPayloadSchemas } from './events.js';

/** Largest payload, as UTF-8 bytes of its JSON, stored or sent unchanged. */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

/** Length, in UTF-16 code units, of every preview and shortened string. */
export const PREVIEW_CHARS = 2000;

/** Appended to a string field that had to be cut short. */
export const TRUNCATION_SUFFIX = '…[graphmind: truncated]';

/** How deep the field shrink recurses before it gives up and marks the subtree. */
export const MAX_SHRINK_DEPTH = 6;

/**
 * Most own enumerable keys the field shrink keeps from any one object (the
 * first ones, in key order), and most top-level fields an oversized payload
 * may have for the field-by-field trim to be attempted at all. Without it a
 * typed array (JSON: an object with one key per element) was walked key by
 * key: ~1 s and ~700 MB for 2 MB of data, and it still did not fit.
 */
export const MAX_SHRINK_KEYS = 256;

/**
 * Most own top-level fields a payload may have for the field trim (tier 2) to
 * be attempted. Deliberately separate from MAX_SHRINK_KEYS: capping the trim at
 * 256 top-level fields sent a payload of 257 small fields and one huge output
 * straight to the skeleton, losing every small field although trimming the one
 * big field would have fitted. The bound exists only so that a payload with
 * millions of top-level keys (a typed array emitted as the payload itself)
 * never pays for per-field sizing; 4,096 keeps that cost negligible.
 */
export const MAX_TRIM_FIELDS = 4096;

/** Longest string, in UTF-16 code units, the last-resort skeleton keeps. */
export const SKELETON_CHARS = 256;

/** The skeleton's string length on its final, smallest attempt. */
export const SKELETON_MIN_CHARS = 32;

export interface TruncatedPayload {
  __graphmindTruncated: true;
  bytes: number;
  preview: string;
  /**
   * Payload fields that were not kept verbatim, when only part of it was too
   * big (the field trim), or every field the skeleton did not keep verbatim.
   */
  fields?: string[];
  /**
   * On an object the field shrink capped at MAX_SHRINK_KEYS keys (at any
   * depth): how many of its keys were not kept.
   */
  keysDropped?: number;
}

export function isTruncatedPayload(value: unknown): value is TruncatedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __graphmindTruncated?: unknown }).__graphmindTruncated === true
  );
}

/** UTF-16 units encoded per `encodeInto` call in `utf8ByteLength`. */
const ENCODE_CHUNK = 65_536;

let scratch: Uint8Array | undefined;
let encoderCache: Utf8Encoder | null | undefined;

interface Utf8Encoder {
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

function sharedEncoder(): Utf8Encoder | undefined {
  if (encoderCache === undefined) {
    try {
      const Ctor = (globalThis as { TextEncoder?: new () => Utf8Encoder }).TextEncoder;
      encoderCache = typeof Ctor === 'function' ? new Ctor() : null;
    } catch {
      encoderCache = null;
    }
  }
  return encoderCache ?? undefined;
}

/**
 * UTF-8 byte length of a string.
 *
 * Identical to `new TextEncoder().encode(text).length` (and Node's
 * `Buffer.byteLength(text)`): a well-formed surrogate pair is 4 bytes and a
 * lone surrogate is 3 (it encodes as U+FFFD). Memory stays bounded for the
 * case this module exists for — measuring a 17 MB payload must not allocate
 * another 17-51 MB just to count it — by encoding into one reused 196 KB
 * scratch buffer, 65,536 UTF-16 units at a time (a chunk never ends between
 * the two halves of a surrogate pair). Where `TextEncoder` is missing, a
 * plain counting loop gives the same answer.
 */
export function utf8ByteLength(text: string): number {
  const encoder = sharedEncoder();
  if (encoder === undefined) return countUtf8Bytes(text);
  const length = text.length;
  scratch ??= new Uint8Array(ENCODE_CHUNK * 3 + 4);
  let bytes = 0;
  let start = 0;
  while (start < length) {
    let end = Math.min(start + ENCODE_CHUNK, length);
    const last = text.charCodeAt(end - 1);
    // Never split a pair: take the next unit too (at most CHUNK + 1 units,
    // at most 3 bytes each, so the scratch buffer can never fill up).
    if (last >= 0xd800 && last <= 0xdbff && end < length) end += 1;
    const chunk = start === 0 && end === length ? text : text.slice(start, end);
    const result = encoder.encodeInto(chunk, scratch);
    if (result.read !== chunk.length) return countUtf8Bytes(text); // cannot happen; be exact anyway
    bytes += result.written;
    start = end;
  }
  return bytes;
}

/** The same count without TextEncoder. Exported for the conformance test. */
export function countUtf8Bytes(text: string): number {
  let bytes = 0;
  const length = text.length;
  for (let i = 0; i < length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Create an own data property. A plain assignment of the key `__proto__`
 * would call the prototype setter instead and lose the key (JSON.parse
 * creates it as an ordinary own property, and so do the Python and Ruby
 * ports).
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/**
 * Shrink one oversized field, PRESERVING ITS JSON TYPE.
 *
 * Type preservation is the whole contract. The obvious implementation —
 * replace the offending value with a marker object — silently destroys the
 * events that matter most: `node.error` carries `error: {name, message}`,
 * both required strings, so a >512KB error message made `error` the biggest
 * field, the marker object replaced it, the stored envelope stopped
 * validating, and the viewer dropped it on replay. A debugger losing
 * precisely the error event is the worst possible failure, and it needs no
 * attacker — a provider returning a large error body is enough.
 *
 * So: a string stays a string (prefix + suffix), an array stays an array, an
 * object stays an object with its own fields shrunk in turn and the marker
 * fields merged in — schemas are loose, so the extra keys are preserved
 * rather than rejected, and `isTruncatedPayload` still reports true.
 *
 * An object keeps at most its first MAX_SHRINK_KEYS own enumerable keys; a
 * capped object also gets `__graphmindTruncated: true` and `keysDropped` (at
 * any depth). The loop stops doing work at the cap and only counts the rest.
 *
 * `encoded` is the value's JSON text when the caller already has it (the
 * field trim sizes every field), so the top-level marker does not serialize
 * a multi-megabyte field a second time.
 *
 * Only called on values that already serialized, so there are no cycles and
 * the depth is one JSON.stringify has survived; the depth bound is belt and
 * braces.
 */
function shrinkValue(value: unknown, depth = 0, encoded?: string): unknown {
  if (typeof value === 'string') {
    return value.length <= PREVIEW_CHARS
      ? value
      : `${value.slice(0, PREVIEW_CHARS)}${TRUNCATION_SUFFIX}`;
  }
  if (Array.isArray(value)) return [];
  if (!isPlainObject(value)) return value; // numbers, booleans, null: never the problem
  if (depth >= MAX_SHRINK_DEPTH) {
    return { __graphmindTruncated: true, bytes: 0, preview: '[deeply nested]' } satisfies TruncatedPayload;
  }
  const shrunk: Record<string, unknown> = {};
  let kept = 0;
  let dropped = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (kept === MAX_SHRINK_KEYS) {
      dropped += 1;
      continue;
    }
    setOwn(shrunk, key, shrinkValue(value[key], depth + 1));
    kept += 1;
  }
  // Marker only at the top of the field, not at every nesting level: one
  // preview per shrunk field is informative, one per node would reintroduce
  // the size problem the shrinking exists to solve. A capped object is the
  // exception — it says so, and how much it lost, wherever it is.
  if (depth > 0) {
    if (dropped > 0) {
      shrunk['__graphmindTruncated'] = true;
      shrunk['keysDropped'] = dropped;
    }
    return shrunk;
  }
  const text = encoded ?? safeStringify(value);
  const marked: Record<string, unknown> = {
    ...shrunk,
    __graphmindTruncated: true,
    bytes: text === undefined ? 0 : text.length,
    preview: text === undefined ? '[unserializable field]' : text.slice(0, PREVIEW_CHARS),
  };
  if (dropped > 0) marked['keysDropped'] = dropped;
  return marked;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return undefined;
  }
}

/** Whether `payload` has more than `limit` own enumerable keys (stops counting past it). */
function hasMoreKeysThan(payload: Record<string, unknown>, limit: number): boolean {
  let count = 0;
  for (const key in payload) {
    if (!Object.hasOwn(payload, key)) continue;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

/** Index of the quote that closes the JSON string opening at `open`, or -1. */
function stringEnd(json: string, open: number): number {
  let at = json.indexOf('"', open + 1);
  while (at !== -1) {
    let backslashes = 0;
    for (let i = at - 1; json.charCodeAt(i) === 0x5c; i -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return at;
    at = json.indexOf('"', at + 1);
  }
  return -1;
}

/**
 * Where each top-level field's value sits in `json`, the JSON.stringify text
 * of a plain object: key -> [start, end) offsets. That slice is exactly
 * `JSON.stringify(payload[key])` (compact output, same escaping), with one
 * exception no JSON-parsed payload can have: a `toJSON(key)` that answers
 * differently for its property name than for "". Keys whose value JSON omits
 * (undefined, functions, symbols) have no span. Returns undefined when the
 * text is not a JSON object, so the caller serializes field by field.
 *
 * One pass over the text (string contents are skipped with indexOf).
 * Exported for its property test only (not part of the package API).
 */
export function topLevelSpans(json: string): Map<string, [number, number]> | undefined {
  const length = json.length;
  if (json.charCodeAt(0) !== 0x7b) return undefined;
  const spans = new Map<string, [number, number]>();
  if (json === '{}') return spans;
  let i = 1;
  while (i < length) {
    if (json.charCodeAt(i) !== 0x22) return undefined;
    const keyEnd = stringEnd(json, i);
    if (keyEnd === -1) return undefined;
    const key = JSON.parse(json.slice(i, keyEnd + 1)) as string;
    if (json.charCodeAt(keyEnd + 1) !== 0x3a) return undefined;
    const start = keyEnd + 2;
    let depth = 0;
    let j = start;
    for (; j < length; j += 1) {
      const unit = json.charCodeAt(j);
      if (unit === 0x22) {
        j = stringEnd(json, j);
        if (j === -1) return undefined;
      } else if (unit === 0x7b || unit === 0x5b) {
        depth += 1;
      } else if (unit === 0x7d || unit === 0x5d) {
        if (depth === 0) break;
        depth -= 1;
      } else if (unit === 0x2c && depth === 0) {
        break;
      }
    }
    if (j >= length || j === start) return undefined;
    spans.set(key, [start, j]);
    if (json.charCodeAt(j) === 0x7d) return j === length - 1 ? spans : undefined;
    i = j + 1;
  }
  return undefined;
}

/**
 * Trim the offending FIELDS of an oversized object payload instead of
 * discarding the whole thing.
 *
 * This matters more than it looks: payload schemas are per message type
 * (`node.finished` needs `nodeId`, `durationMs`, `status`), and a payload
 * replaced wholesale by a marker no longer satisfies its own schema — the
 * viewer's parser rejects the replayed envelope and the node is stuck
 * "running" forever on reload. Keeping the small structural fields and
 * marking only the huge ones keeps the stored envelope valid, which is what
 * makes an oversized tool result *degrade* rather than disappear.
 *
 * Returns undefined when the payload cannot be trimmed into budget this way
 * (still too big) — the caller then tries the skeleton, then the
 * whole-payload marker. The caller only calls it for a payload with at most
 * MAX_SHRINK_KEYS top-level fields.
 */
function truncateFields(
  payload: Record<string, unknown>,
  maxBytes: number,
  totalBytes: number,
  json: string,
): { json: string; payload: Record<string, unknown> } | undefined {
  const sizes: { key: string; bytes: number; encoded: string | undefined }[] = [];
  // Each field's JSON is a slice of the payload's (see `topLevelSpans`), so a
  // multi-megabyte field is not serialized a second (and third) time.
  const spans =
    typeof (payload as { toJSON?: unknown }).toJSON === 'function' ? undefined : topLevelSpans(json);
  for (const key of Object.keys(payload)) {
    const span = spans?.get(key);
    const encoded = span === undefined ? safeStringify(payload[key]) : json.slice(span[0], span[1]);
    sizes.push({ key, bytes: encoded === undefined ? Number.MAX_SAFE_INTEGER : encoded.length, encoded });
  }
  // Biggest first: drop as few fields as possible to get under budget.
  // (Array.prototype.sort is stable: equal sizes keep key order.)
  sizes.sort((a, b) => b.bytes - a.bytes);

  const trimmed: Record<string, unknown> = { ...payload };
  const dropped: string[] = [];
  let remaining = totalBytes;
  for (const { key, bytes, encoded } of sizes) {
    if (remaining <= maxBytes / 2) break; // leave room for the marker itself
    // Type-preserving: see `shrinkValue`. A required string field must come
    // back as a string or the envelope stops satisfying its own schema.
    trimmed[key] = shrinkValue(payload[key], 0, encoded);
    dropped.push(key);
    remaining -= bytes;
  }
  if (dropped.length === 0) return undefined;

  // The top-level marker fields stay, so `isTruncatedPayload` still reports
  // true for a partially truncated payload and every consumer keeps working.
  const marker: TruncatedPayload = {
    __graphmindTruncated: true,
    bytes: totalBytes,
    preview: json.slice(0, PREVIEW_CHARS),
    fields: dropped,
  };
  const result = { ...trimmed, ...marker };
  const encoded = safeStringify(result);
  if (encoded === undefined || utf8ByteLength(encoded) > maxBytes) return undefined;
  return { json: encoded, payload: result };
}

/**
 * Keep every field that still serializes, and replace only the ones that do
 * not (cyclic, or too deeply nested for JSON.stringify) with a marker.
 *
 * The whole point is that the envelope must remain valid against its own
 * schema: `node.finished` keeps nodeId/durationMs/status and loses only the
 * pathological `output`. Returns undefined when the result still cannot be
 * serialized, so the caller can fall back to the whole-payload marker.
 */
function truncateUnserializableFields(
  payload: Record<string, unknown>,
): { json: string; payload: Record<string, unknown> } | undefined {
  const trimmed: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (safeStringify(value) !== undefined) {
      setOwn(trimmed, key, value);
      continue;
    }
    dropped.push(key);
    // Arrays keep their type so `z.array(...)` still matches.
    setOwn(
      trimmed,
      key,
      Array.isArray(value)
        ? []
        : ({
            __graphmindTruncated: true,
            bytes: 0,
            preview: '[unserializable value]',
          } satisfies TruncatedPayload),
    );
  }
  if (dropped.length === 0) return undefined; // nothing to blame; let the caller decide
  trimmed['__graphmindTruncated'] = true;
  trimmed['fields'] = dropped;
  const json = safeStringify(trimmed);
  return json === undefined ? undefined : { json, payload: trimmed };
}

// ---------------------------------------------------------------------------
// The skeleton: the last tier that still yields a VALID event.
// ---------------------------------------------------------------------------

/**
 * The fields a skeleton may keep, from an event schema: its top-level keys in
 * schema declaration order. A REQUIRED key maps to the plan of its own keys
 * when its schema is a loose object, else to `null`; an OPTIONAL key maps to
 * `'optional'` and is kept only when its value is a string, number or boolean
 * (so identity and timing fields such as `instanceId`, `parentId` and
 * `heldMs` survive; optional objects and arrays do not).
 */
export interface SkeletonPlan {
  readonly keys: readonly (readonly [string, SkeletonPlan | null | 'optional'])[];
}

interface ZodInternals {
  _zod: { optin?: string; def: { type: string; catchall?: { _zod: { def: { type: string } } } } };
  shape?: Record<string, unknown>;
}

function planOf(schema: unknown): SkeletonPlan | null {
  const internals = schema as ZodInternals;
  const def = internals._zod?.def;
  // A LOOSE object: type 'object' with an `unknown` catchall (z.looseObject).
  if (def?.type !== 'object' || def.catchall?._zod.def.type !== 'unknown' || internals.shape === undefined) {
    return null;
  }
  const keys: (readonly [string, SkeletonPlan | null | 'optional'])[] = [];
  for (const [key, field] of Object.entries(internals.shape)) {
    keys.push([key, (field as ZodInternals)._zod.optin === 'optional' ? 'optional' : planOf(field)]);
  }
  return { keys };
}

let plans: Map<string, SkeletonPlan> | undefined;

/**
 * The skeleton plan of a known event type (derived once from its zod schema),
 * or undefined for any other type. Exported for the fixture generator, which
 * writes these plans into shrink.json for the Python and Ruby ports.
 */
export function skeletonPlan(type: string): SkeletonPlan | undefined {
  if (plans === undefined) {
    plans = new Map();
    for (const [name, schema] of Object.entries(EventPayloadSchemas)) {
      const plan = planOf(schema);
      if (plan !== null) plans.set(name, plan);
    }
  }
  return plans.get(type);
}

function omittedMarker(): TruncatedPayload {
  return { __graphmindTruncated: true, bytes: 0, preview: '[omitted]' };
}

/**
 * The planned keys of `value`, hard-shrunk, in plan order. `verbatim` holds
 * the keys whose kept value is exactly the original.
 */
function keepPlanned(
  value: Record<string, unknown>,
  plan: SkeletonPlan,
  chars: number,
): { out: Record<string, unknown>; verbatim: Set<string>; kept: number } {
  const out: Record<string, unknown> = {};
  const verbatim = new Set<string>();
  let kept = 0;
  for (const [key, sub] of plan.keys) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    if (sub === 'optional') {
      const type = typeof child;
      if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    }
    const shrunk = hardShrink(child, sub === 'optional' ? null : sub, chars);
    setOwn(out, key, shrunk.value);
    kept += 1;
    if (shrunk.verbatim) verbatim.add(key);
  }
  return { out, verbatim, kept };
}

/**
 * Hard-shrink one kept value for the skeleton. `verbatim` is true when the
 * result is exactly the original value: a string of at most `chars` units, a
 * number, boolean or null, an empty array, or a planned object all of whose
 * own keys were kept verbatim.
 */
function hardShrink(value: unknown, plan: SkeletonPlan | null, chars: number): { value: unknown; verbatim: boolean } {
  if (typeof value === 'string') {
    return value.length <= chars
      ? { value, verbatim: true }
      : { value: `${value.slice(0, chars)}${TRUNCATION_SUFFIX}`, verbatim: false };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { value, verbatim: true };
  }
  if (Array.isArray(value)) return { value: [], verbatim: value.length === 0 };
  if (isPlainObject(value) && plan !== null) {
    const { out, verbatim, kept } = keepPlanned(value, plan, chars);
    return { value: out, verbatim: verbatim.size === kept && !hasMoreKeysThan(value, kept) };
  }
  return { value: omittedMarker(), verbatim: false };
}

/** Skeleton attempts, largest first: [string chars, keep preview and fields]. */
const SKELETON_ATTEMPTS: readonly (readonly [number, boolean])[] = [
  [SKELETON_CHARS, true],
  [SKELETON_CHARS, false],
  [SKELETON_MIN_CHARS, false],
];

/**
 * The last tier before the whole-payload marker, for a known event type.
 *
 * The field trim cannot always fit: an output keyed by id with thousands of
 * small records, hundreds of medium fields, a required nested object with
 * thousands of extra keys ahead of the required ones. The whole-payload
 * marker that used to follow is not a valid node.* payload, so the server
 * dropped the event and its node stayed "running" forever.
 *
 * The skeleton keeps only the schema's fields (see `skeletonPlan`: every
 * required one, and optional ones holding a string, number or boolean), each
 * hard-shrunk (`hardShrink`), then the marker: {__graphmindTruncated, bytes,
 * preview, fields: every original key not kept verbatim}. It is tried three
 * times, smaller each time — [256 chars, preview + fields], [256 chars,
 * preview "" and no fields], [32 chars, preview "" and no fields] — and the
 * first that validates against the type's schema and fits maxBytes (UTF-8)
 * wins. For every known type the last attempt is well under a kilobyte, so
 * it fits any maxBytes >= 4096.
 */
function skeletonPayload(
  payload: Record<string, unknown>,
  type: string,
  plan: SkeletonPlan,
  maxBytes: number,
  bytes: number,
  preview: string,
): { json: string; payload: Record<string, unknown> } | undefined {
  const schema = (EventPayloadSchemas as Record<string, { safeParse(value: unknown): { success: boolean } }>)[type];
  if (schema === undefined) return undefined;
  for (const [chars, full] of SKELETON_ATTEMPTS) {
    const { out, verbatim } = keepPlanned(payload, plan, chars);
    out['__graphmindTruncated'] = true;
    out['bytes'] = bytes;
    out['preview'] = full ? preview : '';
    if (full) {
      const fields: string[] = [];
      // Every key name costs at least its length in UTF-8 bytes of the
      // result, so once the names alone exceed the budget this attempt cannot
      // fit: stop listing (a payload with millions of keys) and move on.
      let units = 0;
      for (const key in payload) {
        if (!Object.hasOwn(payload, key) || verbatim.has(key)) continue;
        fields.push(key);
        units += key.length;
        if (units > maxBytes) break;
      }
      if (units > maxBytes) continue;
      out['fields'] = fields;
    }
    const json = safeStringify(out);
    if (json === undefined || utf8ByteLength(json) > maxBytes) continue;
    if (!schema.safeParse(out).success) continue;
    return { json, payload: out };
  }
  return undefined;
}

function isValidFor(type: string | undefined, payload: unknown): boolean {
  if (type === undefined || !Object.hasOwn(EventPayloadSchemas, type)) return true;
  const schema = (EventPayloadSchemas as Record<string, { safeParse(value: unknown): { success: boolean } }>)[type];
  return schema?.safeParse(payload).success ?? true;
}

/**
 * Serialize a payload, shrinking it when its JSON exceeds `maxBytes` UTF-8
 * bytes (default `MAX_PAYLOAD_BYTES`). Returns the JSON text to store plus
 * the effective payload, so callers can fan out exactly what was persisted.
 *
 * Pass the event `type` whenever you have it: for a known event type the
 * result is then guaranteed to be a VALID payload of that type (the field
 * trim's result is checked, and the skeleton tier stands between it and the
 * whole-payload marker), within `maxBytes` for any `maxBytes >= 4096`. See
 * the TIERS list at the top of this file.
 *
 * Idempotent: a result fed back in is within budget and comes back unchanged
 * (`truncated: false`, same `payload` reference, same `json`). May throw only
 * if reading the payload itself throws (a throwing getter or Proxy trap).
 */
export function serializePayload(
  payload: unknown,
  maxBytes: number = MAX_PAYLOAD_BYTES,
  type?: string,
): { json: string; payload: unknown; truncated: boolean } {
  const plan = type === undefined ? undefined : skeletonPlan(type);
  let json: string;
  try {
    json = JSON.stringify(payload) ?? 'null';
  } catch {
    // Cyclic, nested deeper than the JSON serializer's stack (the depth at
    // which that bites is platform-dependent — Linux trips on payloads macOS
    // serializes fine, which is how CI caught this), or longer than the
    // engine's maximum string length.
    //
    // Replacing the WHOLE payload here loses the fields the payload's own
    // schema requires, so the stored envelope no longer validates and the
    // viewer drops the event on replay: the node hangs "running" forever.
    // Trim the offending FIELDS instead, exactly as the oversized path does,
    // so the event still parses and only the unserializable value is lost.
    if (isPlainObject(payload)) {
      const trimmed = truncateUnserializableFields(payload);
      if (trimmed !== undefined && plan === undefined) {
        return { json: trimmed.json, payload: trimmed.payload, truncated: true };
      }
      if (trimmed !== undefined && type !== undefined) {
        // Known type: the event must also be valid and within budget.
        const bytes = utf8ByteLength(trimmed.json);
        if (bytes <= maxBytes && isValidFor(type, trimmed.payload)) {
          return { json: trimmed.json, payload: trimmed.payload, truncated: true };
        }
        if (bytes > maxBytes && !hasMoreKeysThan(trimmed.payload, MAX_TRIM_FIELDS)) {
          const fitted = truncateFields(trimmed.payload, maxBytes, bytes, trimmed.json);
          if (fitted !== undefined && isValidFor(type, fitted.payload)) {
            return { json: fitted.json, payload: fitted.payload, truncated: true };
          }
        }
      }
      if (plan !== undefined && type !== undefined) {
        const skeleton = skeletonPayload(payload, type, plan, maxBytes, 0, '[unserializable payload]');
        if (skeleton !== undefined) return { json: skeleton.json, payload: skeleton.payload, truncated: true };
      }
    }
    const marker: TruncatedPayload = {
      __graphmindTruncated: true,
      bytes: 0,
      preview: '[unserializable payload]',
    };
    return { json: JSON.stringify(marker), payload: marker, truncated: true };
  }
  const bytes = utf8ByteLength(json);
  if (bytes <= maxBytes) return { json, payload, truncated: false };

  if (isPlainObject(payload)) {
    if (!hasMoreKeysThan(payload, MAX_TRIM_FIELDS)) {
      const trimmed = truncateFields(payload, maxBytes, bytes, json);
      if (trimmed !== undefined && isValidFor(type, trimmed.payload)) {
        return { json: trimmed.json, payload: trimmed.payload, truncated: true };
      }
    }
    if (plan !== undefined && type !== undefined) {
      const skeleton = skeletonPayload(payload, type, plan, maxBytes, bytes, json.slice(0, PREVIEW_CHARS));
      if (skeleton !== undefined) return { json: skeleton.json, payload: skeleton.payload, truncated: true };
    }
  }

  const marker: TruncatedPayload = {
    __graphmindTruncated: true,
    bytes,
    preview: json.slice(0, PREVIEW_CHARS),
  };
  return { json: JSON.stringify(marker), payload: marker, truncated: true };
}
