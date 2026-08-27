/**
 * Bottom bar: the debugger's control surface. Connection state, run/step
 * mode, break-everywhere, and the live breakpoint chips — the things you
 * reach for while execution is held.
 *
 * Two rules this bar exists to keep:
 *
 *  1. **The connection light never flatters the connection.** An open socket
 *     is not a live tail: the server replays a run's history before it tails,
 *     so a saturated server can deliver a whole run as catch-up while the
 *     dot sits on green. "live" here means live; anything else says what it
 *     actually is (`catching up 12k/72k`, `behind 34s`, `replaying`).
 *  2. **No control that cannot act.** In a run exported by `graphmind record
 *     --html` there is no process to mode-switch and no server to hold a
 *     breakpoint: those controls are disabled, and say why on hover.
 */
import { useEffect, useState } from 'react';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { broadcastControl, getConnection } from '../connection/ServerConnection.js';
import {
  indicatorStatus,
  matcherKey,
  matcherLabel,
  streamStatus,
  useUiStore,
  type ConnectionStatus,
  type StreamStatus,
} from '../store/uiStore.js';
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
  replaying: 'Replaying a recorded run locally — no debug server attached.',
  off: 'Not attached to a debug server.',
};

/** Why a debugger control is dead in an exported run. */
const RECORDED_HINT =
  'This page is a run exported by `graphmind record --html` — a frozen record. ' +
  'Nothing is executing and there is no server to send this to.';

function seconds(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** The label and tooltip for an attached-but-not-necessarily-current socket. */
function tailLabel(status: StreamStatus): { label: string; hint: string; modifier: string } {
  if (status.phase === 'catching-up') {
    const done = status.applied.toLocaleString('en-US');
    const total = status.backlog.toLocaleString('en-US');
    return {
      label: `catching up ${done}/${total}`,
      hint:
        `Attached, but this is replayed history, not the live tail: the server is still sending ` +
        `${total} stored events for the runs you are subscribed to. Gates that opened during the ` +
        'backlog have already been decided — you are watching a recording until this finishes.',
      modifier: 'catchup',
    };
  }
  if (status.phase === 'behind') {
    return {
      label: `behind ${seconds(status.lagMs)}`,
      hint:
        `Attached and tailing, but the newest event to arrive is ${seconds(status.lagMs)} old — the ` +
        'stream is not keeping up with the run. What is on the canvas happened a while ago.',
      modifier: 'behind',
    };
  }
  return { label: CONNECTION_LABEL.live, hint: CONNECTION_HINT.live, modifier: 'live' };
}

export function RunBar({
  onToggleRail,
  railOpen,
}: {
  onToggleRail?: () => void;
  railOpen?: boolean;
}) {
  const connection = useUiStore((s) => s.connection);
  const fixtureActive = useUiStore((s) => s.fixtureActive);
  const stream = useUiStore((s) => s.stream);
  const mode = useUiStore((s) => s.mode);
  const breakpoints = useUiStore((s) => s.breakpoints);
  const recorded = isExportedRun();

  // A stalled stream produces no store updates, so "behind" has to be able
  // to expire on its own — otherwise a run that simply finished would sit
  // there accusing the socket of being late.
  const [, tick] = useState(0);
  useEffect(() => {
    if (connection !== 'live') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [connection]);

  const connStatus = indicatorStatus(connection, fixtureActive);
  const tail = connStatus === 'live' ? tailLabel(streamStatus(stream)) : null;
  const connLabel = tail?.label ?? CONNECTION_LABEL[connStatus];
  const connHint = tail?.hint ?? CONNECTION_HINT[connStatus];
  const connModifier = tail?.modifier ?? connStatus;

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

      <div className="gm-conn-group" title={connHint} data-phase={connModifier}>
        <span className={`gm-conn gm-conn--${connModifier}`} />
        <span className="gm-conn-label">{connLabel}</span>
      </div>

      {/* Kept in an exported run too: re-ingesting the embedded envelopes is
          something this page really can do, unlike the controls below. */}
      {fixtureActive && (
        <button
          className="gm-iconbtn"
          title={recorded ? 'Re-render the recorded run' : 'Restart the replay'}
          aria-label="Restart the replay"
          onClick={() => getConnection('fixture')?.restart?.()}
        >
          <IconReplay />
        </button>
      )}

      <span className="gm-runbar-divider" />

      <div
        className={`gm-seg${recorded ? ' gm-seg--dead' : ''}`}
        role="radiogroup"
        aria-label="Execution mode"
        title={recorded ? RECORDED_HINT : undefined}
      >
        <button
          className={mode === 'run' ? 'gm-seg--on' : ''}
          onClick={() => setMode('run')}
          disabled={recorded}
          title={recorded ? RECORDED_HINT : 'Run until a breakpoint or an error'}
          role="radio"
          aria-checked={mode === 'run'}
        >
          Run
        </button>
        <button
          className={mode === 'step' ? 'gm-seg--on' : ''}
          onClick={() => setMode('step')}
          disabled={recorded}
          title={recorded ? RECORDED_HINT : 'Pause at every gate'}
          role="radio"
          aria-checked={mode === 'step'}
        >
          Step
        </button>
      </div>

      <button
        className="gm-toolbtn"
        title={recorded ? RECORDED_HINT : 'Break before every node'}
        onClick={pauseAll}
        disabled={recorded}
      >
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

      <span className="gm-runbar-endpoint" title={recorded ? RECORDED_HINT : undefined}>
        {recorded ? 'recorded · no server' : 'ws · /ws/ui'}
      </span>
    </footer>
  );
}
