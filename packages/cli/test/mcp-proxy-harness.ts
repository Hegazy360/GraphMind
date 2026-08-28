/**
 * Test rig for `graphmind mcp-proxy`.
 *
 *  - `FakeViewer`: a real WebSocket server speaking the GraphMind wire
 *    protocol (hello -> hello.ack, events in, control out). Same double the
 *    adapter suites use, so proxy runs are asserted against the real
 *    `@graphmind-ai/client` transport rather than a stub.
 *  - `ProxyRig`: the MCP client side of the pipe as plain streams, so a test
 *    can write exact bytes in and assert on the exact bytes out. That is what
 *    makes the byte-faithfulness assertions meaningful.
 *
 * The MCP *server* side is always a real child process (see
 * test/fixtures/mcp-proxy/), because the framing bugs this suite is guarding
 * against only exist across a real pipe.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type BreakpointMatcher,
  type ResumeAction,
  type RunMode,
} from '@graphmind-ai/schema';
import { startMcpProxy, type McpProxyHandle, type McpProxyOptions } from '../src/mcp-proxy/proxy.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/mcp-proxy/', import.meta.url));

export interface ReceivedFrame {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface FakeViewerOptions {
  breakpoints?: BreakpointMatcher[];
  mode?: RunMode;
  autoAck?: boolean;
}

/** The GraphMind end: a real ws server that speaks the ingest protocol. */
export class FakeViewer {
  readonly received: ReceivedFrame[] = [];
  connectionCount = 0;

  private readonly sockets = new Set<WebSocket>();
  private readonly waiters: {
    pred: (f: ReceivedFrame) => boolean;
    resolve: (f: ReceivedFrame) => void;
  }[] = [];
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

  /** Every node.started/finished/error for one logical node. */
  forNode(nodeId: string): ReceivedFrame[] {
    return this.received.filter((frame) => frame.payload['nodeId'] === nodeId);
  }

