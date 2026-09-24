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
 *  - The pause registry and the resume race (0.6.0, contract C3): which gates
 *    are held, first-writer-wins across every viewer socket and the HTTP
 *    endpoint, the credential/level check on each resume, and the `principal`
 *    stamped on the stored `exec.resumed`. See pause-registry.ts and
 *    control-auth.ts.
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
import { sanitizeShortText } from '@graphmind-ai/client';
import {
  DEFAULT_CONTROL_LEVEL,
  HUB_CAPABILITY_EDIT_INPUT,
  HUB_CAPABILITY_PAUSE_REGISTRY,
  acceptableRequestId,
  authorizeDebugState,
  authorizeResume,
  contentRefusal,
  sanitizeOperator,
  type ControlPolicy,
  type Principal,
} from './control-auth.js';
import { DebugState } from './debug-state.js';
import { printable } from './printable.js';
import {
  PauseRegistry,
  type PauseInfo,
  type ResumeOutcome,
  type ResumeOutcomeKind,
} from './pause-registry.js';
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
  /**
   * The agent token's `--allow-control` level and `--no-edit-input`.
   * Default: agent control `off`, input edits allowed (for credentials that
   * may edit).
   */
  control?: Partial<ControlPolicy>;
  /** See RESOLVING_TIMEOUT_MS (pause-registry.ts). Tests shorten it. */
  resolvingTimeoutMs?: number;
}

/** What `Hub.requestResume` says right away. */
export type ResumeStart =
  | { kind: 'forwarded'; requestId: string }
  | { kind: 'answered'; outcome: ResumeOutcome };

/** Top-level keys an app may never set on the exec.* events it stores. */
const HUB_STAMPED_KEYS = ['principal', 'operator'] as const;

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
  /** What the app announced in `hello.capabilities` (e.g. `edit-input`). */
  capabilities: ReadonlySet<string>;
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
  /** How the socket authenticated at the upgrade (server.ts). */
  readonly principal: Principal;
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
 * `principal` and `operator` on a stored `exec.*` event are the HUB's word
 * about who released a gate. An app writing them itself would be forging the
 * audit trail, so they are removed from whatever arrives on `/ingest`.
 */
function stripHubStamps(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (!HUB_STAMPED_KEYS.some((key) => Object.hasOwn(payload, key))) return payload;
  const copy: Record<string, unknown> = { ...payload };
  for (const key of HUB_STAMPED_KEYS) delete copy[key];
  return copy;
}

/** The client capability that says it echoes `exec.resume.requestId`. */
const CLIENT_CAPABILITY_REQUEST_ID = 'request-id';

/**
 * A client that echoes `exec.resume.requestId` on its answer — so its answer
 * without one was not an answer to anybody's resume (see PauseRegistry,
 * "Correlation"). It says so with `request-id`, whatever its edit kill switch
 * (GRAPHMIND_DISABLE_EDIT_INPUT drops only `edit-input` from its hello); a
 * client that announced `edit-input` speaks the 0.6 protocol, which echoes too.
 */
function echoesRequestIds(conn: IngestConn): boolean {
  return conn.capabilities.has(CLIENT_CAPABILITY_REQUEST_ID) || conn.capabilities.has(HUB_CAPABILITY_EDIT_INPUT);
}

