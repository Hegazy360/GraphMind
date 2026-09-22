/**
 * Coarse redaction: four kill switches, applied at the one emit choke point.
 *
 * A reviewer of a loopback dev tool asks "can I stop prompts / results from
 * being recorded at all?". This answers exactly that, and nothing subtler:
 * whole-field replacement of `node.started.input` and `node.finished.output`
 * (and the text of `node.token` deltas) with the placeholder `"__REDACTED__"`,
 * chosen by node kind. No deny lists, no regexes, no callbacks — those were
 * refuted (internal/research/phase6-plan-2026-09.md, W7).
 *
 *   GRAPHMIND_HIDE_INPUTS        node.started.input, every kind; `tool-args` deltas
 *   GRAPHMIND_HIDE_OUTPUTS       node.finished.output, every kind; every delta
 *   GRAPHMIND_HIDE_TOOL_ARGS     node.started.input when kind is tool; `tool-args` deltas
 *   GRAPHMIND_HIDE_TOOL_RESULTS  node.finished.output when the instance's kind
 *                                is tool; deltas streamed by a tool node
 *
 * Any env value except unset, empty, `0`, `false`, `off` and `no` turns a
 * switch on (killSwitchOn: an unexpected spelling must not record
 * everything); each is also a session option (`hideInputs`, …). Either source turning a switch on turns it
 * on: an environment switch is a floor that code cannot lower.
 *
 * Every affected event carries `redaction: {count, keys}` — how many values
 * were replaced and which payload fields. `node.error` is deliberately NOT
 * redacted: error messages may echo data, and users of HIDE_OUTPUTS should
 * know that. A field that is absent, or already the placeholder, is left
 * alone and not counted; an existing `redaction` summary is merged.
 *
 * What the TOOL-only switches do not cover (say it wherever they are
 * documented): they hide the tool node's own `input` / `output`. In an agent
 * loop the same values also travel through the LLM node — the model's
 * `tool_use` blocks (its output) and the `tool_result` messages of the next
 * request (its input) — and those are recorded unless HIDE_INPUTS /
 * HIDE_OUTPUTS are on too. (`graphmind mcp-proxy` records an `isError: true`
 * tool result as `node.error`; under HIDE_TOOL_RESULTS / HIDE_OUTPUTS its
 * message no longer quotes the content — decisions.md.)
 *
 * `node.finished` does not name its kind, so open instances are tracked from
 * `node.started` (bounded). Fallbacks, in order: the instance's recorded
 * kind; the node's latest kind (no instanceId, or evicted); the `tool:`
 * nodeId prefix every adapter uses (decisions.md #1). Erring towards
 * redaction is the safe direction for a privacy switch.
 *
 * Two debugger events carry values that belong to a node's input (0.6.0,
 * contract C2), and are covered by the same switches as that input —
 * HIDE_INPUTS, or HIDE_TOOL_ARGS when the paused node is a tool (the session
 * passes the pause's kind; an unknown kind counts as a tool):
 *
 *   exec.resumed.edited  {after: "__REDACTED__"} — the edited input the call ran with
 *   exec.refused.message omitted — it comes from the adapter's validator and
 *                        may describe the input it refused
 *
 * with `redaction: {count, keys: ["edited"] | ["message"]}`. Their failed
 * forms keep `pauseId`, `action` / `code` and `requestId`, hide `edited` and
 * drop `message`, with `redaction.failed`.
 *
 * The session applies this inside `emitInternal`, BEFORE the ring buffer, so
 * replay-on-attach, the WebSocket, storage, exports and the read-only MCP
 * server all see the same redacted event — nothing downstream can bypass it.
 *
 * FAILS CLOSED (internal/decisions.md "Redaction fails closed on internal
 * error", binding for every port). With any switch on, `node.started`,
 * `node.finished` and `node.token` are redacted from a one-read snapshot of
 * the payload (own enumerable fields, an own `toJSON` dropped), so what was
 * inspected is exactly what is sent. When that cannot be done — the payload
 * is not an object, a read throws (a getter, a Proxy trap), token `deltas` a
 * hiding switch could cover is not an array, or a covered delta is neither
 * null nor an object or has a `v` that is present and not a string, or an
 * identity field a switch decides by (`nodeId`/`instanceId`/`kind` of a
 * start, `nodeId`/`instanceId` of a result, `nodeId` of a token, `t` of each
 * delta of a batch a switch could cover) is present, not null and not a string
 * (a String object or a `toJSON` compares as one value and serialises as the
 * string a switch looks for) — the
 * event is replaced by its FAILED FORM, built without reading
 * `input`/`output`/`deltas`:
 *
 *   node.started   {nodeId, parentId?, kind, name, instanceId, input: "__REDACTED__"}
 *   node.finished  {nodeId, instanceId?, durationMs, heldMs?, status, usage?, output: "__REDACTED__"}
 *   node.token     {nodeId, instanceId?, deltas: []}
 *
 * each with `redaction: {count: 0, keys: ["input","output","deltas"], failed:
 * true}`. Fields are copied best-effort: an optional one whose read throws or
 * whose value would fail the wire schema is omitted; when a REQUIRED one
 * cannot be read or is invalid, `apply` returns `undefined` and the event is
 * dropped. Both outcomes are reported through the optional `warn` callback
 * (the session routes it to its rate-limited warner) without quoting the
 * payload or the error. Other event types, and every event when all switches
 * are off, never reach this code (unchanged, zero cost).
 *
 * Never throws, never mutates the adapter's object.
 */
