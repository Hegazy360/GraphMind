/**
 * Bottom bar: the debugger's control surface. Connection state, run/step
 * mode, break-everywhere, and the live breakpoint chips — the things you
 * reach for while execution is held.
 */
import { broadcastControl, getConnection } from '../connection/ServerConnection.js';
import { matcherKey, matcherLabel, useUiStore, type ConnectionStatus } from '../store/uiStore.js';
import { IconPause, IconReplay, IconStack } from './Icons.js';

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  live: 'live',
  connecting: 'connecting',
  detached: 'detached',
  replaying: 'replaying',
  off: 'offline',
};

const CONNECTION_HINT: Record<ConnectionStatus, string> = {
  live: 'Attached to the debug server — events are streaming in.',
  connecting: 'Reaching the debug server…',
  detached: 'The debug server went away. Reconnecting with backoff; gates fail open.',
  replaying: 'Replaying a recorded run locally — no server attached.',
  off: 'Not attached to a debug server.',
};

export function RunBar({
  onToggleRail,
  railOpen,
}: {
  onToggleRail?: () => void;
  railOpen?: boolean;
}) {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const mode = useUiStore((s) => s.mode);
  const breakpoints = useUiStore((s) => s.breakpoints);

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
    <footer className="gm-runbar">
      {onToggleRail !== undefined && (
        <button
          className={`gm-iconbtn${railOpen === true ? ' gm-iconbtn--on' : ''}`}
          onClick={onToggleRail}
          title="Toggle the run list (b)"
          aria-label="Toggle the run list"
        >
          <IconStack />
        </button>
      )}

      <div className="gm-conn-group" title={CONNECTION_HINT[connStatus]}>
        <span className={`gm-conn gm-conn--${connStatus}`} />
        <span className="gm-conn-label">{CONNECTION_LABEL[connStatus]}</span>
      </div>

      {fixtureActive && (
        <button
          className="gm-iconbtn"
          title="Restart the replay"
          aria-label="Restart the replay"
          onClick={() => getConnection('fixture')?.restart?.()}
        >
          <IconReplay />
        </button>
      )}

      <span className="gm-runbar-divider" />

      <div className="gm-seg" role="radiogroup" aria-label="Execution mode">
        <button
          className={mode === 'run' ? 'gm-seg--on' : ''}
          onClick={() => setMode('run')}
          title="Run until a breakpoint or an error"
          role="radio"
          aria-checked={mode === 'run'}
        >
          Run
        </button>
        <button
          className={mode === 'step' ? 'gm-seg--on' : ''}
          onClick={() => setMode('step')}
          title="Pause at every gate"
          role="radio"
          aria-checked={mode === 'step'}
        >
          Step
        </button>
      </div>

      <button className="gm-toolbtn" title="Break before every node" onClick={pauseAll}>
        <IconPause /> Break everywhere
      </button>

      <div className="gm-runbar-chips">
        {breakpoints.map((m) => {
          const key = matcherKey(m);
          return (
            <span key={key} className="gm-chip gm-chip--bp" title="breakpoint">
              <span className="gm-dot gm-dot--error" style={{ width: 6, height: 6 }} />
              {matcherLabel(m)}
              <button onClick={() => clearBreakpoint(key)} aria-label={`Clear breakpoint ${matcherLabel(m)}`}>
                ×
              </button>
            </span>
          );
        })}
      </div>

      <span className="gm-runbar-endpoint">ws · /ws/ui</span>
    </footer>
  );
}