  waitFor(pred: (frame: ReceivedFrame) => boolean, timeoutMs = 8000): Promise<ReceivedFrame> {
    const existing = this.received.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (frame: ReceivedFrame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`fake viewer: timed out waiting for a frame after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForType(type: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs);
  }

  /** Wait for the pause on a specific node (gate tests). */
  waitForPause(nodeId: string, point?: string): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) =>
        frame.type === 'exec.paused' &&
        frame.payload['nodeId'] === nodeId &&
        (point === undefined || frame.payload['point'] === point),
    );
  }

  sendControl(type: string, payload: unknown): void {
    const frame = JSON.stringify({
      gm: PROTOCOL_VERSION,
      seq: this.seq++,
      ts: Date.now(),
      runId: '*',
      type,
      payload,
    });
    for (const socket of this.sockets) socket.send(frame);
  }

  resume(pauseId: string, action: ResumeAction, output?: unknown): void {
    this.sendControl('exec.resume', {
      pauseId,
      action,
      ...(output === undefined ? {} : { output }),
    });
  }

  setBreakpoint(matcher: BreakpointMatcher): void {
    this.sendControl('breakpoint.set', { matcher });
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
          versions: { protocol: PROTOCOL_VERSION, viewer: 'fake-viewer/0.0.0' },
          capabilities: ['pause', 'step', 'inject', 'retry', 'abort'],
          breakpoints: this.options.breakpoints ?? [],
          mode: this.options.mode ?? 'run',
        });
      }
    });
  }
}

export interface RigOptions extends Partial<Omit<McpProxyOptions, 'command' | 'args'>> {
  /** Fixture script name under test/fixtures/mcp-proxy/, or a full command. */
  server?: string;
  command?: string;
  args?: string[];
  /** Where to report to. Omit for the default (nothing listening = detached). */
  viewerUrl?: string;
}

/** The MCP-client end of the pipe, as raw streams. */
export class ProxyRig {
  readonly clientIn = new PassThrough();
  readonly clientOut = new PassThrough();
  readonly clientErr = new PassThrough();
  readonly outChunks: Buffer[] = [];
  readonly errChunks: Buffer[] = [];
  readonly logs: string[] = [];
  readonly handle: McpProxyHandle;

  private buffered = '';
  private readonly lines: string[] = [];
  private readonly lineWaiters: { pred: (line: string) => boolean; resolve: (line: string) => void }[] =
    [];

  constructor(options: RigOptions = {}) {
    this.clientOut.on('data', (chunk: Buffer) => {
      this.outChunks.push(Buffer.from(chunk));
      this.consume(chunk);
    });
    this.clientErr.on('data', (chunk: Buffer) => this.errChunks.push(Buffer.from(chunk)));

    const command = options.command ?? process.execPath;
    const args =
      options.args ?? (options.server === undefined ? [] : [`${FIXTURES}${options.server}`]);

    const {
      server: _server,
      viewerUrl,
      command: _command,
      args: _args,
      sessionOptions,
      ...rest
    } = options;
    this.handle = startMcpProxy({
      command,
      args,
      clientIn: this.clientIn,
      clientOut: this.clientOut,
      clientErr: this.clientErr,
      log: (line) => this.logs.push(line),
      sessionOptions: {
        // No viewer URL means "nothing is listening", which is the fail-open
        // case; tests that want a debugger pass the FakeViewer's url.
        url: viewerUrl ?? 'ws://127.0.0.1:1/ingest',
        connectTimeoutMs: 200,
        handshakeTimeoutMs: 500,
        // Detached rigs point at a dead port; don't busy-retry it.
        retryIntervalMs: 10_000,
        ...sessionOptions,
      },
      ...rest,
    });
  }

  /** Everything the MCP client saw on stdout, byte for byte. */
  get out(): Buffer {
    return Buffer.concat(this.outChunks);
  }

  /** Everything the MCP client saw on stderr, byte for byte. */
  get err(): Buffer {
    return Buffer.concat(this.errChunks);
  }

  /** Write a JSON-RPC message (adds the newline). */
  send(message: unknown): void {
    this.clientIn.write(`${JSON.stringify(message)}\n`);
  }

  /** Write exact bytes — for framing torture tests. */
  sendRaw(data: string | Buffer): void {
    this.clientIn.write(data);
  }

  request(id: string | number, method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  callTool(id: string | number, name: string, args: Record<string, unknown> = {}): void {
    this.request(id, 'tools/call', { name, arguments: args });
  }

  /** Close the client's side of the pipe (the client went away). */
  endClient(): void {
    this.clientIn.end();
  }

  /** Await a line the client received matching `pred`. */
  nextLine(pred: (line: string) => boolean = () => true, timeoutMs = 8000): Promise<string> {
    const index = this.lines.findIndex(pred);
    if (index !== -1) return Promise.resolve(this.lines.splice(index, 1)[0] as string);
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      const timer = setTimeout(() => {
        const at = this.lineWaiters.indexOf(waiter);
        if (at !== -1) this.lineWaiters.splice(at, 1);
        reject(new Error(`rig: timed out waiting for a client-visible line after ${timeoutMs}ms`));
      }, timeoutMs);
      this.lineWaiters.push(waiter);
    });
  }

  /** Await the response frame carrying `id`. */
  response(id: string | number): Promise<Record<string, unknown>> {
    return this.nextLine((line) => {
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        return parsed.id === id;
      } catch {
        return false;
      }
    }).then((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async finish(): Promise<number> {
    return await this.handle.done;
  }

  /** End the client, wait for the proxy to shut down, and return the exit code. */
  async close(): Promise<number> {
    this.endClient();
    return await this.handle.done;
  }

  private consume(chunk: Buffer): void {
    this.buffered += chunk.toString('utf8');
    for (;;) {
      const nl = this.buffered.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffered.slice(0, nl);
      this.buffered = this.buffered.slice(nl + 1);
      let taken = false;
      for (let i = 0; i < this.lineWaiters.length; i += 1) {
        const waiter = this.lineWaiters[i];
        if (waiter !== undefined && waiter.pred(line)) {
          this.lineWaiters.splice(i, 1);
          waiter.resolve(line);
          taken = true;
          break;
        }
      }
      if (!taken) this.lines.push(line);
    }
  }
}

export const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `pred` is true. The predicate may be async — awaiting it matters:
 * a returned promise is always truthy, so a non-awaiting version silently
 * succeeds on the first call and the test asserts against nothing.
 */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  label = 'condition',
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick(5);
  }
}
