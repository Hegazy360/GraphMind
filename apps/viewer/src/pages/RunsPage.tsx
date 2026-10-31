/**
 * Step one: which run?
 *
 * This was a 244px rail pinned beside the canvas, permanently spending a
 * sixth of the window on a question you answer once. As a place of its own
 * it gets the whole width, so a run can say what it actually was — the app,
 * how it ended, how big, how long, what it cost, and the error it stopped on
 * — instead of being a truncated line.
 */
import { useEffect, useMemo, useState } from 'react';
import { runHeldMs } from '../lib/duration.js';
import { runChipLabel } from '../lib/firstRun.js';
import { fmtCount, fmtDuration, fmtRelative } from '../lib/format.js';
import { runErrorOf } from '../builder/model.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { runBadgeStatus, type RunBadgeStatus, type RunState } from '../store/types.js';
import { EmptyState } from '../components/EmptyState.js';
import { IconArrowRight, IconCompass, IconPlus, IconSearch } from '../components/Icons.js';

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
    default:
      return status;
  }
}

function RunCard({ run, now }: { run: RunState; now: number }) {
  const status = runBadgeStatus(run);
  const errors = useMemo(() => {
    let count = 0;
    for (const id of run.order) if (run.nodes[id]?.lastError !== undefined) count += 1;
    return count;
  }, [run]);

  // Held time is not run time: a run someone sat on for a minute at a
  // breakpoint is not a minute-long run.
  const elapsed =
    run.meta.startedTs === undefined ? undefined : (run.meta.finishedTs ?? now) - run.meta.startedTs;
  const held = elapsed === undefined ? 0 : Math.min(elapsed, runHeldMs(run, run.meta.finishedTs ?? now));
  const ran = elapsed === undefined ? undefined : Math.max(0, elapsed - held);
  const failure = runErrorOf(run);

  return (
    <button
      className={`gm-runcard gm-runcard--${status}`}
      onClick={() => useUiStore.getState().selectRun(run.runId)}
    >
      <div className="gm-runcard-top">
        <span className={dotClass(status)} />
        <span className="gm-runcard-app">{run.meta.app}</span>
        <span className={`gm-runcard-status gm-runcard-status--${status}`}>
          {statusLabel(status)}
        </span>
        <span className="gm-chip gm-chip--tiny">{runChipLabel(run.meta)}</span>
        {run.meta.startedTs !== undefined && (
          <span className="gm-runcard-when">{fmtRelative(run.meta.startedTs, now)}</span>
        )}
        <IconArrowRight className="gm-runcard-go" width={14} height={14} />
      </div>

      <div className="gm-runcard-meta">
        {run.order.length > 0 && <span>{fmtCount(run.order.length)} nodes</span>}
        {errors > 0 && (
          <span className="gm-runcard-errors">
            {errors} {errors === 1 ? 'error' : 'errors'}
          </span>
        )}
        {ran !== undefined && (
          <span
            {...(held > 0
              ? { title: `${fmtDuration(elapsed ?? 0)} wall · ${fmtDuration(held)} held at gates` }
              : {})}
          >
            {fmtDuration(ran)}
          </span>
        )}
        {held > 0 && <span className="gm-runcard-held">{fmtDuration(held)} held</span>}
      </div>

      {/* The one line that decides whether you open this run or the next. */}
      {failure !== undefined && (
        <div className={`gm-runcard-error${failure.held ? ' gm-runcard-error--held' : ''}`}>
          {failure.held ? 'Held on ' : ''}
          {failure.text}
        </div>
      )}
    </button>
  );
}

export function RunsPage({ fixtureAvailable }: { fixtureAvailable: boolean }) {
  const runs = useRunStore((s) => s.runs);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const sorted = useMemo(() => {
    const list = Object.values(runs).sort((a, b) => (b.meta.startedTs ?? 0) - (a.meta.startedTs ?? 0));
    const needle = query.trim().toLowerCase();
    if (needle === '') return list;
    return list.filter(
      (run) =>
        run.meta.app.toLowerCase().includes(needle) || run.runId.toLowerCase().includes(needle),
    );
  }, [runs, query]);

  const total = Object.keys(runs).length;

  // Nothing recorded yet: the empty state owns the whole place and says what
  // to do about it, rather than being a card floating beside an empty rail.
  if (total === 0) return <EmptyState fixtureAvailable={fixtureAvailable} />;

  return (
    <div className="gm-runs">
      <div className="gm-runs-inner">
        <header className="gm-runs-head">
          <h1>Runs</h1>
          <span className="gm-runs-count">
            {total} recorded{total > 0 ? ' · newest first' : ''}
          </span>
          {/* The two things that are not a run. They lived in the rail; the
              rail was the price of keeping them one click away on every
              screen, and this is the screen they actually belong on. */}
          <div className="gm-runs-actions">
            <button
              className="gm-toolbtn"
              onClick={() => useUiStore.getState().setPage('connect')}
              title="The install command and the two lines, for your SDK"
            >
              <IconCompass />
              <span className="gm-toolbtn-label">Connect an agent</span>
            </button>
            <button
              className="gm-toolbtn"
              onClick={() => useUiStore.getState().setPage('build')}
              title="Describe an agent, get the instrumented code in your language, create and run it here"
            >
              <IconPlus />
              <span className="gm-toolbtn-label">Build a workflow</span>
            </button>
          </div>
          {total > 5 && (
            <div className="gm-runs-search">
              <IconSearch width={13} height={13} />
              <input
                value={query}
                placeholder="Filter by app or run id…"
                spellCheck={false}
                aria-label="Filter runs"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}
        </header>

        {sorted.length === 0 ? (
          <div className="gm-runs-empty">No run matches that filter.</div>
        ) : (
          <div className="gm-runs-list">
            {sorted.map((run) => (
              <RunCard key={run.runId} run={run} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