/** HTTP-ish status for an outcome: used by the REST endpoint and in tests. */
export function outcomeStatus(outcome: ResumeOutcome): number {
  const byKind: Record<ResumeOutcomeKind, number> = {
    resumed: 200,
    refused: 422,
    taken: 409,
    timeout: 202,
    'no-such-pause': 404,
  };
  if (outcome.outcome === 'refused' && (outcome.code === 'forbidden' || outcome.code === 'edit-refused')) {
    return 403;
  }
  return byKind[outcome.outcome];
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
  /** The one-time deprecation note for tokenless viewer sockets was printed. */
  private warnedTokenless = false;
  readonly state: DebugState;
  /** Open and resolving pauses, and the resume requests racing for them. */
  readonly registry: PauseRegistry<IngestConn>;
  readonly control: ControlPolicy;

  /**
   * Every line the hub logs. App-written text (the app name, run and pause
   * ids) lands in these lines and `/ingest` needs no credential, so controls
   * and bidi characters are shown as `\uXXXX` rather than reaching the
   * operator's terminal.
   */
  private readonly log: LogFn;

  constructor(
    private readonly storage: Storage,
    log: LogFn,
    options: HubOptions = {},
  ) {
    this.log = (message) => log(printable(message));
    this.state = new DebugState(options.breakpoints);
    this.abandonGraceMs = Math.max(0, options.abandonGraceMs ?? DEFAULT_ABANDON_GRACE_MS);
    this.control = {
      agentLevel: options.control?.agentLevel ?? DEFAULT_CONTROL_LEVEL,
      editInput: options.control?.editInput ?? true,
    };
    this.registry = new PauseRegistry<IngestConn>({
      ...(options.resolvingTimeoutMs === undefined
        ? {}
        : { resolvingTimeoutMs: options.resolvingTimeoutMs }),
      log: (message) => this.throttledLog('pause-reopen', () => message),
    });
  }

  /** What this hub implements, for `hello.ack.hubCapabilities` (not an echo). */
  get hubCapabilities(): string[] {
    return this.control.editInput
      ? [HUB_CAPABILITY_PAUSE_REGISTRY, HUB_CAPABILITY_EDIT_INPUT]
      : [HUB_CAPABILITY_PAUSE_REGISTRY];
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
      capabilities: new Set(),
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
      conn.capabilities = new Set(hello.capabilities);
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
            hubCapabilities: this.hubCapabilities,
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
    // Who released a gate is the hub's word, never the app's (contract C3):
    // strip any `principal`/`operator` an app wrote on an exec.* event, then
    // stamp the credential of the resume that won this pause, if one did.
    let payload: unknown = envelope.payload;
    let restamped = false;
    if (envelope.type.startsWith('exec.')) {
      payload = stripHubStamps(payload);
      restamped = payload !== envelope.payload;
    }
    if (result.kind === 'ok' && result.envelope.type === 'exec.resumed' && isRecord(payload)) {
      const resumed = result.envelope.payload;
      const attribution = this.registry.attribution(
        envelope.runId,
        resumed.pauseId,
        resumed.requestId,
        echoesRequestIds(conn),
        resumed.action,
      );
      if (attribution !== undefined) {
        payload = {
          ...payload,
          principal: attribution.principal,
          ...(attribution.operator === undefined ? {} : { operator: attribution.operator }),
        };
        restamped = true;
      }
    }

    const stored = serializePayload(payload, undefined, envelope.type);
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
        this.registry.closeRun(envelope.runId);
      } else if (known.type === 'exec.paused') {
        // Only newly stored frames reach here, so a reconnect's replay of a
        // pause the hub already saw (same seq) never reopens or duplicates it.
        const p = known.payload;
        const opened = this.registry.open(conn, {
          runId: envelope.runId,
          pauseId: p.pauseId,
          nodeId: p.nodeId,
          point: p.point,
          since: envelope.ts,
          ...(p.reason === undefined ? {} : { reason: p.reason }),
          ...(p.smart === undefined ? {} : { smart: p.smart }),
          ...(p.loop === undefined ? {} : { loop: p.loop }),
          ...(p.editable === undefined ? {} : { editable: p.editable }),
          ...(conn.appName === undefined ? {} : { app: conn.appName }),
        });
        if (!opened) {
          this.throttledLog(
            'pause-cap',
            () =>
              `ingest: ${describeConn(conn)} holds too many open pauses; ` +
              `pause "${p.pauseId}" is not tracked (a resume for it is still forwarded)`,
          );
        }
      } else if (known.type === 'exec.resumed') {
        this.registry.resumed(
          envelope.runId,
          known.payload.pauseId,
          known.payload.requestId,
          echoesRequestIds(conn),
          known.payload.action,
        );
      } else if (known.type === 'exec.refused') {
        const p = known.payload;
        // Relayed to a terminal and a viewer: no control or bidi characters.
        this.registry.refused(envelope.runId, p.pauseId, p.requestId, p.code, sanitizeShortText(p.message));
      }
    }
    // Run-list watchers hear about new runs and lifecycle changes.
    if (ownerChanged || envelope.type === 'run.started' || envelope.type === 'run.finished') {
      this.pushRunUpdate(envelope.runId);
    }

    this.fanout(stored.truncated || restamped ? { ...envelope, payload: stored.payload } : envelope);
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
      if (this.runClaims.size >= MAX_RUN_CLAIMS && !this.evictClaimFor(conn)) {
        this.throttledLog(
          'ingest-claim-cap',
          () =>
            `ingest: refusing a frame for new run "${runId}" from ${describeConn(conn)} — ` +
            `${MAX_RUN_CLAIMS} runs are live on other connections`,
        );
        return false;
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

  /**
   * Make room for one more claim. Never a run another CONNECTED app owns —
   * evicting it would let whoever writes next take over that live run and
   * its pauses. The oldest claim of a run nobody holds goes first, then the
   * oldest of `conn`'s own. False when every claim is another app's live run.
   */
  private evictClaimFor(conn: IngestConn): boolean {
    let own: string | undefined;
    for (const runId of this.runClaims.keys()) {
      const owner = this.runOwners.get(runId);
      if (owner === undefined) {
        this.runClaims.delete(runId);
        return true;
      }
      if (owner === conn && own === undefined) own = runId;
    }
    if (own === undefined) return false;
    this.runClaims.delete(own);
    return true;
  }

  private removeIngest(conn: IngestConn): void {
    if (!this.ingestConns.delete(conn)) return;
    // Its client released every gate on detach (fail-open), but can only say
    // so after a reconnect that may never come: close them here.
    this.registry.closeOwner(conn);
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
      if (this.storage.markRunAbandoned(runId, Date.now())) {
        this.pushRunUpdate(runId);
        // A long-poll scoped to this run (`graphmind wait --run`) re-checks
        // whether it ended; nothing in the registry changed to wake it.
        this.registry.touch();
      }
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
    if (reconciled.length > 0) this.registry.touch();
    return reconciled;
  }

  /** Drop pending reconciliation timers. Called when the server closes. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.abandonTimers.values()) clearTimeout(timer);
    this.abandonTimers.clear();
    this.registry.dispose();
  }

  // -- UI side --------------------------------------------------------------

  /**
   * `principal` is decided at the upgrade (server.ts): `viewer` or `agent`
   * for a valid credential, `anonymous` for none. An invalid credential never
   * gets this far.
   */
  addUiSocket(ws: WebSocket, principal: Principal = 'anonymous'): void {
    const conn: UiConn = { ws, alive: true, subs: new Set(), principal };
    this.uiConns.add(conn);
    if (principal === 'anonymous' && !this.warnedTokenless) {
      this.warnedTokenless = true;
      this.log(
        'ui: a viewer connected without a credential. Tokenless viewer sockets are deprecated: ' +
          'they can still continue, retry and abort, but never inject, edit inputs, or change ' +
          'breakpoints or step mode. Open the viewer from the #token= link or the redirect file ' +
          '`graphmind serve` prints.',
      );
    }
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
      control: {
        principal,
        agentLevel: this.control.agentLevel,
        editInput: this.control.editInput,
        hubCapabilities: this.hubCapabilities,
      },
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
        const start = this.requestResume(known.runId, known.payload, conn.principal);
        if (start.kind === 'answered') {
          const { outcome } = start;
          // `requestId` only when it is the resumer's own (a minted one would
          // match nothing on its side), so the viewer's argument editor can
          // tell "the hub refused MY edit" from any other resume's answer.
          const echoed = acceptableRequestId(known.payload.requestId) && outcome.requestId === known.payload.requestId;
          this.sendToUi(conn, {
            type: 'error',
            runId: known.runId,
            message: outcome.message ?? outcome.outcome,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            pauseId: outcome.pauseId,
            outcome: outcome.outcome,
            ...(echoed ? { requestId: outcome.requestId } : {}),
          });
          return;
        }
        // The app's answer (or its absence) comes back to this socket too:
        // the run's events say WHAT happened, this says it answered THIS
        // resume — which an operator racing another one needs to know.
        this.registry.whenAnswered(start.requestId, (outcome) => {
          this.sendToUi(conn, {
            type: 'resume.result',
            runId: outcome.runId,
            pauseId: outcome.pauseId,
            requestId: outcome.requestId,
            outcome: outcome.outcome,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            ...(outcome.message === undefined ? {} : { message: outcome.message }),
          });
        });
        return;
      }
      case 'breakpoint.set':
      case 'breakpoint.clear':
      case 'mode.set': {
        const refusal = authorizeDebugState(conn.principal, this.control);
        if (refusal !== undefined) {
          this.sendToUi(conn, { type: 'error', code: refusal.code, message: refusal.message });
          // The viewer toggles optimistically: tell it what is really armed.
          this.sendToUi(conn, this.stateFrame());
          return;
        }
        if (known.type === 'breakpoint.set') {
          this.state.set(known.payload.matcher);
          this.relayToAllIngest('breakpoint.set', known.payload);
        } else if (known.type === 'breakpoint.clear') {
          this.state.clear(known.payload.matcher);
          this.relayToAllIngest('breakpoint.clear', known.payload);
        } else {
          this.state.mode = known.payload.mode;
          this.relayToAllIngest('mode.set', known.payload);
        }
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

  // -- the resume race (contract C3) -----------------------------------------

  /**
   * One resume, from any surface (a viewer socket, `POST .../resume`). In
   * order: the credential and its level; the content (no placeholder, no
   * truncation marker); the edit gates (`--no-edit-input`, the owner's
   * `edit-input`, the pause's `editable`); then the registry — first writer
   * wins — and the forward, whose delivery is checked. Anything refused
   * before the forward is answered right away and nothing reaches the app.
   */
  requestResume(
    runId: string,
    payload: MessagePayloadMap['exec.resume'],
    principal: Principal,
    deadlineMs?: number,
  ): ResumeStart {
    const { pauseId, action } = payload;
    const hasInput = Object.hasOwn(payload, 'input');
    const given = acceptableRequestId(payload.requestId) ? payload.requestId : undefined;
    const answered = (outcome: ResumeOutcomeKind, code: string, message: string): ResumeStart => ({
      kind: 'answered',
      outcome: { outcome, runId, pauseId, requestId: given ?? randomUUID(), code, message },
    });

    const denied = authorizeResume(principal, this.control, action, hasInput);
    if (denied !== undefined) return answered('refused', denied.code, denied.message);

    // Content guard (W7's inject guard, widened to edits and to truncation
    // markers): a value still carrying the redaction placeholder or a shrink
    // marker is the RECORDING pre-filled into an editor, not something anyone
    // meant to run. Checked before ownership, so an unowned run gets this
    // answer rather than a routing one.
    const content =
      (hasInput ? contentRefusal(payload.input, 'input') : undefined) ??
      (action === 'inject' ? contentRefusal(payload.output, 'output') : undefined);
    if (content !== undefined) return answered('refused', content.code, content.message);

    if (hasInput && !this.control.editInput) {
      return answered(
        'refused',
        'edit-refused',
        'input edits are disabled on this server (started with --no-edit-input)',
      );
    }

    const known = this.registry.get(runId, pauseId);
    if (known === undefined && this.registry.isKnownClosed(runId, pauseId)) {
      return answered(
        'no-such-pause',
        'no-such-pause',
        `pause "${pauseId}" in run "${runId}" is no longer held`,
      );
    }
    if (known?.state === 'resolving') {
      if (!this.registry.resolvingUnanswered(runId, pauseId)) {
        // The resume it is resolving on was already answered `timeout` (a
        // short --timeout gave up) and the app has still not answered it.
        // Nobody took the pause; it is just not answered yet — and it reopens
        // on its own if the app never answers.
        return answered(
          'timeout',
          'still-resolving',
          'the app has not answered an earlier resume of this pause yet; it reopens within ' +
            `${Math.round(this.registry.resolvingTimeoutMs / 1000)} s if the app never does — run it again then`,
        );
      }
      return answered('taken', 'pause-taken', 'another resume for this pause is already being answered');
    }
    const owner = this.registry.ownerOf(runId, pauseId) ?? this.runOwners.get(runId);
    if (owner === undefined || !owner.attached) {
      return answered('no-such-pause', 'no-owner', `no connected app owns run "${runId}"`);
    }
    if (hasInput) {
      // The credential is fine here; the target cannot take an edit. A
      // distinct code (422, CLI exit 6) so nobody raises --allow-control for it.
      if (!owner.capabilities.has(HUB_CAPABILITY_EDIT_INPUT)) {
        return answered(
          'refused',
          'not-editable',
          'the app holding this pause did not announce edit-input (its SDK cannot apply an edited input)',
        );
      }
      if (known === undefined || known.editable !== true) {
        return answered(
          'refused',
          'not-editable',
          'this pause is not editable (the adapter cannot apply an edited input at this gate)',
        );
      }
    }

    const begun = this.registry.begin({
      runId,
      pauseId,
      principal,
      operator: sanitizeOperator((payload as Record<string, unknown>)['operator']),
      requestId: given,
      owner,
      action,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    if (begun.kind === 'taken') {
      return answered('taken', 'pause-taken', 'another resume for this pause is already being answered');
    }
    if (begun.kind === 'closed') {
      return answered(
        'no-such-pause',
        'no-such-pause',
        `pause "${pauseId}" in run "${runId}" is no longer held`,
      );
    }

    // Only the fields this hub understands go on: an unknown field (0.5 hubs
    // relayed `inputPatch` unguarded) is not forwarded, and `output` travels
    // only with `inject`, the one action it means anything for.
    const forwarded: MessagePayloadMap['exec.resume'] = {
      pauseId,
      action,
      requestId: begun.requestId,
      ...(action === 'inject' && Object.hasOwn(payload, 'output') ? { output: payload.output } : {}),
      ...(hasInput ? { input: payload.input } : {}),
    };
    const sent = this.sendToIngest(
      owner,
      createEnvelope({ type: 'exec.resume', runId, seq: owner.seq++, payload: forwarded }),
      (error) => {
        this.registry.abort(begun.requestId, {
          outcome: 'timeout',
          code: 'send-failed',
          message: `the resume could not be delivered to the app (${error.message})`,
        });
      },
    );
    if (!sent) {
      // The same answer as a disconnect a moment after the send (closeOwner):
      // one condition, one outcome, whatever the timing.
      const outcome: ResumeOutcome = {
        outcome: 'timeout',
        runId,
        pauseId,
        requestId: begun.requestId,
        code: 'app-disconnected',
        message: 'the app holding this pause is disconnecting; a detached app releases its gates on its own (fail-open)',
      };
      this.registry.abort(begun.requestId, outcome);
      return { kind: 'answered', outcome };
    }
    if (hasInput) {
      // Values never go to the log; the fact of an edit does.
      this.log(`edit: ${principal} resumed pause "${pauseId}" in run "${runId}" with an edited input`);
    }
    return { kind: 'forwarded', requestId: begun.requestId };
  }

  /** Open and resolving pauses (for `GET /api/pauses`). */
  listPauses(runId?: string): PauseInfo[] {
    return this.registry.list(runId);
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

  private stateFrame(): UiServerMessage {
    return { type: 'state', breakpoints: this.state.breakpoints, mode: this.state.mode };
  }

  private broadcastState(): void {
    const message = this.stateFrame();
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

  /**
   * True when the frame was handed to the socket. A socket that is closing
   * silently drops a send, which is exactly how a resume could leave a pause
   * `resolving` forever — so the caller that cares (the resume race) checks,
   * and hears about a late write error through `onError`.
   */
  private sendToIngest<T extends MessageType>(
    conn: IngestConn,
    envelope: Envelope<T>,
    onError?: (error: Error) => void,
  ): boolean {
    if (conn.ws.readyState !== WS_OPEN) return false;
    try {
      conn.ws.send(
        serializeEnvelope(envelope),
        onError === undefined
          ? undefined
          : (error) => {
              if (error !== undefined && error !== null) onError(error);
            },
      );
      return true;
    } catch (error) {
      this.log(`ingest: failed to send frame (${String(error)})`);
      return false;
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
