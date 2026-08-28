/**
 * Gate bookkeeping. The wiring that sends the controls needs a browser; the
 * two decisions that precede it — *which* gate is holding, and what to call
 * where it sits — do not, and they are the ones a wrong answer breaks the
 * keyboard shortcuts on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { activePause, pausePointLabel } from '../src/lib/gate.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import type { RunState } from '../src/store/types.js';

beforeEach(resetCounters);

function build(events: ReturnType<typeof ev>[]): RunState {
  const runs = events.reduce<RunsMap>((acc, e) => applyEvent(acc, e, 'fixture'), {});
  const run = runs[RUN];
  if (run === undefined) throw new Error('no run');
  return run;
}

describe('activePause', () => {
  it('is undefined for a run that is not held', () => {
    expect(activePause(undefined)).toBeUndefined();
    expect(activePause(build([started('tool:a', 'tool')]))).toBeUndefined();
  });

  it('finds the gate currently holding the run', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'error' }),
    ]);
    expect(activePause(run)?.pauseId).toBe('p1');
    expect(activePause(run)?.nodeId).toBe('tool:a');
  });

  it('forgets a gate once it has been released', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'error' }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }),
    ]);
    expect(activePause(run)).toBeUndefined();
  });

  it('reports the still-open gate when an earlier one has been released', () => {
    const run = build([
      started('tool:a', 'tool'),
      started('tool:b', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'error' }),
      ev('exec.resumed', { pauseId: 'p1', action: 'retry' }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:b', point: 'before' }),
    ]);
    expect(activePause(run)?.pauseId).toBe('p2');
  });
});

describe('pausePointLabel', () => {
  it('says where the gate sits in words a human uses', () => {
    expect(pausePointLabel('error')).toBe('on error');
    expect(pausePointLabel('before')).toBe('before call');
    expect(pausePointLabel('after')).toBe('after call');
  });
});
