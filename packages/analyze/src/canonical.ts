/**
 * Canonical JSON for duplicate-call detection — a port of the client's
 * loop-guard canonicalization (@graphmind-ai/client, loop-guard.ts), so a
 * retrospective analysis groups calls exactly the way the live loop guard
 * does. The client cannot be imported here: it pulls in Node transports and
 * the viewer bundles this package. test/canonical.test.ts pins string parity
 * against `canonicalCall` from the client, so a drift fails the suite.
 *
 * Differences from the client, both deliberate:
 *  - no character budget (the guard's budget is Infinity for inputs anyway);
 *  - the comparison key is the canonical string itself, not a salted HMAC —
 *    the live guard salts per process because its fingerprints travel on the
 *    wire; these never leave the analysis. `shortDigest` (FNV-1a, hex) exists
 *    only to label an incident in a report.
 */

const MAX_DEPTH = 64;

/** Keys ignored at every nesting level, as the live guard ignores them. */
export const DEFAULT_IGNORE_KEYS: ReadonlySet<string> = new Set(['_meta']);

/** JSON-escaped string (same escaping as JSON.stringify). */
function quote(text: string): string {
  return JSON.stringify(text);
}

function canonicalizeValue(
  value: unknown,
  ignoreKeys: ReadonlySet<string>,
  depth: number,
  seen: WeakSet<object>,
): string {
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'number':
      // JSON.stringify: shortest round-trip, `-0` -> "0", NaN/Infinity -> null.
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'object':
      break;
    default:
      return 'null';
  }
  if (value === null) return 'null';
  const object = value as Record<string, unknown> & { toJSON?: unknown };
  if (depth > MAX_DEPTH) return '"[depth]"';
  if (seen.has(object)) return '"[circular]"';
  if (typeof object.toJSON === 'function') {
    let replaced: unknown;
    try {
      replaced = (object.toJSON as () => unknown)();
    } catch {
      return '"[unserializable]"';
    }
    if (replaced === object) return '"[unserializable]"';
    return canonicalizeValue(replaced, ignoreKeys, depth + 1, seen);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      let out = '[';
      for (let i = 0; i < object.length; i += 1) {
        if (i > 0) out += ',';
        out += canonicalizeValue(object[i], ignoreKeys, depth + 1, seen);
      }
      return `${out}]`;
    }
    const keys = Object.keys(object).sort();
    let out = '{';
    let first = true;
    for (const key of keys) {
      if (ignoreKeys.has(key)) continue;
      const item = object[key];
      const type = typeof item;
      if (type === 'undefined' || type === 'function' || type === 'symbol') continue;
      if (!first) out += ',';
      first = false;
      out += `${quote(key)}:${canonicalizeValue(item, ignoreKeys, depth + 1, seen)}`;
    }
    return `${out}}`;
  } finally {
    seen.delete(object);
  }
}

/** Canonical JSON of one value; `undefined` when it cannot be read (a trap threw). */
export function canonicalValue(
  value: unknown,
  ignoreKeys: ReadonlySet<string> = DEFAULT_IGNORE_KEYS,
): string | undefined {
  try {
    return canonicalizeValue(value, ignoreKeys, 0, new WeakSet());
  } catch {
    return undefined;
  }
}

/**
 * The comparison key of one call: `[nodeId, canonical input]`, exactly the
 * string the client's `canonicalCall` builds. `undefined` when the input is
 * unreadable — such a call is not known to equal anything.
 */
export function callKey(
  nodeId: string,
  input: unknown,
  ignoreKeys: ReadonlySet<string> = DEFAULT_IGNORE_KEYS,
): string | undefined {
  const canonical = canonicalValue(input, ignoreKeys);
  return canonical === undefined ? undefined : `[${quote(nodeId)},${canonical}]`;
}

/**
 * Short display label for a call key (FNV-1a 32-bit, 8 hex chars). Stable
 * across platforms and dependency-free; never used for comparison.
 */
export function shortDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
