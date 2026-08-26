/**
 * The hub wires everything together: app (ingest) sockets, viewer (UI)
 * sockets, persistent storage, and the server-held debug state.
 *
 * Responsibilities:
 *  - `hello` -> `hello.ack` handshake (ack carries current breakpoints+mode).
 *  - Persist every run-scoped envelope (unknown types included, stored
 *    opaquely) with `(runId, seq)` dedup; fan live events out to subscribers.
 *  - Track which ingest socket owns which runId so `exec.resume` routes back
 *    to the right app.
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
  type Envelope,
  type MessagePayloadMap,
  type MessageType,
} from '@graphmind/schema';
import type { WebSocket } from 'ws';
import { DebugState } from './debug-state.js';
import type { RunSource, Storage, StoredEvent } from './storage.js';
import type { RunInfo, UiServerMessage, WireEnvelope } from './ui-protocol.js';
import { VERSION } from './version.js';

export type LogFn = (message: string) => void;

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
  /** runId -> viewers tailing it. (WILDCARD subscribers are found via subs.) */
  private readonly runSubs = new Map<string, Set<UiConn>>();
  readonly state = new DebugState();

  constructor(
    private readonly storage: Storage,
    private readonly log: LogFn,
  ) {}

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
    };
    this.ingestConns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = rawToText(data);
      if (text !== undefined) this.handleIngestFrame(conn, text);
    });
    ws.on('close', () => this.removeIngest(conn));
    ws.on('error', () => {
      /* 'close' always follows */
    });
  }

  private handleIngestFrame(conn: IngestConn, text: string): void {
    const result = parseEnvelopeJson(text);
    if (result.kind === 'invalid') {
      this.log(`ingest: dropping invalid frame (${result.reason})`);
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
    // re-claim the run when they replay their buffer).
    const previousOwner = this.runOwners.get(envelope.runId);
    const ownerChanged = previousOwner !== conn;
    if (ownerChanged) {
      previousOwner?.ownedRuns.delete(envelope.runId);
      this.runOwners.set(envelope.runId, conn);
      conn.ownedRuns.add(envelope.runId);
    }

    this.storage.ensureRun({
      id: envelope.runId,
      app: conn.appName ?? 'unknown',
      startedAt: envelope.ts,
      schemaVersion: envelope.gm,
      source: conn.runSource,
    });

    const inserted = this.storage.insertEvent({
      runId: envelope.runId,
      seq: envelope.seq,
      ts: envelope.ts,
      type: envelope.type,
      nodeId: extractNodeId(envelope.payload),
      payload: envelope.payload,
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

    this.fanout(envelope);
  }

  private removeIngest(conn: IngestConn): void {
    if (!this.ingestConns.delete(conn)) return;
    for (const runId of conn.ownedRuns) {
      if (this.runOwners.get(runId) === conn) {
        this.runOwners.delete(runId);
        this.pushRunUpdate(runId);
      }
    }
    conn.ownedRuns.clear();
    if (conn.attached) {
      this.log(`app detached${conn.appName === undefined ? '' : `: ${conn.appName}`}`);
    }
  }

  // -- UI side --------------------------------------------------------------

  addUiSocket(ws: WebSocket): void {
    const conn: UiConn = { ws, alive: true, subs: new Set() };
    this.uiConns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
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
    return this.storage.listRuns().map((run) => ({ ...run, live: this.runOwners.has(run.id) }));
  }

  getRunInfo(id: string): RunInfo | undefined {
    const run = this.storage.getRun(id);
    return run === undefined ? undefined : { ...run, live: this.runOwners.has(id) };
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
