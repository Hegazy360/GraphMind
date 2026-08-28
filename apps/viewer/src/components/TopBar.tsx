/**
 * The canvas toolbar: what run am I looking at, how big is it, what is it
 * costing, and every lens I can put on it (filters, error-path focus, graph
 * vs timeline). Density is deliberate — this is a developer tool, not a
 * landing page.
 */
import { useEffect, useRef, useState } from 'react';
import { copyText, deepLink } from '../lib/commands.js';
import { KIND_ORDER, kindMeta } from '../lib/kinds.js';
import { fmtCost, fmtCount, fmtDuration, fmtTokens } from '../lib/format.js';
import { nextTheme, themeLabel } from '../lib/theme.js';
import { filterSummary, isFilterActive, type StatusFilter } from '../store/filters.js';
import { useRunStore } from '../store/runStore.js';
import { runStats } from '../store/stats.js';
import { runBadgeStatus, type RunBadgeStatus } from '../store/types.js';
import { collapsedFor, useUiStore } from '../store/uiStore.js';
import { collapsibleRoots } from '../store/collapse.js';
import { KindGlyph } from './KindMark.js';
import {
  IconCollapse,
  IconExpand,
  IconFilter,
  IconGraph,
  IconLink,
  IconMoon,
  IconSearch,
  IconSplit,
  IconSun,
  IconTheme,
  IconTimeline,
} from './Icons.js';

/**
 * Every kind the wire contract can carry, in one order (lib/kinds.ts). The
 * MCP trio used to be missing here, which meant a run full of `server` and
 * `resource` nodes could not be filtered at all.
 */
const KINDS = KIND_ORDER;
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

function FilterPopover({ runId }: { runId: string }) {
  const filters = useUiStore((s) => s.filters);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
            {KINDS.map((kind) => {
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
            <span className="gm-filter-hint">
              filters dim, never hide — run {runId.slice(0, 10)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TopBar({ runId }: { runId: string }) {
  const view = useUiStore((s) => s.view);
  const theme = useUiStore((s) => s.theme);
  const collapsedCount = useUiStore((s) => collapsedFor(s, runId).length);
  const statusVersion = useRunStore((s) => s.runs[runId]?.statusVersion ?? 0);
  const meta = useRunStore((s) => s.runs[runId]?.meta);
  const [copied, setCopied] = useState(false);

  const stats = (() => {
    void statusVersion;
    const run = useRunStore.getState().runs[runId];
    return run === undefined ? undefined : runStats(run);
  })();
  const run = useRunStore.getState().runs[runId];
  const badge = run === undefined ? 'pending' : runBadgeStatus(run);

  const copyLink = async () => {
    const ok = await copyText(deepLink(runId, useUiStore.getState().selectedNodeId));
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const toggleCollapseAll = () => {
    const ui = useUiStore.getState();
    if (collapsedCount > 0) ui.expandAll(runId);
    else {
      const current = useRunStore.getState().runs[runId];
      if (current !== undefined) ui.setCollapsed(runId, collapsibleRoots(current));
    }
  };

  return (
    <header className="gm-topbar">
      <div className="gm-topbar-title">
        <span className={statusPillClass(badge)}>{statusLabel(badge)}</span>
        <h1>{meta?.app ?? runId}</h1>
        <button className="gm-linkbtn" onClick={() => void copyLink()} title="Copy a deep link to this view">
          <IconLink />
          {copied ? 'copied' : runId.slice(0, 18)}
        </button>
      </div>

      {stats !== undefined && (
        <div className="gm-topbar-stats" aria-label="Run statistics">
          <Stat value={fmtCount(stats.nodes)} label="nodes" />
          <Stat value={fmtCount(stats.steps)} label="steps" optional />
          <Stat value={fmtCount(stats.tools)} label="tool calls" />
          {stats.errors > 0 && <Stat value={fmtCount(stats.errors)} label="errors" tone="error" />}
          <Stat value={fmtDuration(stats.wallMs)} label="wall" />
          {stats.tokensIn + stats.tokensOut > 0 && (
            <>
              <Stat
                value={`${fmtTokens(stats.tokensIn)}→${fmtTokens(stats.tokensOut)}`}
                label="tokens"
                optional
              />
              <Stat
                value={fmtCost(stats.estCostUsd)}
                label="est. cost"
                optional
                title="Rough estimate at $3/$15 per million tokens — token counts come from the run, prices do not."
              />
            </>
          )}
        </div>
      )}

      <div className="gm-topbar-actions">
        <FilterPopover runId={runId} />

        <button
          className={`gm-toolbtn gm-narrow-hide${collapsedCount > 0 ? ' gm-toolbtn--on' : ''}`}
          onClick={toggleCollapseAll}
          title={collapsedCount > 0 ? 'Expand every group (⇧C)' : 'Collapse sub-agents into summary cards (⇧C)'}
        >
          {collapsedCount > 0 ? <IconExpand /> : <IconCollapse />}
          <span className="gm-toolbtn-label">
            {collapsedCount > 0 ? `${collapsedCount} folded` : 'Collapse'}
          </span>
        </button>

        <div className="gm-seg gm-narrow-hide" role="radiogroup" aria-label="View">
          <button
            className={view === 'graph' ? 'gm-seg--on' : ''}
            onClick={() => useUiStore.getState().setView('graph')}
            title="Graph only"
            aria-label="Graph"
          >
            <IconGraph />
          </button>
          <button
            className={view === 'split' ? 'gm-seg--on' : ''}
            onClick={() => useUiStore.getState().setView('split')}
            title="Graph + timeline (⇧T)"
            aria-label="Split"
          >
            <IconSplit />
          </button>
          <button
            className={view === 'timeline' ? 'gm-seg--on' : ''}
            onClick={() => useUiStore.getState().setView('timeline')}
            title="Timeline only"
            aria-label="Timeline"
          >
            <IconTimeline />
          </button>
        </div>

        <button
          className="gm-toolbtn"
          onClick={() => useUiStore.getState().setPaletteOpen(true)}
          title="Search nodes, runs and actions"
        >
          <IconSearch />
          <span className="gm-toolbtn-label">Search</span>
          <span className="gm-kbd">⌘K</span>
        </button>

        <button
          className="gm-iconbtn"
          onClick={() => useUiStore.getState().setTheme(nextTheme(theme))}
          title={`${themeLabel(theme)} — click to change`}
          aria-label={themeLabel(theme)}
        >
          {theme === 'system' ? <IconTheme /> : theme === 'dark' ? <IconMoon /> : <IconSun />}
        </button>
      </div>
    </header>
  );
}

function Stat({
  value,
  label,
  tone,
  title,
  optional,
}: {
  value: string;
  label: string;
  tone?: 'error';
  title?: string;
  /** Dropped first when the toolbar runs out of room. */
  optional?: boolean;
}) {
  return (
    <div
      className={`gm-stat${tone === 'error' ? ' gm-stat--error' : ''}${optional === true ? ' gm-stat--optional' : ''}`}
      title={title ?? label}
    >
      <span className="gm-stat-value">{value}</span>
      <span className="gm-stat-label">{label}</span>
    </div>
  );
}
