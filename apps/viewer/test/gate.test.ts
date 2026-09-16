/**
 * Gate bookkeeping. The wiring that sends the controls needs a browser; the
 * two decisions that precede it — *which* gate is holding, and what to call
 * where it sits — do not, and they are the ones a wrong answer breaks the
 * keyboard shortcuts on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REDACTED_PLACEHOLDER,
  activePause,
  injectAndResume,
  injectRefusal,
  pausePointLabel,
} from '../src/lib/gate.js';
import { sendControl } from '../src/connection/ServerConnection.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import type { RunState } from '../src/store/types.js';

vi.mock('../src/connection/ServerConnection.js', () => ({ sendControl: vi.fn() }));

beforeEach(() => {
  resetCounters();
  vi.mocked(sendControl).mockClear();
});

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

describe('injectRefusal — the inject guard', () => {
  it('refuses the bare placeholder, the editor pre-fill under a kill switch', () => {
    expect(injectRefusal(REDACTED_PLACEHOLDER)).toBe(
      'this value contains redacted content; edit it before injecting',
    );
    expect(REDACTED_PLACEHOLDER).toBe('__REDACTED__');
  });

  it('refuses the placeholder nested in objects and arrays, inside a string, and as a key', () => {
    expect(injectRefusal({ result: { rows: [{ id: 1, secret: REDACTED_PLACEHOLDER }] } })).toBeDefined();
    expect(injectRefusal([1, [2, [REDACTED_PLACEHOLDER]]])).toBeDefined();
    expect(injectRefusal(`partly ${REDACTED_PLACEHOLDER} edited`)).toBeDefined();
    expect(injectRefusal({ [REDACTED_PLACEHOLDER]: 1 })).toBeDefined();
  });

  it('lets clean values through, including look-alikes and every JSON scalar', () => {
    for (const value of [
      { result: 'REDACTED' },
      '__redacted__',
      '_REDACTED_',
      'REDACTED__',
      { note: 'the output was redacted upstream' },
      null,
      0,
      false,
      '',
      [],
      {},
      'ok',
    ]) {
      expect(injectRefusal(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('never throws on unserialisable values (treated as clean; the resume path owns that error)', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(injectRefusal(cyc)).toBeUndefined();
    expect(injectRefusal(undefined)).toBeUndefined();
    expect(injectRefusal(BigInt(1))).toBeUndefined();
  });
});

describe('injectAndResume', () => {
  it('sends nothing and reports the reason when the value contains redacted content', () => {
    const result = injectAndResume(RUN, 'p1', { text: REDACTED_PLACEHOLDER });
    expect(result).toEqual({ ok: false, reason: 'this value contains redacted content; edit it before injecting' });
    expect(sendControl).not.toHaveBeenCalled();
  });

  it('sends exactly one exec.resume inject for a clean value', () => {
    const result = injectAndResume(RUN, 'p1', { text: 'fixed' });
    expect(result).toEqual({ ok: true });
    expect(sendControl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendControl).mock.calls[0]?.slice(1)).toEqual([
      'exec.resume',
      { pauseId: 'p1', action: 'inject', output: { text: 'fixed' } },
      RUN,
    ]);
  });
});
