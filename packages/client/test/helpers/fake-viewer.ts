/**
 * Test double for the GraphMind viewer: a real WebSocket server that speaks
 * the wire protocol — receives `hello`, replies `hello.ack`, records every
 * event envelope, and can send control messages / crash abruptly.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type BreakpointMatcher,
  type ResumeAction,
  type RunMode,
} from '@graphmind-ai/schema';

export interface ReceivedFrame {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown> & { [key: string]: unknown };
}

export interface FakeViewerOptions {
  /** Breakpoints armed via hello.ack. Default: none. */
  breakpoints?: BreakpointMatcher[];
  /** Mode sent in hello.ack. Default: 'run'. */
  mode?: RunMode;
  /** Reply to hello automatically. Default: true. */
  autoAck?: boolean;
  /** Envelope `gm` used for everything this viewer sends. Default: 1. */
  gm?: number;
  /** `versions.protocol` inside hello.ack. Default: same as gm. */
  ackProtocol?: number;
  /**
   * `hubCapabilities` inside hello.ack (what a 0.6 debugger implements).
   * Default: absent, like a 0.5 debugger.
   */
  hubCapabilities?: string[] | undefined;
  /** Echo the app's own `capabilities` in hello.ack, as the real hub does. Default: a fixed list. */
  echoCapabilities?: boolean;
}

export class FakeViewer {
  readonly received: ReceivedFrame[] = [];
  connectionCount = 0;

  private readonly sockets = new Set<WebSocket>();
  private readonly waiters: { pred: (f: ReceivedFrame) => boolean; resolve: (f: ReceivedFrame) => void }[] = [];
  private seq = 0;

  private constructor(
    private readonly wss: WebSocketServer,
    readonly port: number,
    private readonly options: FakeViewerOptions,
  ) {}

  static async start(options: FakeViewerOptions = {}): Promise<FakeViewer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    const viewer = new FakeViewer(wss, (wss.address() as AddressInfo).port, options);
    wss.on('connection', (socket) => viewer.handleConnection(socket));
    return viewer;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ingest`;
  }

  ofType(type: string): ReceivedFrame[] {
    return this.received.filter((frame) => frame.type === type);
  }

  /** Resolve when a received frame matches (including already-received ones). */
  waitFor(pred: (frame: ReceivedFrame) => boolean, timeoutMs = 5000): Promise<ReceivedFrame> {
    const existing = this.received.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = { pred, resolve: (frame: ReceivedFrame) => { clearTimeout(timer); resolve(frame); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`fake viewer: timed out waiting for frame after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForType(type: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs);
  }

  sendControl(type: string, payload: unknown): void {
    const frame = JSON.stringify({
      gm: this.options.gm ?? PROTOCOL_VERSION,
      seq: this.seq++,
      ts: Date.now(),
      runId: '*',
      type,
      payload,
    });
    for (const socket of this.sockets) socket.send(frame);
  }

  /** Send a completely raw text frame (for malformed-input tests). */
  sendRaw(text: string): void {
    for (const socket of this.sockets) socket.send(text);
  }

  resume(pauseId: string, action: ResumeAction, output?: unknown): void {
    this.sendControl('exec.resume', {
      pauseId,
      action,
      ...(output !== undefined ? { output } : {}),
    });
  }

  /** What the next hello.ack says in `hubCapabilities` (undefined: omit it). */
  setHubCapabilities(capabilities: string[] | undefined): void {
    this.options.hubCapabilities = capabilities;
  }

  /** `exec.resume` with any payload fields (input, requestId, ...). */
  resumeWith(payload: { pauseId: string; action: ResumeAction; [key: string]: unknown }): void {
    this.sendControl('exec.resume', payload);
  }

  setBreakpoint(matcher: BreakpointMatcher): void {
    this.sendControl('breakpoint.set', { matcher });
  }

  clearBreakpoint(matcher: BreakpointMatcher): void {
    this.sendControl('breakpoint.clear', { matcher });
  }

  setMode(mode: RunMode): void {
    this.sendControl('mode.set', { mode });
  }

  /** Drop live connections but keep listening (client should retry+reattach). */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  /** Simulate a viewer crash: hard-kill sockets and the server. */
  killAbruptly(): void {
    for (const socket of this.sockets) socket.terminate();
    this.wss.close();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private handleConnection(socket: WebSocket): void {
    this.connectionCount += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as ReceivedFrame;
      this.received.push(frame);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter !== undefined && waiter.pred(frame)) {
          this.waiters.splice(i, 1);
          waiter.resolve(frame);
        }
      }
      if (frame.type === 'hello' && (this.options.autoAck ?? true)) {
        this.sendControl('hello.ack', {
          versions: {
            protocol: this.options.ackProtocol ?? this.options.gm ?? PROTOCOL_VERSION,
            viewer: 'fake-viewer/0.0.0',
          },
          capabilities: this.options.echoCapabilities === true
            ? frame.payload['capabilities']
            : ['pause', 'step', 'inject', 'retry', 'abort'],
          breakpoints: this.options.breakpoints ?? [],
          mode: this.options.mode ?? 'run',
          ...(this.options.hubCapabilities === undefined ? {} : { hubCapabilities: this.options.hubCapabilities }),
        });
      }
    });
  }
}

export const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `pred` is true (or fail after timeoutMs). */
export async function waitUntil(
  pred: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick(5);
  }
}
