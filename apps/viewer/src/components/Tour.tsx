/**
 * Tour mode (`?fixture=1&tour=1`): the homepage embeds the fixture run and
 * asks the visitor to do the one thing the product exists for — unblock a
 * held call. This is the small card that tells them what to do, and the
 * messages the page around the iframe listens for.
 *
 * Steps: watch (the graph is building) → held (a call failed; do something)
 * → resumed (they did) → done (the run finished). Each step is posted to the
 * parent window as `{ source: 'graphmind-tour', step }`, same origin only.
 * The card never blocks the controls: it floats at the bottom, can be closed,
 * and reads the store the same way the keyboard shortcuts do.
 */
import { useEffect, useState } from 'react';
import { activePause } from '../lib/gate.js';
import { useRunStore } from '../store/runStore.js';

export type TourStep = 'watch' | 'held' | 'resumed' | 'done';

export function parseTourParam(search: string): boolean {
  return new URLSearchParams(search).get('tour') === '1';
}

function tell(step: TourStep): void {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ source: 'graphmind-tour', step }, location.origin);
  } catch {
    // a parent on another origin gets nothing, by design
  }
}

const COPY: Record<TourStep, { title: string; body: string }> = {
  watch: { title: 'A real run, replaying', body: 'The graph draws itself as the agent works. In a moment one tool call will fail.' },
  held: {
    title: 'It failed — and the run is holding for you',
    body: 'Nothing is lost. Click Inject…, give the call the answer it should have returned, and resume. (Or Retry, or Continue with the error.)',
  },
  resumed: { title: 'You unblocked it', body: 'The agent carries on from the value you gave it, as if the call had worked.' },
  done: { title: 'That was a debugging session', body: 'Pause on failure, inspect, fix, resume — on your own agent, with two lines of setup.' },
};

export function Tour() {
  const run = useRunStore((s) => {
    const id = Object.keys(s.runs)[0];
    return id === undefined ? undefined : s.runs[id];
  });
  const held = run !== undefined && activePause(run) !== undefined;
  const finished = run !== undefined && run.meta.status !== 'running' && run.meta.status !== 'pending';
  const [step, setStep] = useState<TourStep>('watch');
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (finished) setStep((s) => (s === 'done' ? s : 'done'));
    else if (held) setStep((s) => (s === 'watch' ? 'held' : s));
    else setStep((s) => (s === 'held' ? 'resumed' : s));
  }, [held, finished]);
  useEffect(() => tell(step), [step]);

  if (closed) return null;
  const copy = COPY[step];
  return (
    <div className={`gm-tour gm-tour--${step}`} role="status" aria-live="polite" data-testid="tour" data-step={step}>
      <span className="gm-tour-dot" aria-hidden="true" />
      <div className="gm-tour-text">
        <b>{copy.title}</b>
        <span>{copy.body}</span>
      </div>
      <button type="button" className="gm-tour-close" aria-label="Hide this tip" onClick={() => setClosed(true)}>
        ×
      </button>
    </div>
  );
}
