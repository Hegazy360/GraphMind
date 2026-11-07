/**
 * Hermetic replay: answer a run's gated calls from a recording instead of
 * from the outside world.
 *
 * A **tape** is the recording turned into an ordered answer table, written
 * by `graphmind replay` from the events already in the local database. The
 * app under replay loads it from `GRAPHMIND_REPLAY=<path>` (the CLI sets
 * that when it spawns your command) and every gated call it recognises is
 * answered locally — no network, no API keys, no token cost, and the same
 * result every time.
 *
 * WHAT REPLAY CAN AND CANNOT ANSWER, precisely — this is the contract the
 * whole feature rests on and it is deliberately narrow:
 *
 *  - **Tool calls**: answered here, in every adapter that honours a `before`
 *    gate decision (every TypeScript adapter and `mcp-proxy`). A tool that
 *    RETURNED a value replays as that value (`inject`); a tool that THREW
 *    replays as that throw (`throw`, a decision that exists only here and
 *    never travels on the wire).
 *  - **LLM steps**: NOT answerable through a gate. An adapter must hand its
 *    SDK the provider's own native result, and what GraphMind records is a
 *    normalized summary — so a model step is replayed by substituting the
 *    MODEL, not by answering its gate (see `replayModel` in the AI SDK
 *    adapter). Adapters without a replay model call the provider for real;
 *    `graphmind replay` says so before it starts.
 *  - **Anything not routed through GraphMind** — a bare `fetch`, a database
 *    write — runs for real. Replay is hermetic only for what it gates.
 *
 * MATCHING. Each entry is keyed by `(nodeId, ordinal)`: the Nth execution of
 * that logical node, in start order. A tool entry also carries `key`, the
 * canonical `[nodeId, input]` string (`canonicalCall`, unsalted so it
 * survives the process boundary — the live loop guard's fingerprints are
 * HMAC'd per process and cannot be used here). The ordinal is authoritative;
 * the key is the honesty check: when the live call's key differs from the
 * recorded one, the agent has diverged from the recording and the entry is a
 * MISMATCH rather than an answer.
 *
 * MISSES AND MISMATCHES are policy, not panic (`onMiss`):
 *  - `error` (the default): the run fails loudly, naming the call;
 *  - `live`: the call runs for real — useful while a test is being written;
 *  - `skip`: an injected `undefined`, for calls whose value nobody reads.
 *
 * LOSSY ENTRIES. A payload over `MAX_PAYLOAD_BYTES` was degraded to a
 * preview marker when it was recorded (schema/shrink.ts), so the tape cannot
 * reproduce it. Such an entry is marked `lossy` and, by default (`onLossy:
 * 'error'`), refuses to answer rather than feed an agent a truncated tool
 * result that looks real.
 *
 * Pure and side-effect free apart from reading its own file: no transport,
 * no timers. Nothing here throws into the host except deliberately, through
 * a `throw` decision or a miss the policy says is fatal.
 */
import type { NodeKind } from '@graphmind-ai/schema';
import type { GateDecision } from './gate-engine.js';
import { canonicalCall, DEFAULT_LOOP_IGNORE_KEYS, UNREADABLE_INPUT } from './loop-guard.js';

/** Current tape format. Bumped only on a breaking change to `TapeEntry`. */
export const TAPE_VERSION = 1;

export type MissPolicy = 'error' | 'live' | 'skip';
export type LossyPolicy = 'error' | 'live';

/** One recorded execution, as the tape stores it. */
export interface TapeEntry {
  nodeId: string;
  kind: NodeKind;
  name: string;
  /** 0-based index of this execution among that node's, in start order. */
  ordinal: number;
  /** Envelope seq of its `node.started` — for error messages and ordering. */
  seq?: number;
  /** Canonical `[nodeId, input]` of the recorded call; absent when unreadable. */
  key?: string;
  status: 'ok' | 'error' | 'aborted';
  /** The recorded return value (`status: 'ok'`). */
  output?: unknown;
  /** The recorded throw (`status: 'error'`). */
  error?: { name: string; message: string; stack?: string };
  /** Usage, for LLM entries a replay model hands back. */
  usage?: unknown;
  /** The recorded value was shrunk and cannot be reproduced faithfully. */
  lossy?: boolean;
}

export interface Tape {
  graphmindTape: number;
  runId: string;
  app?: string;
  recordedAt?: string;
  entries: TapeEntry[];
  /** Nodes whose kind has no replay support in this adapter; informational. */
  notes?: string[];
  /**
   * COUNTERFACTUAL CUT (`graphmind replay --substitute`). The envelope seq of
   * the substituted call: everything the recording captured at or before it
   * still replays, and everything after runs for real.
   *
   * The cut is not a limitation to work around, it is the only honest
   * answer. Once one call returns something different, the next model step
   * sees a prompt that never existed, and the recorded reply to the OLD
   * prompt would answer a question nobody asked — serving it would make the
   * counterfactual meaningless. So past the cut the agent is genuinely
   * running: a provider is called and tools execute.
   */
  cutSeq?: number;
  /**
   * Serve tool calls from the recording but let model steps call the
   * provider for real (`--live-model`). The point is to vary the MODEL's
   * side of the conversation — a reworded tool description, a new system
   * prompt, a different model — against a tool environment that is held
   * fixed, so any change in behaviour is attributable to the change you
   * made rather than to a tool answering differently.
   */
  liveModel?: boolean;
  /** Which calls were substituted, for the report and the run's own record. */
  substituted?: { nodeId: string; ordinal: number }[];
}

