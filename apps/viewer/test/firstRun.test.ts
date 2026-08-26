/**
 * First-run experience + run-source badges: the welcome card shows exactly
 * when the viewer is connected with zero runs, and demo runs are labelled
 * as recorded sessions (keyed off RunInfo.source === 'demo').
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunInfo } from '../src/connection/protocol.js';
import { INTEGRATION_SNIPPET, runChipLabel, shouldShowWelcome } from '../src/lib/firstRun.js';
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

describe('shouldShowWelcome (first-run state)', () => {
  it('shows only when connected with zero runs', () => {
    expect(shouldShowWelcome('live', 0)).toBe(true);
    expect(shouldShowWelcome('live', 1)).toBe(false);
    expect(shouldShowWelcome('connecting', 0)).toBe(false);
    expect(shouldShowWelcome('detached', 0)).toBe(false);
    expect(shouldShowWelcome('off', 0)).toBe(false);
    expect(shouldShowWelcome('replaying', 0)).toBe(false);
  });

  it('the integration snippet is exactly three lines', () => {
    expect(INTEGRATION_SNIPPET.split('\n')).toHaveLength(3);
    expect(INTEGRATION_SNIPPET).toContain('graphmind({');
  });
});

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
