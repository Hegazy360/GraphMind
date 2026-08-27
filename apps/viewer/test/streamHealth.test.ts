/**
 * "live" has to mean live.
 *
 * The server answers a UI `subscribe` by replaying the run's stored history
 * first and only then tailing, so an open socket proves nothing about
 * whether anything current is reaching the canvas. Under ingest saturation a
 * viewer receives an entire run as catch-up — measured at 0 live / 72,144
 * replayed — with no error and no warning. These tests pin the two signals
 * that make that visible: an in-flight replay, and the age of the newest
 * envelope to arrive.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BEHIND_MS,
  IDLE_STREAM,
  LAG_SAMPLE_TTL_MS,
  streamStatus,
  useUiStore,
  type StreamHealth,
} from '../src/store/uiStore.js';
import {
  LAG_SAMPLE_THROTTLE_MS,
  PROGRESS_THROTTLE_MS,
  beginReplay,
  endReplay,
  noteEventAge,
  noteReplayEvent,
  pendingStreamHealth,
  resetStreamHealth,
} from '../src/connection/streamHealth.js';

const health = (patch: Partial<StreamHealth> = {}): StreamHealth => ({
  catchUp: {},
  lagMs: 0,
  lagAt: 0,
  ...patch,
});

beforeEach(() => {
  resetStreamHealth();
});

describe('streamStatus', () => {
  it('an idle socket is tailing, not behind', () => {
    expect(streamStatus(IDLE_STREAM).phase).toBe('tailing');
  });

  it('reports an in-flight replay as catching up, with how far through it is', () => {
    const status = streamStatus(health({ catchUp: { r1: { count: 72_144, applied: 12_048 } } }));
    expect(status.phase).toBe('catching-up');
    expect(status.backlog).toBe(72_144);
    expect(status.applied).toBe(12_048);
  });

  it('sums the backlog across every run still replaying', () => {
    const status = streamStatus(
      health({ catchUp: { a: { count: 10, applied: 4 }, b: { count: 90, applied: 0 } } }),
    );
    expect(status).toMatchObject({ phase: 'catching-up', backlog: 100, applied: 4 });
  });

  it('a replay in flight outranks any lag reading', () => {
    const now = 1_000_000;
    const status = streamStatus(
      health({ catchUp: { a: { count: 5, applied: 1 } }, lagMs: 60_000, lagAt: now }),
      now,
    );
    expect(status.phase).toBe('catching-up');
  });

  it('calls a tail that is delivering stale events "behind"', () => {
    const now = 1_000_000;
    const status = streamStatus(health({ lagMs: BEHIND_MS + 1, lagAt: now }), now);
    expect(status.phase).toBe('behind');
    expect(status.lagMs).toBe(BEHIND_MS + 1);
  });

  it('a small lag is just a live tail', () => {
    const now = 1_000_000;
    expect(streamStatus(health({ lagMs: BEHIND_MS - 1, lagAt: now }), now).phase).toBe('tailing');
  });

  /**
   * A run that finished is idle, not behind: its last event was old the
   * moment it arrived, and nothing has arrived since. Accusing the socket
   * forever would make the indicator noise instead of signal.
   */
  it('forgets a stale lag sample instead of accusing an idle socket', () => {
    const sampledAt = 1_000_000;
    const stream = health({ lagMs: 60_000, lagAt: sampledAt });
    expect(streamStatus(stream, sampledAt + LAG_SAMPLE_TTL_MS - 1).phase).toBe('behind');
    expect(streamStatus(stream, sampledAt + LAG_SAMPLE_TTL_MS + 1).phase).toBe('tailing');
  });
});

describe('stream health from the socket', () => {
  it('a replay.start puts the viewer into catch-up immediately', () => {
    beginReplay('run-a', 72_144);
    expect(streamStatus(useUiStore.getState().stream).phase).toBe('catching-up');
    expect(streamStatus(useUiStore.getState().stream).backlog).toBe(72_144);
  });

  it('replay.end returns it to a live tail', () => {
    beginReplay('run-a', 10);
    endReplay('run-a');
    expect(streamStatus(useUiStore.getState().stream).phase).toBe('tailing');
  });

  it('counts replayed events without a store write per event', () => {
    beginReplay('run-a', 50_000);
    const writes: number[] = [];
    const unsubscribe = useUiStore.subscribe(() => writes.push(1));
    const at = Date.now();
    for (let i = 0; i < 50_000; i += 1) noteReplayEvent('run-a', at);
    unsubscribe();
    // Every event counted…
    expect(pendingStreamHealth().catchUp['run-a']?.applied).toBe(50_000);
    // …and the throttle meant ~none of them touched the store.
    expect(writes.length).toBeLessThanOrEqual(1);
  });

  it('publishes progress once the throttle window passes', () => {
    beginReplay('run-a', 100);
    const at = Date.now();
    noteReplayEvent('run-a', at);
    noteReplayEvent('run-a', at + PROGRESS_THROTTLE_MS + 1);
    expect(streamStatus(useUiStore.getState().stream).applied).toBe(2);
  });

  it('ignores replayed-event counts for a run with no replay open', () => {
    noteReplayEvent('never-subscribed');
    expect(streamStatus(useUiStore.getState().stream).phase).toBe('tailing');
  });

  it('turns an old envelope timestamp into a "behind" reading', () => {
    const now = Date.now();
    noteEventAge(now - 34_000, now);
    const status = streamStatus(useUiStore.getState().stream, now);
    expect(status.phase).toBe('behind');
    expect(status.lagMs).toBeGreaterThanOrEqual(34_000);
  });

  it('a fresh envelope leaves the tail live', () => {
    const now = Date.now();
    noteEventAge(now - 20, now);
    expect(streamStatus(useUiStore.getState().stream, now).phase).toBe('tailing');
  });

  it('throttles lag sampling too — one write per window, not per event', () => {
    const now = Date.now();
    noteEventAge(now - 40_000, now);
    // Same window: a fresher event does not get to overwrite the reading yet.
    noteEventAge(now - 10, now + 1);
    expect(streamStatus(useUiStore.getState().stream, now + 1).phase).toBe('behind');
    // Next window: it does.
    noteEventAge(now - 10, now + LAG_SAMPLE_THROTTLE_MS + 1);
    expect(streamStatus(useUiStore.getState().stream, now + LAG_SAMPLE_THROTTLE_MS + 1).phase).toBe(
      'tailing',
    );
  });

  it('ignores a nonsense timestamp rather than inventing a lag', () => {
    noteEventAge(Number.NaN);
    noteEventAge(0);
    expect(streamStatus(useUiStore.getState().stream).phase).toBe('tailing');
  });

  it('a dropped socket clears the catch-up it will never finish', () => {
    beginReplay('run-a', 900);
    resetStreamHealth();
    expect(streamStatus(useUiStore.getState().stream).phase).toBe('tailing');
    expect(useUiStore.getState().stream.catchUp).toEqual({});
  });
});
