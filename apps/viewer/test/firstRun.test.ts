/**
 * Run-source badges and the first-run decision: demo runs are labelled as
 * recorded sessions (keyed off RunInfo.source === 'demo'), and a viewer with
 * nothing to show offers the connect page exactly once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunInfo } from '../src/connection/protocol.js';
import { runChipLabel, shouldOpenConnect } from '../src/lib/firstRun.js';
import { useRunStore } from '../src/store/runStore.js';

function runInfo(overrides: Partial<RunInfo>): RunInfo {
  return {
    id: 'run-1',
    app: 'trip-planner',
    startedAt: 1000,
    finishedAt: null,
    status: 'running',
    schemaVersion: 1,
    source: 'live',
    eventCount: 0,
    errorCount: 0,
    live: true,
    ...overrides,
  };
}

describe('runChipLabel (recorded-session badge)', () => {
  it("labels server 'demo' runs as recorded sessions", () => {
    expect(runChipLabel({ source: 'live', serverSource: 'demo' })).toBe('recorded session');
    expect(runChipLabel({ source: 'live', serverSource: 'live' })).toBe('live');
    expect(runChipLabel({ source: 'live', serverSource: 'import' })).toBe('imported');
    expect(runChipLabel({ source: 'live' })).toBe('live');
    expect(runChipLabel({ source: 'fixture' })).toBe('replay');
  });
});

describe('runStore.noteRunInfo serverSource', () => {
  beforeEach(() => {
    useRunStore.setState({ runs: {} });
  });

  it('stamps serverSource on runs created from a RunInfo frame', () => {
    useRunStore.getState().noteRunInfo(runInfo({ id: 'demo-abc', source: 'demo' }), 'live');
    const meta = useRunStore.getState().runs['demo-abc']?.meta;
    expect(meta?.serverSource).toBe('demo');
    expect(runChipLabel(meta!)).toBe('recorded session');
  });

  it('backfills serverSource on runs first seen via events', () => {
    // Events arrive first: the run exists with status past 'pending'.
    useRunStore.getState().applyEvent(
      {
        gm: 1,
        seq: 1,
        ts: 1000,
        runId: 'demo-late',
        type: 'run.started',
        payload: { app: 'trip-planner', sdk: { name: 'ai', version: '7' } },
      },
      'live',
    );
    expect(useRunStore.getState().runs['demo-late']?.meta.status).toBe('running');
    useRunStore.getState().noteRunInfo(runInfo({ id: 'demo-late', source: 'demo' }), 'live');
    const meta = useRunStore.getState().runs['demo-late']?.meta;
    expect(meta?.status).toBe('running'); // events stay authoritative
    expect(meta?.serverSource).toBe('demo');
  });
});

describe('shouldOpenConnect (does a stranger land on the connect page?)', () => {
  it('opens on a settled, empty, first-time viewer', () => {
    expect(shouldOpenConnect('live', 0, false)).toBe(true);
    expect(shouldOpenConnect('detached', 0, false)).toBe(true);
  });

  it('never interrupts someone who has runs to look at', () => {
    expect(shouldOpenConnect('live', 1, false)).toBe(false);
  });

  it('never offers itself twice', () => {
    expect(shouldOpenConnect('live', 0, true)).toBe(false);
  });

  it('waits for the connection to settle rather than flashing during the handshake', () => {
    expect(shouldOpenConnect('connecting', 0, false)).toBe(false);
  });

  it('stays out of the way of an offline replay', () => {
    expect(shouldOpenConnect('replaying', 0, false)).toBe(false);
    expect(shouldOpenConnect('off', 0, false)).toBe(false);
  });
});
