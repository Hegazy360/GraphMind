/**
 * What this run did, in one line, above its graph.
 *
 * Four figures — how big, did it fail, how long, what did it cost — plus the
 * two things you put on top of a graph: a filter and the full set of totals.
 * It is part of the run place, not global chrome: on the runs list or a node
 * there is no run for it to describe, and it is simply not there.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { copyText, deepLink } from '../lib/commands.js';
import { fmtCost, fmtCount, fmtDuration, fmtTokens } from '../lib/format.js';
import { KIND_ORDER, kindMeta } from '../lib/kinds.js';
import { detailCells, inputLabel, inputTitle } from '../lib/usage.js';
import { useDismissable } from '../hooks/useDismissable.js';
import { filterSummary, isFilterActive, type StatusFilter } from '../store/filters.js';
import { useRunStore } from '../store/runStore.js';
import { runStats } from '../store/stats.js';
import { runBadgeStatus, type RunBadgeStatus } from '../store/types.js';
import { useUiStore } from '../store/uiStore.js';
import { costTotalTitle, useRunCost } from './costHooks.js';
import { IconFilter, IconLink } from './Icons.js';
import { KindGlyph } from './KindMark.js';

const STATUSES: { value: StatusFilter; label: string; hint: string }[] = [
  { value: 'error', label: 'Errored', hint: 'Nodes that threw' },
  { value: 'paused', label: 'Paused', hint: 'Held at a gate right now' },
  { value: 'running', label: 'Running', hint: 'Currently executing' },
  { value: 'slow', label: 'Slow', hint: 'p90 duration and above, for this run' },
];

function statusPillClass(status: RunBadgeStatus): string {
  switch (status) {
    case 'running':
      return 'gm-pill gm-pill--running';
    case 'paused':
      return 'gm-pill gm-pill--paused';
    case 'ok':
      return 'gm-pill gm-pill--ok';
    case 'error':
      return 'gm-pill gm-pill--error';
    default:
      return 'gm-pill gm-pill--idle';
  }
}

function statusLabel(status: RunBadgeStatus): string {
  return status === 'ok' ? 'done' : status === 'pending' ? 'waiting' : status;
}

/**
 * Which figure the strip sheds first when it runs out of room: lowest
 * first. The est. cost and an error count go last — a cost cut to "$0" reads
 * as free, which is worse than no figure. Nothing shed here is lost; all of
 * it is in Totals.
 */
const STAT_PRIORITY = { nodes: 30, wall: 60, cost: 70, errors: 80 } as const;

/**
 * Fit the figures into the room the strip leaves them: show every one, then
 * shed the lowest priority until the row fits.
 */
export function fitStats(box: HTMLElement): void {
  const row = box.firstElementChild;
  if (!(row instanceof HTMLElement)) return;
  const items = Array.from(row.querySelectorAll<HTMLElement>('[data-priority]'));
  for (const item of items) item.hidden = false;
  const order = [...items].sort(
    (a, b) => Number(a.dataset['priority']) - Number(b.dataset['priority']),
  );
  for (const item of order) {
    if (row.offsetWidth <= box.clientWidth) break;
    item.hidden = true;
  }
}

function Stat({
  value,
  label,
  tone,
  title,
  priority,
}: {
  value: string;
  label: string;
  tone?: 'error';
  title?: string;
  priority: number;
}) {
  return (
    <div
      className={`gm-stat${tone === 'error' ? ' gm-stat--error' : ''}`}
      title={title ?? label}
      data-priority={priority}
    >
      <span className="gm-stat-value">{value}</span>
      <span className="gm-stat-label">{label}</span>
    </div>
  );
}

function TotalCell({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'error' | 'dim';
  title?: string | undefined;
}) {
  return (
    <div
      className={`gm-inspect-stat${tone !== undefined ? ` gm-inspect-stat--${tone}` : ''}`}
      {...(title !== undefined && title !== '' ? { title } : {})}
    >
      <span className="gm-inspect-stat-value">{value}</span>
      <span className="gm-inspect-stat-label">{label}</span>
    </div>
  );
}

