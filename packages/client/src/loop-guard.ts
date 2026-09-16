/**
 * Loop guard: stop an agent that makes the same tool call again, back-to-back,
 * with the same arguments — while a debugger is attached to do something
 * about it.
 *
 * Detection lives here, in the client session, so every adapter and the
 * `graphmind mcp-proxy` inherit it with no adapter change. The session
 * fingerprints `(nodeId, input)` where `node.started` is emitted (the only
 * place the input is visible — `GateNode` is `{nodeId, kind, name}`) and
 * CONSULTS the streak at the next `gate('before')` for that node:
 *
 *   - mode `pause` + debugger attached : the Nth identical call is HELD
 *     through the normal gate path (so `pauseTimeoutMs` and fail-open release
 *     on disconnect apply) with `reason: 'loop'` and `loop: {repeats,
 *     firstSeq, lastSeq, fingerprint}` on `exec.paused` — a built-in
 *     breakpoint that fires regardless of the viewer's breakpoints or mode;
 *   - mode `pause` + detached, or mode `warn` : ONE rate-limited warning per
 *     streak through the session's warner, and execution continues;
 *   - mode `off` (or threshold 0) : nothing at all, not even fingerprinting.
 *
 * Counting (rule v3, internal/decisions.md "Loop hold v3: a loop is the same
 * call BACK-TO-BACK" — identical in the Python and Ruby ports):
 *
 *   1. Per run, per node KIND, the guard keeps ONE streak:
 *      {nodeId, fingerprint, count, firstSeq, lastSeq}.
 *   2. A WATCHED start (guard enabled, kind in `kinds`, not in `allowNodes`)
 *      with a readable input: same (nodeId, fingerprint) as its kind's streak
 *      -> count += 1, lastSeq = seq; otherwise the streak is REPLACED by
 *      {nodeId, fingerprint, count: 1, firstSeq: seq, lastSeq: seq}.
 *   3. A watched start whose input cannot be read (a getter, a Proxy trap or
 *      a `toJSON` throws — or its nodeId is not a string) CLEARS its kind's
 *      streak: it is not known to equal anything.
 *   4. Unwatched starts (other kinds, allow-listed nodes) touch no streak, so
 *      an LLM step between two identical tool calls does not break the tool
 *      streak (model -> tool -> model -> tool is still a loop).
 *   5. `gate('before')` holds when the gated node's kind streak belongs to
 *      this nodeId and count >= threshold; each count holds at most once, so a
 *      `retry` (same instance, no new `node.started`) runs on, and the next
 *      identical back-to-back call holds again.
 *   6. Memory: one streak per (run, kind); runs are LRU-bounded.
 *
 * Why back-to-back and not "per node, whatever happens between": under
 * `graphmind mcp-proxy` a whole host session is one run, so an agent calling
 * `list_issues({})` at minute 1, 20 and 45 with dozens of other tools between
 * was held as a loop. A false hold freezes the user's agent, which is worse
 * than no hold. Accepted consequence: a model ALTERNATING between tools
 * (search, read, search, read) is not held. Parallel identical calls (fan-out)
 * still count: their starts are back-to-back.
 *
 * Fingerprint = the first 32 hex chars of SHA-256 over the canonical JSON of
 * `[nodeId, input]`: keys sorted (UTF-16 code-unit order — JS's default
 * string sort), no whitespace, numbers in JS shortest round-trip form
 * (`1.0` -> `1`, `-0` -> `0`, non-finite -> `null`), `undefined`/functions
 * dropped from objects and `null` in arrays, `toJSON` honoured (Dates),
 * cycles and depth > 64 replaced by markers, and a configurable set of
 * per-request metadata keys (default: MCP's `_meta`) removed at every nesting
 * level so a nonce does not hide a real loop. Pagination keys are part of the
 * call: page 3 is a different question from page 2. The conformance fixture
 * for the Python/Ruby ports is test/fixtures/loop-guard.json (version 3).
 *
 * Everything here is bookkeeping: never throws into the host, never keeps a
 * reference to a host object.
 */
import { createHash } from 'node:crypto';
import type { NodeKind } from '@graphmind-ai/schema';
import type { EnvLike } from './env.js';

export type LoopMode = 'pause' | 'warn' | 'off';

