/**
 * Fixture replay: feeds a bundled event log through the exact same ingest
 * path as the live socket, preserving the recorded pacing (gaps capped so a
 * long-idle recording still demos well). Powers dev mode (`?fixture=1`),
 * design iteration and the empty-state demo button — no server required.
 *
 * The replay is interactive: when it plays an `exec.paused` event it stops
 * and waits for a real `exec.resume` control, then emits the matching
 * `exec.resumed` and continues — `abort` short-circuits to an aborted run,
 * `inject` rewrites the failed call's `node.finished` to the injected
 * output and skips the recorded retry.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ControlType, MessagePayloadMap } from '@graphmind-ai/schema';
import { generateMcpRun } from '../store/mcpFixture.js';
import { useRunStore } from '../store/runStore.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useUiStore } from '../store/uiStore.js';
import { ingestValue } from './ingest.js';
import { registerConnection, type ServerConnection } from './ServerConnection.js';
import demoRun from '../fixtures/demo-run.json';

/**
 * A run exported by `graphmind record --html` inlines its envelopes here, so
 * the page is a complete, offline record of one run: no server, no fixture,
 * nothing to install. Played back instantly rather than paced — it is
 * evidence being read, not a demo being watched.
 */
export function embeddedRun(): RawFixtureEnvelope[] | null {
  const raw = (globalThis as { __GRAPHMIND_RUN__?: unknown }).__GRAPHMIND_RUN__;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw as RawFixtureEnvelope[];
}

/**
 * True when this page *is* an exported run rather than a live (or paced
 * replay) session.
 *
 * It matters for anything that offers to change execution: an exported run
 * is a frozen record, so a gate it captured can never be released. Nothing
 * is executing, and there is nowhere for a control to go — the UI must say
 * so rather than render a button that silently does nothing.
 *
 * Computed once: the inline `window.__GRAPHMIND_RUN__` script cannot change
 * after load.
 */
let exported: boolean | undefined;
export function isExportedRun(): boolean {
  exported ??= embeddedRun() !== null;
  return exported;
}

interface RawFixtureEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
}

const MAX_GAP_MS = 1400;
/** Synthetic seqs (exec.resumed, aborted run.finished) start well clear of the recording. */
const SYNTHETIC_SEQ_BASE = 100000;

/**
 * Which bundled run to replay. `demo` is the recorded trip-planner session
 * every screenshot and e2e test uses; `mcp` is a generated MCP server session
 * (see store/mcpFixture.ts) — there is no recorded MCP run to ship yet, and
 * an MCP-shaped canvas has to be designable and testable regardless.
 */
export type FixtureName = 'demo' | 'mcp';

export function parseFixtureParam(search: string): FixtureName | null {
  const value = new URLSearchParams(search).get('fixture');
  if (value === null || value === '') return null;
  if (value === 'mcp') return 'mcp';
  return 'demo';
}

export class FixtureConnection implements ServerConnection {
  readonly source = 'fixture' as const;

  constructor(private readonly fixture: FixtureName = 'demo') {}

  private events: RawFixtureEnvelope[] = [];
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waitingPauseId: string | undefined;
  private tsOffset = 0;
  private syntheticSeq = SYNTHETIC_SEQ_BASE;
  private runId = '';
  private disposed = false;

  start(): void {
    this.disposed = false; // start() re-arms after a StrictMode dispose/restart
    const embedded = embeddedRun();
    const bundled =
      this.fixture === 'mcp'
        ? (generateMcpRun() as unknown as RawFixtureEnvelope[])
        : (demoRun as unknown as RawFixtureEnvelope[]);
    const recorded = (embedded ?? bundled).map((e) => ({
      ...e,
    }));
    this.events = recorded;
    this.index = 0;
    this.waitingPauseId = undefined;
    this.syntheticSeq = SYNTHETIC_SEQ_BASE;
    const first = recorded[0];
    if (first === undefined) return;
    this.runId = first.runId;
    if (embedded !== null) {
      // Exported run: show the whole thing at once, timestamps as recorded.
      this.tsOffset = 0;
      while (!this.disposed && this.index < this.events.length) {
        const event = this.events[this.index];
        this.index += 1;
        if (event !== undefined) ingestValue({ ...event }, 'fixture');
      }
      return;
    }
    this.tsOffset = Date.now() - first.ts;
    this.scheduleNext(200);
  }

