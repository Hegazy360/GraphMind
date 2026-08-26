/**
 * Test doubles: a fake instrumented app (raw `ws` speaking schema envelopes,
 * like @graphmind/client would) and a fake viewer speaking the UI
 * subprotocol. Both queue incoming messages for predicate-based awaiting.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
  type MessagePayloadMap,
  type MessageType,
} from '@graphmind/schema';
import WebSocket from 'ws';
import { startServer, type GraphMindServer, type ServerOptions } from '../src/server.js';
import type { UiServerMessage, WireEnvelope } from '../src/ui-protocol.js';

export class MessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: {
    predicate: (item: T) => boolean;
    resolve: (item: T) => void;
  }[] = [];

  push(item: T): void {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (waiter !== undefined && waiter.predicate(item)) {
        this.waiters.splice(i, 1);
        waiter.resolve(item);
        return;
      }
    }
    this.items.push(item);
  }

  /** Await (and consume) the first item matching `predicate`. */
  next(predicate: (item: T) => boolean = () => true, timeoutMs = 3000, label = 'message'): Promise<T> {
    const index = this.items.findIndex(predicate);
    if (index !== -1) {
      const [item] = this.items.splice(index, 1);
      return Promise.resolve(item as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = { predicate, resolve: (item: T) => {
        clearTimeout(timer);
        resolve(item);
      } };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Everything received so far (without consuming). */
  peekAll(): T[] {
    return [...this.items];
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }
}

/** Await `open`. Listeners must already be attached — frames can arrive in
 * the same tick as `open`, so construct the fake (which subscribes to
 * `message`) BEFORE awaiting this. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

/** A fake instrumented app on `WS /ingest`. */
export class FakeApp {
  seq = 0;
  ack: MessagePayloadMap['hello.ack'] | undefined;
  readonly received = new MessageQueue<WireEnvelope>();
  readonly closed: Promise<void>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const result = parseEnvelopeJson(String(data));
      if (result.kind === 'ok' || result.kind === 'unknown-type') {
        this.received.push(result.envelope as WireEnvelope);
      }
    });
    this.closed = new Promise((resolve) => ws.once('close', () => resolve()));
  }

  /** Connect + `hello` -> `hello.ack` handshake (unless `handshake: false`). */
  static async connect(
    port: number,
    opts: { app?: string; capabilities?: string[]; handshake?: boolean } = {},
  ): Promise<FakeApp> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
    const app = new FakeApp(ws);
    await opened(ws);
    if (opts.handshake === false) return app;
    app.send('hello', '*', {
      versions: { protocol: 1, client: 'test-0.0.0' },
      capabilities: opts.capabilities ?? ['pause', 'step'],
      ...(opts.app === undefined ? {} : { app: opts.app }),
    });
    const ackEnvelope = await app.received.next((e) => e.type === 'hello.ack', 3000, 'hello.ack');
    app.ack = ackEnvelope.payload as MessagePayloadMap['hello.ack'];
    return app;
  }

  /** Send a typed envelope. Returns the seq used (auto-assigned by default). */
  send<T extends MessageType>(
    type: T,
    runId: string,
    payload: MessagePayloadMap[T],
    seq?: number,
  ): number {
    const used = seq ?? this.seq++;
    this.ws.send(serializeEnvelope(createEnvelope({ type, runId, payload, seq: used })));
    return used;
  }

  /** Send an arbitrary JSON frame (unknown types, malformed data, ...). */
  sendRaw(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  nextControl(
    predicate: (e: WireEnvelope) => boolean = () => true,
    label = 'control envelope',
  ): Promise<WireEnvelope> {
    return this.received.next(predicate, 3000, label);
  }

  close(): Promise<void> {
    return closeSocket(this.ws);
  }
}

/** A fake viewer on `WS /ws/ui`. */
export class FakeUI {
  readonly received = new MessageQueue<UiServerMessage>();
  welcome: Extract<UiServerMessage, { type: 'welcome' }> | undefined;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.received.push(JSON.parse(String(data)) as UiServerMessage);
    });
  }

  static async connect(port: number): Promise<FakeUI> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`);
    const ui = new FakeUI(ws);
    await opened(ws);
    ui.welcome = (await ui.received.next(
      (m) => m.type === 'welcome',
      3000,
      'welcome',
    )) as Extract<UiServerMessage, { type: 'welcome' }>;
    return ui;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  subscribe(runId: string): void {
    this.send({ type: 'subscribe', runId });
  }

  control<T extends MessageType>(type: T, runId: string, payload: MessagePayloadMap[T], seq = 0): void {
    this.send({ type: 'control', envelope: createEnvelope({ type, runId, payload, seq }) });
  }

  next(
    predicate: (m: UiServerMessage) => boolean = () => true,
    label = 'ui message',
  ): Promise<UiServerMessage> {
    return this.received.next(predicate, 3000, label);
  }

  close(): Promise<void> {
    return closeSocket(this.ws);
  }
}

export interface TestServer {
  server: GraphMindServer;
  port: number;
  dir: string;
  dbPath: string;
  cleanup(): Promise<void>;
}

/** Ephemeral port, tmp-dir DB, silent logs. */
export async function startTestServer(options: ServerOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-cli-test-'));
  const dbPath = join(dir, 'graphmind.db');
  const server = await startServer({
    port: 0,
    dbPath,
    log: () => {},
    viewerDist: join(dir, 'no-viewer-here'),
    ...options,
  });
  return {
    server,
    port: server.port,
    dir,
    dbPath,
    async cleanup() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function fetchJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

/** Poll until `probe` returns true (ingest is async relative to the test). */
export async function waitUntil(
  probe: () => Promise<boolean> | boolean,
  label = 'condition',
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
