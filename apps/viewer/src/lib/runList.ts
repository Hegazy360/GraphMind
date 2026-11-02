/**
 * The runs list, as data.
 *
 * `graphmind serve` replays everything it has kept — by default the newest
 * two hundred runs from the last thirty days — and the viewer used to pour
 * that straight onto the page as one undifferentiated column, newest first.
 * Forty runs of three apps across a fortnight is not a list you can read;
 * it is a list you scroll.
 *
 * So the list is structured before it is drawn, and the structure is
 * decided here, where it can be tested without a DOM:
 *
 *   - what is happening *now* (running, or held at a gate) is pinned on top,
 *     because a stopped process outranks history;
 *   - the rest is grouped — by when it ran (today, yesterday, this week,
 *     older) or by which app ran it — and each group says how it went;
 *   - the facets (status, app, source) count what they would show, so a
 *     chip reads `Failed 9`, not `Failed`.
 *
 * Nothing here renders. The page maps these results to rows.
 */
import { runChipLabel } from './firstRun.js';
import { runErrorOf } from '../builder/graph.js';
import { runBadgeStatus, type RunBadgeStatus, type RunState } from '../store/types.js';

/** One run, summarised once for the list. Time-dependent figures are not here. */
export interface RunRow {
  run: RunState;
  status: RunBadgeStatus;
  /** The source chip's label: `live`, `imported`, `replay`, `recorded session`. */
  source: string;
  failure: { text: string; held: boolean } | undefined;
}

export function summariseRun(run: RunState): RunRow {
  const status = runBadgeStatus(run);
  let failure = runErrorOf(run);
  // A gate the recording never saw released (an exported run, a stream that
  // finished before its resume arrived) is not "held" once the run is over.
  // The error that ended the run is still the line that matters.
  if (failure?.held === true && !isLive(status)) {
    const error = run.meta.error;
    failure =
      status === 'error' && error !== undefined
        ? { text: `${error.name}: ${error.message}`, held: false }
        : undefined;
  }
  return { run, status, source: runChipLabel(run.meta), failure };
}

/** Is the run still going (or still arriving)? */
export function isLive(status: RunBadgeStatus): boolean {
  return status === 'running' || status === 'paused' || status === 'pending';
}

/** Did it end badly? An aborted run counts: someone stopped it on purpose, which is still not "done". */
export function isFailed(status: RunBadgeStatus): boolean {
  return status === 'error' || status === 'aborted';
}

// ── facets ─────────────────────────────────────────────────────────────────

export type StatusFacet = 'all' | 'live' | 'held' | 'failed' | 'done';

export interface Facets {
  total: number;
  live: number;
  held: number;
  failed: number;
  done: number;
  /** Apps by run count, most runs first; ties by name. */
  apps: { name: string; count: number }[];
  /** Source labels by run count, most first. */
  sources: { label: string; count: number }[];
}

export function facetsOf(rows: readonly RunRow[]): Facets {
  const apps = new Map<string, number>();
  const sources = new Map<string, number>();
  const facets: Facets = { total: rows.length, live: 0, held: 0, failed: 0, done: 0, apps: [], sources: [] };
  for (const row of rows) {
    if (isLive(row.status)) facets.live += 1;
    if (row.status === 'paused') facets.held += 1;
    if (isFailed(row.status)) facets.failed += 1;
    if (row.status === 'ok') facets.done += 1;
    apps.set(row.run.meta.app, (apps.get(row.run.meta.app) ?? 0) + 1);
    sources.set(row.source, (sources.get(row.source) ?? 0) + 1);
  }
  const byCount = (a: [string, number], b: [string, number]): number =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  facets.apps = [...apps.entries()].sort(byCount).map(([name, count]) => ({ name, count }));
  facets.sources = [...sources.entries()].sort(byCount).map(([label, count]) => ({ label, count }));
  return facets;
}

export interface RunFilter {
  status: StatusFacet;
  /** An app name, or undefined for every app. */
  app: string | undefined;
  /** A source label, or undefined for every source. */
  source: string | undefined;
  query: string;
}

export const NO_FILTER: RunFilter = { status: 'all', app: undefined, source: undefined, query: '' };

export function isFiltering(filter: RunFilter): boolean {
  return (
    filter.status !== 'all' ||
    filter.app !== undefined ||
    filter.source !== undefined ||
    filter.query.trim() !== ''
  );
}

function matchesStatus(status: RunBadgeStatus, facet: StatusFacet): boolean {
  switch (facet) {
    case 'all':
      return true;
    case 'live':
      return isLive(status);
    case 'held':
      return status === 'paused';
    case 'failed':
      return isFailed(status);
    case 'done':
      return status === 'ok';
  }
}

/**
 * The search matches the things you remember about a run: the app, the id
 * (or the tail of it you copied from a log), and the error it stopped on.
 */
