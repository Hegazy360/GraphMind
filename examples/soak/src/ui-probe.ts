/**
 * A headless viewer. Speaks the real `/ws/ui` subprotocol (ui-protocol.ts):
 * subscribe `'*'` for the run list, subscribe per run for replay-then-tail.
 *
 * It records everything needed to prove the server's delivery contract:
 * arrival order, seqs, the per-run ordinal `i` the workload stamps into each
 * payload, replay boundaries, and end-to-end latency (envelope.ts, set by the
 * client at emit, vs. arrival here — same machine, same clock).
 */
import { WebSocket } from 'ws';

export interface RunTrace {
  runId: string;
  /** Payload ordinals in arrival order (-1 for events without one). */
  order: number[];
  /** Envelope seqs in arrival order. */
  seqs: number[];
  /** Types in arrival order. */
  types: string[];
  firstAt: number;
  lastAt: number;
  latencies: number[];
  replayStarts: number[];
  replayEnds: number;
  /** Per-event: true when it arrived inside a replay window. */
  replayed: boolean[];
  /** Live-phase latency samples only (replay latency is storage age). */
  liveLatencies: number[];
  /** Raw event frames, only when `keepRaw` is on (viewer replay scenario). */
  raw: unknown[];
}

export interface ProbeOptions {
  /** Keep full envelopes so they can be replayed into the viewer reducer. */
  keepRaw?: boolean;
  /** Auto-subscribe to every run the server announces. Default true. */
  autoSubscribe?: boolean;
  /** Collect latency samples. Default true. */
  latency?: boolean;
}

export class UiProbe {
  private readonly socket: WebSocket;
  private readonly subscribed = new Set<string>();
  private readonly replaying = new Set<string>();
  readonly runs = new Map<string, RunTrace>();
  readonly errors: string[] = [];
  runUpdates = 0;
  welcomed = false;

  private constructor(
    socket: WebSocket,
    private readonly options: ProbeOptions,
  ) {
    this.socket = socket;
    this.socket.on('message', (data) => this.onFrame(String(data)));
  }

  static async connect(url: string, options: ProbeOptions = {}): Promise<UiProbe> {
    const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    const probe = new UiProbe(socket, options);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return probe;
  }

  subscribe(runId: string): void {
    if (this.subscribed.has(runId)) return;
    this.subscribed.add(runId);
    this.socket.send(JSON.stringify({ type: 'subscribe', runId }));
  }

  unsubscribe(runId: string): void {
    this.subscribed.delete(runId);
    this.socket.send(JSON.stringify({ type: 'unsubscribe', runId }));
  }

  trace(runId: string): RunTrace {
    let trace = this.runs.get(runId);
    if (trace === undefined) {
      trace = {
        runId,
        order: [],
        seqs: [],
        types: [],
        firstAt: 0,
        lastAt: 0,
        latencies: [],
        replayStarts: [],
        replayEnds: 0,
        replayed: [],
        liveLatencies: [],
        raw: [],
      };
      this.runs.set(runId, trace);
    }
    return trace;
  }

  private onFrame(text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.errors.push('non-JSON frame from server');
      return;
    }
    const now = Date.now();
    switch (frame['type']) {
      case 'welcome':
        this.welcomed = true;
        return;
      case 'runs': {
        const runs = frame['runs'] as { id: string }[];
        this.runUpdates += 1;
        if (this.options.autoSubscribe !== false) for (const run of runs) this.subscribe(run.id);
        return;
      }
      case 'run.update': {
        this.runUpdates += 1;
        const run = frame['run'] as { id: string };
        if (this.options.autoSubscribe !== false) this.subscribe(run.id);
        return;
      }
      case 'replay.start': {
        const trace = this.trace(String(frame['runId']));
        trace.replayStarts.push(Number(frame['count'] ?? 0));
        this.replaying.add(trace.runId);
        return;
      }
      case 'replay.end': {
        const runId = String(frame['runId']);
        this.trace(runId).replayEnds += 1;
        this.replaying.delete(runId);
        return;
      }
      case 'event': {
        const envelope = frame['envelope'] as {
          seq: number;
          ts: number;
          type: string;
          payload: unknown;
        };
        const trace = this.trace(String(frame['runId']));
        if (trace.firstAt === 0) trace.firstAt = now;
        trace.lastAt = now;
        trace.seqs.push(envelope.seq);
        trace.types.push(envelope.type);
        const payload = envelope.payload as { i?: unknown } | null;
        trace.order.push(
          payload !== null && typeof payload === 'object' && typeof payload.i === 'number'
            ? payload.i
            : -1,
        );
        const inReplay = this.replaying.has(trace.runId);
        trace.replayed.push(inReplay);
        if (this.options.latency !== false) {
          trace.latencies.push(now - envelope.ts);
          if (!inReplay) trace.liveLatencies.push(now - envelope.ts);
        }
        if (this.options.keepRaw === true) trace.raw.push(envelope);
        return;
      }
      case 'error':
        this.errors.push(String(frame['message']));
        return;
      default:
        return;
    }
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
      setTimeout(resolve, 1000);
    });
  }
}
