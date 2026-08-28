/**
 * The hub wires everything together: app (ingest) sockets, viewer (UI)
 * sockets, persistent storage, and the server-held debug state.
 *
 * Responsibilities:
 *  - `hello` -> `hello.ack` handshake (ack carries current breakpoints+mode).
 *  - Persist every run-scoped envelope (unknown types included, stored
 *    opaquely) with `(runId, seq)` dedup; fan live events out to subscribers.
 *  - Track which ingest socket owns which runId so `exec.resume` routes back
 *    to the right app — and reconcile a run to a terminal `abandoned` state
 *    when that socket goes away without a `run.finished`.
 *  - Replay-then-tail for UI subscriptions (race-free: storage is
 *    synchronous, so the whole subscribe handler runs in one tick).
 *  - ws-level ping/pong bookkeeping so the server can reap stale sockets.
 */
import {
  PROTOCOL_VERSION,
  WILDCARD_RUN_ID,
  createEnvelope,
  isControlType,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
  type BreakpointMatcher,
  type Envelope,
  type MessagePayloadMap,
  type MessageType,
} from '@graphmind-ai/schema';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { DebugState } from './debug-state.js';
import {
  serializePayload,
  type RunSource,
  type RunSummary,
  type Storage,
  type StoredEvent,
} from './storage.js';
import type { RunInfo, UiServerMessage, WireEnvelope } from './ui-protocol.js';
import { VERSION } from './version.js';

export type LogFn = (message: string) => void;

/**
 * How long a run keeps its `running` status after its owning ingest socket
 * drops, before the server calls it abandoned.
 *
 * Sized against the client transport: it retries at 200/400/800ms after an
 * established attachment drops and then settles on a 10s interval, so 15s
 * covers even the slow path. A blip therefore never marks a live run dead —
 * the reconnect re-claims the run and cancels the timer.
 */
export const DEFAULT_ABANDON_GRACE_MS = 15_000;

/** How many run claims to remember. Oldest are evicted first. */
const MAX_RUN_CLAIMS = 5_000;

/** Longest `resumeToken` accepted from a client (ours are 32 hex chars). */
const MAX_RESUME_TOKEN_LENGTH = 128;

/** Minimum gap between two identical log lines. See `Hub.throttledLog`. */
const LOG_THROTTLE_MS = 1_000;

export interface HubOptions {
  /** Breakpoints a fresh debug session arms. Default: `{point:'error'}`. */
  breakpoints?: readonly BreakpointMatcher[];
  /** See DEFAULT_ABANDON_GRACE_MS. 0 reconciles on the next tick (tests). */
  abandonGraceMs?: number;
}

interface IngestConn {
  readonly ws: WebSocket;
  alive: boolean;
  /** True once `hello` was received and `hello.ack` sent. */
  attached: boolean;
  /** Server->app envelope sequence counter (per connection). */
  seq: number;
  appName: string | undefined;
  /**
   * How runs from this connection are registered. `'live'` for real apps;
   * `'demo'` when the `hello` payload carries `source: 'demo'` (the CLI's
   * bundled demo replayer announces itself that way).
   */
  runSource: RunSource;
  readonly ownedRuns: Set<string>;
  /**
   * This connection's identity for run claims. Minted on `hello` and handed
   * back in `hello.ack`; a reconnecting client echoes it so it re-claims its
   * own runs. Empty until `hello`.
   */
  claimToken: string;
  /**
   * The client announced the `run-claim` capability, i.e. it echoes its token
   * on reconnect. Claims made by such a connection are enforced even after it
   * disconnects; claims by older clients are only enforced while connected,
   * because an old client cannot prove continuity across a reconnect.
   */
  claimAware: boolean;
}

/** Who is allowed to write to a run. See `Hub.checkClaim`. */
interface RunClaim {
  token: string;
  /** The claimant announced `run-claim`, so the claim outlives its socket. */
  strict: boolean;
}

interface UiConn {
  readonly ws: WebSocket;
  alive: boolean;
  /** Subscribed run ids; may contain WILDCARD_RUN_ID for run-list updates. */
  readonly subs: Set<string>;
}