export interface LoopGuardOptions {
  /**
   * Identical calls in a row — back-to-back, no other watched call of the
   * same kind between them — that count as a loop. Default 3
   * (`GRAPHMIND_LOOP_THRESHOLD`). `0` disables the guard.
   */
  threshold?: number;
  /**
   * What to do at the threshold: hold the gate (`pause`, default —
   * only when a debugger is attached; detached it warns), only warn
   * (`warn`), or nothing (`off`). Env: `GRAPHMIND_ON_LOOP`.
   */
  mode?: LoopMode;
  /**
   * Input keys ignored (at every nesting level) when fingerprinting: keys
   * whose value changes on every request WITHOUT changing what is asked for
   * (a nonce, a request id), so a real loop is still recognised. Default
   * `['_meta']` — MCP's reserved protocol metadata, where clients put a
   * per-request `progressToken`. REPLACES the default list
   * (`DEFAULT_LOOP_IGNORE_KEYS`); pass `[]` to ignore nothing. Do not add
   * pagination keys (`cursor`, `page`, `offset`) unless you want every walk
   * through pages of one query to count as a loop: page 3 is not page 2.
   */
  ignoreKeys?: readonly string[];
  /**
   * Nodes that legitimately repeat (a poll-until-done tool): matched by
   * exact `nodeId` (`tool:pollJob`) or exact `name` (`pollJob`). Never
   * fingerprinted, never held, never warned about — and invisible to the
   * streak: an allow-listed call between two identical calls does not
   * separate them.
   */
  allowNodes?: readonly string[];
  // Env: `GRAPHMIND_LOOP_ALLOW` — comma-separated, for callers that cannot set
  // options (above all `graphmind mcp-proxy`). An option array replaces it.
  /**
   * Node kinds the guard watches. Default `['tool']`: LLM step inputs carry
   * the whole growing conversation, so a repeated model call is rarely
   * byte-identical and always expensive to fingerprint. Add `'llm'` (or any
   * kind) deliberately. Each watched kind keeps its own streak.
   */
  kinds?: readonly NodeKind[];
}

/** What `exec.paused.loop` carries when `reason` is `loop`. */
export interface LoopInfo {
  /** Identical back-to-back calls so far, this one included (>= threshold). */
  repeats: number;
  /** Envelope seq of the first `node.started` in the streak. */
  firstSeq: number;
  /** Envelope seq of the `node.started` of the held call. */
  lastSeq: number;
  /** The shared fingerprint (32 hex chars). */
  fingerprint: string;
}

export interface ResolvedLoopGuard {
  threshold: number;
  mode: LoopMode;
  ignoreKeys: ReadonlySet<string>;
  allowNodes: ReadonlySet<string>;
  kinds: ReadonlySet<NodeKind>;
}

export const DEFAULT_LOOP_THRESHOLD = 3;
export const DEFAULT_LOOP_MODE: LoopMode = 'pause';
export const DEFAULT_LOOP_KINDS: readonly NodeKind[] = Object.freeze(['tool'] as NodeKind[]);
/**
 * Keys that change on every request without changing the request. Only MCP's
 * reserved `_meta` by default: an MCP client with progress enabled stamps a
 * unique `_meta.progressToken` on every `tools/call`, and `graphmind
 * mcp-proxy`'s tool input is the whole params object — without this the same
 * tool with the same arguments never looks identical through the proxy.
 *
 * Pagination keys (`cursor`, `page`, `offset`, `before`, `after`...) are
 * deliberately NOT here: ignoring them makes page 1, 2, 3 of one listing — or
 * `Read({file_path, offset: 0 | 2000 | 4000})` — fingerprint identically, and
 * the third page would be held under a banner claiming "identical arguments".
 */
export const DEFAULT_LOOP_IGNORE_KEYS: readonly string[] = Object.freeze(['_meta']);

/** Distinct runs whose loop state is kept; least-recently-used evicted past this. */
export const MAX_LOOP_RUNS = 64;
/**
 * Pass as `input` to `LoopGuard.record` when reading the start's input threw:
 * the call happened, with arguments nobody can compare (rule 3: it clears the
 * kind's streak).
 */
export const UNREADABLE_INPUT: unique symbol = Symbol('graphmind.loop.unreadableInput');
/** Nesting deeper than this is fingerprinted as a marker, not walked. */
const MAX_DEPTH = 64;
const FINGERPRINT_HEX_CHARS = 32;

