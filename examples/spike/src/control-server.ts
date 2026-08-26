/**
 * The "fake debugger": a tiny WS control server. On connect it arms the
 * scenario's breakpoints; on every exec.paused event it runs the scripted
 * handler, which typically calls ctl.resume(pauseId, action).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { AgentToDebugger, DebuggerToAgent, ResumeAction } from './protocol.js';
import type { Trace } from './trace.js';

export type PausedEvent = Extract<AgentToDebugger, { type: 'exec.paused' }>;

export interface DebuggerController {
  port: number;
  resume(pauseId: string, action: ResumeAction): void;
  /** Simulates a debugger crash: hard-kill every socket and the server. */
  killAbruptly(): void;
  close(): Promise<void>;
}

export interface DebuggerScript {
  breakpoints: string[];
  onPaused?: (msg: PausedEvent, ctl: DebuggerController) => void | Promise<void>;
}

export async function startFakeDebugger(
  script: DebuggerScript,
  trace: Trace,
): Promise<DebuggerController> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  let socket: WebSocket | undefined;
  const send = (msg: DebuggerToAgent) => socket?.send(JSON.stringify(msg));

  const ctl: DebuggerController = {
    port,
    resume(pauseId, action) {
      trace.mark('ctl:resume-sent', { pauseId, action: action.type });
      send({ type: 'exec.resume', pauseId, action });
    },
    killAbruptly() {
      trace.mark('ctl:kill');
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const client of wss.clients) client.close();
        wss.close(() => resolve());
      }),
  };

  wss.on('connection', ws => {
    socket = ws;
    send({ type: 'bp.set', breakpoints: script.breakpoints });
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as AgentToDebugger;
      if (msg.type === 'exec.paused') {
        trace.mark('ctl:paused-received', {
          pauseId: msg.pauseId,
          point: msg.point,
          toolName: msg.node.toolName,
          stepIndex: msg.node.stepIndex,
        });
        void script.onPaused?.(msg, ctl);
      }
    });
  });

  return ctl;
}
