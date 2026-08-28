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
  PROTOCOL_VERSION,
  WILDCARD_RUN_ID,
  createEnvelope,
  serializeEnvelope,
  type EventPayloadMap,
  type EventType,
  type KnownEnvelope,
  type MessagePayloadMap,
  type PausePoint,
  type ResumeAction,
  type RunStatus,
  type SdkInfo,
} from '@graphmind-ai/schema';
import { resolveEnabled, resolveUrl, type EnvLike } from './env.js';
import { GraphMindAbortError, isAbortError, toErrorInfo } from './errors.js';
import {
  CONTINUE_DECISION,
  GateEngine,
  type GateDecision,
  type GateNode,
} from './gate-engine.js';
import { makeCounterIds, newId } from './ids.js';
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
    });

    this.engine = new GateEngine(
      {
        newPauseId: this.newPauseId,
        onPaused: (pauseId, node, point, runId) => {
          this.emitInternal('exec.paused', { pauseId, nodeId: node.nodeId, point }, runId);
        },
        onResumed: (pauseId, _node, action, runId) => {
          this.emitInternal('exec.resumed', { pauseId, action }, runId);
        },
      },
      options.pauseTimeoutMs,
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
      this.emitInternal(type, payload, this.resolveRunId());
    });
  }

  gate(point: PausePoint, node: GateNode): Promise<GateDecision> {
    if (!this.active()) return CONTINUE_PROMISE;
    try {
      this.ensureStarted();
      // Fast path: detached, or attached with nothing matching.
      if (!this.transport.attached || !this.engine.shouldPause(point, node)) {
        return CONTINUE_PROMISE;
      }
      const ctx = this.currentRun();
      const runId = this.resolveRunId();
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

  /** Envelope + buffer + (if attached) send. No enable/guard checks here. */
  private emitInternal<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    runId: string,
  ): void {
    const seq = this.nextSeq();
    const json = serializeEnvelope(
      // Instantiated at the EventType union: TS cannot relate the generic
      // indexed accesses EventPayloadMap[T] / MessagePayloadMap[T] directly.
      createEnvelope<EventType>({ type, payload, seq, runId }),
    );
    const item: BufferedEnvelope = { json, seq, runId, sent: false };
    this.buffer.push(item);
    if (this.transport.attached && this.transport.send(json)) item.sent = true;
  }

  /**
   * The ring buffer evicted an event. Two very different meanings:
   *  - it was already delivered  -> nothing happened; forget it.
   *  - it never left the process -> a hole in the recorded run. Remember the
   *    seq range so the next attach can mark it, and tell the developer.
   */
  private recordEviction(item: BufferedEnvelope): void {
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
    this.warnLoss();
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
