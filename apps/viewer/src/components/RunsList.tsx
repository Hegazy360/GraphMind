/**
 * Left rail: live-updating list of runs with app name, status, time and
 * source badge.
 */
import { useEffect, useMemo, useState } from 'react';
import { runChipLabel } from '../lib/firstRun.js';
import { fmtRelative } from '../lib/format.js';
import { useRunStore } from '../store/runStore.js';
import { useUiStore } from '../store/uiStore.js';
import { runBadgeStatus, type RunBadgeStatus, type RunState } from '../store/types.js';

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
  return (
    <button
      className={`gm-run-item${selected ? ' gm-run-item--selected' : ''}`}
      onClick={() => useUiStore.getState().selectRun(run.runId)}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <span className={dotClass(status)} />
        <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.meta.app}
        </span>
        <span className="gm-chip" style={{ padding: '1px 7px' }}>
          {runChipLabel(run.meta)}
        </span>
      </div>
      <div
        className="flex items-center"
        style={{
          gap: 6,
          marginTop: 4,
          fontSize: 11,
          color: 'var(--text-faint)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {run.runId.slice(0, 14)}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            color: status === 'error' ? 'var(--err)' : status === 'paused' ? 'var(--amber)' : 'var(--text-faint)',
          }}
        >
          {statusLabel(status)}
        </span>
        {run.meta.startedTs !== undefined && (
          <span style={{ flexShrink: 0 }}>· {fmtRelative(run.meta.startedTs, now)}</span>
        )}
      </div>
    </button>
  );
}

export function RunsList() {
  const runs = useRunStore((s) => s.runs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const sorted = useMemo(
    () =>
      Object.values(runs).sort(
        (a, b) => (b.meta.startedTs ?? 0) - (a.meta.startedTs ?? 0),
      ),
    [runs],
  );

  return (
    <nav className="gm-rail flex flex-col" style={{ width: 236, flexShrink: 0 }}>
      <div
        className="flex items-center px-4"
        style={{ height: 52, borderBottom: '1px solid var(--border)', gap: 8, flexShrink: 0 }}
      >
        <GraphMindMark />
        <span style={{ fontWeight: 650, fontSize: 14, letterSpacing: '-0.02em' }}>GraphMind</span>
        <span className="gm-node-kind" style={{ marginTop: 2 }}>
          debugger
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: 8 }}>
        <div className="gm-section-label" style={{ padding: '6px 10px 8px' }}>
          Runs
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--text-faint)' }}>
            No runs yet.
          </div>
        ) : (
          <div className="flex flex-col" style={{ gap: 2 }}>
            {sorted.map((run) => (
              <RunItem key={run.runId} run={run} now={now} />
            ))}
          </div>
        )}
      </div>
      <div
        className="px-4 py-3"
        style={{ borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-faint)', display: 'flex', gap: 10 }}
      >
        <span>
          <span className="gm-kbd">/</span> search
        </span>
        <span>
          <span className="gm-kbd">f</span> follow
        </span>
        <span>
          <span className="gm-kbd">esc</span> close
        </span>
      </div>
    </nav>
  );
}

export function GraphMindMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="5" r="2.4" fill="var(--accent)" />
      <circle cx="5" cy="17" r="2.4" fill="var(--text-dim)" />
      <circle cx="19" cy="17" r="2.4" fill="var(--text-dim)" />
      <path d="M12 7.4 6.2 15M12 7.4l5.8 7.6" stroke="var(--text-faint)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
