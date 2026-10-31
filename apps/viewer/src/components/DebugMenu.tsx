/**
 * How the debugger behaves: run or step, what it breaks on, and what this
 * tab is allowed to do.
 *
 * This was a whole bar across the bottom of every screen, including the ones
 * with no canvas to step. It is session state, not page content — you set it
 * once and it holds for every run — so it belongs behind a menu, with the
 * one part that has to be glanceable (is a breakpoint armed?) shown as a
 * count on the button.
 *
 * Two rules it keeps from the bar it replaces:
 *
 *  1. **No control that cannot act.** In a run exported by `graphmind record
 *     --html` there is no process to mode-switch and no server to hold a
 *     breakpoint; those controls are disabled and say why. A tab without the
 *     viewer token is refused by the server, so it is told that here rather
 *     than finding out when a click does nothing.
 *  2. **A refused control says so.** "pause taken", "edit refused" and the
 *     rest surface for a few seconds, because the click did not do what its
 *     label said.
 */
import { useEffect, useRef, useState } from 'react';
import { isExportedRun } from '../connection/FixtureConnection.js';
import { broadcastControl } from '../connection/ServerConnection.js';
import { useDismissable } from '../hooks/useDismissable.js';
import { debugDeniedNote } from '../lib/control.js';
import { controlNoticeLabel } from '../lib/hubReply.js';
import { matcherKey, matcherLabel, useUiStore, type ControlInfo } from '../store/uiStore.js';
import { IconPause, IconSliders } from './Icons.js';

/** Why a debugger control is dead in an exported run. */
const RECORDED_HINT =
  'This page is a run exported by `graphmind record --html` — a frozen record. ' +
  'Nothing is executing and there is no server to send this to.';

/** How long a refused-control notice stays on screen. */
const NOTICE_MS = 6_000;

const AGENT_LEVEL_HINT: Record<ControlInfo['agentLevel'], string> = {
  off: 'A coding agent (graphmind resume) cannot release pauses. Start the server with --allow-control=resume|inject|edit to allow it.',
  resume: 'A coding agent may continue, retry and abort pauses (serve --allow-control=resume).',
  inject: 'A coding agent may continue, retry, abort and inject results (serve --allow-control=inject).',
  edit: 'A coding agent may also run held calls with edited arguments (serve --allow-control=edit).',
};

function ControlLines({ control }: { control: ControlInfo }) {
  const you =
    control.principal === 'viewer'
      ? {
          label: 'full control',
          hint: 'This tab holds the viewer token: it can resume, inject and edit held calls.',
        }
      : {
          label: 'no token',
          hint:
            'This tab connected without the viewer token: it can continue, retry and abort, but not inject, step, ' +
            'edit a held call or change breakpoints. Open the viewer from the link `graphmind serve` printed (or its ' +
            'redirect file) for full control.',
        };
  return (
    <div className="gm-dbg-control">
      <span
        className={`gm-chip gm-chip--tiny gm-chip--control${control.principal === 'viewer' ? '' : ' gm-chip--warn'}`}
        title={you.hint}
        data-principal={control.principal}
        data-agent-level={control.agentLevel}
      >
        {you.label} · agent: {control.agentLevel}
      </span>
      <span className="gm-filter-hint" title={AGENT_LEVEL_HINT[control.agentLevel]}>
        {control.editInput ? 'ws · /ws/ui' : 'input edits off (--no-edit-input)'}
      </span>
    </div>
  );
}

export function DebugMenu() {
  const mode = useUiStore((s) => s.mode);
  const breakpoints = useUiStore((s) => s.breakpoints);
  const control = useUiStore((s) => s.control);
  const notice = useUiStore((s) => s.controlNotice);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, () => setOpen(false), ref);

  const recorded = isExportedRun();
  const denied = recorded ? RECORDED_HINT : debugDeniedNote(control);
  const locked = denied !== undefined;

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => {
      if (useUiStore.getState().controlNotice?.nonce === notice.nonce) {
        useUiStore.getState().clearControlNotice();
      }
    }, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

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

  // Step mode and an armed breakpoint both change what the next event does,
  // so they are legible without opening anything.
  const armed = breakpoints.length;
  const flagged = mode === 'step' || armed > 0;

  return (
    <div className="gm-popover-host" ref={ref}>
      {notice !== undefined && (
        <span className="gm-chip gm-chip--tiny gm-chip--notice" role="status" title={notice.message}>
          {controlNoticeLabel(notice.code, notice.message)}
        </span>
      )}
      <button
        className={`gm-toolbtn${open || flagged ? ' gm-toolbtn--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Run or step, and what the debugger breaks on"
      >
        <IconSliders />
        <span className="gm-toolbtn-label">{mode === 'step' ? 'Step' : 'Debug'}</span>
        {armed > 0 && <span className="gm-count">{armed}</span>}
      </button>

      {open && (
        <div className="gm-popover" role="dialog" aria-label="Debug controls">
          <div className="gm-section-label">Execution</div>
          <div
            className={`gm-seg gm-seg--wide${recorded ? ' gm-seg--dead' : locked ? ' gm-seg--locked' : ''}`}
            role="radiogroup"
            aria-label="Execution mode"
            title={denied}
          >
            <button
              className={mode === 'run' ? 'gm-seg--on' : ''}
              onClick={() => setMode('run')}
              disabled={locked}
              title={denied ?? 'Run until a breakpoint or an error'}
              role="radio"
              aria-checked={mode === 'run'}
            >
              Run
            </button>
            <button
              className={mode === 'step' ? 'gm-seg--on' : ''}
              onClick={() => setMode('step')}
              disabled={locked}
              title={denied ?? 'Pause at every gate'}
              role="radio"
              aria-checked={mode === 'step'}
            >
              Step
            </button>
          </div>

          <div className="gm-section-label" style={{ marginTop: 12 }}>
            Breakpoints
          </div>
          <button
            className="gm-filter-row"
            title={denied ?? 'Break before every node'}
            onClick={pauseAll}
            disabled={locked}
          >
            <IconPause />
            Break everywhere
          </button>
          {breakpoints.length === 0 ? (
            <div className="gm-filter-hint" style={{ marginTop: 8 }}>
              A fresh server arms an error breakpoint for you — a run stops at a throw whether or
              not anything is listed here.
            </div>
          ) : (
            <div className="gm-dbg-chips">
              {breakpoints.map((m) => {
                const key = matcherKey(m);
                return (
                  <span key={key} className="gm-chip gm-chip--bp" title="breakpoint">
                    <span className="gm-dot gm-dot--error" style={{ width: 6, height: 6 }} />
                    {matcherLabel(m)}
                    <button
                      onClick={() => clearBreakpoint(key)}
                      disabled={locked}
                      title={denied ?? 'Clear this breakpoint'}
                      aria-label={`Clear breakpoint ${matcherLabel(m)}`}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div className="gm-popover-foot">
            {recorded ? (
              <span className="gm-filter-hint" title={RECORDED_HINT}>
                recorded · no server
              </span>
            ) : control !== undefined ? (
              <ControlLines control={control} />
            ) : (
              <span className="gm-filter-hint">Not attached to a debug server.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
