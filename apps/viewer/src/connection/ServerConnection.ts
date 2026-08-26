/**
 * The seam between the viewer and whatever is feeding it events. Two
 * implementations: the live `/ws/ui` socket (see protocol.ts for the wire
 * contract shared with the CLI server) and the bundled fixture replay.
 */
import {
  createEnvelope,
  WILDCARD_RUN_ID,
  type ControlType,
  type MessagePayloadMap,
} from '@graphmind/schema';
import type { RunSource } from '../store/types.js';

export interface ServerConnection {
  readonly source: RunSource;
  sendControl: <T extends ControlType>(type: T, payload: MessagePayloadMap[T], runId?: string) => void;
  /** Fixture replays support restarting from the top. */
  restart?: () => void;
}

/** Local seq for control envelopes — the server re-mints it anyway. */
let viewerSeq = 0;

/** A `control` frame wrapping one full schema control envelope. */
export function buildControlFrame<T extends ControlType>(
  type: T,
  payload: MessagePayloadMap[T],
  runId: string = WILDCARD_RUN_ID,
): string {
  return JSON.stringify({
    type: 'control',
    envelope: createEnvelope({ type, payload, seq: viewerSeq++, runId }),
  });
}

/** `subscribe` frame: a run id → replay-then-tail, `'*'` → run list mode. */
export function buildSubscribeFrame(runId: string = WILDCARD_RUN_ID): string {
  return JSON.stringify({ type: 'subscribe', runId });
}

export function buildUnsubscribeFrame(runId: string): string {
  return JSON.stringify({ type: 'unsubscribe', runId });
}

/** Resolve the websocket endpoint for this page. */
export function resolveServerUrl(search: string): string {
  const params = new URLSearchParams(search);
  const explicit = params.get('ws');
  if (explicit !== null && explicit !== '') return explicit;
  const server = params.get('server');
  if (server !== null && server !== '') return `ws://${server}/ws/ui`;
  const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);
  if (!isDev && typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    // Served by the CLI itself → same origin.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/ui`;
  }
  return 'ws://127.0.0.1:4747/ws/ui';
}

// ── control routing ────────────────────────────────────────────────────────
// Pause banners and the run bar don't care where a run came from; they look
// the sender up by the run's source.

const senders = new Map<RunSource, ServerConnection>();

export function getConnection(source: RunSource): ServerConnection | undefined {
  return senders.get(source);
}

export function registerConnection(conn: ServerConnection): () => void {
  senders.set(conn.source, conn);
  return () => {
    if (senders.get(conn.source) === conn) senders.delete(conn.source);
  };
}

export function sendControl<T extends ControlType>(
  source: RunSource,
  type: T,
  payload: MessagePayloadMap[T],
  runId?: string,
): void {
  const conn = senders.get(source);
  if (conn === undefined) {
    console.warn(`[graphmind] no ${source} connection to send ${type}`);
    return;
  }
  conn.sendControl(type, payload, runId);
}

/** Broadcast a control to every attached connection (mode, breakpoints). */
export function broadcastControl<T extends ControlType>(
  type: T,
  payload: MessagePayloadMap[T],
): void {
  for (const conn of senders.values()) conn.sendControl(type, payload);
}
