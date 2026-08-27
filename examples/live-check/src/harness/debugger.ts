/**
 * A headless debugger: a real client of the CLI's `/ws/ui` subprotocol, the
 * same one the viewer speaks. It subscribes to every run, records every
 * envelope with the wall clock AND the monotonic clock (so pauses can be
 * correlated with the HTTP probe), and can set breakpoints, switch mode and
 * resume held gates.
 */
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import type { BreakpointMatcher, ResumeAction, RunMode } from '@graphmind-ai/schema';
import { WebSocket } from 'ws';
import { clock } from './probe.js';

export interface WireEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SeenEnvelope {
  envelope: WireEnvelope;
  /** `performance.now()` when the debugger received it. */
  at: number;
}

export interface PauseEvent {
  runId: string;
  pauseId: string;
  nodeId: string;
  point: 'before' | 'after' | 'error';
  at: number;
}

type PauseHandler = (pause: PauseEvent) => void | Promise<void>;

export class HeadlessDebugger {
  readonly seen: SeenEnvelope[] = [];
  readonly pauses: PauseEvent[] = [];
  readonly errors: string[] = [];
  /** Pause ids that have been resumed by this debugger. */
  readonly resumed = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly pauseHandlers: PauseHandler[] = [];
  private readonly waiters: { predicate: (e: SeenEnvelope) => boolean; resolve: () => void }[] = [];
  private seq = 0;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(uiUrl: string): Promise<HeadlessDebugger> {
    const ws = new WebSocket(uiUrl);
    const dbg = new HeadlessDebugger(ws);
    ws.on('message', (data) => dbg.onMessage(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    dbg.send({ type: 'subscribe', runId: '*' });
    return dbg;
  }

  private send(frame: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private onMessage(raw: string): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(raw) as Record<string, any>;
    } catch {
      return;
    }
    if (frame['type'] === 'error') {
      this.errors.push(String(frame['message']));
      return;
    }
    if (frame['type'] === 'runs' || frame['type'] === 'run.update') {
      const runs = frame['type'] === 'runs' ? frame['runs'] : [frame['run']];
      for (const run of runs ?? []) {
        const id = run?.id;
        if (typeof id === 'string' && !this.subscribed.has(id)) {
          this.subscribed.add(id);
          this.send({ type: 'subscribe', runId: id });
        }
      }
      return;
    }
    if (frame['type'] !== 'event') return;
    const envelope = frame['envelope'] as WireEnvelope | undefined;
    if (envelope === undefined) return;
    const entry: SeenEnvelope = { envelope, at: clock() };
    this.seen.push(entry);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (waiter !== undefined && waiter.predicate(entry)) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
    if (envelope.type === 'exec.paused') {
      const pause: PauseEvent = {
        runId: envelope.runId,
        pauseId: String(envelope.payload['pauseId']),
        nodeId: String(envelope.payload['nodeId']),
        point: envelope.payload['point'] as PauseEvent['point'],
        at: entry.at,
      };
      this.pauses.push(pause);
      for (const handler of this.pauseHandlers) {
        void Promise.resolve(handler(pause)).catch((error: unknown) => {
          this.errors.push(`pause handler threw: ${String(error)}`);
        });
      }
    }
  }

  onPaused(handler: PauseHandler): void {
    this.pauseHandlers.push(handler);
  }

  resume(runId: string, pauseId: string, action: ResumeAction, output?: unknown): void {
    this.resumed.add(pauseId);
    this.send({
      type: 'control',
      envelope: {
        gm: PROTOCOL_VERSION,
        seq: this.seq++,
        ts: Date.now(),
        runId,
        type: 'exec.resume',
        payload: { pauseId, action, ...(output === undefined ? {} : { output }) },
      },
    });
  }

  setBreakpoint(matcher: BreakpointMatcher): void {
    this.control('breakpoint.set', { matcher });
  }

  clearBreakpoint(matcher: BreakpointMatcher): void {
    this.control('breakpoint.clear', { matcher });
  }

  setMode(mode: RunMode): void {
    this.control('mode.set', { mode });
  }

  private control(type: string, payload: unknown): void {
    this.send({
      type: 'control',
      envelope: {
        gm: PROTOCOL_VERSION,
        seq: this.seq++,
        ts: Date.now(),
        runId: '*',
        type,
        payload,
      },
    });
  }

  /** Envelopes of one type, optionally restricted to one run. */
  events(type: string, runId?: string): WireEnvelope[] {
    return this.seen
      .map((s) => s.envelope)
      .filter((e) => e.type === type && (runId === undefined || e.runId === runId));
  }

  /** Wait until an envelope matching `predicate` arrives. */
  waitFor(
    predicate: (e: SeenEnvelope) => boolean,
    timeoutMs = 30_000,
    label = 'envelope',
  ): Promise<void> {
    if (this.seen.some(predicate)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // best effort
    }
  }
}
