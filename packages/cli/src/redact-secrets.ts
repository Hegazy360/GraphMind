/**
 * Export sanitisation for `graphmind record` (NDJSON and --html).
 *
 * The second question a reviewer of a loopback dev tool asks is "will a
 * shared export leak a secret?". The answer here is deliberately narrow and
 * predictable: values under an exact list of secret-shaped KEYS become
 * "__REDACTED__"; nothing is inferred from values (no regexes, no entropy
 * heuristics — those were refuted, see internal/research/phase6-plan-2026-09.md
 * W7, and substring key matching was refuted because it blanks `max_tokens`).
 *
 * Match rule (binding, "Shared contracts"): case-insensitive, on the whole
 * key or a `_`/`-`-delimited segment run of it. `api_key`, `x-api-key`,
 * `Authorization`, `http_authorization` match; `max_tokens`, `tokenizer`,
 * `apiKeys` do not. One extension, a strict superset of that rule: a
 * camelCase boundary counts as a delimiter too, because JS payloads spell
 * these keys `accessToken` / `clientSecret` / `privateKey`, and an export
 * that kept those while blanking `access_token` would be a leak with a
 * green checkmark. Everything the binding rule matches still matches;
 * everything it names as a non-match (`max_tokens`, `maxTokens`,
 * `tokenizer`) still does not. Because it is a segment rule it also matches
 * `token_count` and `client_secret_expires_at` — over-redaction is the safe
 * direction, and `--no-redact-secrets` keeps everything.
 *
 * The same walk serves both export formats, so they can never disagree.
 * It never un-redacts anything already redacted (a second pass is a no-op),
 * never mutates its input, and never throws.
 */
import type { StoredEvent } from './storage.js';

/** The placeholder. Identical to @graphmind-ai/client's `REDACTED` by contract. */
export const REDACTED = '__REDACTED__';

/** The binding key list. Compared lower-cased; `-` and `_` are equivalent. */
export const SECRET_KEYS: readonly string[] = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'password',
  'passwd',
  'secret',
  'client_secret',
  'private_key',
  'access_token',
  'refresh_token',
  'token',
  'bearer',
]);

/** Delimiter-normalised (`-` -> `_`), lower-cased forms, for the segment-run test. */
const NORMALISED_KEYS: ReadonlySet<string> = new Set(SECRET_KEYS.map((k) => k.replace(/-/g, '_')));
/**
 * The most segments any listed key has (`client_secret` -> 2). A longer run
 * can never equal a listed key, so the segment-run test only builds runs up
 * to this length: linear in the key, no cap needed for hostile keys.
 */
const MAX_RUN_SEGMENTS = Math.max(...[...NORMALISED_KEYS].map((k) => k.split('_').length));

/** The binding rule on an already lower-cased, `-` -> `_` normalised key. */
function matchesNormalised(norm: string): boolean {
  if (NORMALISED_KEYS.has(norm)) return true;
  if (!norm.includes('_')) return false;
  const segments = norm.split('_').filter((s) => s !== '');
  for (let i = 0; i < segments.length; i += 1) {
    let run = '';
    const end = Math.min(segments.length, i + MAX_RUN_SEGMENTS);
    for (let j = i; j < end; j += 1) {
      run = j === i ? (segments[j] as string) : `${run}_${segments[j] as string}`;
      if (NORMALISED_KEYS.has(run)) return true;
    }
  }
  return false;
}

/**
 * Does this key name a secret? Whole key, or any contiguous run of its
 * `_`/`-`-delimited segments, equal to a listed key (case-insensitive).
 *
 * Two passes, so the camelCase extension can only ADD matches: first the
 * binding rule on the key exactly as written (lower-cased) — `PassWord`,
 * `APIkey`, `CLIENTsecret` match here — then the same rule with camelCase
 * boundaries turned into delimiters (`accessToken` -> `access_token`). A
 * single split-first pass used to miss the first group: `PassWord` became
 * `pass_word` and `APIkey` became `ap_ikey`, and both were exported in clear.
 */
export function isSecretKey(key: string): boolean {
  if (typeof key !== 'string' || key === '') return false;
  if (matchesNormalised(key.toLowerCase().replace(/-/g, '_'))) return true;
  const split = key
    // camelCase / PascalCase / acronym boundaries become delimiters:
    // accessToken -> access_Token, HTTPToken -> HTTP_Token, APIKey -> API_Key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // Same split as /([A-Z]+)([A-Z][a-z])/ but linear: that form backtracks
    // quadratically on a long run of capitals (a 50k-char key took 3.5 s).
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, '_')
    .toLowerCase()
    .replace(/-/g, '_');
  return matchesNormalised(split);
}

export interface RedactSecretsResult<T = unknown> {
  value: T;
  /** Values replaced by this call (already-redacted values are not counted). */
  count: number;
  /** Distinct matched key spellings, exactly as they appeared. */
  keys: Set<string>;
}

interface WalkState {
  count: number;
  keys: Set<string>;
}

/** Nothing to hide, or a placeholder would misrepresent what was there. */
function isSkippable(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === REDACTED;
}

/** One container being walked: its children so far, and where the walk is in it. */
interface Frame {
  src: object;
  /** Own enumerable keys (objects) — undefined for arrays, which walk by index. */
  keys: string[] | undefined;
  length: number;
  index: number;
  /** Walked children, in order (values for arrays, values for `keys` for objects). */
  out: unknown[];
  changed: boolean;
}