  restart(): void {
    this.stopTimer();
    useRunStore.getState().clearRun(this.runId);
    tokenBuffers.clearRun(this.runId);
    this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  sendControl<T extends ControlType>(type: T, payload: MessagePayloadMap[T], _runId?: string): void {
    if (type !== 'exec.resume') return; // breakpoints/mode: recorded viewer-side only
    const resume = payload as MessagePayloadMap['exec.resume'];
    if (this.waitingPauseId === undefined || resume.pauseId !== this.waitingPauseId) return;
    const pausedNodeId = this.pausedNodeId(resume.pauseId);
    this.waitingPauseId = undefined;

    this.emit({
      type: 'exec.resumed',
      payload: { pauseId: resume.pauseId, action: resume.action },
    });

    if (resume.action === 'abort') {
      this.emit({
        type: 'run.finished',
        payload: {
          status: 'aborted',
          error: { name: 'AbortError', message: 'aborted from the debugger' },
        },
      });
      this.index = this.events.length;
      return;
    }

    if (resume.action === 'inject' && pausedNodeId !== undefined) {
      this.applyInjection(pausedNodeId, resume.output);
    }

    this.scheduleNext(260);
  }

  private pausedNodeId(pauseId: string): string | undefined {
    for (let i = this.index - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event !== undefined && event.type === 'exec.paused' && event.payload['pauseId'] === pauseId) {
        return event.payload['nodeId'] as string;
      }
    }
    return undefined;
  }

  /**
   * Inject semantics: the next `node.finished` for the paused node becomes
   * an `ok` finish carrying the injected output, and the recorded retry
   * instance (contiguous later events for the same node) is dropped.
   */
  private applyInjection(nodeId: string, output: unknown): void {
    let patched = false;
    const remaining: RawFixtureEnvelope[] = [];
    for (let i = this.index; i < this.events.length; i++) {
      const event = this.events[i];
      if (event === undefined) continue;
      const isForNode = event.type.startsWith('node.') && event.payload['nodeId'] === nodeId;
      if (isForNode && !patched && event.type === 'node.finished') {
        remaining.push({
          ...event,
          payload: { ...event.payload, status: 'ok', output, injected: true },
        });
        patched = true;
        continue;
      }
      if (isForNode) continue; // drop error bookkeeping + recorded retry
      remaining.push(event);
    }
    this.events = [...this.events.slice(0, this.index), ...remaining];
  }

  private emit(partial: { type: string; payload: Record<string, unknown> }): void {
    ingestValue(
      {
        gm: 1,
        seq: this.syntheticSeq++,
        ts: Date.now(),
        runId: this.runId,
        type: partial.type,
        payload: partial.payload,
      },
      'fixture',
    );
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(delay: number): void {
    if (this.disposed) return;
    this.stopTimer();
    this.timer = setTimeout(() => this.step(), delay);
  }

  private step(): void {
    if (this.disposed) return;
    const event = this.events[this.index];
    if (event === undefined) return; // replay complete
    this.index += 1;
    ingestValue({ ...event, ts: event.ts + this.tsOffset }, 'fixture');

    if (event.type === 'exec.paused') {
      this.waitingPauseId = event.payload['pauseId'] as string;
      return; // hold until the viewer resumes
    }

    const next = this.events[this.index];
    if (next === undefined) return;
    const gap = Math.max(0, Math.min(next.ts - event.ts, MAX_GAP_MS));
    this.scheduleNext(gap);
  }
}

export function useFixtureConnection(fixture: FixtureName | null): FixtureConnection | null {
  const ref = useRef<FixtureConnection | null>(null);
  const connection = useMemo(
    () => (fixture === null ? null : new FixtureConnection(fixture)),
    [fixture],
  );
  ref.current = connection;

  useEffect(() => {
    if (connection === null) return;
    const ui = useUiStore.getState();
    ui.setFixtureActive(true);
    connection.start();
    const unregister = registerConnection(connection);
    return () => {
      connection.dispose();
      unregister();
      useUiStore.getState().setFixtureActive(false);
    };
  }, [connection]);

  return connection;
}
