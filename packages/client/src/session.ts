/**
 * The GraphMind session: the one object an adapter talks to.
 *
 * Guarantees:
 *  - NEVER throws into the host app. Internal failures no-op with a
 *    rate-limited console.warn. (Errors thrown by the host's own `fn` inside
 *    `session.run` are the host's errors and propagate untouched.)
 *  - Zero-cost when detached: `gate()` returns a shared resolved promise on
 *    the fast path.
 *  - Fail-open: disconnect/dispose auto-continues every held gate.
 *  - Kill switches: GRAPHMIND_DISABLED=1 always disables; NODE_ENV=production
 *    disables unless GRAPHMIND=1. Disabled sessions never touch the network.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  KNOWN_CAPABILITIES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  WILDCARD_RUN_ID,
  createEnvelope,
  parseEnvelope,
  serializeEnvelope,
  serializePayload,
  type Envelope,
  type EventPayloadMap,
  type EventType,
  type KnownEnvelope,
  type MessagePayloadMap,
  type NodeKind,
  type PausePoint,
  type ResumeAction,
  type RunStatus,
  type SdkInfo,
} from '@graphmind-ai/schema';
import { type Clock, monotonicNow, normalizeDurationMs } from './clock.js';
import { resolveEnabled, resolveUrl, type EnvLike } from './env.js';
import { GraphMindAbortError, isAbortError, toErrorInfo } from './errors.js';
import {
  CONTINUE_DECISION,
  GateEngine,
  type GateDecision,
  type GateNode,
} from './gate-engine.js';
import { HeldLedger } from './held-ledger.js';
import {
  LoopGuard,
  UNREADABLE_INPUT,
  resolveLoopGuard,
  type LoopGuardOptions,
  type LoopInfo,
} from './loop-guard.js';
import { makeCounterIds, newId } from './ids.js';
import { REDACTED, Redactor, resolveRedaction } from './redaction.js';
import { RingBuffer } from './ring-buffer.js';
import { RateLimitedWarner, type WarnSink } from './safe.js';
import { Transport, type WebSocketConstructor } from './transport.js';

export const CLIENT_VERSION = '0.1.0';

export interface RunContext {
  readonly runId: string;
  readonly name: string;
  /**
   * Aborted (with an AbortError-named reason) when the debugger resolves a
   * gate with action `abort`. Adapters should pass `ctx.signal` into SDK
   * calls so an abort cancels them without triggering SDK retry logic.
   */
  readonly abortController: AbortController;
  readonly signal: AbortSignal;
}

export interface SessionOptions {
  /** Viewer endpoint. Default: GRAPHMIND_URL or ws://127.0.0.1:4747/ingest. */
  url?: string;
  /** Reported in run.started / hello. Default: "node". */
  appName?: string;
  /** The instrumented SDK, reported in run.started / hello. */
  sdk?: SdkInfo;
  /** Extra metadata merged into every run.started `meta`. */
  meta?: Record<string, unknown>;
  /** Force enable/disable. GRAPHMIND_DISABLED=1 still wins. */
  enabled?: boolean;
  /** Socket connect budget. Default 300ms. */
  connectTimeoutMs?: number;
  /** hello -> hello.ack budget. Default 1000ms. */
  handshakeTimeoutMs?: number;
  /**
   * Steady-state background reconnect interval. Default 10s. After an
   * *established* attachment drops, the transport first retries fast
   * (200/400/800ms, each clamped to this value) before settling here.
   */
  retryIntervalMs?: number;
  /** Ring buffer capacity (events retained for replay-on-attach). Default 5000. */
  bufferSize?: number;
  /**
   * Approximate memory ceiling for the ring buffer, in bytes. Default 8 MiB.
   * Events are dropped oldest-first once serialized frames exceed it, so a
   * host emitting multi-megabyte payloads cannot turn the replay buffer into
   * `bufferSize` x payload-size of retained memory. Dropped events are
   * reported exactly like capacity drops (gap marker + warning).
   */
  maxBufferBytes?: number;
  /** Auto-continue a held gate nobody resumes after this long. Default: hold forever. */
  pauseTimeoutMs?: number;
  /**
   * WebSocket implementation override. Omit for the global WebSocket
   * (Node >= 22). Passing the key explicitly set to `undefined` means "no
   * implementation available" (the session stays permanently detached).
   */
  webSocket?: WebSocketConstructor | undefined;
  /** Environment override, for tests. Default: process.env. */
  env?: EnvLike;
  /** Warning sink override (default console.warn) and rate-limit interval. */
  logger?: WarnSink;
  warnIntervalMs?: number;
  /**
   * Monotonic millisecond clock used for held-time accounting (`heldMs`).
   * Default `performance.now()`. For tests.
   */
  clock?: Clock;
  /**
   * Loop hold: hold the before-gate of the Nth identical call of one tool made
   * back-to-back — no other watched call of the same kind in between — while
   * a debugger is attached (see loop-guard.ts, rule v3).
   * Default `{threshold: 3, mode: 'pause', kinds: ['tool']}`, overridable per
   * field here or via `GRAPHMIND_LOOP_THRESHOLD` / `GRAPHMIND_ON_LOOP`.
   * `false` switches it off.
   */
  loopGuard?: LoopGuardOptions | false;
  // -- Coarse redaction (W7; see redaction.ts). Each defaults to its env switch;
  // either source turning one on turns it on (env is a floor code cannot lower).
  /** Replace `node.started.input` with "__REDACTED__" on every node. Env: GRAPHMIND_HIDE_INPUTS. */
  hideInputs?: boolean;
  /** Replace `node.finished.output` and every token delta's text. Env: GRAPHMIND_HIDE_OUTPUTS. */
  hideOutputs?: boolean;
  /** Replace the input of tool nodes only (and streamed tool-args). Env: GRAPHMIND_HIDE_TOOL_ARGS. */
  hideToolArgs?: boolean;
  /** Replace the output of tool nodes only. Env: GRAPHMIND_HIDE_TOOL_RESULTS. */
  hideToolResults?: boolean;
}

