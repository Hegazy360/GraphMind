/**
 * The protocol-boundary harness: a real GraphMind server plus raw sockets
 * that can put *anything* on the wire.
 *
 * Everything else in this package drives GraphMind the way a well-behaved app
 * does — through the SDK, which can only produce well-formed envelopes. That
 * is the wrong tool for asking what a hostile or broken peer can do, because
 * the interesting frames are exactly the ones the SDK will never emit.
 *
 * So: `RawIngest` and `RawViewer` send TEXT. No schema, no client, no
 * serializer between the test and the socket. A test can send a truncated
 * JSON document, a 90 MB frame, a lone surrogate, a `__proto__` key, or an
 * envelope claiming another process's run — and then ask what the server did
 * with it.
 *
 * The invariants every fuzz test in this package asserts against that:
 *
 *   1. the server process never crashes and never wedges (`alive()`),
 *   2. one bad frame never kills the connection it arrived on,
 *   3. a bad frame never touches an unrelated run,
 *   4. every event that reaches storage is still an envelope the viewer's own
 *      `parseEnvelope` accepts.
 *
 * Nothing here is mocked: `startServer` is the shipped `graphmind serve`
 * pipeline, over a throwaway SQLite file on an ephemeral port.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, WILDCARD_RUN_ID } from '@graphmind-ai/schema';
import { startServer, type GraphMindServer } from 'graphmind-ai';

/** The wire envelope, as a plain object a test can deliberately deform. */
export interface WireFrame {
  gm?: unknown;
  seq?: unknown;
  ts?: unknown;
  runId?: unknown;
  type?: unknown;
  payload?: unknown;
  [extra: string]: unknown;
}

export interface WireServerOptions {
  /** Stale-socket ping interval. Small values make reaping observable. */
  pingIntervalMs?: number;
  /** Grace before a run whose app vanished is marked `abandoned`. */
  abandonGraceMs?: number;
  /**
   * `'off'` disarms the default pause-on-error breakpoint (decisions.md #8).
   *
   * Needed by any test that makes an instrumented app throw on purpose: with
   * the default armed, the app holds at the error gate until a debugger
   * resumes it, and a test with no viewer attached simply hangs.
   */
  pauseOnError?: string;
}

/**
 * A running server plus the log lines it produced.
 *
 * The log is captured rather than discarded because "how much does the
 * server say about a bad frame" is itself an attack surface: `graphmind
 * serve` logs to a TTY, and a synchronous write per hostile frame is a way
 * to spend the operator's event loop.
 */
export class WireServer {
  private closed = false;

  private constructor(
    readonly server: GraphMindServer,
    /** Every line the server has logged, live. */
    readonly logs: string[],
    private readonly dir: string,
  ) {}

  static async boot(options: WireServerOptions = {}): Promise<WireServer> {
    const dir = mkdtempSync(join(tmpdir(), 'graphmind-wire-'));
    const logs: string[] = [];
    const server = await startServer({
      port: 0,
      dbPath: join(dir, 'graphmind.db'),
      openBrowser: false,
      log: (line: string) => {
        logs.push(line);
      },
      env: { GRAPHMIND_RETENTION: 'off', GRAPHMIND_TELEMETRY: '0' },
      ...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
      ...(options.abandonGraceMs === undefined ? {} : { abandonGraceMs: options.abandonGraceMs }),
      ...(options.pauseOnError === undefined ? {} : { pauseOnError: options.pauseOnError }),
    });
    return new WireServer(server, logs, dir);
  }

  get port(): number {
    return this.server.port;
  }

  get url(): string {
    return this.server.url;
  }

  get ingestUrl(): string {
    return `ws://127.0.0.1:${this.server.port}/ingest`;
  }

  get uiUrl(): string {
    return `ws://127.0.0.1:${this.server.port}/ws/ui`;
  }

  /** Snapshot of the lines the server has logged so far. */
  logLines(): string[] {
    return [...this.logs];
  }

  /**
   * Liveness AND responsiveness: `/health` answers within `timeoutMs`.
   * A server that is up but has its event loop pinned fails this, which is
   * the failure mode a flood is supposed to cause and must not.
   */
  async alive(timeoutMs = 5_000): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async runs(): Promise<
    { id: string; app: string; status: string; eventCount: number; startedAt: number }[]
  > {
    const response = await fetch(`${this.url}/api/runs`);
    const body = (await response.json()) as {
      runs: { id: string; app: string; status: string; eventCount: number; startedAt: number }[];
    };
    return body.runs;
  }

