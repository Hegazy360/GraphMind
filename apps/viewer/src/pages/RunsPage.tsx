/**
 * Step one: which run?
 *
 * The server replays everything it has kept, and that used to land here as
 * one flat column of cards, newest first, with no way to tell a morning's
 * work from last week's or one app's runs from another's. This is the same
 * list, structured (lib/runList.ts decides how):
 *
 *   - a strip of facets across the top says how the history went — how
 *     many are live, held, failed, done — and each is a filter;
 *   - what is happening now is pinned above the history;
 *   - the history is shelved by day or by app, each shelf with its own
 *     tally, long shelves folded to a preview;
 *   - every row is a table row, not a card: the figures line up in
 *     columns, so a run's size, time, tokens and cost can be compared with
 *     the one above it rather than read out of a sentence.
 */
import { useEffect, useMemo, useState } from 'react';
import { runHeldMs } from '../lib/duration.js';
import { fmtCost, fmtCount, fmtDuration, fmtRelative, fmtTokens } from '../lib/format.js';
import {
  NO_FILTER,
  SHELF_PREVIEW,
  facetsOf,
  groupRuns,
  isFiltering,
  matchesFilter,
  shortRunId,
  summariseRun,
  type Facets,
  type GroupBy,
  type RunFilter,
  type RunGroup,
  type RunRow,
  type StatusFacet,
} from '../lib/runList.js';
import { useRunStore } from '../store/runStore.js';
import { runStats } from '../store/stats.js';
import { useUiStore } from '../store/uiStore.js';
import type { RunBadgeStatus } from '../store/types.js';
import { EmptyState } from '../components/EmptyState.js';
import { costTotalTitle, useRunCost } from '../components/costHooks.js';
import {
  IconArrowRight,
  IconChevron,
  IconClose,
  IconCompass,
  IconPlus,
  IconSearch,
} from '../components/Icons.js';

function dotClass(status: RunBadgeStatus): string {
  switch (status) {
    case 'running':
      return 'gm-dot gm-dot--running';
    case 'paused':
      return 'gm-dot gm-dot--paused';
    case 'ok':
      return 'gm-dot gm-dot--ok';
    case 'error':
      return 'gm-dot gm-dot--error';
    default:
      return 'gm-dot';
  }
}

function statusLabel(status: RunBadgeStatus): string {
  switch (status) {
    case 'pending':
      return 'waiting';
    case 'ok':
      return 'done';
    case 'paused':
      return 'held';
    default:
      return status;
  }
}