/** Everything the run reported, whole, with room for its units. */
function RunTotals({
  stats,
  runCost,
}: {
  stats: ReturnType<typeof runStats>;
  runCost: ReturnType<typeof useRunCost>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, () => setOpen(false), ref);

  return (
    <div className="gm-popover-host" ref={ref}>
      <button
        className={`gm-toolbtn gm-toolbtn--quiet${open ? ' gm-toolbtn--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Every figure this run reported"
      >
        <span className="gm-toolbtn-label">Totals</span>
      </button>
      {open && (
        <div className="gm-popover gm-popover--totals" role="dialog" aria-label="Run totals">
          <div className="gm-section-label">Shape</div>
          <div className="gm-inspect-stats">
            <TotalCell label="nodes" value={fmtCount(stats.nodes)} />
            <TotalCell label="llm steps" value={fmtCount(stats.steps)} />
            <TotalCell label="tool calls" value={fmtCount(stats.tools)} />
            <TotalCell
              label={stats.errors === 1 ? 'error' : 'errors'}
              value={fmtCount(stats.errors)}
              tone={stats.errors > 0 ? 'error' : 'dim'}
            />
          </div>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Time
          </div>
          <div className="gm-inspect-stats">
            <TotalCell label="wall" value={fmtDuration(stats.wallMs)} />
            <TotalCell label="running" value={fmtDuration(stats.ranMs)} />
            <TotalCell
              label="held at gates"
              value={fmtDuration(stats.heldMs)}
              tone="dim"
              title="Time a gate held execution — not run time"
            />
          </div>

          {stats.tokensIn + stats.tokensOut > 0 && (
            <>
              <div className="gm-section-label" style={{ marginTop: 12 }}>
                Tokens
              </div>
              <div className="gm-inspect-stats">
                <TotalCell
                  label={inputLabel(stats.tokenBasis)}
                  value={fmtTokens(stats.tokensIn)}
                  title={inputTitle(stats.tokenBasis)}
                />
                <TotalCell label="out" value={fmtTokens(stats.tokensOut)} />
                {detailCells(stats).map((cell) => (
                  <TotalCell
                    key={cell.label}
                    label={cell.label}
                    value={cell.value}
                    title={cell.title}
                    tone="dim"
                  />
                ))}
              </div>
            </>
          )}

          {runCost !== undefined && (
            <div className="gm-popover-foot">
              <span className="gm-filter-hint">
                {costTotalTitle(runCost, 'LLM step')} Token counts come from the run; prices do not.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterPopover({ runId }: { runId: string }) {
  const filters = useUiStore((s) => s.filters);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, () => setOpen(false), ref);

  const active = isFilterActive(filters);
  const ui = useUiStore.getState();

  return (
    <div className="gm-popover-host" ref={ref}>
      <button
        className={`gm-toolbtn${active ? ' gm-toolbtn--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter the canvas"
      >
        <IconFilter />
        <span className="gm-toolbtn-label">{active ? filterSummary(filters) : 'Filter'}</span>
      </button>
      {open && (
        <div className="gm-popover" role="dialog" aria-label="Canvas filters">
          <div className="gm-section-label">Focus</div>
          <button
            className={`gm-filter-row${filters.errorPathOnly ? ' gm-filter-row--on' : ''}`}
            onClick={() => ui.toggleErrorPath()}
          >
            <span className="gm-dot gm-dot--error" />
            Only the error path
            <span className="gm-filter-hint">dims everything not upstream of a failure</span>
          </button>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Status
          </div>
          <div className="gm-filter-chips">
            {STATUSES.map((entry) => (
              <button
                key={entry.value}
                className={`gm-chip gm-chip--button${filters.status === entry.value ? ' gm-chip--on' : ''}`}
                title={entry.hint}
                onClick={() => ui.setStatusFilter(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Kind
          </div>
          <div className="gm-filter-chips">
            {KIND_ORDER.map((kind) => {
              const on = filters.kinds !== null && filters.kinds.includes(kind);
              return (
                <button
                  key={kind}
                  className={`gm-chip gm-chip--button gm-chip--kind gm-kind--${kind}${on ? ' gm-chip--on' : ''}`}
                  title={kindMeta(kind).hint}
                  onClick={() => ui.toggleKindFilter(kind)}
                >
                  <KindGlyph kind={kind} size={10} />
                  {kind}
                </button>
              );
            })}
          </div>

          <div className="gm-popover-foot">
            <button className="gm-action" onClick={() => ui.clearFilters()}>
              Clear filters
            </button>
            <span className="gm-filter-hint">filters dim, never hide — run {runId.slice(0, 10)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function RunSummary({ runId }: { runId: string }) {
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const [copied, setCopied] = useState(false);
  const runCost = useRunCost(runId);

  const stats = (() => {
    void statusVersion;
    const run = useRunStore.getState().runs[runId];
    return run === undefined ? undefined : runStats(run);
  })();
  const run = useRunStore.getState().runs[runId];
  const badge = run === undefined ? 'pending' : runBadgeStatus(run);

  const statsBox = useRef<HTMLDivElement>(null);
  const fitKey =
    stats === undefined
      ? ''
      : [stats.nodes, stats.errors, stats.wallMs, runCost?.total].map(String).join('|');
  useLayoutEffect(() => {
    const box = statsBox.current;
    if (box === null) return;
    fitStats(box);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitStats(box));
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitKey]);

  const copyLink = async () => {
    const ok = await copyText(deepLink(runId, undefined));
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="gm-runsummary">
      <span className={statusPillClass(badge)}>{statusLabel(badge)}</span>

      {stats !== undefined && (
        <>
          <div className="gm-topbar-stats" aria-label="Run statistics" ref={statsBox}>
            <div className="gm-topbar-stats-row">
              <Stat value={fmtCount(stats.nodes)} label="nodes" priority={STAT_PRIORITY.nodes} />
              {stats.errors > 0 && (
                <Stat
                  value={fmtCount(stats.errors)}
                  label={stats.errors === 1 ? 'error' : 'errors'}
                  tone="error"
                  priority={STAT_PRIORITY.errors}
                />
              )}
              <Stat
                value={fmtDuration(stats.wallMs)}
                label="wall"
                priority={STAT_PRIORITY.wall}
                {...(stats.heldMs > 0
                  ? {
                      title: `${fmtDuration(stats.ranMs)} running · ${fmtDuration(stats.heldMs)} held at gates`,
                    }
                  : {})}
              />
              {runCost !== undefined && (
                <Stat
                  value={fmtCost(runCost.total)}
                  label="est. cost"
                  priority={STAT_PRIORITY.cost}
                  title={`${costTotalTitle(runCost, 'LLM step')} Token counts come from the run; prices do not.`}
                />
              )}
            </div>
          </div>
          <RunTotals stats={stats} runCost={runCost} />
        </>
      )}

      <div className="gm-runsummary-end">
        <button
          className="gm-linkbtn gm-linkbtn--icon"
          onClick={() => void copyLink()}
          title={`Copy a deep link to this run — ${runId}`}
          aria-label="Copy a deep link to this run"
        >
          <IconLink />
          {copied && <span className="gm-linkbtn-flash">copied</span>}
        </button>
        <FilterPopover runId={runId} />
      </div>
    </div>
  );
}
