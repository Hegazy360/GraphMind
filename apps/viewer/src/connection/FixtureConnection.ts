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
import { useRunStore } from '../store/runStore.js';
import { tokenBuffers } from '../store/tokenBuffers.js';
import { useUiStore } from '../store/uiStore.js';
import { ingestValue } from './ingest.js';
import { registerConnection, type ServerConnection } from './ServerConnection.js';
import demoRun from '../fixtures/demo-run.json';

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

export class FixtureConnection implements ServerConnection {
  readonly source = 'fixture' as const;

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
    const recorded = (demoRun as unknown as RawFixtureEnvelope[]).map((e) => ({ ...e }));
    this.events = recorded;
    this.index = 0;
    this.waitingPauseId = undefined;
    this.syntheticSeq = SYNTHETIC_SEQ_BASE;
    const first = recorded[0];
    if (first === undefined) return;
    this.runId = first.runId;
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

export function useFixtureConnection(enabled: boolean): FixtureConnection | null {
  const ref = useRef<FixtureConnection | null>(null);
  const connection = useMemo(() => (enabled ? new FixtureConnection() : null), [enabled]);
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