export interface ReadyOptions {
  /** How long to wait for the handshake before resolving false. Default 2000ms. */
  timeoutMs?: number;
}

export interface SessionStats {
  enabled: boolean;
  attached: boolean;
  buffered: number;
  /**
   * Events evicted from the replay ring buffer since the session started.
   * NOT the same as data loss: an event that was already delivered to the
   * debugger is evicted the moment the buffer wraps, which is normal on any
   * run longer than `bufferSize`. Use `lost` for the number that matters.
   */
  dropped: number;
  /**
   * Events evicted **before they ever reached the debugger** — actual holes
   * in the recorded run. Every one of these is announced: a gap marker on the
   * next attach plus a rate-limited warning to the host's logs.
   */
  lost: number;
  /** Runs with a gap marker still waiting for an attach to carry it. */
  pendingGaps: number;
  heldGates: number;
  seq: number;
}

/** One contiguous hole in a run's event stream, as carried by a gap marker. */
interface GapRecord {
  droppedCount: number;
  fromSeq: number;
  toSeq: number;
}

/** A serialized envelope plus the bookkeeping the gap accounting needs. */
interface BufferedEnvelope {
  json: string;
  seq: number;
  runId: string;
  /** True once the transport has accepted this frame for delivery. */
  sent: boolean;
}

export interface Session {
  readonly enabled: boolean;
  readonly attached: boolean;
  /**
   * Attach guarantee: force-start the lazy transport connection immediately
   * (even before any emit) and resolve `true` once the handshake completes
   * (attached), or `false` on timeout (default 2000ms). Resolves `false`
   * immediately when the session is disabled or disposed; `true` instantly
   * when already attached. Never throws (never rejects). Concurrent calls
   * share one connection attempt, and after a disconnect a new call re-arms
   * (kicking an immediate reconnect instead of waiting out the retry
   * interval). Fail-open by design: a `false` result means "still detached —
   * carry on"; it is never an error.
   */
  ready(opts?: ReadyOptions): Promise<boolean>;
  /**
   * Run `fn` inside a new run context (AsyncLocalStorage). Emits
   * `run.started` / `run.finished` around it. Errors from `fn` propagate.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /** The active run context, if any. */
  currentRun(): RunContext | undefined;
  /** Emit one event. Attributed to the current run (or an implicit one). */
  emit<T extends EventType>(type: T, payload: EventPayloadMap[T]): void;
  /**
   * The core gating primitive: await before/after/error boundaries. Resolves
   * `{action:'continue'}` synchronously-fast when detached or not matching.
   */
  gate(point: PausePoint, node: GateNode): Promise<GateDecision>;
  /** Diagnostics snapshot (also used by tests). */
  stats(): SessionStats;
  /** Release held gates, close the socket, stop timers. Idempotent. */
  dispose(): Promise<void>;
}

const CONTINUE_PROMISE: Promise<GateDecision> = Promise.resolve(CONTINUE_DECISION);

const DEFAULTS = {
  connectTimeoutMs: 300,
  handshakeTimeoutMs: 1000,
  retryIntervalMs: 10_000,
  /**
   * How much run a default session can lose the debugger for and still record
   * completely. The soak baseline puts a comfortable live run at <= ~2,000
   * events/s, and the transport's fast-reconnect burst puts a blip's dark
   * window at ~0.2-0.5s (see transport.ts), so 5,000 frames is ~2.5s of
   * headroom at the ceiling and ~25s at a more typical 200 events/s.
   * Bounded in bytes as well — see `maxBufferBytes`.
   */
  bufferSize: 5000,
  /** 8 MiB: ~46,000 frames at the soak baseline's 175 B/event. */
  maxBufferBytes: 8 * 1024 * 1024,
  readyTimeoutMs: 2000,
} as const;

/**
 * Cap on the number of distinct runs whose gaps are tracked between two
 * attaches. Drops beyond it are still counted and warned about, they just
 * lose their per-run attribution (there is no run to hang the marker on that
 * would not itself be a guess).
 */
const MAX_TRACKED_GAP_RUNS = 64;