import { NodeKindSchema, RefusalCodeSchema, ResumeActionSchema, RunStatusSchema } from '@graphmind-ai/schema';
import type { EventPayloadMap, EventType, NodeKind, TokenDelta } from '@graphmind-ai/schema';
import { killSwitchOn, type EnvLike } from './env.js';

/** The placeholder every hidden value becomes. Shared by every language port. */
export const REDACTED = '__REDACTED__';

export interface RedactionSwitches {
  hideInputs: boolean;
  hideOutputs: boolean;
  hideToolArgs: boolean;
  hideToolResults: boolean;
}

/** The session options; each defaults to its environment switch. */
export type RedactionOptions = { [K in keyof RedactionSwitches]?: boolean | undefined };

/** Loose on purpose: it rides a loose wire object and may gain fields later. */
export interface RedactionSummary {
  count: number;
  keys: string[];
  [extra: string]: unknown;
}

export const NO_REDACTION: Readonly<RedactionSwitches> = Object.freeze({
  hideInputs: false,
  hideOutputs: false,
  hideToolArgs: false,
  hideToolResults: false,
});

/**
 * A GRAPHMIND_HIDE_* value that turns its switch ON: anything but unset,
 * empty, `0`, `false`, `off` and `no` (see killSwitchOn in env.ts).
 */
export function envFlagOn(value: string | undefined): boolean {
  return killSwitchOn(value);
}

/**
 * Resolve the switches from options and environment. Either source turning
 * a switch on turns it on (see the module comment).
 */
/**
 * An option value that turns a switch ON. The types say boolean, but these are
 * privacy switches read from JS configs, YAML and env-derived objects, so the
 * spellings the environment accepts count here too (`1`, `"1"`, `"true"`).
 * Anything else is off. Failing closed is the right direction for a switch
 * whose whole job is to keep data out of the recording.
 */
export function optionFlagOn(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && envFlagOn(value);
}

export function resolveRedaction(options: RedactionOptions | undefined, env: EnvLike): RedactionSwitches {
  const opt: Record<string, unknown> =
    options !== null && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  return {
    hideInputs: optionFlagOn(opt['hideInputs']) || envFlagOn(env['GRAPHMIND_HIDE_INPUTS']),
    hideOutputs: optionFlagOn(opt['hideOutputs']) || envFlagOn(env['GRAPHMIND_HIDE_OUTPUTS']),
    hideToolArgs: optionFlagOn(opt['hideToolArgs']) || envFlagOn(env['GRAPHMIND_HIDE_TOOL_ARGS']),
    hideToolResults:
      optionFlagOn(opt['hideToolResults']) || envFlagOn(env['GRAPHMIND_HIDE_TOOL_RESULTS']),
  };
}

export function anyRedaction(s: RedactionSwitches): boolean {
  return s.hideInputs || s.hideOutputs || s.hideToolArgs || s.hideToolResults;
}

/** Open instances tracked at once, across all runs; oldest evicted past this. */
export const DEFAULT_MAX_TRACKED_INSTANCES = 10_000;
/** Latest-kind-per-node entries kept; oldest evicted past this. */
const MAX_TRACKED_NODES = 10_000;

