/**
 * The runs list, as data: live runs are pinned, history is shelved by day
 * or by app, facets count what they would show, and the search matches what
 * you remember about a run.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_FILTER,
  canGroupByApp,
  facetsOf,
  groupRuns,
  isFiltering,
  matchesFilter,
  shortRunId,
  summariseRun,
  timeBucket,
} from '../src/lib/runList.js';
import type { RunState } from '../src/store/types.js';

const DAY = 86_400_000;
/** A fixed "now": a Wednesday at 15:00 local time. */
const NOW = (() => {
  const d = new Date(2026, 10, 4, 15, 0, 0, 0);
  return d.getTime();
})();

type MetaOverrides = { [K in keyof RunState['meta']]?: RunState['meta'][K] | undefined };

function run(
  overrides: MetaOverrides & { pauses?: RunState['pauses']; nodes?: RunState['nodes'] } = {},
): RunState {
  const { pauses, nodes, ...rest } = overrides;
  const runId = rest.runId ?? 'run-1';
  const meta: RunState['meta'] = {
    runId,
    app: 'trip-planner',
    status: 'ok',
    source: 'live',
    startedTs: NOW - 60_000,
    finishedTs: NOW - 30_000,
  };
  // An explicit `undefined` removes the field (a run with no start, a run
  // that has not finished), which a spread cannot say under exact optionals.
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) delete (meta as unknown as Record<string, unknown>)[key];
    else (meta as unknown as Record<string, unknown>)[key] = value;
  }
  return {
    runId,
    meta,
    nodes: nodes ?? {},
    order: Object.keys(nodes ?? {}),
    pauses: pauses ?? {},
    seqSeen: new Set(),
    structureVersion: 0,
    statusVersion: 0,
  };
}

const heldRun = (runId: string, startedTs: number): RunState =>
  run({
    runId,
    status: 'running',
    startedTs,
    finishedTs: undefined,
    nodes: {
      n1: {
        nodeId: 'n1',
        kind: 'tool',
        name: 'fetch',
        ghost: false,
        executions: [],
        activePauseId: 'p1',
        lastError: { name: 'TimeoutError', message: 'upstream took 30s' },
      },
    },
    pauses: {
      p1: { pauseId: 'p1', nodeId: 'n1', point: 'error', ts: startedTs + 1000, active: true },
    },
  });

describe('timeBucket', () => {
  it('shelves finished runs by the local day they started', () => {
    expect(timeBucket(summariseRun(run({ startedTs: NOW - 3_600_000 })), NOW)).toBe('today');
    expect(timeBucket(summariseRun(run({ startedTs: NOW - DAY })), NOW)).toBe('yesterday');
    expect(timeBucket(summariseRun(run({ startedTs: NOW - 3 * DAY })), NOW)).toBe('week');
    expect(timeBucket(summariseRun(run({ startedTs: NOW - 9 * DAY })), NOW)).toBe('older');
  });

  it('uses midnight, not a rolling 24 hours: 01:00 today is today, 23:00 yesterday is yesterday', () => {
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(timeBucket(summariseRun(run({ startedTs: midnight.getTime() + 3_600_000 })), NOW)).toBe('today');
    expect(timeBucket(summariseRun(run({ startedTs: midnight.getTime() - 3_600_000 })), NOW)).toBe('yesterday');
  });

  it('pins live runs whatever the clock says, and does not guess for a stub with no start', () => {
    expect(timeBucket(summariseRun(run({ status: 'running', finishedTs: undefined, startedTs: NOW - 9 * DAY })), NOW)).toBe('live');
    expect(timeBucket(summariseRun(heldRun('h', NOW - 2 * DAY)), NOW)).toBe('live');
    expect(timeBucket(summariseRun(run({ startedTs: undefined, finishedTs: undefined })), NOW)).toBe('older');
  });
});

describe('summariseRun', () => {
  it('does not call a finished run held, even if its recording never saw the gate released', () => {
    const stale = heldRun('stale', NOW - 60_000);
    stale.meta.status = 'ok';
    stale.meta.finishedTs = NOW - 30_000;
    const row = summariseRun(stale);
    expect(row.status).toBe('ok');
    expect(row.failure).toBeUndefined();

    const failed = heldRun('failed', NOW - 60_000);
    failed.meta.status = 'error';
    failed.meta.finishedTs = NOW - 30_000;
    failed.meta.error = { name: 'RunError', message: 'gave up' };
    expect(summariseRun(failed).failure).toEqual({ text: 'RunError: gave up', held: false });
  });

  it('reports a live hold as held, with the error the gate stopped on', () => {
    expect(summariseRun(heldRun('h', NOW - 1000)).failure).toEqual({
      text: 'TimeoutError: upstream took 30s',
      held: true,
    });
  });
});

