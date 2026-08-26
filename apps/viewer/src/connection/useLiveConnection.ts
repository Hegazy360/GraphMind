/**
 * The live `/ws/ui` path: useWebSocketWithRetry (ported from the legacy
 * client) speaking the CLI server's frame protocol (see protocol.ts).
 *
 * Strategy: subscribe `'*'` for the run list, then auto-subscribe every run
 * the server announces — each subscription replays history (deduped on
 * `(runId, seq)`) and then tails live events.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  PROTOCOL_VERSION,
  WILDCARD_RUN_ID,
  type ControlType,
  type MessagePayloadMap,
} from '@graphmind-ai/schema';
import useWebSocketWithRetry from '../hooks/useWebSocketWithRetry.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { ingestValue } from './ingest.js';
import type { RunInfo, UiServerFrame } from './protocol.js';
import {
  buildControlFrame,
  buildSubscribeFrame,
  registerConnection,
  type ServerConnection,
} from './ServerConnection.js';

/** Adopt the server's authoritative debug state (mode + breakpoints). */
function applyDebugState(frame: { breakpoints?: unknown; mode?: unknown }): void {
  const ui = useUiStore.getState();
  if (frame.mode === 'run' || frame.mode === 'step') ui.setMode(frame.mode);
  if (Array.isArray(frame.breakpoints)) {
    useUiStore.setState({ breakpoints: frame.breakpoints as typeof ui.breakpoints });
  }
}

export function useLiveConnection(url: string | null): ServerConnection {
  const ws = useWebSocketWithRetry(url, {
    onStatus: (status) => {
      if (url === null) return;
      useUiStore
        .getState()
        .setConnection(status === 'open' ? 'live' : status === 'connecting' ? 'connecting' : 'detached');
    },
  });
  const wsRef = useRef<WebSocket | null>(null);
  wsRef.current = ws;

  useEffect(() => {
    if (ws === null) return;
    const subscribed = new Set<string>();
    const subscribeRun = (runId: string) => {
      if (subscribed.has(runId) || ws.readyState !== WebSocket.OPEN) return;
      subscribed.add(runId);
      ws.send(buildSubscribeFrame(runId));
    };
    const noteRun = (info: RunInfo) => {
      useRunStore.getState().noteRunInfo(info, 'live');
      subscribeRun(info.id);
    };

    ws.send(buildSubscribeFrame(WILDCARD_RUN_ID));

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: UiServerFrame;
      try {
        frame = JSON.parse(event.data) as UiServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'welcome':
          if (frame.versions.protocol !== PROTOCOL_VERSION) {
            console.warn(
              `[graphmind] server speaks protocol v${frame.versions.protocol}, viewer v${PROTOCOL_VERSION}`,
            );
          }
          applyDebugState(frame);
          break;
        case 'state':
          applyDebugState(frame);
          break;
        case 'runs':
          for (const info of frame.runs) noteRun(info);
          break;
        case 'run.update':
          noteRun(frame.run);
          break;
        case 'event':
          ingestValue(frame.envelope, 'live');
          break;
        case 'replay.start':
        case 'replay.end':
          break; // dedup on (runId, seq) makes replay idempotent
        case 'error':
          console.warn('[graphmind] server error:', frame.message);
          break;
        default:
          break; // unknown frame types are ignored gracefully
      }
    };
    ws.addEventListener('message', onMessage);
    return () => ws.removeEventListener('message', onMessage);
  }, [ws]);

  const connection = useMemo<ServerConnection>(
    () => ({
      source: 'live',
      sendControl: <T extends ControlType>(
        type: T,
        payload: MessagePayloadMap[T],
        runId?: string,
      ) => {
        const socket = wsRef.current;
        if (socket === null || socket.readyState !== WebSocket.OPEN) {
          console.warn(`[graphmind] not connected; dropped ${type}`);
          return;
        }
        socket.send(buildControlFrame(type, payload, runId));
      },
    }),
    [],
  );

  useEffect(() => {
    if (url === null) return;
    return registerConnection(connection);
  }, [connection, url]);

  return connection;
}