export interface ReplayOptions {
  onMiss?: MissPolicy;
  onLossy?: LossyPolicy;
  /** Called once per miss/mismatch/lossy refusal, for the CLI's report. */
  onEvent?: (event: ReplayEvent) => void;
}

export type ReplayEventKind = 'answered' | 'miss' | 'mismatch' | 'lossy' | 'live';

export interface ReplayEvent {
  kind: ReplayEventKind;
  nodeId: string;
  nodeKind: NodeKind;
  ordinal: number;
  /** Present on `mismatch`: what the recording expected vs what ran. */
  expectedKey?: string;
  actualKey?: string;
  message?: string;
}

/** A tape entry rejected the call; the run must not continue past it. */
export class ReplayMissError extends Error {
  override name = 'ReplayMissError';
  constructor(
    message: string,
    readonly event: ReplayEvent,
  ) {
    super(message);
  }
}

/** Parse a tape, or throw a readable error. Never returns a partial tape. */
export function parseTape(text: string): Tape {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`not a GraphMind tape (invalid JSON): ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') throw new Error('not a GraphMind tape (not an object)');
  const tape = raw as Partial<Tape>;
  if (tape.graphmindTape !== TAPE_VERSION) {
    throw new Error(
      `tape format ${String(tape.graphmindTape)} is not supported by this version (expected ${TAPE_VERSION})`,
    );
  }
  if (!Array.isArray(tape.entries)) throw new Error('tape has no entries');
  if (typeof tape.runId !== 'string') throw new Error('tape has no runId');
  return { ...(tape as Tape), entries: tape.entries as TapeEntry[] };
}

/**
 * The canonical key of a live call, matching how the tape writer built its
 * `key`. `undefined` when the input cannot be read faithfully — such a call
 * is never claimed to equal a recorded one.
 */
export function liveKey(nodeId: string, input: unknown): string | undefined {
  if (input === UNREADABLE_INPUT) return undefined;
  try {
    const key = canonicalCall(nodeId, input, new Set(DEFAULT_LOOP_IGNORE_KEYS));
    // `canonicalize` reports a value it could not read faithfully (a getter
    // or `toJSON` that threw, a self-returning `toJSON`) as this marker
    // rather than throwing. Two such inputs are NOT known to be equal, so a
    // key containing one must never be compared — the live loop guard draws
    // the same line with its `lossy` flag.
    return key.includes('"[unserializable]"') ? undefined : key;
  } catch {
    return undefined;
  }
}

/**
 * The replay decision source. One per session; consulted at `before` gates
 * and by an adapter's replay model. Stateful only in its per-node ordinal
 * counters, so a node called three times answers from three entries in
 * order.
 */
export class ReplayTape {
  private readonly byNode = new Map<string, TapeEntry[]>();
  /** Entries handed out per node (never past the end). */
  private readonly taken = new Map<string, number>();
  /** Calls ATTEMPTED per node, including the ones the tape could not answer. */
  private readonly attempts = new Map<string, number>();
  private readonly onMiss: MissPolicy;
  private readonly onLossy: LossyPolicy;
  private readonly onEvent: ((event: ReplayEvent) => void) | undefined;

  constructor(
    readonly tape: Tape,
    options: ReplayOptions = {},
  ) {
    this.onMiss = options.onMiss ?? 'error';
    this.onLossy = options.onLossy ?? 'error';
    this.onEvent = options.onEvent;
    for (const entry of tape.entries) {
      const list = this.byNode.get(entry.nodeId);
      if (list === undefined) this.byNode.set(entry.nodeId, [entry]);
      else list.push(entry);
    }
    for (const list of this.byNode.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  }

  private emit(event: ReplayEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // a reporter must never break the run
    }
  }

  /** How many entries this tape holds for `kind` — the CLI's pre-flight report. */
  countOf(kind: NodeKind): number {
    let n = 0;
    for (const entry of this.tape.entries) if (entry.kind === kind) n += 1;
    return n;
  }

  /** Entries never consumed by the end of the run (the agent stopped early). */
  unconsumed(): TapeEntry[] {
    const out: TapeEntry[] = [];
    for (const [nodeId, list] of this.byNode) {
      const used = this.taken.get(nodeId) ?? 0;
      out.push(...list.slice(used));
    }
    return out;
  }

  /** The next entry for this node, without consuming it. */
  private peek(nodeId: string): TapeEntry | undefined {
    const list = this.byNode.get(nodeId);
    return list?.[this.taken.get(nodeId) ?? 0];
  }

  /**
   * True when this node's next call lies past the counterfactual cut and so
   * must run for real (see `Tape.cutSeq`). A tape with no cut never says
   * yes, which is why ordinary replay pays nothing for this.
   *
   * A node whose entries have run out counts as past the cut too: after a
   * substitution the recording describes a run that no longer exists, so
   * "nothing recorded" means "go and find out", not "miss".
   */
  beyondCut(nodeId: string): boolean {
    const cut = this.tape.cutSeq;
    if (cut === undefined) return false;
    const next = this.peek(nodeId);
    return next === undefined || next.seq === undefined || next.seq > cut;
  }

  /** `--live-model`: every model step calls the provider, from the first. */
  get liveModel(): boolean {
    return this.tape.liveModel === true;
  }

  /** `--substitute`: this tape stops at a cut, after which the run is real. */
  get hasCut(): boolean {
    return this.tape.cutSeq !== undefined;
  }

  /** True when model steps must call their provider (`--live-model`, or past a cut). */
  modelIsLive(llmNodeId: string): boolean {
    return this.tape.liveModel === true || this.beyondCut(llmNodeId);
  }

  /**
   * Take the next recorded execution of `nodeId`, or undefined when the tape
   * has none left. Advances the node's ordinal — one call, one entry.
   */
  next(nodeId: string): TapeEntry | undefined {
    const list = this.byNode.get(nodeId);
    if (list === undefined) return undefined;
    const used = this.taken.get(nodeId) ?? 0;
    const entry = list[used];
    if (entry === undefined) return undefined;
    this.taken.set(nodeId, used + 1);
    return entry;
  }

  /**
   * The decision for a gated call, or `undefined` to let it run live. `input`
   * is what the live call is about to run with, for the key check.
   *
   * Throws `ReplayMissError` when the policy says a miss is fatal — the run
   * stops at the first divergence rather than producing a recording that
   * silently mixes replayed and live work.
   */
  decide(nodeId: string, kind: NodeKind, input: unknown): GateDecision | undefined {
    // Which call of this node THIS is, counted from the calls actually made
    // — `next()` does not advance past the end, so the attempt counter is
    // the only thing that can name call #N of a node the tape ran out of.
    const ordinal = this.attempts.get(nodeId) ?? 0;
    this.attempts.set(nodeId, ordinal + 1);
    // Past a counterfactual cut the recording no longer describes this run:
    // the call runs for real. Checked before consuming, so no entry is
    // silently burned on a call it was never going to answer.
    if (this.beyondCut(nodeId)) {
      this.emit({ kind: 'live', nodeId, nodeKind: kind, ordinal, message: 'past the substitution — running for real' });
      return undefined;
    }
    const entry = this.next(nodeId);
    if (entry === undefined) {
      return this.miss({
        kind: 'miss',
        nodeId,
        nodeKind: kind,
        ordinal,
        message: `the recording has no call #${ordinal + 1} of "${nodeId}"`,
      });
    }
    const actual = liveKey(nodeId, input);
    if (entry.key !== undefined && actual !== undefined && actual !== entry.key) {
      return this.miss({
        kind: 'mismatch',
        nodeId,
        nodeKind: kind,
        ordinal,
        expectedKey: entry.key,
        actualKey: actual,
        message: `call #${ordinal + 1} of "${nodeId}" ran with different arguments than the recording`,
      });
    }
    if (entry.lossy === true) {
      const event: ReplayEvent = {
        kind: 'lossy',
        nodeId,
        nodeKind: kind,
        ordinal,
        message:
          `call #${ordinal + 1} of "${nodeId}" was too large to record in full ` +
          '(the recording kept a preview), so it cannot be replayed faithfully',
      };
      if (this.onLossy === 'live') {
        this.emit({ ...event, kind: 'live' });
        return undefined;
      }
      this.emit(event);
      throw new ReplayMissError(event.message ?? 'lossy tape entry', event);
    }
    this.emit({ kind: 'answered', nodeId, nodeKind: kind, ordinal });
    if (entry.status === 'error') {
      const error = Object.assign(new Error(entry.error?.message ?? 'recorded failure'), {
        name: entry.error?.name ?? 'Error',
        ...(entry.error?.stack !== undefined ? { stack: entry.error.stack } : {}),
      });
      return { action: 'throw', error };
    }
    return { action: 'inject', output: entry.output };
  }

  /** Apply the miss policy: undefined = run live, or throw. */
  private miss(event: ReplayEvent): GateDecision | undefined {
    if (this.onMiss === 'live') {
      this.emit({ ...event, kind: 'live' });
      return undefined;
    }
    if (this.onMiss === 'skip') {
      this.emit(event);
      return { action: 'inject', output: undefined };
    }
    this.emit(event);
    throw new ReplayMissError(
      `${event.message ?? 'replay miss'} — the agent diverged from the recording. ` +
        'Re-record, or pass --on-miss=live to let unmatched calls run for real.',
      event,
    );
  }
}
