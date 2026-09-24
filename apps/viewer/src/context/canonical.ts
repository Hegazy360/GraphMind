/**
 * Canonical form + hash for comparing recorded prompt messages.
 *
 * Two messages are "the same" when what the MODEL sees is the same:
 *
 *  - Keys that only steer caching or SDK plumbing move between steps without
 *    changing the prompt — the usual pattern re-marks the newest message with
 *    a cache breakpoint every turn — so they are dropped: `cache_control`
 *    (Anthropic), `providerOptions` / `providerMetadata` (AI SDK),
 *    `usage_metadata` / `response_metadata` (LangChain message dumps).
 *  - A `content` that is one plain text part is the same as that text as a
 *    string (`"hi"` ≡ `[{type:'text', text:'hi'}]`): moving the breakpoint
 *    onto a string message turns it into the block form, and the providers
 *    treat the two alike.
 *  - Object keys are sorted, so two recorders that order keys differently
 *    still agree.
 */

const VOLATILE_KEYS = new Set([
  'cache_control',
  'providerOptions',
  'providerMetadata',
  'usage_metadata',
  'response_metadata',
]);

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);

/** `[{type:'text', text}]` (volatile keys aside) → `text`; anything else as is. */
function plainContent(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) return value;
  const part = value[0] as unknown;
  if (part === null || typeof part !== 'object' || Array.isArray(part)) return value;
  const record = part as Record<string, unknown>;
  if (typeof record['text'] !== 'string' || !TEXT_PART_TYPES.has(String(record['type']))) return value;
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'text' && !VOLATILE_KEYS.has(key) && record[key] !== undefined) return value;
  }
  return record['text'];
}

/** JSON text with sorted keys and volatile keys removed. Never throws. */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  write(value, parts, 0);
  return parts.join('');
}

function write(value: unknown, out: string[], depth: number): void {
  if (depth > 64) {
    out.push('"…"');
    return;
  }
  if (value === null || value === undefined) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'number':
      out.push(Number.isFinite(value) ? String(value) : 'null');
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'object':
      break;
    default:
      out.push('null');
      return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      write(value[i], out, depth + 1);
    }
    out.push(']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => !VOLATILE_KEYS.has(k) && record[k] !== undefined)
    .sort();
  out.push('{');
  keys.forEach((key, i) => {
    if (i > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(key === 'content' ? plainContent(record[key]) : record[key], out, depth + 1);
  });
  out.push('}');
}

/** cyrb53: a fast 53-bit string hash (not cryptographic; collisions ~2^-53). */
export function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Identity key of a value: hash + length of its canonical JSON. */
export function identityOf(value: unknown): { key: string; size: number } {
  const json = canonicalJson(value);
  return { key: `${hash53(json).toString(36)}:${json.length}`, size: json.length };
}