function frameOf(src: object): Frame {
  const keys = Array.isArray(src) ? undefined : Object.keys(src);
  return { src, keys, length: keys === undefined ? (src as unknown[]).length : keys.length, index: 0, out: [], changed: false };
}

/**
 * Iterative, copy-on-write walk. No recursion, so no depth at which it stops
 * descending: a secret nested 50,000 levels deep is found like one at the
 * top (JSON.parse accepts far deeper documents than any recursion limit, and
 * a depth cap that left the subtree as it was exported that secret in clear).
 * Untouched subtrees keep their identity. A back-reference to a container
 * still being walked (a cycle — impossible for JSON, possible for a caller)
 * is left as is rather than followed.
 */
function walk(root: unknown, state: WalkState): unknown {
  if (root === null || typeof root !== 'object') return root;
  const stack: Frame[] = [frameOf(root)];
  const onStack = new Set<object>([root]);
  for (;;) {
    const frame = stack[stack.length - 1] as Frame;
    if (frame.index < frame.length) {
      const key = frame.keys === undefined ? undefined : (frame.keys[frame.index] as string);
      const current =
        key === undefined
          ? (frame.src as unknown[])[frame.index]
          : (frame.src as Record<string, unknown>)[key];
      if (key !== undefined && isSecretKey(key) && !isSkippable(current)) {
        state.count += 1;
        state.keys.add(key);
        frame.out.push(REDACTED);
        frame.changed = true;
        frame.index += 1;
        continue;
      }
      if (current !== null && typeof current === 'object' && !onStack.has(current)) {
        onStack.add(current);
        stack.push(frameOf(current));
        continue; // its walked value is delivered to this frame when it completes
      }
      frame.out.push(current);
      frame.index += 1;
      continue;
    }

    // This container is complete: build its replacement only if something changed.
    stack.pop();
    onStack.delete(frame.src);
    let value: unknown = frame.src;
    if (frame.changed) {
      value =
        frame.keys === undefined
          ? frame.out
          : // Object.fromEntries defines OWN properties, so a "__proto__" key coming
            // out of JSON.parse stays a plain key instead of rewiring the prototype.
            Object.fromEntries(frame.keys.map((k, i) => [k, frame.out[i]]));
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) return value;
    parent.out.push(value);
    if (value !== frame.src) parent.changed = true;
    parent.index += 1;
  }
}

/**
 * Replace every value under a secret-shaped key, at any depth (arrays
 * included), with the placeholder. Returns the same reference when nothing
 * matched. Never throws.
 */
export function redactSecrets<T>(value: T): RedactSecretsResult<T> {
  const state: WalkState = { count: 0, keys: new Set() };
  try {
    return { value: walk(value, state) as T, count: state.count, keys: state.keys };
  } catch {
    return { value, count: 0, keys: new Set() };
  }
}

export interface RedactEventsResult {
  events: StoredEvent[];
  count: number;
  keys: Set<string>;
}

/** Apply `redactSecrets` to every stored event's payload; envelope fields untouched. */
export function redactStoredEvents(events: readonly StoredEvent[]): RedactEventsResult {
  let count = 0;
  const keys = new Set<string>();
  const out = events.map((event) => {
    const result = redactSecrets(event.payload);
    count += result.count;
    for (const key of result.keys) keys.add(key);
    const redacted = result.value === event.payload ? event : { ...event, payload: result.value };
    return withoutLoopFingerprint(redacted);
  });
  return { events: out, count, keys };
}

/**
 * `exec.paused.loop.fingerprint` is an unsalted digest of the node's WHOLE
 * input. Once any secret has been removed from that input, the digest plus the
 * rest of the export is a dictionary attack away from the secret (the W5
 * verifier recovered a password from five guesses). The viewer never renders
 * the fingerprint — it groups identical calls by `firstSeq`/`lastSeq` — so a
 * sanitised export drops it unconditionally. It is not a secret-keyed value,
 * so it is not counted in the summary line.
 */
function withoutLoopFingerprint(event: StoredEvent): StoredEvent {
  if (event.type !== 'exec.paused') return event;
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return event;
  const loop = (payload as Record<string, unknown>)['loop'];
  if (loop === null || typeof loop !== 'object' || Array.isArray(loop)) return event;
  const fingerprint = (loop as Record<string, unknown>)['fingerprint'];
  if (fingerprint === undefined || fingerprint === REDACTED) return event;
  return {
    ...event,
    payload: { ...(payload as Record<string, unknown>), loop: { ...(loop as Record<string, unknown>), fingerprint: REDACTED } },
  };
}

/** The one line `graphmind record` prints about what it did. */
export function redactionSummaryLine(count: number, distinctKeys: number): string {
  const values = count === 1 ? 'value' : 'values';
  const keys = distinctKeys === 1 ? 'key' : 'keys';
  return `redacted ${count} ${values} under ${distinctKeys} distinct ${keys} (--no-redact-secrets keeps them)`;
}

/**
 * Inject guard predicate (defence in depth for apps/viewer/src/lib/gate.ts):
 * does the JSON form of this value contain the placeholder anywhere — as a
 * value, inside a string, or as a key? Never throws; unserialisable input is
 * treated as clean (the resume path will reject it on its own terms).
 */
export function containsRedacted(value: unknown): boolean {
  if (value === undefined) return false;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.includes(REDACTED);
  } catch {
    return false;
  }
}