export function matchesFilter(row: RunRow, filter: RunFilter): boolean {
  if (!matchesStatus(row.status, filter.status)) return false;
  if (filter.app !== undefined && row.run.meta.app !== filter.app) return false;
  if (filter.source !== undefined && row.source !== filter.source) return false;
  const needle = filter.query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    row.run.meta.app.toLowerCase().includes(needle) ||
    row.run.runId.toLowerCase().includes(needle) ||
    (row.failure?.text.toLowerCase().includes(needle) ?? false)
  );
}

// ── grouping ───────────────────────────────────────────────────────────────

export type GroupBy = 'time' | 'app';

export type TimeBucket = 'live' | 'today' | 'yesterday' | 'week' | 'older';

const DAY_MS = 86_400_000;

/** Local midnight of the day `now` falls in. */
function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Which shelf a run sits on. Live runs are their own shelf whatever the
 * clock says; everything else is by the day it *started*, in local time.
 * A run with no start (a stub the replay has not reached) is "older", not
 * "today": claiming recency for something unknown is the wrong guess.
 */
export function timeBucket(row: RunRow, now: number): TimeBucket {
  if (isLive(row.status)) return 'live';
  const started = row.run.meta.startedTs;
  if (started === undefined) return 'older';
  const today = startOfDay(now);
  if (started >= today) return 'today';
  if (started >= today - DAY_MS) return 'yesterday';
  if (started >= today - 6 * DAY_MS) return 'week';
  return 'older';
}

export const TIME_BUCKET_ORDER: readonly TimeBucket[] = ['live', 'today', 'yesterday', 'week', 'older'];

export const TIME_BUCKET_LABEL: Record<TimeBucket, string> = {
  live: 'Live now',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Earlier this week',
  older: 'Older',
};

export interface RunGroup {
  /** Stable key for React and for remembering which groups are expanded. */
  key: string;
  label: string;
  /** The pinned "happening now" shelf — never truncated. */
  live: boolean;
  rows: RunRow[];
  /** How the group went, for its heading. */
  failed: number;
  held: number;
  running: number;
}

/**
 * Within a shelf, newest first — except on the live shelf, where a held run
 * comes before a running one: it is the one waiting on you.
 */
function compareRows(a: RunRow, b: RunRow): number {
  const heldA = a.status === 'paused' ? 0 : 1;
  const heldB = b.status === 'paused' ? 0 : 1;
  if (heldA !== heldB) return heldA - heldB;
  return (b.run.meta.startedTs ?? 0) - (a.run.meta.startedTs ?? 0);
}

function tally(group: RunGroup): RunGroup {
  for (const row of group.rows) {
    if (isFailed(row.status)) group.failed += 1;
    if (row.status === 'paused') group.held += 1;
    if (row.status === 'running' || row.status === 'pending') group.running += 1;
  }
  group.rows.sort(compareRows);
  return group;
}

function emptyGroup(key: string, label: string, live: boolean): RunGroup {
  return { key, label, live, rows: [], failed: 0, held: 0, running: 0 };
}

/**
 * The shelves, in reading order, empty ones left out. Live runs are pinned
 * on top in both modes: on the app shelf they would otherwise be buried
 * under whichever app happens to have run most recently.
 */
export function groupRuns(rows: readonly RunRow[], by: GroupBy, now: number): RunGroup[] {
  if (by === 'time') {
    const buckets = new Map<TimeBucket, RunGroup>();
    for (const row of rows) {
      const bucket = timeBucket(row, now);
      let group = buckets.get(bucket);
      if (group === undefined) {
        group = emptyGroup(bucket, TIME_BUCKET_LABEL[bucket], bucket === 'live');
        buckets.set(bucket, group);
      }
      group.rows.push(row);
    }
    const out: RunGroup[] = [];
    for (const bucket of TIME_BUCKET_ORDER) {
      const group = buckets.get(bucket);
      if (group !== undefined) out.push(tally(group));
    }
    return out;
  }

  const live = emptyGroup('live', TIME_BUCKET_LABEL.live, true);
  const apps = new Map<string, RunGroup>();
  for (const row of rows) {
    if (isLive(row.status)) {
      live.rows.push(row);
      continue;
    }
    const app = row.run.meta.app;
    let group = apps.get(app);
    if (group === undefined) {
      group = emptyGroup(`app:${app}`, app, false);
      apps.set(app, group);
    }
    group.rows.push(row);
  }
  const latest = (group: RunGroup): number =>
    group.rows.reduce((max, row) => Math.max(max, row.run.meta.startedTs ?? 0), 0);
  const shelves = [...apps.values()].map(tally).sort((a, b) => latest(b) - latest(a) || a.label.localeCompare(b.label));
  return live.rows.length > 0 ? [tally(live), ...shelves] : shelves;
}

/** How many rows a history shelf shows before it asks you to unfold it. */
export const SHELF_PREVIEW = 8;

/**
 * The short form of a run id — enough to tell two runs of one app apart,
 * not so much it crowds the name. A readable id (`demo-trip-planner-3`)
 * keeps its tail; a 36-character UUID is cut to its first block.
 */
export function shortRunId(runId: string): string {
  if (runId.length <= 14) return runId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.exec(runId);
  if (uuid !== null) return runId.slice(0, 8);
  return `…${runId.slice(-10)}`;
}