/** The full start time, for a row's hover: the relative form loses the day. */
function fmtStarted(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * When a run started, as the column reads it: relative while it is recent,
 * then the day and the time — `Nov 1, 14:02` says more on a "Yesterday"
 * shelf than `11/1/2026` does, and the year only when it is not this one.
 */
function fmtWhen(ts: number, now: number): string {
  if (now - ts < 86_400_000) return fmtRelative(ts, now);
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

function plural(n: number, noun: string): string {
  return `${fmtCount(n)} ${noun}${n === 1 ? '' : 's'}`;
}

// ── one row ────────────────────────────────────────────────────────────────

function RunRowView({ row, now }: { row: RunRow; now: number }) {
  const { run, status, failure } = row;
  const stats = useMemo(
    () => runStats(run, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusVersion is the change signal; `now` only moves a live run's wall time
    [run.runId, run.statusVersion, status === 'ok' || status === 'error' || status === 'aborted' ? 0 : now],
  );
  const cost = useRunCost(run.runId);

  // Held time is not run time: a run someone sat on for a minute at a
  // breakpoint is not a minute-long run.
  const elapsed =
    run.meta.startedTs === undefined ? undefined : (run.meta.finishedTs ?? now) - run.meta.startedTs;
  const held = elapsed === undefined ? 0 : Math.min(elapsed, runHeldMs(run, run.meta.finishedTs ?? now));
  const ran = elapsed === undefined ? undefined : Math.max(0, elapsed - held);
  const tokens = stats.tokensIn + stats.tokensOut;

  return (
    <button
      className={`gm-runcard gm-runcard--${status}${failure !== undefined ? ' gm-runcard--failed' : ''}`}
      onClick={() => useUiStore.getState().selectRun(run.runId)}
    >
      <span className="gm-runcard-dotcell">
        <span className={dotClass(status)} />
      </span>

      <span className="gm-runcard-name">
        <span className="gm-runcard-app">{run.meta.app}</span>
        <span className="gm-runcard-id gm-mono" title={run.runId}>
          {shortRunId(run.runId)}
        </span>
        <span className={`gm-runcard-status gm-runcard-status--${status}`}>{statusLabel(status)}</span>
        {row.source !== 'live' && <span className="gm-chip gm-chip--tiny">{row.source}</span>}
      </span>

      {/* The figures. `display: contents` keeps them in the grid while the
          wrapper stays the one hook the tests and the audit use. */}
      <span className="gm-runcard-meta">
        <span className="gm-runcard-cell gm-runcard-shape">
          {stats.nodes > 0 ? (
            <>
              <span>{plural(stats.nodes, 'node')}</span>
              {/* Abbreviated, because this cell holds four figures and the
                  column is a column: the hover spells each one out. */}
              {stats.steps > 0 && (
                <span className="gm-runcard-sub" title={plural(stats.steps, 'llm step')}>
                  {fmtCount(stats.steps)} llm
                </span>
              )}
              {stats.tools > 0 && (
                <span className="gm-runcard-sub" title={plural(stats.tools, 'tool call')}>
                  {fmtCount(stats.tools)} tools
                </span>
              )}
              {stats.errors > 0 && (
                <span className="gm-runcard-errors" title={plural(stats.errors, 'failed call')}>
                  {fmtCount(stats.errors)} err
                </span>
              )}
            </>
          ) : (
            <span className="gm-runcard-none">—</span>
          )}
        </span>

        <span className="gm-runcard-cell gm-runcard-took">
          {ran !== undefined ? (
            <span
              {...(held > 0
                ? { title: `${fmtDuration(elapsed ?? 0)} wall · ${fmtDuration(held)} held at gates` }
                : {})}
            >
              {fmtDuration(ran)}
            </span>
          ) : (
            <span className="gm-runcard-none">—</span>
          )}
          {held > 0 && <span className="gm-runcard-held">+{fmtDuration(held)} held</span>}
        </span>

        <span className="gm-runcard-cell gm-runcard-spend">
          {tokens > 0 ? (
            <span title={`${fmtCount(stats.tokensIn)} in · ${fmtCount(stats.tokensOut)} out`}>
              {fmtTokens(tokens)} tok
            </span>
          ) : (
            <span className="gm-runcard-none">—</span>
          )}
          {cost !== undefined && (
            <span className="gm-runcard-cost" title={costTotalTitle(cost, 'step')}>
              {fmtCost(cost.total)}
            </span>
          )}
        </span>
      </span>

      <span className="gm-runcard-when">
        {run.meta.startedTs !== undefined && (
          <span title={fmtStarted(run.meta.startedTs)}>{fmtWhen(run.meta.startedTs, now)}</span>
        )}
      </span>
      <IconArrowRight className="gm-runcard-go" width={14} height={14} />

      {/* The one line that decides whether you open this run or the next. */}
      {failure !== undefined && (
        <span className={`gm-runcard-error${failure.held ? ' gm-runcard-error--held' : ''}`}>
          {failure.held ? 'Held on ' : ''}
          {failure.text}
        </span>
      )}
    </button>
  );
}

// ── one shelf ──────────────────────────────────────────────────────────────

function Shelf({
  group,
  now,
  expanded,
  onToggle,
}: {
  group: RunGroup;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const folded = !group.live && !expanded && group.rows.length > SHELF_PREVIEW;
  const rows = folded ? group.rows.slice(0, SHELF_PREVIEW) : group.rows;
  const hidden = group.rows.length - rows.length;
  return (
    <section className={`gm-shelf${group.live ? ' gm-shelf--live' : ''}`} aria-label={group.label}>
      <header className="gm-shelf-head">
        <h2>{group.label}</h2>
        <span className="gm-shelf-tally">
          <span>{plural(group.rows.length, 'run')}</span>
          {group.held > 0 && <span className="gm-shelf-tally--held">{group.held} held</span>}
          {group.running > 0 && <span>{group.running} running</span>}
          {group.failed > 0 && <span className="gm-shelf-tally--failed">{group.failed} failed</span>}
        </span>
      </header>
      <div className="gm-shelf-rows">
        {rows.map((row) => (
          <RunRowView key={row.run.runId} row={row} now={now} />
        ))}
      </div>
      {(folded || (expanded && group.rows.length > SHELF_PREVIEW)) && (
        <button className="gm-shelf-more" onClick={onToggle}>
          <IconChevron
            width={12}
            height={12}
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          />
          {folded ? `Show ${hidden} more` : 'Show fewer'}
        </button>
      )}
    </section>
  );
}

// ── the facets ─────────────────────────────────────────────────────────────

const STATUS_FACETS: { value: StatusFacet; label: string; count: (f: Facets) => number; hint: string }[] = [
  { value: 'all', label: 'All', count: (f) => f.total, hint: 'Every run the server has kept' },
  { value: 'live', label: 'Live', count: (f) => f.live, hint: 'Running right now, or held' },
  { value: 'held', label: 'Held', count: (f) => f.held, hint: 'Stopped at a gate, waiting on you' },
  { value: 'failed', label: 'Failed', count: (f) => f.failed, hint: 'Ended in an error, or aborted' },
  { value: 'done', label: 'Done', count: (f) => f.done, hint: 'Finished cleanly' },
];

function FacetBar({
  facets,
  filter,
  onChange,
}: {
  facets: Facets;
  filter: RunFilter;
  onChange: (next: RunFilter) => void;
}) {
  return (
    <div className="gm-facets" role="group" aria-label="Filter by status">
      {STATUS_FACETS.map((facet) => {
        const count = facet.count(facets);
        // A facet with nothing behind it is still shown, greyed: the row of
        // five is the shape of the page, and "Held 0" is itself information.
        const on = filter.status === facet.value;
        return (
          <button
            key={facet.value}
            className={`gm-facet gm-facet--${facet.value}${on ? ' gm-facet--on' : ''}${count === 0 ? ' gm-facet--none' : ''}`}
            title={facet.hint}
            aria-pressed={on}
            onClick={() => onChange({ ...filter, status: on ? 'all' : facet.value })}
          >
            <span className="gm-facet-count">{fmtCount(count)}</span>
            <span className="gm-facet-label">{facet.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Pick one of a short list of values — chips when there are few, a menu when many. */
function PickOne({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; count: number }[];
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  if (options.length <= 1) return null;
  if (options.length > 6) {
    return (
      <label className="gm-pick gm-pick--menu">
        <span className="gm-pick-label">{label}</span>
        <select
          value={value ?? ''}
          aria-label={`Filter by ${label.toLowerCase()}`}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        >
          <option value="">All ({options.length})</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value} ({option.count})
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div className="gm-pick" role="group" aria-label={`Filter by ${label.toLowerCase()}`}>
      <span className="gm-pick-label">{label}</span>
      {options.map((option) => {
        const on = value === option.value;
        return (
          <button
            key={option.value}
            className={`gm-chip gm-chip--button${on ? ' gm-chip--on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(on ? undefined : option.value)}
          >
            {option.value}
            <span className="gm-pick-count">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── the two things that are not a run ──────────────────────────────────────

/**
 * Connect and Build were a pair of 28px toolbar buttons in the corner of the
 * header, which is where you put a control you already know about. They are
 * not that: for most people arriving here one of the two *is* the next step,
 * and a list of past runs is only the backdrop to it.
 *
 * So they are cards in a column beside the list — which also stops the table
 * running the full width of a wide window, where a row's name and its
 * figures end up a hand apart. The list keeps a reading width and the space
 * that is left does something.
 */
function ActionCard({
  label,
  blurb,
  icon,
  primary,
  onClick,
}: {
  label: string;
  blurb: string;
  icon: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    // The accessible name is the label alone: the blurb is for the eye, and
    // "Build a workflow Describe an agent and get…" is not a button's name.
    <button
      className={`gm-actioncard${primary === true ? ' gm-actioncard--primary' : ''}`}
      aria-label={label}
      onClick={onClick}
    >
      <span className="gm-actioncard-icon">{icon}</span>
      <span className="gm-actioncard-text">
        <span className="gm-actioncard-label">
          {label}
          <IconArrowRight className="gm-actioncard-go" width={13} height={13} />
        </span>
        <span className="gm-actioncard-blurb">{blurb}</span>
      </span>
    </button>
  );
}

function ActionRail({ fixtureAvailable }: { fixtureAvailable: boolean }) {
  return (
    <aside className="gm-runs-rail" aria-label="Start something">
      <h2 className="gm-rail-label">Start something</h2>
      <ActionCard
        primary
        label="Connect an agent"
        blurb="One package and two lines, for the SDK you already use."
        icon={<IconCompass width={17} height={17} />}
        onClick={() => useUiStore.getState().setPage('connect')}
      />
      <ActionCard
        label="Build a workflow"
        blurb="Describe an agent, get instrumented code, run it here."
        icon={<IconPlus width={17} height={17} />}
        onClick={() => useUiStore.getState().setPage('build')}
      />
      {fixtureAvailable && (
        <button
          className="gm-rail-quiet"
          onClick={() => useUiStore.getState().requestDemo()}
          title="A recorded trip-planner session, replayed into this viewer"
        >
          Replay the bundled demo run
        </button>
      )}
    </aside>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

export function RunsPage({ fixtureAvailable }: { fixtureAvailable: boolean }) {
  const runs = useRunStore((s) => s.runs);
  const connection = useUiStore((s) => s.connection);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<RunFilter>(NO_FILTER);
  const [groupBy, setGroupBy] = useState<GroupBy>('time');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => Object.values(runs).map(summariseRun), [runs]);
  const facets = useMemo(() => facetsOf(rows), [rows]);
  const shown = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);
  const groups = useMemo(() => groupRuns(shown, groupBy, now), [shown, groupBy, now]);

  const total = rows.length;

  // Nothing recorded yet: the empty state owns the whole place and says what
  // to do about it, rather than being a card floating beside an empty rail.
  if (total === 0) return <EmptyState fixtureAvailable={fixtureAvailable} />;

  // A filter you can see is a filter you can clear: an app chosen from a
  // menu of twenty is otherwise invisible once the menu closes.
  const filtering = isFiltering(filter);
  const offline = connection === 'off';
  const whence = offline
    ? 'replayed from a recording'
    : 'everything the debugger server has kept';

  return (
    <div className="gm-runs">
      <div className="gm-runs-inner">
        <header className="gm-runs-head">
          <div className="gm-runs-title">
            <h1>Runs</h1>
            <span className="gm-runs-count">
              {plural(total, 'run')}
              {facets.apps.length > 1 ? ` across ${plural(facets.apps.length, 'app')}` : ''} · {whence}
            </span>
          </div>
        </header>

        <div className="gm-runs-body">
          <div className="gm-runs-main">
        <FacetBar facets={facets} filter={filter} onChange={setFilter} />

        <div className="gm-runs-tools">
          <PickOne
            label="App"
            options={facets.apps.map((app) => ({ value: app.name, count: app.count }))}
            value={filter.app}
            onChange={(app) => setFilter({ ...filter, app })}
          />
          <PickOne
            label="Source"
            options={facets.sources.map((source) => ({ value: source.label, count: source.count }))}
            value={filter.source}
            onChange={(source) => setFilter({ ...filter, source })}
          />
          <div className="gm-runs-tools-end">
            <div className="gm-seg" role="group" aria-label="Group runs by">
              <span className="gm-pick-label">Group by</span>
              <button
                className={`gm-seg-btn${groupBy === 'time' ? ' gm-seg-btn--on' : ''}`}
                aria-pressed={groupBy === 'time'}
                onClick={() => setGroupBy('time')}
              >
                Day
              </button>
              <button
                className={`gm-seg-btn${groupBy === 'app' ? ' gm-seg-btn--on' : ''}`}
                aria-pressed={groupBy === 'app'}
                onClick={() => setGroupBy('app')}
              >
                App
              </button>
            </div>
            <div className="gm-runs-search">
              <IconSearch width={13} height={13} />
              <input
                value={filter.query}
                placeholder="Search app, run id or error…"
                spellCheck={false}
                aria-label="Search runs"
                onChange={(event) => setFilter({ ...filter, query: event.target.value })}
              />
              {filter.query !== '' && (
                <button
                  className="gm-runs-search-clear"
                  aria-label="Clear search"
                  onClick={() => setFilter({ ...filter, query: '' })}
                >
                  <IconClose width={11} height={11} />
                </button>
              )}
            </div>
          </div>
        </div>

        {filtering && (
          <div className="gm-runs-showing">
            Showing {plural(shown.length, 'run')} of {total}
            <button className="gm-runs-clear" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          </div>
        )}

        {groups.length === 0 ? (
          <div className="gm-runs-empty">
            No run matches.{' '}
            <button className="gm-runs-clear" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          </div>
        ) : (
          <div className="gm-runs-list">
            <div className="gm-runs-cols" aria-hidden="true">
              <span />
              <span>Run</span>
              <span>Shape</span>
              <span>Took</span>
              <span>Spend</span>
              <span>Started</span>
              <span />
            </div>
            {groups.map((group) => (
              <Shelf
                key={group.key}
                group={group}
                now={now}
                expanded={expanded[group.key] === true}
                onToggle={() => setExpanded((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
              />
            ))}
          </div>
        )}
          </div>

          <ActionRail fixtureAvailable={fixtureAvailable} />
        </div>
      </div>
    </div>
  );
}