  /**
   * Every stored envelope of one run, exactly as the REST API serves it.
   *
   * Paginated, because `GET /api/runs/:id/events` caps a page at 5,000 and a
   * flood test that only read the first page would silently measure the cap
   * instead of the server.
   */
  async events(runId: string): Promise<WireFrame[]> {
    const out: WireFrame[] = [];
    let afterSeq = -1;
    for (;;) {
      const response = await fetch(
        `${this.url}/api/runs/${encodeURIComponent(runId)}/events?limit=5000&afterSeq=${afterSeq}`,
      );
      if (!response.ok) return out;
      const body = (await response.json()) as {
        events: WireFrame[];
        nextAfterSeq: number | null;
      };
      out.push(...body.events);
      if (body.nextAfterSeq === null) return out;
      afterSeq = body.nextAfterSeq;
    }
  }

  /** How many events a run has, without transferring them. */
  async eventCount(runId: string): Promise<number> {
    const response = await fetch(
      `${this.url}/api/runs/${encodeURIComponent(runId)}/events?limit=1`,
    );
    if (!response.ok) return 0;
    const body = (await response.json()) as { total: number };
    return body.total;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const OPEN = 1;

/** Base for the two raw sockets: open, send text, collect frames, close. */
abstract class RawSocket {
  readonly received: string[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  protected constructor(protected readonly ws: WebSocket) {}

  protected static async open<T extends RawSocket>(
    url: string,
    make: (ws: WebSocket) => T,
    headers?: Record<string, string>,
  ): Promise<T> {
    // 128 MB so the CLIENT is never the thing that refuses an oversized
    // frame — the question under test is what the SERVER accepts.
    const ws = new WebSocket(url, {
      maxPayload: 128 * 1024 * 1024,
      ...(headers === undefined ? {} : { headers }),
    });
    const socket = make(ws);
    // Listeners BEFORE the open handshake is awaited. `/ws/ui` sends its
    // `welcome` the instant the connection is accepted, and when the upgrade
    // response and that frame land in one TCP segment `ws` emits 'open' and
    // 'message' synchronously — the await continuation runs too late and the
    // first frame is lost. That cost an afternoon as an intermittent failure.
    ws.on('message', (data) => socket.received.push(String(data)));
    ws.on('close', (code, reason) => socket.closes.push({ code, reason: String(reason) }));
    ws.on('error', () => {
      /* 'close' follows */
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`upgrade to ${url} timed out`)), 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  }

  get open(): boolean {
    return this.ws.readyState === OPEN;
  }

  /** Frames received so far, JSON-parsed; unparseable frames are skipped. */
  json<T = Record<string, unknown>>(): T[] {
    const out: T[] = [];
    for (const text of this.received) {
      try {
        out.push(JSON.parse(text) as T);
      } catch {
        /* the server should never send us non-JSON; a test asserts that */
      }
    }
    return out;
  }

  /** Raw text on the wire. Anything at all — this is the point of the class. */
  send(text: string): void {
    if (!this.open) return;
    this.ws.send(text);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* already gone */
    }
  }
}

/**
 * An instrumented app — or something pretending to be one. Nothing here
 * validates: `send` puts the exact bytes given on `/ingest`.
 */
export class RawIngest extends RawSocket {
  private seq = 0;

  static async connect(
    server: WireServer,
    options: { app?: string; hello?: boolean; headers?: Record<string, string> } = {},
  ): Promise<RawIngest> {
    const socket = await RawSocket.open(
      server.ingestUrl,
      (ws) => new RawIngest(ws),
      options.headers,
    );
    if (options.hello !== false) socket.hello(options.app ?? 'raw');
    return socket;
  }

  /** The handshake, well-formed. `hello: false` at connect skips it. */
  hello(app = 'raw', extra: Record<string, unknown> = {}): void {
    this.frame({
      runId: WILDCARD_RUN_ID,
      type: 'hello',
      payload: {
        versions: { protocol: PROTOCOL_VERSION, client: '0.0.0-raw' },
        capabilities: ['pause', 'inject', 'retry', 'abort'],
        app,
        ...extra,
      },
    });
  }

  /**
   * Send a well-formed envelope with the next sequence number, overriding
   * whatever the caller wants to deform.
   */
  frame(overrides: WireFrame): void {
    this.send(
      JSON.stringify({
        gm: PROTOCOL_VERSION,
        seq: this.seq++,
        ts: Date.now(),
        runId: WILDCARD_RUN_ID,
        type: 'node.started',
        payload: { nodeId: 'n', kind: 'tool', name: 'n', instanceId: 'i', input: null },
        ...overrides,
      }),
    );
  }

  /** A minimal valid `node.started` on `runId`, at an explicit `seq`. */
  node(runId: string, seq: number, name = 'ok', nodeId = `tool:${name}`): void {
    this.send(
      JSON.stringify({
        gm: PROTOCOL_VERSION,
        seq,
        ts: Date.now(),
        runId,
        type: 'node.started',
        payload: { nodeId, kind: 'tool', name, instanceId: `${name}-${seq}`, input: null },
      }),
    );
  }

  /** Envelopes the server pushed back (hello.ack, exec.resume, relays). */
  inbound(): WireFrame[] {
    return this.json<WireFrame>();
  }
}

/** A viewer, raw. Speaks the `/ws/ui` subprotocol as text. */
export class RawViewer extends RawSocket {
  private controlSeq = 0;

  static async connect(
    server: WireServer,
    headers?: Record<string, string>,
  ): Promise<RawViewer> {
    return await RawSocket.open(server.uiUrl, (ws) => new RawViewer(ws), headers);
  }

  subscribe(runId: string): void {
    this.send(JSON.stringify({ type: 'subscribe', runId }));
  }

  control(runId: string, type: string, payload: unknown): void {
    this.send(
      JSON.stringify({
        type: 'control',
        envelope: {
          gm: PROTOCOL_VERSION,
          seq: this.controlSeq++,
          ts: Date.now(),
          runId,
          type,
          payload,
        },
      }),
    );
  }

  /** Every `event` frame for `runId`, in arrival order. */
  eventsFor(runId: string): WireFrame[] {
    const out: WireFrame[] = [];
    for (const frame of this.json<{ type?: string; runId?: string; envelope?: WireFrame }>()) {
      if (frame.type === 'event' && frame.runId === runId && frame.envelope !== undefined) {
        out.push(frame.envelope);
      }
    }
    return out;
  }

  errors(): string[] {
    const out: string[] = [];
    for (const frame of this.json<{ type?: string; message?: string }>()) {
      if (frame.type === 'error' && typeof frame.message === 'string') out.push(frame.message);
    }
    return out;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait until the server has persisted `count` events for `runId`.
 *
 * Ingest is asynchronous — the socket write returns long before SQLite has
 * the row — so every "what did the server store" assertion needs a barrier.
 * Returns the events; throws with a useful message on timeout.
 */
export async function waitForEvents(
  server: WireServer,
  runId: string,
  count: number,
  timeoutMs = 15_000,
): Promise<WireFrame[]> {
  const deadline = Date.now() + timeoutMs;
  let have = 0;
  for (;;) {
    // Poll the cheap `total`, then transfer the events once, at the end.
    have = await server.eventCount(runId);
    if (have >= count) return await server.events(runId);
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${count} events on "${runId}" (have ${have})`,
      );
    }
    await sleep(25);
  }
}

/**
 * A quiescence barrier: send a well-formed marker frame on the same
 * connection and wait for it to land.
 *
 * The ingest socket is ordered, so once the marker is stored every frame the
 * test sent before it has been processed — including the ones the server
 * decided to drop, which is what a fuzz test actually needs to know. Polling
 * a fixed delay instead makes the whole suite flaky on a loaded CI runner.
 */
let markerSeq = 0;

export async function drainIngest(
  server: WireServer,
  socket: RawIngest,
  markerRun = '__marker__',
  timeoutMs = 15_000,
): Promise<void> {
  const seq = markerSeq++;
  socket.node(markerRun, seq, 'marker');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await server.events(markerRun);
    if (events.some((event) => event.seq === seq)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms draining the ingest socket`);
    }
    await sleep(25);
  }
}
