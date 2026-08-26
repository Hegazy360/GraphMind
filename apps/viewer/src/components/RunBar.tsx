/**
 * Bottom bar: connection status, run picker, run/step mode toggle,
 * pause-all, breakpoint chips.
 */
import { broadcastControl, getConnection } from '../connection/ServerConnection.js';
import { useRunStore } from '../store/runStore.js';
import { matcherKey, matcherLabel, useUiStore, type ConnectionStatus } from '../store/uiStore.js';
import { IconPause, IconReplay } from './Icons.js';

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  live: 'live',
  connecting: 'connecting',
  detached: 'detached',
  replaying: 'replaying',
  off: 'offline',
};

export function RunBar() {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const mode = useUiStore((s) => s.mode);
  const breakpoints = useUiStore((s) => s.breakpoints);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const runs = useRunStore((s) => s.runs);

  const runIds = Object.keys(runs);
  const connStatus: ConnectionStatus = fixtureActive && connection === 'off' ? 'replaying' : connection;

  const setMode = (next: 'run' | 'step') => {
    useUiStore.getState().setMode(next);
    broadcastControl('mode.set', { mode: next });
  };

  const pauseAll = () => {
    const matcher = {};
    useUiStore.getState().addBreakpoint(matcher);
    broadcastControl('breakpoint.set', { matcher });
  };

  const clearBreakpoint = (key: string) => {
    const matcher = breakpoints.find((m) => matcherKey(m) === key);
    if (matcher === undefined) return;
    useUiStore.getState().removeBreakpoint(matcher);
    broadcastControl('breakpoint.clear', { matcher });
  };

  return (
    <footer className="gm-runbar flex items-center px-4" style={{ height: 44, gap: 14, flexShrink: 0 }}>
      <div className="flex items-center" style={{ gap: 7 }}>
        <span className={`gm-conn gm-conn--${connStatus}`} />
        <span style={{ fontSize: 11.5, color: 'var(--text-dim)', fontWeight: 550 }}>
          {CONNECTION_LABEL[connStatus]}
        </span>
        {fixtureActive && (
          <button
            className="gm-iconbtn"
            title="Restart replay"
            onClick={() => getConnection('fixture')?.restart?.()}
          >
            <IconReplay />
          </button>
        )}
      </div>

      <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

      {runIds.length > 0 && (
        <select
          value={selectedRunId ?? ''}
          onChange={(e) => useUiStore.getState().selectRun(e.target.value === '' ? undefined : e.target.value)}
          style={{
            background: 'var(--surface-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            fontSize: 11.5,
            padding: '3px 8px',
            outline: 'none',
            maxWidth: 220,
          }}
        >
          <option value="">select run…</option>
          {runIds.map((id) => {
            const run = runs[id];
            return (
              <option key={id} value={id}>
                {run?.meta.app ?? id} — {id.slice(0, 14)}
              </option>
            );
          })}
        </select>
      )}

      <div className="gm-seg" role="radiogroup" aria-label="Execution mode">
        <button className={mode === 'run' ? 'gm-seg--on' : ''} onClick={() => setMode('run')}>
          Run
        </button>
        <button className={mode === 'step' ? 'gm-seg--on' : ''} onClick={() => setMode('step')}>
          Step
        </button>
      </div>

      <button
        className="gm-iconbtn"
        style={{ width: 'auto', padding: '0 9px', gap: 5, fontSize: 11.5, fontWeight: 550 }}
        title="Pause before every node"
        onClick={pauseAll}
      >
        <IconPause /> Pause all
      </button>

      <div className="flex min-w-0 flex-1 items-center overflow-x-auto" style={{ gap: 6 }}>
        {breakpoints.map((m) => {
          const key = matcherKey(m);
          return (
            <span key={key} className="gm-chip" title="breakpoint">
              <span className="gm-dot gm-dot--error" style={{ width: 6, height: 6 }} />
              {matcherLabel(m)}
              <button onClick={() => clearBreakpoint(key)} aria-label={`Clear breakpoint ${matcherLabel(m)}`}>
                ×
              </button>
            </span>
          );
        })}
      </div>

      <span style={{ fontSize: 10.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
        ws · /ws/ui
      </span>
    </footer>
  );
}