const SEP = '\u0000';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge a fresh summary into whatever `redaction` the payload already had. */
function mergeSummary(existing: unknown, count: number, key: string): RedactionSummary {
  if (isRecord(existing) && typeof existing['count'] === 'number' && Array.isArray(existing['keys'])) {
    const prior = existing['keys'].filter((k): k is string => typeof k === 'string');
    const keys = prior.includes(key) ? prior : [...prior, key];
    // The wire schema says a non-negative (safe) integer, and the hub drops an
    // envelope that fails it: never carry a bad prior count into the sum, or a
    // `count: 1.5` from upstream would lose the whole redacted event.
    const raw = existing['count'];
    const priorCount = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    const total = priorCount + count;
    return { count: Number.isSafeInteger(total) ? total : count, keys };
  }
  return { count, keys: [key] };
}

/** `redaction` on a failed form: nothing counted, every hideable field named. */
export const FAILED_REDACTION_KEYS: readonly string[] = Object.freeze(['input', 'output', 'deltas']);

/** Receives the fail-closed reports. Keys: `redaction:failed`, `redaction:dropped`. */
export type RedactionWarn = (key: string, message: string) => void;

/** Thrown (and caught) inside `apply` when a payload cannot be inspected safely. */
class Uninspectable extends Error {}

const NODE_KINDS: ReadonlySet<string> = new Set(NodeKindSchema.options);
const RUN_STATUSES: ReadonlySet<string> = new Set(RunStatusSchema.options);
const RESUME_ACTIONS: ReadonlySet<string> = new Set(ResumeActionSchema.options);
const REFUSAL_CODES: ReadonlySet<string> = new Set(RefusalCodeSchema.options);
/** Read failed. Distinct from every value a payload can hold. */
const UNREADABLE: unique symbol = Symbol('unreadable');

/** `obj[key]`, or UNREADABLE when the read throws. */
function read(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * One read of every own enumerable field into a plain object (what
 * JSON.stringify would see), minus an own `toJSON` that could substitute the
 * whole value at serialisation time. Throws when the object cannot be read.
 */
function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  if (Object.prototype.hasOwnProperty.call(copy, 'toJSON')) delete copy['toJSON'];
  return copy;
}

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * An identity field a switch decides by (a start's `kind`, the `nodeId` /
 * `instanceId` a result's kind is looked up by, a delta's `t`), read from the
 * snapshot: absent or null -> undefined, a string -> itself. Anything else is
 * compared as one value but serialised as another — JSON.stringify writes a
 * String object, or any object with a `toJSON`, as a plain string — so a
 * `kind: new String('tool')` would keep the tool's arguments visible under a
 * `"kind":"tool"` on the wire. Such a payload cannot be inspected: fail closed.
 */
