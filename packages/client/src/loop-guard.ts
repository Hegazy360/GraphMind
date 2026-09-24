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
 * Loop kinds v4 (0.6.0, contract C4 — internal/research/phase7-plan-2026-09.md;
 * conformance fixture test/fixtures/loop-kinds.json). Beside the v3 streak,
 * each (run, watched kind) keeps a HISTORY: a ring of the last 64 COMPLETED
 * watched calls, in completion order, each `{nodeId, input fingerprint,
 * outcome, outcome digest, start seq}`. The session feeds it from
 * `node.started` (the call opens), `node.error` (its error is noted) and
 * `node.finished` (it completes: `ok`, `fail`, or unknown), correlated by
 * (run, nodeId, instanceId) — or, without an instanceId, the node's most
 * recent open call. At every watched start the history is checked, and a hit
 * holds that call's before-gate with `reason: 'loop'`, `loop.kind` and the
 * four legacy fields (a 0.5 viewer renders them), once per start:
 *
 *   cycle         k = 2..4 calls repeated in 3 identical laps: the last 3k
 *                 completed calls are three laps equal position by position
 *                 on (nodeId, input fingerprint, outcome, outcome digest);
 *                 a lap holds at least 2 distinct (nodeId, input) calls
 *                 (k = 1 is v3's job); the starting call equals the lap's
 *                 first call. Smallest k wins. `period` = k, `laps` = the
 *                 identical laps counted back from the newest (>= 3),
 *                 `repeats` = `laps`, `firstSeq` = the start seq of the first
 *                 counted lap's first call. After a cycle hold the next one
 *                 needs another full lap (not every rotation of the same
 *                 cycle). Identical RESULTS are required: a poll whose
 *                 answer changes never looks like a cycle.
 *   error-repeat  the node's own last 3 completed calls failed with an
 *                 identical error — calls of other nodes between them do not
 *                 matter, their arguments may differ, and a success of the
 *                 node (or a call that is not comparable) ends the streak.
 *                 `repeats` = the identical failures (>= 3), `firstSeq` = the
 *                 first one's start seq. Failure = `node.finished` status
 *                 `ok` with an error-shaped TOOL output (smart.ts's strict
 *                 rule; error digest = the canonical result), or status
 *                 `error`, whose error digest is, in this order: the
 *                 canonical result when a tool's output has a RETURNED
 *                 error shape (isError / success / exit code — mcp-proxy
 *                 finishes an isError result this way); the `node.error`
 *                 name + message, each whitespace-collapsed and cut to 512
 *                 chars (a thrown error, a JSON-RPC error); the canonical
 *                 `{error}` output; else unknown (equals nothing).
 *
 * Precedence at one gate: v3 repeat > cycle > error-repeat. Cycle laps and
 * the error-repeat count are fixed at 3 in 0.6.0; `threshold` governs only
 * the v3 rule (0 still switches the whole guard off), and `mode`, `kinds`,
 * `allowNodes` and `ignoreKeys` apply to every kind — an allow-listed call is
 * invisible to the history too, so a lap made only of allow-listed calls
 * cannot exist.
 *
 * Every digest the new kinds compute — outputs, errors, the `loop.fingerprint`
 * they report — is an HMAC-SHA-256 keyed with a random per-process salt that
 * never leaves the process: equal values give equal digests within one
 * process, and no digest can be checked against a guessed value outside it.
 * Outputs are digested locally, pre-redaction, and never sent; an output
 * whose canonical form exceeds MAX_OUTPUT_CANONICAL_CHARS is not digested at
 * all (that call compares equal to nothing) so a huge tool result never costs
 * the host more than a bounded walk. Starts that never reached the wire, or
 * whose input could not be read, complete as calls that equal nothing.
 *
 * Everything here is bookkeeping: never throws into the host, never keeps a
 * reference to a host object.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { NodeKind } from '@graphmind-ai/schema';
import type { EnvLike } from './env.js';
import { errorResultShape, isReturnedErrorShape } from './smart.js';

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

/**
 * What `exec.paused.loop` carries when `reason` is `loop`. The four legacy
 * fields are always filled (a 0.5 viewer requires them); `kind` is absent for
 * the v3 identical-repeat rule, as in 0.5.
 */
export interface LoopInfo {
  /**
   * v3: identical back-to-back calls so far, this one included (>= threshold).
   * cycle: identical laps before this call (>= 3). error-repeat: identical
   * failures of this node before this call (>= 3).
   */
  repeats: number;
  /** Envelope seq of the first `node.started` of the evidence (streak, first lap, first failure). */
  firstSeq: number;
  /** Envelope seq of the `node.started` of the held call. */
  lastSeq: number;
  /**
   * v3: the unsalted digest of the call (hidden under an input HIDE switch).
   * cycle / error-repeat: a per-process salted digest of the lap / the error.
   * 32 hex chars.
   */
  fingerprint: string;
  /** Which detector held (0.6.0); absent = v3 `repeat`. */
  kind?: 'cycle' | 'error-repeat';
  /** cycle: calls per lap (2..4). */
  period?: number;
  /** cycle: identical laps seen before this hold. */
  laps?: number;
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

/** Completed watched calls remembered per (run, kind) for the v4 kinds. */
export const LOOP_HISTORY_SIZE = 64;
/** Identical laps before a cycle holds (fixed in 0.6.0). */
export const CYCLE_LAPS = 3;
/** Calls per lap a cycle may have. */
export const CYCLE_MIN_PERIOD = 2;
export const CYCLE_MAX_PERIOD = 4;
/** Identical failures of one node before error-repeat holds (fixed in 0.6.0). */
export const ERROR_REPEAT_COUNT = 3;
/** Started-but-unfinished watched calls remembered per run; oldest forgotten past this. */
export const MAX_OPEN_CALLS_PER_RUN = 256;
/** Error name / message: whitespace-collapsed, then cut to this many characters. */
export const MAX_ERROR_TEXT_CHARS = 512;
/** A message longer than this is collapsed from its first this-many characters only. */
const MAX_ERROR_SCAN_CHARS = 1024 * 1024;
/**
 * An output (or error-shaped result) whose canonical form would exceed this
 * many characters is not digested: that call equals nothing. Bounds what a
 * huge tool result costs the host at `node.finished` (~0.01 ms/KB to walk).
 */
export const MAX_OUTPUT_CANONICAL_CHARS = 256 * 1024;

/**
 * The per-process salt of every v4 digest. Random, never sent, never logged:
 * a salted digest proves "equal to that other call in this process" and
 * nothing to anyone holding a dictionary of likely values.
 */
const PROCESS_SALT: Uint8Array = newSalt();

function newSalt(): Uint8Array {
  try {
    return randomBytes(32);
  } catch {
    // No CSPRNG (never seen on a supported Node): still unguessable enough
    // for a debugging aid, and never a module-load crash in the host.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  }
}

/** HMAC-SHA-256 of `text` keyed with `salt`, first 32 hex chars. */
export function saltedDigest(text: string, salt: Uint8Array = PROCESS_SALT): string {
  return createHmac('sha256', salt).update(text, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
}

/**
 * The error text an error-repeat compares: runs of whitespace (JS `\s`)
 * collapsed to one space, trimmed, cut to MAX_ERROR_TEXT_CHARS. Scans at most
 * the first 1 MiB characters of the text.
 */
export function errorTextKey(text: string): string {
  const head = text.length > MAX_ERROR_SCAN_CHARS ? text.slice(0, MAX_ERROR_SCAN_CHARS) : text;
  return head.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT_CHARS);
}

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
  /**
   * Characters of string content (values and keys) still allowed; walking
   * past it throws OVER_BUDGET. Infinity for inputs (v3 is unbounded).
   */
  budget: number;
}

/** Thrown out of a walk whose string content exceeds its budget. */
const OVER_BUDGET: unique symbol = Symbol('graphmind.loop.overBudget');

function spend(ctx: CanonContext, chars: number): void {
  ctx.budget -= chars;
  if (ctx.budget < 0) throw OVER_BUDGET;
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
      // Charged BEFORE quoting, so a 2 MB string over budget costs nothing.
      spend(ctx, value.length + 1);
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
        spend(ctx, 1);
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
      spend(ctx, key.length + 1);
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
    return canonicalizeValue(value, ignoreKeys, 0, { seen: new WeakSet(), lossy: false, budget: Infinity });
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
    const ctx: CanonContext = { seen: new WeakSet(), lossy: false, budget: Infinity };
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

// -- v4 digests ----------------------------------------------------------------

/**
 * The salted digest of an output (`out`) or an error-shaped result (`res`),
 * or `undefined` when it cannot be read faithfully or its canonical form
 * would exceed MAX_OUTPUT_CANONICAL_CHARS (the walk stops there).
 */
function outcomeDigest(
  prefix: 'out' | 'res',
  value: unknown,
  ignoreKeys: ReadonlySet<string>,
  salt: Uint8Array,
): string | undefined {
  if (value === UNREADABLE_INPUT) return undefined;
  try {
    const ctx: CanonContext = { seen: new WeakSet(), lossy: false, budget: MAX_OUTPUT_CANONICAL_CHARS };
    const canonical = canonicalizeValue(value, ignoreKeys, 0, ctx);
    if (ctx.lossy) return undefined;
    return saltedDigest(`${prefix}\u0000${canonical}`, salt);
  } catch {
    return undefined; // over budget, or a read threw
  }
}

/** The salted digest of a thrown error: name and message, each errorTextKey'd. */
function thrownErrorDigest(name: string, message: string, salt: Uint8Array): string {
  return saltedDigest(`err\u0000${JSON.stringify([errorTextKey(name), errorTextKey(message)])}`, salt);
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

/** A watched call that started and has not completed yet (v4). */
interface OpenCall {
  kind: NodeKind;
  nodeId: string;
  instanceId: string | undefined;
  /** The v3 input fingerprint; undefined = not comparable (unreadable, or never on the wire). */
  inFp: string | undefined;
  startSeq: number;
  /** Salted digest of the latest `node.error` of this call; undefined = none, or unreadable. */
  errFp: string | undefined;
}

/** One completed watched call in a history ring (v4). */
interface CallEntry {
  /** Undefined: a watched call whose nodeId could not be read — equals nothing. */
  nodeId: string | undefined;
  /** Undefined: not comparable. */
  inFp: string | undefined;
  /** Undefined: aborted, or how it ended is unknown. */
  outcome: 'ok' | 'fail' | undefined;
  /** Salted digest of the output (`ok`) or of the error (`fail`); undefined = unknown. */
  outFp: string | undefined;
  /** Envelope seq of the call's `node.started`. */
  startSeq: number;
}

interface KindHistory {
  /** The last LOOP_HISTORY_SIZE completed watched calls, oldest first. */
  ring: CallEntry[];
  /** Entries ever pushed (the ring keeps only the newest). */
  completed: number;
  /** No cycle is reported while `completed` is below this: one hold per lap. */
  cycleQuietUntil: number;
  /** What this kind's latest watched start tripped, for its before-gate. */
  verdict: { nodeId: string; info: LoopInfo; tripped: boolean } | undefined;
}

interface RunState {
  /** v3: one streak per watched kind. */
  streaks: Map<NodeKind, Streak>;
  /** v4: one history per watched kind. */
  histories: Map<NodeKind, KindHistory>;
  /** v4: watched calls started and not yet completed, oldest first (bounded). */
  open: OpenCall[];
}

/** Result of recording a `node.started`. */
export interface LoopRecord {
  repeats: number;
  firstSeq: number;
  lastSeq: number;
  fingerprint: string;
  /** True on the exact call that reaches the threshold (and every one after). */
  atThreshold: boolean;
  /** A v4 kind (cycle, error-repeat) this start trips, if any. */
  detected?: LoopInfo;
}

function historyOf(state: RunState, kind: NodeKind): KindHistory {
  let history = state.histories.get(kind);
  if (history === undefined) {
    history = { ring: [], completed: 0, cycleQuietUntil: 0, verdict: undefined };
    state.histories.set(kind, history);
  }
  return history;
}

function pushEntry(history: KindHistory, entry: CallEntry): void {
  history.ring.push(entry);
  if (history.ring.length > LOOP_HISTORY_SIZE) history.ring.shift();
  history.completed += 1;
}

/** Every field a comparison needs is known. */
function comparable(entry: CallEntry): boolean {
  return (
    entry.nodeId !== undefined && entry.inFp !== undefined && entry.outcome !== undefined && entry.outFp !== undefined
  );
}

/** Same call with the same result (both comparable). */
function sameEntry(a: CallEntry, b: CallEntry | undefined): boolean {
  return (
    b !== undefined &&
    comparable(a) &&
    comparable(b) &&
    a.nodeId === b.nodeId &&
    a.inFp === b.inFp &&
    a.outcome === b.outcome &&
    a.outFp === b.outFp
  );
}

/** The k entries from `a` equal the k entries from `b`, position by position. */
function lapsEqual(ring: readonly CallEntry[], a: number, b: number, k: number): boolean {
  for (let i = 0; i < k; i += 1) {
    const x = ring[a + i];
    if (x === undefined || !sameEntry(x, ring[b + i])) return false;
  }
  return true;
}

/**
 * cycle: the last 3k completed calls are 3 identical laps whose first call is
 * the one starting now; smallest k wins; one hold per lap.
 */
function detectCycle(
  history: KindHistory,
  nodeId: string,
  inFp: string,
  seq: number,
  salt: Uint8Array,
): LoopInfo | undefined {
  if (history.completed < history.cycleQuietUntil) return undefined;
  const ring = history.ring;
  for (let k = CYCLE_MIN_PERIOD; k <= CYCLE_MAX_PERIOD; k += 1) {
    const span = CYCLE_LAPS * k;
    if (ring.length < span) return undefined; // longer periods need even more
    const base = ring.length - span;
    const head = ring[base];
    if (head === undefined || head.nodeId !== nodeId || head.inFp !== inFp) continue;
    let identical = true;
    for (let lap = 1; lap < CYCLE_LAPS && identical; lap += 1) {
      identical = lapsEqual(ring, base, base + lap * k, k);
    }
    if (!identical) continue;
    let distinct = false;
    for (let i = 1; i < k && !distinct; i += 1) {
      const entry = ring[base + i];
      distinct = entry !== undefined && (entry.nodeId !== head.nodeId || entry.inFp !== head.inFp);
    }
    if (!distinct) continue; // one call repeated: the v3 rule's case
    // The newest lap is the reference; count identical laps back from it.
    const newest = ring.length - k;
    let first = base;
    let laps = CYCLE_LAPS;
    while (first - k >= 0 && lapsEqual(ring, first - k, newest, k)) {
      first -= k;
      laps += 1;
    }
    history.cycleQuietUntil = history.completed + k;
    const lap: unknown[] = [];
    for (let i = 0; i < k; i += 1) {
      const entry = ring[newest + i] as CallEntry;
      lap.push([entry.nodeId, entry.inFp, entry.outcome, entry.outFp]);
    }
    return {
      repeats: laps,
      firstSeq: (ring[first] as CallEntry).startSeq,
      lastSeq: seq,
      fingerprint: saltedDigest(`lap\u0000${JSON.stringify(lap)}`, salt),
      kind: 'cycle',
      period: k,
      laps,
    };
  }
  return undefined;
}

/**
 * error-repeat: the node's own newest completed calls failed with one
 * identical error, at least ERROR_REPEAT_COUNT times; other nodes' calls
 * between them are skipped; a success, a different error, or anything not
 * comparable ends the streak.
 */
function detectErrorRepeat(history: KindHistory, nodeId: string, seq: number): LoopInfo | undefined {
  const ring = history.ring;
  let count = 0;
  let errFp: string | undefined;
  let firstSeq = seq;
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    const entry = ring[i] as CallEntry;
    if (entry.nodeId === undefined) break; // could have been this node
    if (entry.nodeId !== nodeId) continue;
    if (entry.outcome !== 'fail' || entry.outFp === undefined || entry.inFp === undefined) break;
    if (errFp === undefined) errFp = entry.outFp;
    else if (entry.outFp !== errFp) break;
    count += 1;
    firstSeq = entry.startSeq;
  }
  if (count < ERROR_REPEAT_COUNT || errFp === undefined) return undefined;
  return { repeats: count, firstSeq, lastSeq: seq, fingerprint: errFp, kind: 'error-repeat' };
}

export class LoopGuard {
  /** Per-run state; runs in least-recently-used order for eviction. */
  private readonly runs = new Map<string, RunState>();
  /** Keys every v4 digest (the process salt unless a test passes one). */
  private readonly salt: Uint8Array;

  constructor(
    readonly config: ResolvedLoopGuard,
    /** Tests only: the salt for v4 digests. Default: the per-process salt. */
    salt?: Uint8Array,
  ) {
    this.salt = salt ?? PROCESS_SALT;
  }

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
   * `node.started` (rules 2-4, and v4): fingerprint the call, extend or
   * replace its kind's streak, open the call for the history, and check the
   * history for a cycle or an error-repeat this start trips. `seq` is the
   * envelope seq that `node.started` received. Returns `undefined` when the
   * node is not watched, or when its input could not be read (pass
   * `UNREADABLE_INPUT` if reading it threw, or if the start never reached the
   * wire) — the latter clears the kind's streak and opens a call that will
   * equal nothing.
   */
  record(
    runId: string,
    kind: NodeKind,
    nodeId: string,
    name: string,
    input: unknown,
    seq: number,
    instanceId?: string,
  ): LoopRecord | undefined {
    if (!this.appliesTo(kind, nodeId, name)) return undefined;
    const fingerprint = comparableFingerprint(nodeId, input, this.config.ignoreKeys);
    const state = this.stateFor(runId);
    const history = historyOf(state, kind);
    history.verdict = undefined;
    const instance = typeof instanceId === 'string' ? instanceId : undefined;
    if (fingerprint === undefined) {
      // Rule 3: the call DID happen, with arguments we cannot compare. Not
      // provably identical to anything, so the previous call is no longer
      // "the call right before" the next one.
      state.streaks.delete(kind);
      if (typeof nodeId === 'string') {
        this.openCall(state, { kind, nodeId, instanceId: instance, inFp: undefined, startSeq: seq, errFp: undefined });
      } else {
        // No nodeId to correlate a completion with: it goes in as it starts.
        pushEntry(history, { nodeId: undefined, inFp: undefined, outcome: undefined, outFp: undefined, startSeq: seq });
      }
      return undefined;
    }
    let streak = state.streaks.get(kind);
    if (streak !== undefined && streak.nodeId === nodeId && streak.fingerprint === fingerprint) {
      streak.repeats += 1;
      streak.lastSeq = seq;
      streak.tripped = false;
    } else {
      streak = { nodeId, fingerprint, repeats: 1, firstSeq: seq, lastSeq: seq, tripped: false, warned: false };
      state.streaks.set(kind, streak);
    }
    this.openCall(state, { kind, nodeId, instanceId: instance, inFp: fingerprint, startSeq: seq, errFp: undefined });
    const detected =
      detectCycle(history, nodeId, fingerprint, seq, this.salt) ?? detectErrorRepeat(history, nodeId, seq);
    if (detected !== undefined) history.verdict = { nodeId, info: detected, tripped: false };
    const record: LoopRecord = {
      repeats: streak.repeats,
      firstSeq: streak.firstSeq,
      lastSeq: streak.lastSeq,
      fingerprint,
      atThreshold: streak.repeats >= this.config.threshold,
    };
    if (detected !== undefined) record.detected = { ...detected };
    return record;
  }

  /**
   * `node.error` (v4): note the error of a watched open call — its name and
   * message, whitespace-collapsed and cut to 512 chars, as a salted digest.
   * A retried call keeps only its latest error. Non-string name or message:
   * the error is unknown (the call will equal nothing if it ends failed).
   */
  noteError(runId: string, nodeId: string, instanceId: string | undefined, name: unknown, message: unknown): void {
    if (!this.enabled) return;
    const call = this.findOpen(this.runs.get(runId), nodeId, instanceId);
    if (call === undefined) return;
    call.errFp =
      typeof name === 'string' && typeof message === 'string' ? thrownErrorDigest(name, message, this.salt) : undefined;
  }

  /**
   * `node.finished` (v4): a watched open call completed — into its kind's
   * history. `status` `ok` is a success unless a TOOL's output is
   * error-shaped (then a failure, digest of the canonical result); `error`
   * is a failure (digest: an error-shaped output, else the noted
   * `node.error`); anything else (`aborted`) equals nothing. `emitted` false
   * (the event never reached the wire) or an unreadable output
   * (`UNREADABLE_INPUT`) also equal nothing. Unwatched nodes are ignored.
   */
  complete(
    runId: string,
    nodeId: string,
    instanceId: string | undefined,
    status: unknown,
    output: unknown,
    emitted: boolean,
  ): void {
    if (!this.enabled) return;
    const state = this.runs.get(runId);
    if (state === undefined) return;
    const index = this.findOpenIndex(state, nodeId, instanceId);
    if (index < 0) return;
    const call = state.open[index] as OpenCall;
    state.open.splice(index, 1);
    this.touch(runId, state);
    pushEntry(historyOf(state, call.kind), this.entryFor(call, status, output, emitted));
  }

  /**
   * `gate('before')` (rule 5, and v4): is this node's latest start the Nth
   * identical back-to-back call — or else the start of lap 4 of a cycle, or
   * the call after 3 identical failures? Precedence v3 > cycle >
   * error-repeat. Trips at most once per start — a `retry` that re-enters the
   * same gate without a new `node.started` gets `undefined` and runs on.
   */
  consult(runId: string, kind: NodeKind, nodeId: string, name: string): LoopInfo | undefined {
    if (!this.appliesTo(kind, nodeId, name)) return undefined;
    const state = this.runs.get(runId);
    if (state === undefined) return undefined;
    const verdict = state.histories.get(kind)?.verdict;
    const streak = state.streaks.get(kind);
    if (
      streak !== undefined &&
      streak.nodeId === nodeId &&
      !streak.tripped &&
      streak.repeats >= this.config.threshold
    ) {
      streak.tripped = true;
      // The v3 hold explains this start; the v4 verdict is spent with it.
      if (verdict !== undefined && verdict.nodeId === nodeId) verdict.tripped = true;
      return {
        repeats: streak.repeats,
        firstSeq: streak.firstSeq,
        lastSeq: streak.lastSeq,
        fingerprint: streak.fingerprint,
      };
    }
    if (verdict === undefined || verdict.nodeId !== nodeId || verdict.tripped) return undefined;
    verdict.tripped = true;
    return { ...verdict.info };
  }

  /**
   * Claim the single warning for the current streak of this node (of `kind`,
   * or of whichever watched kind's streak belongs to `nodeId`). True the first
   * time (caller should warn), false afterwards or when no streak is this
   * node's. (v3 streaks only; v4 warnings are rate-limited by their key.)
   */
  claimWarning(runId: string, nodeId: string, kind?: NodeKind): boolean {
    const streaks = this.runs.get(runId)?.streaks;
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
    for (const state of this.runs.values()) total += state.streaks.size;
    return total;
  }

  /**
   * Diagnostics: v4 calls currently remembered, across runs — completed
   * (at most LOOP_HISTORY_SIZE per run and kind) plus open (at most
   * MAX_OPEN_CALLS_PER_RUN per run).
   */
  get trackedCalls(): number {
    let total = 0;
    for (const state of this.runs.values()) {
      total += state.open.length;
      for (const history of state.histories.values()) total += history.ring.length;
    }
    return total;
  }

  private entryFor(call: OpenCall, status: unknown, output: unknown, emitted: boolean): CallEntry {
    const unknown: CallEntry = {
      nodeId: call.nodeId,
      inFp: undefined,
      outcome: undefined,
      outFp: undefined,
      startSeq: call.startSeq,
    };
    if (!emitted || call.inFp === undefined) return unknown;
    const readable = output !== UNREADABLE_INPUT;
    const shape = readable && call.kind === 'tool' ? errorResultShape(output) : undefined;
    const ignore = this.config.ignoreKeys;
    const result = (): string | undefined => outcomeDigest('res', output, ignore, this.salt);
    if (status === 'ok') {
      if (!readable) return unknown;
      return shape !== undefined
        ? { ...unknown, inFp: call.inFp, outcome: 'fail', outFp: result() }
        : { ...unknown, inFp: call.inFp, outcome: 'ok', outFp: outcomeDigest('out', output, ignore, this.salt) };
    }
    if (status === 'error') {
      // A failure the tool RETURNED (isError, success false, an exit code) is
      // its result, whatever the adapter wrote into node.error — mcp-proxy's
      // message for an isError result is one constant sentence under a HIDE
      // switch, which would make every failure look the same. Otherwise the
      // thrown error's name + message (a JSON-RPC error through the proxy
      // too); else an `{error}`-shaped output.
      const outFp = isReturnedErrorShape(shape)
        ? result()
        : call.errFp !== undefined
          ? call.errFp
          : shape !== undefined
            ? result()
            : undefined;
      return { ...unknown, inFp: call.inFp, outcome: 'fail', outFp };
    }
    return unknown; // aborted, or a status nobody documented
  }

  private openCall(state: RunState, call: OpenCall): void {
    if (call.instanceId !== undefined) {
      // A restarted instance id: the older start will never complete.
      const index = state.open.findIndex((o) => o.nodeId === call.nodeId && o.instanceId === call.instanceId);
      if (index >= 0) state.open.splice(index, 1);
    }
    state.open.push(call);
    if (state.open.length > MAX_OPEN_CALLS_PER_RUN) state.open.shift();
  }

  /**
   * The open call a `node.error` / `node.finished` belongs to: the one with
   * this instanceId; when no open call carries it, the node's most recent
   * open call that has none; for an event that names no instanceId (the AI
   * SDK's `node.error`), simply the node's most recent open call.
   */
  private findOpenIndex(state: RunState, nodeId: string, instanceId: string | undefined): number {
    if (typeof nodeId !== 'string') return -1;
    const open = state.open;
    if (typeof instanceId === 'string') {
      for (let i = open.length - 1; i >= 0; i -= 1) {
        const call = open[i] as OpenCall;
        if (call.nodeId === nodeId && call.instanceId === instanceId) return i;
      }
      for (let i = open.length - 1; i >= 0; i -= 1) {
        const call = open[i] as OpenCall;
        if (call.nodeId === nodeId && call.instanceId === undefined) return i;
      }
      return -1;
    }
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if ((open[i] as OpenCall).nodeId === nodeId) return i;
    }
    return -1;
  }

  private findOpen(state: RunState | undefined, nodeId: string, instanceId: string | undefined): OpenCall | undefined {
    if (state === undefined) return undefined;
    const index = this.findOpenIndex(state, nodeId, instanceId);
    return index < 0 ? undefined : state.open[index];
  }

  /** Least-recently-used order (see stateFor). */
  private touch(runId: string, state: RunState): void {
    this.runs.delete(runId);
    this.runs.set(runId, state);
  }

  private stateFor(runId: string): RunState {
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      // Least-recently-used, not oldest-created: a long run that is still
      // calling tools must not lose its streak because MAX_LOOP_RUNS short
      // runs came and went meanwhile.
      this.touch(runId, existing);
      return existing;
    }
    if (this.runs.size >= MAX_LOOP_RUNS) {
      const oldest = this.runs.keys().next();
      if (!oldest.done) this.runs.delete(oldest.value);
    }
    const state: RunState = { streaks: new Map(), histories: new Map(), open: [] };
    this.runs.set(runId, state);
    return state;
  }
}