// -- configuration ----------------------------------------------------------

/**
 * `GRAPHMIND_LOOP_THRESHOLD`: a non-negative integer; anything else (empty,
 * NaN, negative, fractional) falls back to `fallback`. Never throws.
 */
export function parseLoopThreshold(raw: string | undefined, fallback = DEFAULT_LOOP_THRESHOLD): number {
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

/**
 * `GRAPHMIND_LOOP_ALLOW`: comma-separated node ids or names that legitimately
 * repeat (`pollJob,tool:heartbeat`). Whitespace around entries is ignored,
 * empty entries are dropped. Anything that is not a string -> [].
 */
export function parseLoopAllow(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `GRAPHMIND_ON_LOOP`: `pause` | `warn` | `off` (case-insensitive); anything else -> `fallback`. */
export function parseLoopMode(raw: string | undefined, fallback: LoopMode = DEFAULT_LOOP_MODE): LoopMode {
  if (raw === undefined) return fallback;
  const text = raw.trim().toLowerCase();
  if (text === 'pause' || text === 'warn' || text === 'off') return text;
  if (text === '0' || text === 'false' || text === 'none') return 'off';
  return fallback;
}

function validThreshold(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function validMode(value: unknown): LoopMode | undefined {
  return value === 'pause' || value === 'warn' || value === 'off' ? value : undefined;
}

/**
 * Precedence, per field: explicit option > environment > default.
 * `loopGuard: false` is shorthand for `{ mode: 'off' }`. Never throws: an
 * option object whose reads throw (a getter, a Proxy) is ignored as a whole —
 * the environment and the defaults still apply — and an unreadable
 * environment falls back to the defaults. The session is constructed from
 * this, so a throw here would escape `createSession` into the host.
 */
export function resolveLoopGuard(
  options: LoopGuardOptions | false | undefined,
  env: EnvLike,
): ResolvedLoopGuard {
  try {
    return resolveLoopGuardStrict(options, env);
  } catch {
    try {
      return resolveLoopGuardStrict(undefined, env);
    } catch {
      return resolveLoopGuardStrict(undefined, {});
    }
  }
}

function resolveLoopGuardStrict(
  options: LoopGuardOptions | false | undefined,
  env: EnvLike,
): ResolvedLoopGuard {
  const opts = options === false ? { mode: 'off' as const } : (options ?? {});
  const threshold =
    validThreshold(opts.threshold) ?? parseLoopThreshold(env['GRAPHMIND_LOOP_THRESHOLD']);
  const mode = validMode(opts.mode) ?? parseLoopMode(env['GRAPHMIND_ON_LOOP']);
  const ignoreKeys = new Set<string>(
    Array.isArray(opts.ignoreKeys)
      ? opts.ignoreKeys.filter((key): key is string => typeof key === 'string')
      : DEFAULT_LOOP_IGNORE_KEYS,
  );
  const allowNodes = new Set<string>(
    Array.isArray(opts.allowNodes)
      ? opts.allowNodes.filter((node): node is string => typeof node === 'string')
      : parseLoopAllow(env['GRAPHMIND_LOOP_ALLOW']),
  );
  const kinds = new Set<NodeKind>(
    Array.isArray(opts.kinds)
      ? opts.kinds.filter((kind): kind is NodeKind => typeof kind === 'string')
      : DEFAULT_LOOP_KINDS,
  );
  return { threshold, mode, ignoreKeys, allowNodes, kinds };
}

// -- canonical JSON + fingerprint ------------------------------------------

/** JSON-escaped string (same escaping as JSON.stringify — the ports must match it). */
function quote(text: string): string {
  return JSON.stringify(text);
}

interface CanonContext {
  seen: WeakSet<object>;
  /**
   * Something could not be read faithfully (a throwing or self-returning
   * `toJSON`). The string still gets a marker, but two such inputs are not
   * known to be the same call — the guard must not count them as identical.
   */
  lossy: boolean;
}

function canonicalizeValue(
  value: unknown,
  ignoreKeys: ReadonlySet<string>,
  depth: number,
  ctx: CanonContext,
): string {
  const seen = ctx.seen;
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
    // Date, Buffer, URL... — exactly what JSON.stringify would serialize.
    let replaced: unknown;
    try {
      replaced = (object.toJSON as () => unknown)();
    } catch {
      ctx.lossy = true;
      return '"[unserializable]"';
    }
    if (replaced === object) {
      ctx.lossy = true;
      return '"[unserializable]"';
    }
    return canonicalizeValue(replaced, ignoreKeys, depth + 1, ctx);
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      let out = '[';
      for (let i = 0; i < object.length; i += 1) {
        if (i > 0) out += ',';
        out += canonicalizeValue(object[i], ignoreKeys, depth + 1, ctx);
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
      out += `${quote(key)}:${canonicalizeValue(item, ignoreKeys, depth + 1, ctx)}`;
    }
    return `${out}}`;
  } finally {
    seen.delete(object);
  }
}

/** Canonical JSON of one value (see the module comment for the rules). */
export function canonicalize(value: unknown, ignoreKeys: ReadonlySet<string> = new Set()): string {
  try {
    return canonicalizeValue(value, ignoreKeys, 0, { seen: new WeakSet(), lossy: false });
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * The fingerprint the guard compares, or `undefined` when the input could not
 * be read faithfully (a getter / Proxy trap / `toJSON` threw, the session
 * passed `UNREADABLE_INPUT`, or the nodeId is not a string): such a call is
 * not known to equal anything, so it neither extends nor starts a streak — it
 * clears its kind's streak (rule 3).
 */
function comparableFingerprint(
  nodeId: string,
  input: unknown,
  ignoreKeys: ReadonlySet<string>,
): string | undefined {
  if (typeof nodeId !== 'string' || input === UNREADABLE_INPUT) return undefined;
  try {
    const ctx: CanonContext = { seen: new WeakSet(), lossy: false };
    const canonical = `[${quote(nodeId)},${canonicalizeValue(input, ignoreKeys, 0, ctx)}]`;
    if (ctx.lossy) return undefined;
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
  } catch {
    return undefined;
  }
}

/** The canonical string a fingerprint hashes: `[nodeId, input]`. */
export function canonicalCall(nodeId: string, input: unknown, ignoreKeys: ReadonlySet<string> = new Set()): string {
  return `[${quote(nodeId)},${canonicalize(input, ignoreKeys)}]`;
}

/** SHA-256 (first 32 hex chars) of `canonicalCall(nodeId, input)`. */
export function fingerprintCall(
  nodeId: string,
  input: unknown,
  ignoreKeys: ReadonlySet<string> = new Set(),
): string {
  return createHash('sha256')
    .update(canonicalCall(nodeId, input, ignoreKeys), 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_CHARS);
}

// -- the guard ---------------------------------------------------------------

/** Rule 1: the one streak a run keeps per watched kind. */
interface Streak {
  nodeId: string;
  fingerprint: string;
  repeats: number;
  firstSeq: number;
  lastSeq: number;
  /** This count already held (or was consulted past the threshold). */
  tripped: boolean;
  /** This streak already produced its one warning. */
  warned: boolean;
}

/** Result of recording a `node.started`. */
export interface LoopRecord {
  repeats: number;
  firstSeq: number;
  lastSeq: number;
  fingerprint: string;
  /** True on the exact call that reaches the threshold (and every one after). */
  atThreshold: boolean;
}

export class LoopGuard {
  /** run -> kind -> streak; runs in least-recently-used order for eviction. */
  private readonly runs = new Map<string, Map<NodeKind, Streak>>();

  constructor(readonly config: ResolvedLoopGuard) {}

  /** False when nothing is ever fingerprinted (mode off or threshold 0). */
  get enabled(): boolean {
    return this.config.mode !== 'off' && this.config.threshold > 0;
  }

  get mode(): LoopMode {
    return this.config.mode;
  }

  get threshold(): number {
    return this.config.threshold;
  }

  /** Does the guard watch this node at all? */
  appliesTo(kind: NodeKind, nodeId: string, name: string): boolean {
    if (!this.enabled) return false;
    if (!this.config.kinds.has(kind)) return false;
    if (this.config.allowNodes.size > 0) {
      if (this.config.allowNodes.has(nodeId) || this.config.allowNodes.has(name)) return false;
    }
    return true;
  }

  /**
   * `node.started` (rules 2-4): fingerprint the call and extend or replace
   * its kind's streak. `seq` is the envelope seq that `node.started` is about
   * to get. Returns `undefined` when the node is not watched, or when its
   * input could not be read (pass `UNREADABLE_INPUT` if reading it threw) —
   * the latter clears the kind's streak.
   */
  record(
    runId: string,
    kind: NodeKind,
    nodeId: string,
    name: string,
    input: unknown,
    seq: number,
  ): LoopRecord | undefined {
    if (!this.appliesTo(kind, nodeId, name)) return undefined;
    const fingerprint = comparableFingerprint(nodeId, input, this.config.ignoreKeys);
    if (fingerprint === undefined) {
      // Rule 3: the call DID happen, with arguments we cannot compare. Not
      // provably identical to anything, so the previous call is no longer
      // "the call right before" the next one.
      this.runs.get(runId)?.delete(kind);
      return undefined;
    }
    const streaks = this.streaksFor(runId);
    let streak = streaks.get(kind);
    if (streak !== undefined && streak.nodeId === nodeId && streak.fingerprint === fingerprint) {
      streak.repeats += 1;
      streak.lastSeq = seq;
      streak.tripped = false;
    } else {
      streak = { nodeId, fingerprint, repeats: 1, firstSeq: seq, lastSeq: seq, tripped: false, warned: false };
      streaks.set(kind, streak);
    }
    return {
      repeats: streak.repeats,
      firstSeq: streak.firstSeq,
      lastSeq: streak.lastSeq,
      fingerprint,
      atThreshold: streak.repeats >= this.config.threshold,
    };
  }

  /**
   * `gate('before')` (rule 5): is this node's latest start the Nth identical
   * back-to-back call? Trips at most once per count — a `retry` that re-enters
   * the same gate without a new `node.started` gets `undefined` and runs on.
   */
  consult(runId: string, kind: NodeKind, nodeId: string, name: string): LoopInfo | undefined {
    if (!this.appliesTo(kind, nodeId, name)) return undefined;
    const streak = this.runs.get(runId)?.get(kind);
    if (
      streak === undefined ||
      streak.nodeId !== nodeId ||
      streak.tripped ||
      streak.repeats < this.config.threshold
    ) {
      return undefined;
    }
    streak.tripped = true;
    return {
      repeats: streak.repeats,
      firstSeq: streak.firstSeq,
      lastSeq: streak.lastSeq,
      fingerprint: streak.fingerprint,
    };
  }

  /**
   * Claim the single warning for the current streak of this node (of `kind`,
   * or of whichever watched kind's streak belongs to `nodeId`). True the first
   * time (caller should warn), false afterwards or when no streak is this
   * node's.
   */
  claimWarning(runId: string, nodeId: string, kind?: NodeKind): boolean {
    const streaks = this.runs.get(runId);
    if (streaks === undefined) return false;
    const candidates = kind === undefined ? [...streaks.values()] : [streaks.get(kind)];
    for (const streak of candidates) {
      if (streak === undefined || streak.nodeId !== nodeId) continue;
      if (streak.warned) return false;
      streak.warned = true;
      return true;
    }
    return false;
  }

  /** Drop everything remembered about a run. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  /** Diagnostics: runs currently tracked. */
  get trackedRuns(): number {
    return this.runs.size;
  }

  /** Diagnostics: streaks currently kept, across runs (at most runs x watched kinds). */
  get trackedStreaks(): number {
    let total = 0;
    for (const streaks of this.runs.values()) total += streaks.size;
    return total;
  }

  private streaksFor(runId: string): Map<NodeKind, Streak> {
    let streaks = this.runs.get(runId);
    if (streaks !== undefined) {
      // Least-recently-used, not oldest-created: a long run that is still
      // calling tools must not lose its streak because MAX_LOOP_RUNS short
      // runs came and went meanwhile.
      this.runs.delete(runId);
      this.runs.set(runId, streaks);
      return streaks;
    }
    if (this.runs.size >= MAX_LOOP_RUNS) {
      const oldest = this.runs.keys().next();
      if (!oldest.done) this.runs.delete(oldest.value);
    }
    streaks = new Map();
    this.runs.set(runId, streaks);
    return streaks;
  }
}