function identity(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Uninspectable(`${key} is not a string`);
  return value;
}
const isDuration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isTokenCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class Redactor {
  /** Kind per open instance (run + nodeId + instanceId), insertion-ordered. */
  private readonly instances = new Map<string, NodeKind>();
  /** Latest kind per logical node (run + nodeId), insertion-ordered. */
  private readonly nodes = new Map<string, NodeKind>();

  constructor(
    readonly switches: RedactionSwitches,
    private readonly maxInstances: number = DEFAULT_MAX_TRACKED_INSTANCES,
    private readonly warn?: RedactionWarn,
  ) {}

  /** True when at least one switch is on (the session skips `apply` otherwise). */
  get active(): boolean {
    return anyRedaction(this.switches);
  }

  /** Diagnostics / tests. */
  get trackedInstances(): number {
    return this.instances.size;
  }

  /**
   * Redact one event. Every switch off, or a type other than node.started /
   * node.finished / node.token / exec.resumed / exec.refused: the very same
   * object. Otherwise a plain copy (see the module comment) — redacted,
   * unchanged, or the failed form — or `undefined`, meaning the event must
   * NOT be emitted. `nodeKind` is the paused node's kind, for exec.resumed /
   * exec.refused (which do not name their node). Never throws.
   */
  apply<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    runId: string,
    nodeKind?: NodeKind,
  ): EventPayloadMap[T] | undefined {
    if (!this.active) return payload;
    if (type === 'exec.resumed' || type === 'exec.refused') return this.onPauseAnswer(type, payload, nodeKind);
    if (type !== 'node.started' && type !== 'node.finished' && type !== 'node.token') return payload;
    try {
      if (!isRecord(payload)) throw new Uninspectable('payload is not an object');
      const p = snapshot(payload);
      switch (type) {
        case 'node.started':
          return this.onStarted(p as EventPayloadMap['node.started'], runId) as EventPayloadMap[T];
        case 'node.finished':
          return this.onFinished(p as EventPayloadMap['node.finished'], runId) as EventPayloadMap[T];
        default:
          return this.onToken(p as EventPayloadMap['node.token'], runId) as EventPayloadMap[T];
      }
    } catch {
      return this.failClosed(type, payload, runId);
    }
  }

  // -- exec.resumed / exec.refused (edited input) -----------------------------

  /**
   * The input-shaped parts of a pause's answer, hidden exactly when the
   * paused node's input is (module comment). Not covered: the very same
   * object. Covered: a copy from a one-read snapshot, or the failed form.
   */
  private onPauseAnswer<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    nodeKind: NodeKind | undefined,
  ): EventPayloadMap[T] | undefined {
    const s = this.switches;
    const covered = s.hideInputs || (s.hideToolArgs && (nodeKind === undefined || nodeKind === 'tool'));
    if (!covered) return payload;
    try {
      if (!isRecord(payload)) throw new Uninspectable('payload is not an object');
      const p = snapshot(payload);
      identity(p, 'pauseId');
      if (type === 'exec.resumed') {
        const edited = p['edited'];
        if (edited === undefined) return p as EventPayloadMap[T];
        if (isRecord(edited) && Object.keys(edited).length === 1 && read(edited, 'after') === REDACTED) {
          return p as EventPayloadMap[T]; // already the placeholder: left alone, not counted
        }
        return {
          ...p,
          edited: { after: REDACTED },
          redaction: mergeSummary(p['redaction'], 1, 'edited'),
        } as EventPayloadMap[T];
      }
      if (!('message' in p) || p['message'] === undefined) return p as EventPayloadMap[T];
      const out: Record<string, unknown> = { ...p, redaction: mergeSummary(p['redaction'], 1, 'message') };
      delete out['message'];
      return out as EventPayloadMap[T];
    } catch {
      return this.failClosedAnswer(type, payload);
    }
  }

  /**
   * Failed form of a pause answer: identity copied best-effort, `edited`
   * hidden (kept as the placeholder when it may have been there), `message`
   * dropped. `undefined` when `pauseId` and `action` / `code` cannot be read
   * as valid values — the event is then dropped.
   */
  private failClosedAnswer<T extends EventType>(type: T, payload: unknown): EventPayloadMap[T] | undefined {
    let out: Record<string, unknown> | undefined;
    try {
      out = this.failedAnswerForm(type, payload);
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      this.report(
        'redaction:dropped',
        `a ${type} event could not be redacted and its identity fields could not be read; ` +
          'dropped it rather than send data a GRAPHMIND_HIDE_* switch hides',
      );
      return undefined;
    }
    this.report(
      'redaction:failed',
      `redaction failed on a ${type} event (unreadable or malformed payload); ` +
        'sent it with the edited input / refusal message hidden and redaction.failed set',
    );
    return out as EventPayloadMap[T];
  }

  private failedAnswerForm(type: EventType, payload: unknown): Record<string, unknown> | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const pauseId = read(payload, 'pauseId');
    if (!isString(pauseId)) return undefined;
    const requestId = read(payload, 'requestId');
    const echo = isString(requestId) ? { requestId } : {};
    if (type === 'exec.resumed') {
      const action = read(payload, 'action');
      if (!isString(action) || !RESUME_ACTIONS.has(action)) return undefined;
      // Unreadable counts as present: an edit the record cannot rule out.
      const mayHaveEdit = read(payload, 'edited') !== undefined;
      return {
        pauseId,
        action,
        ...(mayHaveEdit ? { edited: { after: REDACTED } } : {}),
        ...echo,
        redaction: { count: 0, keys: ['edited'], failed: true },
      };
    }
    const code = read(payload, 'code');
    if (!isString(code) || !REFUSAL_CODES.has(code)) return undefined;
    return { pauseId, code, ...echo, redaction: { count: 0, keys: ['message'], failed: true } };
  }

  // -- fail closed -------------------------------------------------------------

  private failClosed<T extends EventType>(type: T, payload: unknown, runId: string): EventPayloadMap[T] | undefined {
    let out: Record<string, unknown> | undefined;
    try {
      out = this.failedForm(type, payload, runId);
    } catch {
      out = undefined;
    }
    if (out === undefined) {
      this.report(
        'redaction:dropped',
        `a ${type} event could not be redacted and its identity fields could not be read; ` +
          'dropped it rather than send data a GRAPHMIND_HIDE_* switch hides',
      );
      return undefined;
    }
    this.report(
      'redaction:failed',
      `redaction failed on a ${type} event (unreadable or malformed payload); ` +
        'sent it with input/output/deltas hidden and redaction.failed set',
    );
    return out as EventPayloadMap[T];
  }

  /** The failed form (module comment), or undefined when it cannot be valid. */
  private failedForm(type: EventType, payload: unknown, runId: string): Record<string, unknown> | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const nodeId = read(payload, 'nodeId');
    if (!isString(nodeId)) return undefined;
    const out: Record<string, unknown> = { nodeId };
    const optional = (key: string, valid: (v: unknown) => boolean): void => {
      const value = read(payload, key);
      if (valid(value)) out[key] = value;
    };
    const failed = { count: 0, keys: [...FAILED_REDACTION_KEYS], failed: true };
    switch (type) {
      case 'node.started': {
        optional('parentId', isString);
        const kind = read(payload, 'kind');
        const name = read(payload, 'name');
        const instanceId = read(payload, 'instanceId');
        if (!isString(kind) || !NODE_KINDS.has(kind) || !isString(name) || !isString(instanceId)) return undefined;
        // Still learn the kind, so this instance's node.finished is judged right.
        this.remember(runId, nodeId, instanceId, kind as NodeKind);
        return { ...out, kind, name, instanceId, input: REDACTED, redaction: failed };
      }
      case 'node.finished': {
        const instanceId = read(payload, 'instanceId');
        if (isString(instanceId)) {
          out['instanceId'] = instanceId;
          this.instances.delete(instanceKey(runId, nodeId, instanceId));
        }
        const durationMs = read(payload, 'durationMs');
        const status = read(payload, 'status');
        if (!isDuration(durationMs) || !isString(status) || !RUN_STATUSES.has(status)) return undefined;
        out['durationMs'] = durationMs;
        optional('heldMs', isDuration);
        out['status'] = status;
        const usage = read(payload, 'usage');
        if (typeof usage === 'object' && usage !== null) {
          const inputTokens = read(usage, 'inputTokens');
          const outputTokens = read(usage, 'outputTokens');
          if (isTokenCount(inputTokens) && isTokenCount(outputTokens)) out['usage'] = { inputTokens, outputTokens };
        }
        return { ...out, output: REDACTED, redaction: failed };
      }
      case 'node.token':
        optional('instanceId', isString);
        return { ...out, deltas: [], redaction: failed };
      default:
        return undefined;
    }
  }

  private report(key: string, message: string): void {
    try {
      this.warn?.(key, message);
    } catch {
      // a throwing sink must not turn a safe outcome into a throw
    }
  }

  // -- events ---------------------------------------------------------------
  // Each handler receives the SNAPSHOT (a plain object) and returns it, or a
  // copy of it — never the adapter's object. A throw means "fail closed".

  private onStarted(p: EventPayloadMap['node.started'], runId: string): EventPayloadMap['node.started'] {
    const fields = p as unknown as Record<string, unknown>;
    const nodeId = identity(fields, 'nodeId');
    const instanceId = identity(fields, 'instanceId');
    const kind = identity(fields, 'kind');
    if (nodeId !== undefined && kind !== undefined) {
      this.remember(runId, nodeId, instanceId, kind as NodeKind);
    }
    const hide = this.switches.hideInputs || (this.switches.hideToolArgs && kind === 'tool');
    if (!hide || !('input' in p) || p.input === undefined || p.input === REDACTED) return p;
    return { ...p, input: REDACTED, redaction: mergeSummary(p['redaction'], 1, 'input') };
  }

  private onFinished(p: EventPayloadMap['node.finished'], runId: string): EventPayloadMap['node.finished'] {
    const fields = p as unknown as Record<string, unknown>;
    const nodeId = identity(fields, 'nodeId');
    const instanceId = identity(fields, 'instanceId');
    const kind = nodeId !== undefined ? this.kindOf(runId, nodeId, instanceId) : undefined;
    if (nodeId !== undefined && instanceId !== undefined) {
      this.instances.delete(instanceKey(runId, nodeId, instanceId));
    }
    const hide = this.switches.hideOutputs || (this.switches.hideToolResults && kind === 'tool');
    if (!hide || !('output' in p) || p.output === undefined || p.output === REDACTED) return p;
    return { ...p, output: REDACTED, redaction: mergeSummary(p['redaction'], 1, 'output') };
  }

  private onToken(p: EventPayloadMap['node.token'], runId: string): EventPayloadMap['node.token'] {
    const s = this.switches;
    const nodeId = identity(p as unknown as Record<string, unknown>, 'nodeId');
    const nodeIsTool =
      nodeId !== undefined && s.hideToolResults ? this.kindOf(runId, nodeId, undefined) === 'tool' : false;
    const hideAll = s.hideOutputs || nodeIsTool;
    const hideToolArgs = s.hideToolArgs || s.hideInputs;
    if (!hideAll && !hideToolArgs) return p;
    if (!Array.isArray(p.deltas)) throw new Uninspectable('deltas is not an array');

    let count = 0;
    // One read of the array and of each delta; the copies are what is sent.
    const source: unknown[] = Array.from(p.deltas as unknown[]);
    const deltas = source.map((delta): TokenDelta => {
      if (delta === null || delta === undefined) return delta as unknown as TokenDelta;
      if (!isRecord(delta)) {
        // A bare string (or number, array...) where a delta belongs: its
        // channel is unknown, so every hiding switch may cover it.
        throw new Uninspectable('a delta is not an object');
      }
      const d = snapshot(delta);
      // `identity(d, 't')`, inlined (per delta, hot); read even under hideAll: one rule for every port.
      const channel = d['t'];
      if (channel !== undefined && channel !== null && typeof channel !== 'string') {
        throw new Uninspectable('t is not a string');
      }
      const hide = hideAll || (hideToolArgs && channel === 'tool-args');
      if (!hide) return d as TokenDelta;
      const v = d['v'];
      if (v === undefined) return d as TokenDelta;
      if (typeof v !== 'string') throw new Uninspectable('a covered delta value is not a string');
      if (v === '') return d as TokenDelta;
      count += 1;
      return { ...(d as TokenDelta), v: '', chars: v.length };
    });
    if (count === 0) return { ...p, deltas };
    return { ...p, deltas, redaction: mergeSummary(p['redaction'], count, 'deltas') };
  }

  // -- kind tracking ----------------------------------------------------------

  private remember(runId: string, nodeId: string, instanceId: string | undefined, kind: NodeKind): void {
    const nodeKey = `${runId}${SEP}${nodeId}`;
    this.nodes.delete(nodeKey); // re-insert so the newest is last (eviction order)
    this.nodes.set(nodeKey, kind);
    if (this.nodes.size > MAX_TRACKED_NODES) this.evictOldest(this.nodes);
    if (instanceId === undefined) return;
    this.instances.set(instanceKey(runId, nodeId, instanceId), kind);
    while (this.instances.size > this.maxInstances) this.evictOldest(this.instances);
  }

  private kindOf(runId: string, nodeId: string, instanceId: string | undefined): NodeKind | undefined {
    if (instanceId !== undefined) {
      const byInstance = this.instances.get(instanceKey(runId, nodeId, instanceId));
      if (byInstance !== undefined) return byInstance;
    }
    const byNode = this.nodes.get(`${runId}${SEP}${nodeId}`);
    if (byNode !== undefined) return byNode;
    // Last resort: the nodeId convention every adapter follows (decisions.md #1).
    return nodeId.startsWith('tool:') ? 'tool' : undefined;
  }

  private evictOldest(map: Map<string, NodeKind>): void {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

function instanceKey(runId: string, nodeId: string, instanceId: string): string {
  return `${runId}${SEP}${nodeId}${SEP}${instanceId}`;
}