describe('groupRuns', () => {
  const rows = [
    run({ runId: 'a', startedTs: NOW - 10_000 }),
    run({ runId: 'b', startedTs: NOW - 20_000, status: 'error', error: { name: 'E', message: 'boom' } }),
    run({ runId: 'c', app: 'support-bot', startedTs: NOW - DAY }),
    run({ runId: 'd', app: 'support-bot', startedTs: NOW - 10 * DAY }),
    run({ runId: 'live', status: 'running', finishedTs: undefined, startedTs: NOW - 5000 }),
    heldRun('held', NOW - 3 * DAY),
  ].map(summariseRun);

  it('by day: live first, then today, yesterday, older — empty shelves left out', () => {
    const groups = groupRuns(rows, 'time', NOW);
    expect(groups.map((g) => g.key)).toEqual(['live', 'today', 'yesterday', 'older']);
    expect(groups[0]?.live).toBe(true);
    // The held run outranks the running one, however old it is.
    expect(groups[0]?.rows.map((r) => r.run.runId)).toEqual(['held', 'live']);
    // Newest first inside a shelf.
    expect(groups[1]?.rows.map((r) => r.run.runId)).toEqual(['a', 'b']);
  });

  it('tallies each shelf', () => {
    const groups = groupRuns(rows, 'time', NOW);
    expect(groups[0]).toMatchObject({ held: 1, running: 1, failed: 0 });
    expect(groups[1]).toMatchObject({ held: 0, running: 0, failed: 1 });
  });

  it('by app: live still pinned on top, apps by most recent run', () => {
    const groups = groupRuns(rows, 'app', NOW);
    expect(groups.map((g) => g.key)).toEqual(['live', 'app:trip-planner', 'app:support-bot']);
    expect(groups[2]?.rows.map((r) => r.run.runId)).toEqual(['c', 'd']);
  });

  it('by app with nothing live has no live shelf', () => {
    const quiet = rows.filter((r) => r.status === 'ok' || r.status === 'error');
    expect(groupRuns(quiet, 'app', NOW).map((g) => g.key)).toEqual(['app:trip-planner', 'app:support-bot']);
  });
});

describe('facets and filter', () => {
  const rows = [
    run({ runId: 'a' }),
    run({ runId: 'b', status: 'error', error: { name: 'RateLimit', message: '429 from provider' } }),
    run({ runId: 'c', status: 'aborted' }),
    run({ runId: 'd', app: 'support-bot', serverSource: 'import' }),
    heldRun('held', NOW - 1000),
  ].map(summariseRun);
  const facets = facetsOf(rows);

  it('counts what each facet would show', () => {
    expect(facets).toMatchObject({ total: 5, live: 1, held: 1, failed: 2, done: 2 });
    expect(facets.apps).toEqual([
      { name: 'trip-planner', count: 4 },
      { name: 'support-bot', count: 1 },
    ]);
    expect(facets.sources).toEqual([
      { label: 'live', count: 4 },
      { label: 'imported', count: 1 },
    ]);
  });

  it('filters by status, app and source', () => {
    const ids = (f: Partial<typeof NO_FILTER>) =>
      rows.filter((r) => matchesFilter(r, { ...NO_FILTER, ...f })).map((r) => r.run.runId);
    expect(ids({ status: 'failed' })).toEqual(['b', 'c']);
    expect(ids({ status: 'held' })).toEqual(['held']);
    expect(ids({ status: 'live' })).toEqual(['held']);
    expect(ids({ status: 'done' })).toEqual(['a', 'd']);
    expect(ids({ app: 'support-bot' })).toEqual(['d']);
    expect(ids({ source: 'imported' })).toEqual(['d']);
  });

  it('searches the app, the run id and the error it stopped on', () => {
    const ids = (query: string) =>
      rows.filter((r) => matchesFilter(r, { ...NO_FILTER, query })).map((r) => r.run.runId);
    expect(ids('support')).toEqual(['d']);
    expect(ids('HELD')).toEqual(['held']);
    expect(ids('429')).toEqual(['b']);
    expect(ids('upstream took')).toEqual(['held']);
    expect(ids('   ')).toHaveLength(5);
  });

  it('knows when a filter is in force', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, query: '  ' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, app: 'x' })).toBe(true);
    expect(isFiltering({ ...NO_FILTER, status: 'done' })).toBe(true);
  });
});

describe('shortRunId', () => {
  it('keeps a short id whole, a UUID to its first block, and a long name to its tail', () => {
    expect(shortRunId('run-7')).toBe('run-7');
    expect(shortRunId('3f2a9c10-1b2c-4d5e-8f90-abcdefabcdef')).toBe('3f2a9c10');
    expect(shortRunId('demo-trip-planner-2026-11-04T15')).toBe('…6-11-04T15');
  });
});

describe('canGroupByApp', () => {
  const facetsOfApps = (names: string[]) =>
    facetsOf(names.map((app, i) => summariseRun(run({ runId: `r${i}`, app }))));

  it('is offered only when more than one app is on the list', () => {
    expect(canGroupByApp(facetsOfApps(['a', 'b']), NO_FILTER)).toBe(true);
    expect(canGroupByApp(facetsOfApps(['a', 'a']), NO_FILTER)).toBe(false);
    expect(canGroupByApp(facetsOfApps([]), NO_FILTER)).toBe(false);
  });

  it('is withdrawn once a filter has narrowed the list to one app', () => {
    const facets = facetsOfApps(['a', 'b']);
    expect(canGroupByApp(facets, { ...NO_FILTER, app: 'a' })).toBe(false);
    // A status filter does not narrow the apps, so it still applies.
    expect(canGroupByApp(facets, { ...NO_FILTER, status: 'done' })).toBe(true);
  });
});