const WS_OPEN = 1;

function rawToText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractNodeId(payload: unknown): string | null {
  if (isRecord(payload) && typeof payload['nodeId'] === 'string') return payload['nodeId'];
  return null;
}

/**
 * A stored run row as `GET /api/runs` (and the UI socket) serve it.
 *
 * `durationMs` is derived here rather than carried on the wire: the row
 * already has both timestamps, and every consumer was otherwise subtracting
 * envelope timestamps by hand. `null` while the run is in flight. Clamped at
 * zero because `startedAt` is rewritten by `run.started` and a machine whose
 * clock steps backwards must not produce a negative duration.
 */
function toRunInfo(run: RunSummary, live: boolean): RunInfo {
  return {
    ...run,
    live,
    durationMs: run.finishedAt === null ? null : Math.max(0, run.finishedAt - run.startedAt),
  };
}

/** How an ingest connection is named in a log line. */
function describeConn(conn: IngestConn): string {
  return conn.appName === undefined ? 'an unnamed app' : `app "${conn.appName}"`;
}

function toWireEnvelope(event: StoredEvent): WireEnvelope {
  return {
    gm: PROTOCOL_VERSION,
    seq: event.seq,
    ts: event.ts,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
  };
}

export class Hub {
  private readonly ingestConns = new Set<IngestConn>();
  private readonly uiConns = new Set<UiConn>();
  private readonly runOwners = new Map<string, IngestConn>();
  /**
   * runId -> who may write to it. Outlives the connection so a reconnect can
   * prove it is the same client. Insertion-ordered and capped: a claim is
   * ~100 bytes and only the newest MAX_RUN_CLAIMS runs can be re-claimed,
   * which is far beyond any real local session.
   */
  private readonly runClaims = new Map<string, RunClaim>();
  /** Rate-limiting state for `throttledLog`, keyed by message kind. */
  private readonly logThrottle = new Map<string, { last: number; suppressed: number }>();
  /** runId -> viewers tailing it. (WILDCARD subscribers are found via subs.) */
  private readonly runSubs = new Map<string, Set<UiConn>>();
  /** runId -> pending "mark abandoned" timer armed by a disconnect. */
  private readonly abandonTimers = new Map<string, NodeJS.Timeout>();
  private readonly abandonGraceMs: number;
  private disposed = false;
  readonly state: DebugState;

  constructor(
    private readonly storage: Storage,
    private readonly log: LogFn,
    options: HubOptions = {},
  ) {
    this.state = new DebugState(options.breakpoints);
    this.abandonGraceMs = Math.max(0, options.abandonGraceMs ?? DEFAULT_ABANDON_GRACE_MS);
  }

  // -- ingest side ----------------------------------------------------------

