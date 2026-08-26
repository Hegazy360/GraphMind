/**
 * Event-sourced run store. State is only ever advanced through
 * `applyEvent` — live socket, fixture replay and (later) imports all share
 * the same code path via `ingest()`.
 */
import { create } from 'zustand';
import type { EventEnvelope } from '@graphmind-ai/schema';
import type { RunInfo } from '../connection/protocol.js';
import { applyEvent, type RunsMap } from './applyEvent.js';
import type { RunSource, RunState } from './types.js';

interface RunStoreState {
  runs: RunsMap;
  /** Returns true when the envelope changed state (false = deduped/no-op). */
  applyEvent: (envelope: EventEnvelope, source: RunSource) => boolean;
  /**
   * Seed/refresh run metadata from a server `runs`/`run.update` frame.
   * Events remain authoritative — RunInfo only fills fields the event
   * stream hasn't established yet (a run listed before its replay landed).
   */
  noteRunInfo: (info: RunInfo, source: RunSource) => void;
  clearRun: (runId: string) => void;
}

export const useRunStore = create<RunStoreState>((set, get) => ({
  runs: {},
  applyEvent: (envelope, source) => {
    const before = get().runs;
    const after = applyEvent(before, envelope, source);
    if (after === before) return false;
    set({ runs: after });
    return true;
  },
  noteRunInfo: (info, source) => {
    set((state) => {
      const existing = state.runs[info.id];
      if (existing !== undefined) {
        const needsMeta = existing.meta.status === 'pending';
        const needsSource = existing.meta.serverSource !== info.source;
        if (!needsMeta && !needsSource) return state;
        return {
          runs: {
            ...state.runs,
            [info.id]: {
              ...existing,
              meta: {
                ...existing.meta,
                ...(needsMeta
                  ? { app: info.app, startedTs: info.startedAt, status: info.status }
                  : {}),
                serverSource: info.source,
              },
              statusVersion: existing.statusVersion + 1,
            },
          },
        };
      }
      const stub: RunState = {
        runId: info.id,
        meta: {
          runId: info.id,
          app: info.app,
          startedTs: info.startedAt,
          ...(info.finishedAt !== null ? { finishedTs: info.finishedAt } : {}),
          status: info.status,
          source,
          serverSource: info.source,
        },
        nodes: {},
        order: [],
        pauses: {},
        seqSeen: new Set<number>(),
        structureVersion: 0,
        statusVersion: 0,
      };
      return { runs: { ...state.runs, [info.id]: stub } };
    });
  },
  clearRun: (runId) => {
    set((state) => {
      const { [runId]: _dropped, ...rest } = state.runs;
      return { runs: rest };
    });
  },
}));