function defaultWebSocket(): WebSocketConstructor | undefined {
  return (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
}

class SessionImpl implements Session {
  readonly enabled: boolean;

  private readonly warner: RateLimitedWarner;
  private readonly transport: Transport;
  private readonly engine: GateEngine;
  private readonly buffer: RingBuffer<BufferedEnvelope>;
  /** Pins gate holds to node instances so `node.finished` can carry `heldMs`. */
  private readonly ledger: HeldLedger;
  /** Coarse redaction (W7): the kill switches, applied in emitInternal before the buffer. */
  private readonly redactor: Redactor;
  /** Loop hold: back-to-back identical tool calls (rule v3), consulted at gate('before'). */
  private readonly loopGuard: LoopGuard;
  /**
   * Loop details for the hold `gate()` is about to open. `GateEngine.hold`
   * calls `onPaused` synchronously inside its Promise executor, so this is
   * set immediately before `hold()` and consumed inside `onPaused` — never
   * across a tick, never shared between two gates.
   */
  private pendingLoop: LoopInfo | undefined;
  private readonly als = new AsyncLocalStorage<RunContext>();
  private readonly newPauseId = makeCounterIds('pause');

  private readonly appName: string;
  private readonly sdk: SdkInfo;
  private readonly meta: Record<string, unknown> | undefined;

  private seq = 0;
  /** Identity handed out by the debugger in `hello.ack`; see `buildHello`. */
  private sessionToken: string | undefined;
  private started = false;
  private disposed = false;
  private implicitRun: RunContext | undefined;
  /** Pending `ready()` settlers; each self-removes on settle. */
  private readonly readyWaiters = new Set<(attached: boolean) => void>();
  /** Holes waiting to be announced, keyed by the run they punched through. */
  private readonly pendingGaps = new Map<string, GapRecord>();
  /** Events evicted before delivery, ever (see SessionStats.lost). */
  private lostTotal = 0;
  /** Losses past MAX_TRACKED_GAP_RUNS: counted and warned, not attributed. */
  private unattributedLost = 0;

  constructor(options: SessionOptions) {
    const env = options.env ?? process.env;
    this.enabled = resolveEnabled(options.enabled, env);
    this.warner = new RateLimitedWarner(options.warnIntervalMs, options.logger);
    this.appName = options.appName ?? 'node';
    this.sdk = options.sdk ?? { name: 'custom', version: '0.0.0' };
    this.meta = options.meta;
    this.buffer = new RingBuffer<BufferedEnvelope>({
      capacity: options.bufferSize ?? DEFAULTS.bufferSize,
      maxBytes: options.maxBufferBytes ?? DEFAULTS.maxBufferBytes,
      sizeOf: (item) => item.json.length,
      onEvict: (item) => this.recordEviction(item),
      // One event bigger than the whole buffer must never evict every older
      // event; emitInternal decides its fate instead (see handleUnbuffered).
      rejectOversize: true,
    });

    this.ledger = new HeldLedger(options.clock ?? monotonicNow);
    this.redactor = new Redactor(
      resolveRedaction(
        {
          hideInputs: options.hideInputs,
          hideOutputs: options.hideOutputs,
          hideToolArgs: options.hideToolArgs,
          hideToolResults: options.hideToolResults,
        },
        env,
      ),
      undefined,
      // Fail-closed reports (a failed form sent, or an event dropped), one line
      // per key per interval — never the payload, never the error text.
      (key, message) => this.warner.warn(key, message),
    );
    this.loopGuard = new LoopGuard(resolveLoopGuard(options.loopGuard, env));
    this.engine = new GateEngine(
      {
        newPauseId: this.newPauseId,
        onPaused: (pauseId, node, point, runId) => {
          // Loop hold (W5): the built-in breakpoint says why it fired. Taken
          // FIRST so a throw anywhere below can never leave it behind for the
          // next, unrelated hold.
          const loop = this.pendingLoop;
          this.pendingLoop = undefined;
          this.ledger.holdOpened(pauseId, runId, node.nodeId, point);
          this.emitInternal(
            'exec.paused',
            loop === undefined
              ? { pauseId, nodeId: node.nodeId, point }
              : { pauseId, nodeId: node.nodeId, point, reason: 'loop', loop: this.loopOnWire(loop, node) },
            runId,
          );
        },
        onResumed: (pauseId, _node, action, runId) => {
          this.ledger.holdClosed(pauseId);
          this.emitInternal('exec.resumed', { pauseId, action }, runId);
        },
      },
      options.pauseTimeoutMs,
      options.clock ?? monotonicNow,
    );

    this.transport = new Transport(
      {
        url: resolveUrl(options.url, env),
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
        retryIntervalMs: options.retryIntervalMs ?? DEFAULTS.retryIntervalMs,
        webSocket: 'webSocket' in options ? options.webSocket : defaultWebSocket(),
        warner: this.warner,
      },
      {
        buildHello: () => this.buildHello(),
        onAttached: (ack) => this.handleAttached(ack),
        onDetached: () => this.handleDetached(),
        onControl: (envelope) => this.handleControl(envelope),
      },
    );
  }

  get attached(): boolean {
    return this.transport.attached;
  }

  currentRun(): RunContext | undefined {
    return this.als.getStore();
  }

  ready(opts: ReadyOptions = {}): Promise<boolean> {
    try {
      if (!this.active()) return Promise.resolve(false);
      this.ensureStarted();
      // Re-arm: if a previous attempt failed (or we got disconnected), don't
      // sit out the retry interval — connect now. No-op mid-attempt/attached.
      this.transport.kick();
      if (this.transport.attached) return Promise.resolve(true);
      const timeoutMs = opts.timeoutMs ?? DEFAULTS.readyTimeoutMs;
      return new Promise<boolean>((resolve) => {
        const settle = (attached: boolean): void => {
          clearTimeout(timer);
          this.readyWaiters.delete(settle);
          resolve(attached);
        };
        // Deliberately NOT unref'd, unlike every other timer in this client.
        //
        // Elsewhere unref is right: background reconnects must never keep a
        // finished process alive. Here it is fatal. `await gm.ready()` before
        // the agent starts is often the ONLY pending work in the process, so
        // an unref'd timer lets the event loop drain, and Node exits with
        // code 13 ("unsettled top-level await") printing nothing — the exact
        // shape of a user starting their agent before starting the debugger.
        // Failing open means resolving false, which cannot happen if the
        // process dies first. The timer is cleared the moment we settle, so
        // it holds the loop for at most `timeoutMs`.
        const timer = setTimeout(() => settle(false), timeoutMs);
        this.readyWaiters.add(settle);
      });
    } catch (error) {
      this.warner.warn('ready', 'internal error in ready(); resolving detached', error);
      return Promise.resolve(false);
    }
  }

  async run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T> {
    const ctx = this.makeRunContext(name);
    if (!this.active()) {
      return await this.als.run(ctx, () => fn(ctx));
    }
    this.guard('run-start', () => {
      this.ensureStarted();
      this.emitInternal(
        'run.started',
        {
          app: this.appName,
          sdk: this.sdk,
          meta: { name, ...this.meta },
        },
        ctx.runId,
      );
    });
    try {
      const result = await this.als.run(ctx, () => fn(ctx));
      this.guard('run-finish', () => {
        const status: RunStatus = ctx.signal.aborted ? 'aborted' : 'ok';
        this.emitInternal('run.finished', { status }, ctx.runId);
      });
      return result;
    } catch (error) {
      this.guard('run-finish', () => {
        const status: RunStatus =
          ctx.signal.aborted || isAbortError(error) ? 'aborted' : 'error';
        this.emitInternal('run.finished', { status, error: toErrorInfo(error) }, ctx.runId);
      });
      throw error; // the host's own error — always propagates
    }
  }

  emit<T extends EventType>(type: T, payload: EventPayloadMap[T]): void {
    if (!this.active()) return;
    this.guard('emit', () => {
      this.ensureStarted();
      const runId = this.resolveRunId();
      if (type !== 'node.started') {
        this.emitInternal(type, payload, runId);
        return;
      }
      // Loop hold (W5): fingerprint the call on the adapter's own payload (the
      // redactor works on a copy and never mutates it), recorded once the
      // frame exists (Ruby parity, decision "A dropped event takes no seq and
      // clears its kind's loop streak"). A start the redactor dropped, or one
      // that could not be serialised, never reached the wire: it is not "the
      // call right before" the next one, so it clears its kind's streak
      // (rule 3), and a hold's firstSeq/lastSeq always name an emitted event.
      let seq: number | undefined;
      try {
        seq = this.emitInternal(type, payload, runId);
      } finally {
        this.noteNodeStarted(payload as EventPayloadMap['node.started'], runId, seq);
      }
    });
  }

  gate(point: PausePoint, node: GateNode): Promise<GateDecision> {
    if (!this.active()) return CONTINUE_PROMISE;
    try {
      this.ensureStarted();
      // Fast path: detached, or attached with nothing matching. The loop hold
      // (W5) is a built-in breakpoint consulted only when attached, only at
      // 'before', only in mode 'pause' — detached, the fast path is untouched.
      const loop =
        point === 'before' && this.transport.attached && this.loopGuard.mode === 'pause'
          ? this.loopGuard.consult(this.resolveRunId(), node.kind, node.nodeId, node.name)
          : undefined;
      if (
        loop === undefined &&
        (!this.transport.attached || !this.engine.shouldPause(point, node))
      ) {
        return CONTINUE_PROMISE;
      }
      const ctx = this.currentRun();
      const runId = this.resolveRunId();
      this.pendingLoop = loop;
      return this.engine.hold(point, node, runId).then(
        (decision) => {
          if (decision.action === 'abort') {
            try {
              ctx?.abortController.abort(new GraphMindAbortError());
            } catch {
              // never throw into the host
            }
          }
          return decision;
        },
        (error) => {
          this.warner.warn('gate', 'internal gate error; continuing', error);
          return CONTINUE_DECISION;
        },
      );
    } catch (error) {
      this.warner.warn('gate', 'internal gate error; continuing', error);
      return CONTINUE_PROMISE;
    }
  }

  stats(): SessionStats {
    return {
      enabled: this.enabled,
      attached: this.attached,
      buffered: this.buffer.size,
      dropped: this.buffer.dropped,
      lost: this.lostTotal,
      pendingGaps: this.pendingGaps.size,
      heldGates: this.engine.heldCount,
      seq: this.seq,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.guard('dispose', () => {
      this.engine.releaseAll();
      this.engine.disarm();
      if (this.implicitRun !== undefined && this.enabled) {
        this.emitInternal('run.finished', { status: 'ok' }, this.implicitRun.runId);
      }
      this.transport.dispose();
    });
    this.settleReadyWaiters(false); // a disposed session can never attach
  }

  // -- internals ------------------------------------------------------------

  /** Enabled and not disposed. */
  private active(): boolean {
    return this.enabled && !this.disposed;
  }

  /** Run an internal step; degrade internal failures to a warning. */
  private guard(key: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.warner.warn(key, `internal error in ${key}; GraphMind degrading to no-op`, error);
    }
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.transport.start();
  }

  /**
   * Loop hold, the recording half (rule v3, see loop-guard.ts). Fingerprints a
   * watched node's input and extends or replaces its kind's back-to-back
   * streak; the before-gate consults it. When the count reaches the threshold
   * and nothing will hold — no debugger attached, or mode `warn` — say so once
   * per streak, so a looping agent is never silent even when nobody is
   * watching. Each field is read once, here: an input whose read throws clears
   * the kind's streak (rule 3); a start whose kind cannot be read touches no
   * streak. `seq` is the seq the start's envelope received, or `undefined`
   * when it was never emitted (dropped by the redactor, or not serialisable):
   * such a start is recorded as unreadable, which clears its kind's streak.
   * Pure bookkeeping: never throws.
   */
  private noteNodeStarted(
    payload: EventPayloadMap['node.started'],
    runId: string,
    seq: number | undefined,
  ): void {
    try {
      const guard = this.loopGuard;
      if (!guard.enabled) return;
      let kind: NodeKind;
      try {
        kind = payload.kind;
      } catch {
        return; // no kind, no streak to extend or clear
      }
      let nodeId: string;
      let name: string;
      try {
        nodeId = payload.nodeId;
        name = payload.name;
      } catch {
        // Unidentifiable call of a (possibly) watched kind: clears (rule 3).
        nodeId = undefined as unknown as string;
        name = '';
      }
      let input: unknown = UNREADABLE_INPUT;
      if (seq !== undefined) {
        try {
          input = payload.input;
        } catch {
          input = UNREADABLE_INPUT;
        }
      }
      // Never emitted: UNREADABLE_INPUT clears the streak before `seq` is used.
      const record = guard.record(runId, kind, nodeId, name, input, seq ?? -1);
      if (record === undefined || !record.atThreshold) return;
      const willHold = guard.mode === 'pause' && this.transport.attached;
      if (willHold) return;
      if (!guard.claimWarning(runId, nodeId, kind)) return;
      const times = `${record.repeats}×`;
      const because =
        guard.mode === 'warn'
          ? 'GRAPHMIND_ON_LOOP=warn, so it is not being held'
          : 'no debugger is attached to hold it (start `npx graphmind-ai` to pause it there)';
      this.warner.warn(
        `loop:${nodeId}`,
        `possible loop: ${name} (${nodeId}) was called ${times} in a row with ` +
          `identical arguments; ${because}. Polling on purpose? add it to ` +
          `loopGuard.allowNodes; GRAPHMIND_ON_LOOP=off silences this`,
      );
    } catch {
      // never throw into the host
    }
  }

  /**
   * Loop hold (W5): `exec.paused.loop` as it may leave the process. The
   * fingerprint is an unsalted digest of this node's input; when a redaction
   * switch hides that input (`hideInputs`, or `hideToolArgs` on a tool), a
   * low-entropy argument — an email, a zip code, an id — would be a
   * dictionary attack away from the digest, so the digest is hidden with it.
   * The hold, `repeats`, `firstSeq` and `lastSeq` are unaffected.
   */
  private loopOnWire(
    loop: LoopInfo,
    node: GateNode,
  ): NonNullable<EventPayloadMap['exec.paused']['loop']> {
    const s = this.redactor.switches;
    const hidden = s.hideInputs || (s.hideToolArgs && node.kind === 'tool');
    return hidden ? { ...loop, fingerprint: REDACTED } : { ...loop };
  }

  private makeRunContext(name: string): RunContext {
    const abortController = new AbortController();
    return {
      runId: newId('run'),
      name,
      abortController,
      signal: abortController.signal,
    };
  }

  /** Current run's id; events outside any run share one implicit run. */
  private resolveRunId(): string {
    const ctx = this.als.getStore();
    if (ctx !== undefined) return ctx.runId;
    if (this.implicitRun === undefined) {
      this.implicitRun = this.makeRunContext('implicit');
      this.emitInternal(
        'run.started',
        {
          app: this.appName,
          sdk: this.sdk,
          meta: { name: 'implicit', implicit: true, ...this.meta },
        },
        this.implicitRun.runId,
      );
    }
    return this.implicitRun.runId;
  }

  /**
   * Envelope + buffer + (if attached) send. No enable/guard checks here.
   * Returns the seq the event was emitted with, or `undefined` when the
   * redactor dropped it (a serialisation failure throws, as before).
   */
  private emitInternal<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    runId: string,
  ): number | undefined {
    // Coarse redaction (W7) runs FIRST, before the ring buffer and before any
    // other bookkeeping reads the payload: the kill switches must hold for
    // replay-on-attach, storage and every export, so nothing may see the raw
    // input/output past this line. `apply` is a no-op when every switch is off.
    // It fails closed: `undefined` means the payload could not be redacted
    // safely nor replaced by a valid failed form — the event is not emitted
    // (the redactor already warned) and takes NO seq, so the seqs of emitted
    // events stay consecutive (decision "A dropped event takes no seq").
    const redacted = this.redactor.apply(type, payload, runId);
    if (redacted === undefined) return undefined;
    const seq = this.nextSeq();
    let json: string;
    try {
      // Instantiated at the EventType union: TS cannot relate the generic
      // indexed accesses EventPayloadMap[T] / MessagePayloadMap[T] directly.
      const envelope = createEnvelope<EventType>({
        type,
        payload: this.withHeldTime(type, redacted, runId),
        seq,
        runId,
      });
      // Payload budget, AFTER redaction and held time, BEFORE the ring buffer:
      // what is buffered and sent is exactly what the server stores.
      json = this.serializeWithinBudget(type, envelope);
    } catch (error) {
      // Not serialisable at all: never emitted, so give the seq back — unless
      // something re-entered emit meanwhile (a logger, a toJSON) and took the
      // next one, where handing it back would duplicate a seq.
      if (this.seq === seq + 1) this.seq = seq;
      throw error;
    }
    const item: BufferedEnvelope = { json, seq, runId, sent: false };
    if (!this.buffer.push(item)) {
      this.handleUnbuffered(item);
      return seq;
    }
    if (this.transport.attached && this.transport.send(json)) item.sent = true;
    return seq;
  }

  /**
   * Serialize an event envelope with its payload held to the protocol's
   * payload budget (MAX_PAYLOAD_BYTES, 512 KB of UTF-8 JSON).
   *
   * The server has always shrunk a larger payload to a type-preserving
   * preview before storing it (`serializePayload`, now in @graphmind-ai/schema).
   * Doing it only there meant a 17 MB payload was framed whole: it evicted
   * the replay buffer and was refused by the server's 16 MiB frame cap, so the
   * event vanished — no seq stored, the node "running" forever, nothing
   * counted or printed. Applying the SAME function here makes the event
   * degrade exactly as the server would have stored it; the server's own pass
   * is then a no-op (the function is idempotent).
   *
   * Under the budget the envelope is serialized once, exactly as before: the
   * pre-check is exact (a string's UTF-8 size is at most 3x its UTF-16 length,
   * and the payload's JSON is a substring of the envelope's), so only an
   * envelope longer than MAX_PAYLOAD_BYTES / 3 characters pays for a parse of
   * the frame and a second stringify of its payload.
   *
   * The shrink runs on the payload parsed back out of the frame — what the
   * server will parse — never on the live object. JSON rewrites a Buffer
   * (toJSON -> {type, data: [...]}), a typed array, a Date, a URL, anything
   * with toJSON, and drops keys whose value is undefined; shrinking the live
   * value diverged from the server for all of them, and for a Buffer it walked
   * every byte as an object key (a 1 MB tool result: ~170 ms inside the host's
   * emit), could not fit the result, and fell back to the whole-payload marker
   * — not a valid node.finished, so ingest dropped the event outright.
   *
   * A payload JSON cannot serialize at all (a cycle, a BigInt) used to throw
   * here and drop the event; it now degrades the same way, field by field.
   * If reading the payload itself throws, that still propagates to the
   * caller's guard (the event is dropped with a warning, never thrown).
   * Warnings are one per event type per interval and never quote content.
   */
  private serializeWithinBudget(type: EventType, envelope: Envelope<EventType>): string {
    let payload: unknown = envelope.payload;
    let json: string;
    try {
      json = serializeEnvelope(envelope);
    } catch (error) {
      // A cycle, a BigInt, or JSON longer than the engine's maximum string
      // length. Here the payload only has to become serializable — and, with
      // its type, stay a valid event; the budget is applied below, to the
      // wire form, exactly as for every other event (hence no byte limit).
      const degraded = serializePayload(payload, Number.POSITIVE_INFINITY, type);
      if (!degraded.truncated) throw error;
      payload = degraded.payload;
      const degradedEnvelope = { ...envelope, payload: payload as never };
      json = serializeEnvelope(degradedEnvelope);
      if (parseEnvelope(degradedEnvelope).kind === 'invalid') {
        this.warner.warn(
          `payload-invalid:${type}`,
          `a ${type} event had a value that could not be serialized to JSON, and it could not ` +
            `be degraded to a valid event; the debugger will drop it`,
        );
      } else {
        this.warner.warn(
          `payload-unserializable:${type}`,
          `a ${type} event had a value that could not be serialized to JSON; it was sent with ` +
            `that value replaced by a marker`,
        );
      }
      // Fall through: the fields that DID serialize may still be over budget
      // (a cycle next to a 17 MB string), exactly as the server would see it.
    }
    if (json.length * 3 <= MAX_PAYLOAD_BYTES) return json;
    // The wire form of the payload (see above): exactly what the server parses.
    const wirePayload = (JSON.parse(json) as { payload?: unknown }).payload;
    const shrunk = serializePayload(wirePayload, MAX_PAYLOAD_BYTES, type);
    if (!shrunk.truncated) return json;
    const bytes = (shrunk.payload as { bytes?: unknown }).bytes;
    const size = typeof bytes === 'number' ? bytes : 'unknown';
    const shrunkEnvelope = { ...envelope, payload: shrunk.payload as never };
    // With its type the shrink keeps a valid event of every known type (the
    // skeleton tier); only an event that was not valid to begin with ends up
    // as the whole-payload marker, which the server drops at ingest. Say so
    // rather than promise a preview. (Only this over-budget path pays for the
    // check.)
    if (parseEnvelope(shrunkEnvelope).kind === 'invalid') {
      this.warner.warn(
        `payload-invalid:${type}`,
        `a ${type} event of ${size} bytes could not be shrunk to a valid event (the debugger ` +
          `stores at most ${MAX_PAYLOAD_BYTES / 1024} KB per payload, and this payload is not a ` +
          `valid ${type} event); the debugger will drop it`,
      );
    } else {
      this.warner.warn(
        `payload-budget:${type}`,
        `an event of ${size} bytes was shrunk to a preview ` +
          `(the debugger stores at most ${MAX_PAYLOAD_BYTES / 1024} KB per payload)`,
      );
    }
    return serializeEnvelope(shrunkEnvelope);
  }

  /**
   * The ring buffer refused an envelope bigger than its whole byte budget
   * (`maxBufferBytes`) rather than evict every older event for it. With the
   * payload budget above this takes a `maxBufferBytes` configured below
   * ~512 KB to reach. Attached: send it live (it is not replayable, but it is
   * not lost). Detached: it is lost — counted in `stats().lost` and marked by
   * the next gap marker like any other loss — with one warning of its own.
   */
  private handleUnbuffered(item: BufferedEnvelope): void {
    const size = `${item.json.length} characters`;
    const limit = `maxBufferBytes is ${this.buffer.byteLimit}`;
    if (this.transport.attached && this.transport.send(item.json)) {
      item.sent = true;
      this.warner.warn(
        'buffer-oversize-sent',
        `an event of ${size} is larger than the whole replay buffer (${limit}); it was sent ` +
          `but not kept for replay`,
      );
      return;
    }
    this.recordEviction(item, false);
    this.warner.warn(
      'buffer-oversize-lost',
      `dropped an event of ${size}: it is larger than the whole replay buffer (${limit}) and ` +
        `the debugger is not attached; the recorded run is incomplete. Raise \`maxBufferBytes\``,
    );
  }

  /**
   * Held time is not run time. Track node instances as they start, pin gate
   * holds to them (see HeldLedger), and stamp the total onto `node.finished`
   * / `node.error` as the loose field `heldMs`. `durationMs` is left exactly
   * as the adapter measured it (wall clock, held time included); "ran" is
   * `durationMs - heldMs`. An adapter that already set `heldMs` wins. Pure
   * bookkeeping: any failure leaves the payload untouched.
   */
  private withHeldTime<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    runId: string,
  ): EventPayloadMap[T] {
    try {
      switch (type) {
        case 'node.started': {
          const p = payload as EventPayloadMap['node.started'];
          this.ledger.started(runId, p.nodeId, p.instanceId, p.parentId);
          return payload;
        }
        case 'node.error': {
          const p = payload as EventPayloadMap['node.error'];
          this.ledger.errored(runId, p.nodeId, p.instanceId);
          if (typeof p['heldMs'] === 'number') return payload;
          const heldMs = this.ledger.peek(runId, p.nodeId, p.instanceId);
          return heldMs === undefined ? payload : ({ ...p, heldMs } as EventPayloadMap[T]);
        }
        case 'node.finished': {
          const p = payload as EventPayloadMap['node.finished'];
          const heldMs = this.ledger.finished(runId, p.nodeId, p.instanceId);
          // Wire contract for every duration: finite, >= 0, 0.01 ms resolution
          // (adapters already comply; a raw `emit` is held to the same rule).
          const durationMs = normalizeDurationMs(p.durationMs);
          const out = durationMs === p.durationMs ? p : { ...p, durationMs };
          if (typeof p['heldMs'] === 'number' || heldMs === undefined) {
            return out as EventPayloadMap[T];
          }
          return { ...out, heldMs } as EventPayloadMap[T];
        }
        default:
          return payload;
      }
    } catch {
      return payload;
    }
  }

  /**
   * The ring buffer evicted an event. Two very different meanings:
   *  - it was already delivered  -> nothing happened; forget it.
   *  - it never left the process -> a hole in the recorded run. Remember the
   *    seq range so the next attach can mark it, and tell the developer.
   */
  private recordEviction(item: BufferedEnvelope, warn = true): void {
    if (item.sent) return;
    this.lostTotal += 1;
    const existing = this.pendingGaps.get(item.runId);
    if (existing !== undefined) {
      existing.droppedCount += 1;
      if (item.seq < existing.fromSeq) existing.fromSeq = item.seq;
      if (item.seq > existing.toSeq) existing.toSeq = item.seq;
    } else if (this.pendingGaps.size < MAX_TRACKED_GAP_RUNS) {
      this.pendingGaps.set(item.runId, {
        droppedCount: 1,
        fromSeq: item.seq,
        toSeq: item.seq,
      });
    } else {
      this.unattributedLost += 1;
    }
    // `warn = false`: the caller reports this loss with a warning of its own.
    if (warn) this.warnLoss();
  }

  /**
   * Requirement: loss must reach the developer even if the debugger never
   * comes back to carry a gap marker. Rate-limited per key, so a 3,000-event
   * overflow is one line, not 3,000.
   */
  private warnLoss(): void {
    const unattributed =
      this.unattributedLost > 0
        ? `; ${this.unattributedLost} of them spread past ${MAX_TRACKED_GAP_RUNS} runs and are ` +
          `counted but not marked`
        : '';
    this.warner.warn(
      'buffer-overflow',
      `dropped ${this.lostTotal} event${this.lostTotal === 1 ? '' : 's'} while the debugger ` +
        `was unreachable; the recorded run is incomplete. Raise \`bufferSize\` ` +
        `(currently ${this.buffer.capacity}) or reconnect the debugger sooner${unattributed}`,
    );
  }

  /**
   * Announce every hole punched while we were dark, one marker per affected
   * run, before the surviving buffer is replayed (the lost events are older
   * than everything still buffered).
   *
   * `packages/schema` has no `run.gap` type and is not ours to extend, so the
   * marker rides a real, valid `graph.hint` envelope — `nodes: []`, which
   * asserts nothing false about the graph — with the truth in a loose payload
   * field. Loose fields are the protocol's forward-compatibility contract
   * (see schema/primitives.ts) and already used this way elsewhere
   * (`ungated`, `injected`, `source`). The server stores it, `GET
   * /api/runs/:id/events` returns it, and a viewer can render the hole. See
   * the open issue asking for a first-class `run.gap` event.
   *
   * Gap markers are deliberately NOT buffered: if the send fails the record
   * goes back on the pending pile and the next attach tries again.
   */
  private flushGapMarkers(): void {
    if (this.pendingGaps.size === 0) return;
    const pending = [...this.pendingGaps];
    this.pendingGaps.clear();
    for (let i = 0; i < pending.length; i += 1) {
      const entry = pending[i];
      if (entry === undefined) continue;
      const [runId, gap] = entry;
      const payload = {
        nodes: [],
        gap: {
          droppedCount: gap.droppedCount,
          fromSeq: gap.fromSeq,
          toSeq: gap.toSeq,
          reason: 'buffer-overflow',
        },
      } satisfies EventPayloadMap['graph.hint'];
      const json = serializeEnvelope(
        createEnvelope<EventType>({ type: 'graph.hint', payload, seq: this.nextSeq(), runId }),
      );
      if (!this.transport.send(json)) {
        // Socket died mid-flush: keep this and every remaining record.
        for (let j = i; j < pending.length; j += 1) {
          const rest = pending[j];
          if (rest !== undefined) this.pendingGaps.set(rest[0], rest[1]);
        }
        return;
      }
    }
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private buildHello(): string {
    const payload: MessagePayloadMap['hello'] = {
      versions: { protocol: PROTOCOL_VERSION, client: CLIENT_VERSION },
      capabilities: [...KNOWN_CAPABILITIES],
      app: this.appName,
      sdk: this.sdk,
      // Echoing the token from the last `hello.ack` is what lets the debugger
      // recognise a reconnect as the SAME app, and so refuse writes to our
      // runs from any other local process. Absent on the first connection.
      ...(this.sessionToken === undefined ? {} : { resumeToken: this.sessionToken }),
    };
    return serializeEnvelope(
      createEnvelope({ type: 'hello', payload, seq: this.nextSeq(), runId: WILDCARD_RUN_ID }),
    );
  }

  private handleAttached(ack: MessagePayloadMap['hello.ack']): void {
    // Kept across reconnects on purpose (see buildHello). Only ever replaced,
    // never cleared on detach: the whole point is to survive the drop.
    if (typeof ack.sessionToken === 'string' && ack.sessionToken.length > 0) {
      this.sessionToken = ack.sessionToken;
    }
    this.guard('attach', () => {
      this.engine.arm(ack.breakpoints, ack.mode);
      // Holes first: what they describe is older than anything still buffered.
      this.flushGapMarkers();
      // Replay-on-attach: everything still in the ring buffer, oldest first.
      // Envelopes keep their original seq, so viewers deduplicate replays.
      for (const item of this.buffer.toArray()) {
        if (!this.transport.send(item.json)) break;
        item.sent = true;
      }
    });
    // After arming: a resolved `ready()` guarantees gates can already pause.
    this.settleReadyWaiters(true);
  }

  /** Resolve every pending `ready()` waiter (each self-removes). */
  private settleReadyWaiters(attached: boolean): void {
    for (const settle of [...this.readyWaiters]) {
      try {
        settle(attached);
      } catch {
        // never throw into transport callbacks
      }
    }
  }

  private handleDetached(): void {
    this.guard('detach', () => {
      // FAIL-OPEN: no debugger, no holds. Also forget its breakpoints/mode;
      // the next hello.ack re-arms them.
      this.engine.disarm();
      this.engine.releaseAll();
    });
  }

  private handleControl(envelope: KnownEnvelope): void {
    this.guard('control', () => {
      switch (envelope.type) {
        case 'exec.resume': {
          const { pauseId, action, output } = envelope.payload;
          this.engine.resume(pauseId, action as ResumeAction, output);
          break;
        }
        case 'breakpoint.set':
          this.engine.addBreakpoint(envelope.payload.matcher);
          break;
        case 'breakpoint.clear':
          this.engine.removeBreakpoint(envelope.payload.matcher);
          break;
        case 'mode.set':
          this.engine.setMode(envelope.payload.mode);
          break;
        default:
          // Events echoed back, duplicate handshakes, future additions: ignore.
          break;
      }
    });
  }
}

/**
 * Create a GraphMind session. Never throws; on catastrophic misconfiguration
 * it returns a permanently disabled session and warns once.
 */
export function createSession(options: SessionOptions = {}): Session {
  try {
    return new SessionImpl(options);
  } catch (error) {
    try {
      console.warn(
        `[graphmind] failed to create session; GraphMind is disabled (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    } catch {
      // ignore
    }
    return new SessionImpl({ ...options, enabled: false, bufferSize: 1, env: {} });
  }
}