  addIngestSocket(ws: WebSocket): void {
    const conn: IngestConn = {
      ws,
      alive: true,
      attached: false,
      seq: 0,
      appName: undefined,
      runSource: 'live',
      ownedRuns: new Set(),
      claimToken: '',
      claimAware: false,
    };
    this.ingestConns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      // Any inbound frame proves the peer is alive, not just a pong. A pong
      // sits BEHIND that peer's own frames in the same TCP stream, so a busy
      // app was being terminated by the reaper precisely because the server
      // was busy reading from it — dropping everything in flight silently.
      conn.alive = true;
      if (isBinary) return;
      const text = rawToText(data);
      if (text !== undefined) this.handleIngestFrame(conn, text);
    });
    ws.on('close', () => this.removeIngest(conn));
    ws.on('error', () => {
      /* 'close' always follows */
    });
  }

  /**
   * Log at most one line per key per window, with a count of what was
   * swallowed. `graphmind serve` writes its log synchronously to the
   * operator's TTY, so an unthrottled per-frame line lets a peer sending
   * garbage at line rate turn the server into a blocking writer — and buries
   * everything the operator actually needs to read.
   */
  private throttledLog(key: string, message: () => string): void {
    const now = Date.now();
    const entry = this.logThrottle.get(key);
    if (entry !== undefined && now - entry.last < LOG_THROTTLE_MS) {
      entry.suppressed += 1;
      return;
    }
    const suppressed = entry?.suppressed ?? 0;
    this.logThrottle.set(key, { last: now, suppressed: 0 });
    this.log(suppressed === 0 ? message() : `${message()} (+${suppressed} more)`);
  }

  private handleIngestFrame(conn: IngestConn, text: string): void {
    const result = parseEnvelopeJson(text);
    if (result.kind === 'invalid') {
      this.throttledLog(
        'ingest-invalid',
        () => `ingest: dropping invalid frame (${result.reason})`,
      );
      return;
    }
    if (result.kind === 'version-mismatch') {
      this.log(
        `ingest: app speaks protocol v${result.received}, this server speaks v${result.supported}; closing`,
      );
      conn.ws.close(1002, `unsupported protocol version ${result.received}`);
      return;
    }

    // Handshake: the first (and only meaningful) pre-attach frame is `hello`.
    if (result.kind === 'ok' && result.envelope.type === 'hello') {
      const hello = result.envelope.payload;
      conn.attached = true;
      if (typeof hello.app === 'string') conn.appName = hello.app;
      // Loose-schema extension: the bundled demo replayer marks itself so its
      // runs are registered (and badged in the viewer) as recorded sessions.
      if ((hello as Record<string, unknown>)['source'] === 'demo') conn.runSource = 'demo';
      conn.claimAware = hello.capabilities.includes('run-claim');
      // A client that echoes its previous token keeps the same identity, so
      // the runs it was streaming before the socket dropped are still its
      // own. Anything else gets a fresh identity — including a made-up token,
      // which simply will not match any existing claim.
      const presented = (hello as Record<string, unknown>)['resumeToken'];
      conn.claimToken =
        typeof presented === 'string' &&
        presented.length > 0 &&
        presented.length <= MAX_RESUME_TOKEN_LENGTH
          ? presented
          : randomUUID().replaceAll('-', '');
      this.sendToIngest(
        conn,
        createEnvelope({
          type: 'hello.ack',
          runId: WILDCARD_RUN_ID,
          seq: conn.seq++,
          payload: {
            versions: { protocol: PROTOCOL_VERSION, viewer: VERSION },
            capabilities: hello.capabilities,
            breakpoints: this.state.breakpoints,
            mode: this.state.mode,
            sessionToken: conn.claimToken,
          },
        }),
      );
      this.log(`app attached${conn.appName === undefined ? '' : `: ${conn.appName}`}`);
      return;
    }
    if (!conn.attached) return; // anything else before `hello` is ignored

    const envelope: WireEnvelope = result.envelope;
    if (envelope.runId === WILDCARD_RUN_ID) return; // nothing run-scoped to store
    // Apps emit events; control/ack types coming *from* an app are dropped.
    if (isControlType(envelope.type) || envelope.type === 'hello.ack') return;

    // Ownership: the most recent socket streaming a run owns it (reconnects
    // re-claim the run when they replay their buffer) — but only if this
    // connection is entitled to the run at all.
    if (!this.checkClaim(conn, envelope.runId)) return;

    const previousOwner = this.runOwners.get(envelope.runId);
    const ownerChanged = previousOwner !== conn;
    if (ownerChanged) {
      previousOwner?.ownedRuns.delete(envelope.runId);
      this.runOwners.set(envelope.runId, conn);
      conn.ownedRuns.add(envelope.runId);
      // A run may legitimately span a reconnect (the client replays its
      // buffer and keeps going), so re-claiming a run cancels any pending
      // reconciliation and un-marks one that already landed. Guarded inside
      // storage on `status = 'abandoned'`, so this can never revive a run
      // that genuinely finished.
      this.cancelAbandon(envelope.runId);
      this.storage.markRunResumed(envelope.runId);
    }

    this.storage.ensureRun({
      id: envelope.runId,
      app: conn.appName ?? 'unknown',
      startedAt: envelope.ts,
      schemaVersion: envelope.gm,
      source: conn.runSource,
    });

    // Apply the payload guard HERE, so the fan-out relays exactly what storage
    // keeps. Doing it only inside storage meant a 32MB tool result was still
    // pushed in full to every attached viewer (server RSS 95MB -> 303MB in the
    // soak repro), and a live view then disagreed with the same run on reload.
    //
    // `serializePayload` is idempotent, so storage re-applying it to the value
    // below is a no-op; the cost is one extra `JSON.stringify` of an
    // already-in-budget payload, measured at 0.29µs/event (~0.6% of one core
    // at 20k events/s) — cheap enough to prefer over widening the Storage
    // interface just to hand the JSON down.
    const stored = serializePayload(envelope.payload);
    const inserted = this.storage.insertEvent({
      runId: envelope.runId,
      seq: envelope.seq,
      ts: envelope.ts,
      // Denormalized from the ORIGINAL payload: `nodeId` is an index column,
      // and it must survive even when the payload itself could not be trimmed.
      nodeId: extractNodeId(envelope.payload),
      type: envelope.type,
      payload: stored.payload,
    });
    if (!inserted) {
      // Duplicate `(runId, seq)` — a replayed envelope (decisions.md #5).
      // Ownership was still re-claimed above; nothing else to do.
      if (ownerChanged) this.pushRunUpdate(envelope.runId);
      return;
    }

    if (result.kind === 'ok') {
      const known = result.envelope;
      if (known.type === 'run.started') {
        const app = typeof known.payload.app === 'string' ? known.payload.app : undefined;
        this.storage.markRunStarted(
          envelope.runId,
          app ?? conn.appName ?? 'unknown',
          envelope.ts,
        );
      } else if (known.type === 'run.finished') {
        this.storage.markRunFinished(envelope.runId, known.payload.status, envelope.ts);
      }
    }
    // Run-list watchers hear about new runs and lifecycle changes.
    if (ownerChanged || envelope.type === 'run.started' || envelope.type === 'run.finished') {
      this.pushRunUpdate(envelope.runId);
    }

    this.fanout(stored.truncated ? { ...envelope, payload: stored.payload } : envelope);
  }

  /**
   * May this connection write to this run?
   *
   * `/ingest` is not a log sink. It decides which process an `exec.resume` is
   * delivered to, and therefore which process gets to keep running — so
   * "last writer owns the run" meant any local process could name another's
   * run once and thereafter receive its resumes (with whatever value the
   * operator injected), fabricate nodes inside it, wedge its gate forever, or
   * mark it finished. It could also pre-claim low `seq` numbers and have the
   * real app's events silently dropped by the `(runId, seq)` dedup.
   *
   * A run is therefore claimed by the token that first wrote to it:
   *
   *  - same token                  -> allowed (this is the reconnect path)
   *  - different token, claimant still connected -> refused, always
   *  - different token, claimant gone, claim is `strict`  -> refused
   *  - different token, claimant gone, claim is not strict -> allowed
   *
   * The last case is the compatibility seam. A client older than the
   * `run-claim` capability cannot echo a token, so after a reconnect it
   * cannot prove it is the same client — refusing it would break reconnect
   * for every pinned 0.3.x SDK. Such clients keep today's behaviour in that
   * one window, and are protected the rest of the time. Current clients are
   * protected unconditionally.
   */
  private checkClaim(conn: IngestConn, runId: string): boolean {
    const claim = this.runClaims.get(runId);
    if (claim === undefined) {
      if (this.runClaims.size >= MAX_RUN_CLAIMS) {
        const oldest = this.runClaims.keys().next();
        if (!oldest.done) this.runClaims.delete(oldest.value);
      }
      this.runClaims.set(runId, { token: conn.claimToken, strict: conn.claimAware });
      return true;
    }
    if (claim.token === conn.claimToken) return true;

    const claimantConnected = this.runOwners.has(runId);
    if (claim.strict || claimantConnected) {
      this.throttledLog(
        'ingest-claim',
        () =>
          `ingest: refusing a frame for run "${runId}" from ${describeConn(conn)} — ` +
          'that run belongs to another connection',
      );
      return false;
    }
    // Legacy takeover. Say so: it is the one path where identity is assumed
    // rather than proven, and an operator seeing this unexpectedly is seeing
    // either a stale SDK or something worth looking at.
    this.throttledLog(
      'ingest-claim-takeover',
      () =>
        `ingest: run "${runId}" re-claimed by ${describeConn(conn)}, which cannot prove it is ` +
        'the original app (SDK predates the run-claim capability); upgrade to remove this window',
    );
    this.runClaims.set(runId, { token: conn.claimToken, strict: conn.claimAware });
    return true;
  }

  private removeIngest(conn: IngestConn): void {
    if (!this.ingestConns.delete(conn)) return;
    for (const runId of conn.ownedRuns) {
      if (this.runOwners.get(runId) === conn) {
        this.runOwners.delete(runId);
        this.pushRunUpdate(runId);
        this.scheduleAbandon(runId);
      }
    }
    conn.ownedRuns.clear();
    if (conn.attached) {
      this.log(`app detached${conn.appName === undefined ? '' : `: ${conn.appName}`}`);
    }
  }

  // -- orphan reconciliation ------------------------------------------------

  /**
   * The owning connection is gone. After the grace period — long enough for
   * the client's reconnect burst — a run that never sent `run.finished` is
   * reconciled to `abandoned`, so the runs list cannot fill up with rows that
   * claim to be in flight forever.
   *
   * Re-armed on every disconnect, so a run that reconnects and dies again is
   * reconciled again rather than reverting to a phantom.
   */
  private scheduleAbandon(runId: string): void {
    this.cancelAbandon(runId);
    if (this.disposed) return;
    const reconcile = (): void => {
      this.abandonTimers.delete(runId);
      if (this.runOwners.has(runId)) return; // re-claimed in the meantime
      if (this.storage.markRunAbandoned(runId, Date.now())) this.pushRunUpdate(runId);
    };
    // Always deferred, even at grace 0: `removeIngest` runs inside a socket
    // 'close' handler and a reconnecting client can be mid-handshake.
    const timer = setTimeout(reconcile, this.abandonGraceMs);
    // Never keep the process alive for housekeeping; the HTTP server holds
    // the loop open for as long as this matters.
    timer.unref?.();
    this.abandonTimers.set(runId, timer);
  }

  private cancelAbandon(runId: string): void {
    const timer = this.abandonTimers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.abandonTimers.delete(runId);
  }

  /**
   * Reconcile runs left `running` by a *previous* server process. Nothing can
   * still be streaming them — this process has never seen their apps — so
   * without this sweep they stay in-flight forever across restarts, and
   * retention refuses to prune them (it protects unfinished runs on purpose).
   *
   * Runs this process already owns are skipped, so a second server sharing
   * the same database file cannot kill a live run.
   */
  reconcileOrphanedRuns(): string[] {
    const now = Date.now();
    const reconciled: string[] = [];
    for (const runId of this.storage.listRunningRunIds()) {
      if (this.runOwners.has(runId)) continue;
      if (this.storage.markRunAbandoned(runId, now)) reconciled.push(runId);
    }
    for (const runId of reconciled) this.pushRunUpdate(runId);
    return reconciled;
  }

  /** Drop pending reconciliation timers. Called when the server closes. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.abandonTimers.values()) clearTimeout(timer);
    this.abandonTimers.clear();
  }

  // -- UI side --------------------------------------------------------------

  addUiSocket(ws: WebSocket): void {
    const conn: UiConn = { ws, alive: true, subs: new Set() };
    this.uiConns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      conn.alive = true; // see the ingest socket: reading bytes proves liveness
      if (isBinary) return;
      const text = rawToText(data);
      if (text !== undefined) this.handleUiFrame(conn, text);
    });
    ws.on('close', () => this.removeUi(conn));
    ws.on('error', () => {
      /* 'close' always follows */
    });
    this.sendToUi(conn, {
      type: 'welcome',
      versions: { protocol: PROTOCOL_VERSION, server: VERSION },
      breakpoints: this.state.breakpoints,
      mode: this.state.mode,
    });
  }

  private handleUiFrame(conn: UiConn, text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.sendToUi(conn, { type: 'error', message: 'frame is not valid JSON' });
      return;
    }
    if (!isRecord(message) || typeof message['type'] !== 'string') {
      this.sendToUi(conn, { type: 'error', message: 'message must be an object with a "type"' });
      return;
    }
    switch (message['type']) {
      case 'subscribe':
        this.handleSubscribe(conn, message['runId']);
        return;
      case 'unsubscribe':
        this.handleUnsubscribe(conn, message['runId']);
        return;
      case 'control':
        this.handleControl(conn, message['envelope']);
        return;
      default:
        this.sendToUi(conn, {
          type: 'error',
          message: `unknown message type "${message['type']}"`,
        });
    }
  }

  private handleSubscribe(conn: UiConn, runId: unknown): void {
    if (typeof runId !== 'string' || runId === '') {
      this.sendToUi(conn, { type: 'error', message: 'subscribe requires a string "runId"' });
      return;
    }
    if (runId === WILDCARD_RUN_ID) {
      conn.subs.add(runId);
      this.sendToUi(conn, { type: 'runs', runs: this.listRunInfos() });
      return;
    }
    // Already tailing it: acknowledge without replaying. A viewer that
    // re-subscribes to a run it is already on wants the tail it already has,
    // and replaying a 2,000-event run once per repeated frame is a free
    // amplifier for anything that can open the UI socket.
    if (conn.subs.has(runId)) {
      this.sendToUi(conn, { type: 'replay.start', runId, count: 0 });
      this.sendToUi(conn, { type: 'replay.end', runId });
      return;
    }
    // Replay-then-tail. Storage reads are synchronous, so no live event can
    // interleave between the replay below and adding the live subscription.
    const page = this.storage.listEvents(runId);
    this.sendToUi(conn, { type: 'replay.start', runId, count: page.events.length });
    for (const event of page.events) {
      this.sendToUi(conn, { type: 'event', runId, envelope: toWireEnvelope(event) });
    }
    this.sendToUi(conn, { type: 'replay.end', runId });
    conn.subs.add(runId);
    let subs = this.runSubs.get(runId);
    if (subs === undefined) {
      subs = new Set();
      this.runSubs.set(runId, subs);
    }
    subs.add(conn);
  }

  private handleUnsubscribe(conn: UiConn, runId: unknown): void {
    if (typeof runId !== 'string') return;
    conn.subs.delete(runId);
    const subs = this.runSubs.get(runId);
    if (subs !== undefined) {
      subs.delete(conn);
      if (subs.size === 0) this.runSubs.delete(runId);
    }
  }

  private handleControl(conn: UiConn, envelope: unknown): void {
    const result = parseEnvelope(envelope);
    if (result.kind !== 'ok') {
      const detail = result.kind === 'invalid' ? `: ${result.reason}` : ` (${result.kind})`;
      this.sendToUi(conn, { type: 'error', message: `invalid control envelope${detail}` });
      return;
    }
    const known = result.envelope;
    switch (known.type) {
      case 'exec.resume': {
        const owner = this.runOwners.get(known.runId);
        if (owner === undefined || !owner.attached) {
          this.sendToUi(conn, {
            type: 'error',
            runId: known.runId,
            message: `no connected app owns run "${known.runId}"`,
          });
          return;
        }
        this.sendToIngest(
          owner,
          createEnvelope({
            type: 'exec.resume',
            runId: known.runId,
            seq: owner.seq++,
            payload: known.payload,
          }),
        );
        return;
      }
      case 'breakpoint.set': {
        this.state.set(known.payload.matcher);
        this.relayToAllIngest('breakpoint.set', known.payload);
        this.broadcastState();
        return;
      }
      case 'breakpoint.clear': {
        this.state.clear(known.payload.matcher);
        this.relayToAllIngest('breakpoint.clear', known.payload);
        this.broadcastState();
        return;
      }
      case 'mode.set': {
        this.state.mode = known.payload.mode;
        this.relayToAllIngest('mode.set', known.payload);
        this.broadcastState();
        return;
      }
      default:
        this.sendToUi(conn, {
          type: 'error',
          message: `"${known.type}" is not a control type`,
        });
    }
  }

  private removeUi(conn: UiConn): void {
    if (!this.uiConns.delete(conn)) return;
    for (const runId of conn.subs) {
      const subs = this.runSubs.get(runId);
      if (subs !== undefined) {
        subs.delete(conn);
        if (subs.size === 0) this.runSubs.delete(runId);
      }
    }
    conn.subs.clear();
  }

  // -- shared ---------------------------------------------------------------

  listRunInfos(): RunInfo[] {
    return this.storage.listRuns().map((run) => toRunInfo(run, this.runOwners.has(run.id)));
  }

  getRunInfo(id: string): RunInfo | undefined {
    const run = this.storage.getRun(id);
    return run === undefined ? undefined : toRunInfo(run, this.runOwners.has(id));
  }

  /** Ping every socket; terminate those that missed the previous ping. */
  pingAll(): void {
    for (const conn of [...this.ingestConns, ...this.uiConns]) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  /** Politely close every socket, terminating stragglers after `graceMs`. */
  async closeAll(graceMs: number): Promise<void> {
    const sockets = [...this.ingestConns, ...this.uiConns].map((c) => c.ws);
    if (sockets.length === 0) return;
    const allClosed = Promise.all(
      sockets.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === ws.CLOSED) return resolve();
            ws.once('close', () => resolve());
          }),
      ),
    );
    for (const ws of sockets) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        ws.terminate();
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    await Promise.race([allClosed, grace]);
    if (timer !== undefined) clearTimeout(timer);
    for (const ws of sockets) {
      if (ws.readyState !== ws.CLOSED) ws.terminate();
    }
  }

  private fanout(envelope: WireEnvelope): void {
    const subs = this.runSubs.get(envelope.runId);
    if (subs === undefined) return;
    for (const conn of subs) {
      this.sendToUi(conn, { type: 'event', runId: envelope.runId, envelope });
    }
  }

  private pushRunUpdate(runId: string): void {
    const run = this.getRunInfo(runId);
    if (run === undefined) return;
    for (const conn of this.uiConns) {
      if (conn.subs.has(WILDCARD_RUN_ID)) this.sendToUi(conn, { type: 'run.update', run });
    }
  }

  private broadcastState(): void {
    const message: UiServerMessage = {
      type: 'state',
      breakpoints: this.state.breakpoints,
      mode: this.state.mode,
    };
    for (const conn of this.uiConns) this.sendToUi(conn, message);
  }

  private relayToAllIngest<T extends 'breakpoint.set' | 'breakpoint.clear' | 'mode.set'>(
    type: T,
    payload: MessagePayloadMap[T],
  ): void {
    for (const conn of this.ingestConns) {
      if (!conn.attached) continue;
      this.sendToIngest(
        conn,
        createEnvelope<T>({ type, payload, runId: WILDCARD_RUN_ID, seq: conn.seq++ }),
      );
    }
  }

  private sendToIngest<T extends MessageType>(conn: IngestConn, envelope: Envelope<T>): void {
    if (conn.ws.readyState !== WS_OPEN) return;
    try {
      conn.ws.send(serializeEnvelope(envelope));
    } catch (error) {
      this.log(`ingest: failed to send frame (${String(error)})`);
    }
  }

  private sendToUi(conn: UiConn, message: UiServerMessage): void {
    if (conn.ws.readyState !== WS_OPEN) return;
    try {
      conn.ws.send(JSON.stringify(message));
    } catch (error) {
      this.log(`ui: failed to send frame (${String(error)})`);
    }
  }
}
