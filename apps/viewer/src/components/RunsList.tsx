/**
 * Left rail: live-updating list of runs with app name, status, time, source
 * badge, and a one-line shape summary (nodes / errors) so you can tell two
 * runs of the same app apart without opening them.
 */
import { useEffect, useMemo, useState } from 'react';
import { runChipLabel } from '../lib/firstRun.js';
import { fmtCount, fmtDuration, fmtRelative } from '../lib/format.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { runBadgeStatus, type RunBadgeStatus, type RunState } from '../store/types.js';
import { GraphMindMark } from './Mark.js';
import { IconClose, IconSearch } from './Icons.js';

export { GraphMindMark };

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

function RunItem({ run, now }: { run: RunState; now: number }) {
  const selected = useUiStore((s) => s.selectedRunId === run.runId);
  const status = runBadgeStatus(run);
  const nodeCount = run.order.length;
  const errors = useMemo(() => {
    let count = 0;
    for (const id of run.order) {
      const node = run.nodes[id];
      if (node?.lastError !== undefined) count += 1;
    }
    return count;
  }, [run]);
  const elapsed =
    run.meta.startedTs === undefined
      ? undefined
      : (run.meta.finishedTs ?? now) - run.meta.startedTs;

  return (
    <button
      className={`gm-run-item${selected ? ' gm-run-item--selected' : ''}`}
      onClick={() => useUiStore.getState().selectRun(run.runId)}
      aria-current={selected}
    >
      <div className="gm-run-item-top">
        <span className={dotClass(status)} />
        <span className="gm-run-item-app">{run.meta.app}</span>
        <span className="gm-chip gm-chip--tiny">{runChipLabel(run.meta)}</span>
      </div>
      <div className="gm-run-item-meta">
        <span
          className={`gm-run-item-status gm-run-item-status--${status}`}
        >
          {statusLabel(status)}
        </span>
        {nodeCount > 0 && <span>· {fmtCount(nodeCount)} nodes</span>}
        {errors > 0 && <span className="gm-run-item-errors">· {errors} err</span>}
        {elapsed !== undefined && <span>· {fmtDuration(elapsed)}</span>}
        {run.meta.startedTs !== undefined && (
          <span className="gm-run-item-when">{fmtRelative(run.meta.startedTs, now)}</span>
        )}
      </div>
    </button>
  );
}

export function RunsList({ onCollapse }: { onCollapse?: () => void }) {
  const runs = useRunStore((s) => s.runs);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const sorted = useMemo(() => {
    const list = Object.values(runs).sort(
      (a, b) => (b.meta.startedTs ?? 0) - (a.meta.startedTs ?? 0),
    );
    if (query.trim() === '') return list;
    const needle = query.trim().toLowerCase();
    return list.filter(
      (run) =>
        run.meta.app.toLowerCase().includes(needle) || run.runId.toLowerCase().includes(needle),
    );
  }, [runs, query]);

  return (
    <nav className="gm-rail" aria-label="Runs">
      <div className="gm-rail-head">
        <GraphMindMark />
        <span className="gm-wordmark">GraphMind</span>
        <span className="gm-node-kind">debugger</span>
        {onCollapse !== undefined && (
          <button
            className="gm-iconbtn"
            style={{ marginLeft: 'auto' }}
            onClick={onCollapse}
            title="Hide the run list (b)"
            aria-label="Hide the run list"
          >
            <IconClose />
          </button>
        )}
      </div>

      {Object.keys(runs).length > 6 && (
        <div className="gm-rail-search">
          <IconSearch width={12} height={12} />
          <input
            value={query}
            placeholder="Filter runs…"
            spellCheck={false}
            aria-label="Filter runs"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="gm-rail-list">
        <div className="gm-section-label gm-rail-label">
          Runs
          <span>{Object.keys(runs).length}</span>
        </div>
        {sorted.length === 0 ? (
          <div className="gm-rail-empty">
            {Object.keys(runs).length === 0 ? 'No runs yet.' : 'No run matches that filter.'}
          </div>
        ) : (
          <div className="gm-rail-items">
            {sorted.map((run) => (
              <RunItem key={run.runId} run={run} now={now} />
            ))}
          </div>
        )}
      </div>

      <div className="gm-rail-foot">
        <span>
          <span className="gm-kbd">⌘K</span> palette
        </span>
        <span>
          <span className="gm-kbd">⇧T</span> timeline
        </span>
        <span>
          <span className="gm-kbd">f</span> follow
        </span>
      </div>
    </nav>
  );
}
