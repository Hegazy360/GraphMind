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
  heldGate,
  injectAndResume,
  injectPrefill,
  injectRefusal,
  pausePointLabel,
  shownPause,
} from '../src/lib/gate.js';
import { sendControl } from '../src/connection/ServerConnection.js';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { useRunStore } from '../src/store/runStore.js';
import { useUiStore } from '../src/store/uiStore.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import { activePausesOf, type RunState } from '../src/store/types.js';

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

/**
 * Two parallel calls of one tool that BOTH hold (the server lists both open):
 * the keyboard must act on the pause the card and the footer show, and the
 * selected execution picks which one that is.
 */
describe('parallel holds on one node', () => {
  const TOOL = 'tool:convertCurrency';
  function bothHeld(): RunState {
    return build([
      started('llm:step', 'llm', { instanceId: 's0' }),
      started(TOOL, 'tool', { parentId: 'llm:step', instanceId: 'call-a', input: { to: 'XYZ' } }),
      started(TOOL, 'tool', { parentId: 'llm:step', instanceId: 'call-b', input: { to: 'QQQ' } }),
      ev('node.error', { nodeId: TOOL, instanceId: 'call-a', error: { name: 'Error', message: 'XYZ' } }),
      ev('exec.paused', { pauseId: 'pause_1', nodeId: TOOL, point: 'error', editable: true, instanceId: 'call-a' }),
      ev('node.error', { nodeId: TOOL, instanceId: 'call-b', error: { name: 'Error', message: 'QQQ' } }),
      ev('exec.paused', { pauseId: 'pause_2', nodeId: TOOL, point: 'error', editable: true, instanceId: 'call-b' }),
    ]);
  }
  function select(run: RunState, nodeId: string | undefined, instanceIdx?: number): void {
    useRunStore.setState({ runs: { [RUN]: run } });
    useUiStore.getState().selectNode(RUN, nodeId);
    if (instanceIdx !== undefined) useUiStore.getState().setInstanceIdx(instanceIdx);
  }

  it('lists every active pause of the node, oldest first', () => {
    expect(activePausesOf(bothHeld(), TOOL).map((p) => p.pauseId)).toEqual(['pause_1', 'pause_2']);
  });

  it('the keyboard acts on the pause the card shows for the selected node', () => {
    const run = bothHeld();
    select(run, TOOL);
    const shown = shownPause(run, TOOL)?.pauseId;
    expect(shown).toBe(run.nodes[TOOL]?.activePauseId);
    expect(heldGate(RUN)?.pauseId).toBe(shown);
  });

  it('with nothing selected, the keyboard still acts on a pause a card shows', () => {
    const run = bothHeld();
    select(run, undefined);
    expect(heldGate(RUN)?.pauseId).toBe(run.nodes[TOOL]?.activePauseId);
  });

  it('picking a held execution in the inspector makes its pause the one shown and keyed', () => {
    const run = bothHeld();
    select(run, TOOL, 0); // call-a
    expect(shownPause(run, TOOL, 0)?.pauseId).toBe('pause_1');
    expect(heldGate(RUN)?.pauseId).toBe('pause_1');
    select(run, TOOL, 1); // call-b
    expect(heldGate(RUN)?.pauseId).toBe('pause_2');
  });

  it('after one is released, the node, the card and the keyboard fall back to the other', () => {
    let run = bothHeld();
    run = applyEvent({ [RUN]: run }, ev('exec.resumed', { pauseId: 'pause_2', action: 'continue' }), 'fixture')[RUN] as RunState;
    expect(run.nodes[TOOL]?.activePauseId).toBe('pause_1');
    select(run, TOOL);
    expect(shownPause(run, TOOL)?.pauseId).toBe('pause_1');
    expect(heldGate(RUN)?.pauseId).toBe('pause_1');
  });
});

describe('injectPrefill — what the inject editor opens with', () => {
  const exec = (output?: unknown) => ({
    instanceId: 'c1',
    input: { env: 'prod' },
    status: 'running' as const,
    startedTs: 1,
    ...(output !== undefined ? { output } : {}),
  });

  it('a recorded result is the template', () => {
    expect(JSON.parse(injectPrefill(exec({ ok: true }), 'after').text)).toEqual({ ok: true });
  });

  it('at an after gate with no result on the wire yet, it starts empty — never with the arguments', () => {
    const prefill = injectPrefill(exec(), 'after');
    expect(JSON.parse(prefill.text)).toEqual({});
    expect(prefill.note).toContain('not recorded yet');
  });

  it('before the call runs, the arguments stay the template (unchanged)', () => {
    expect(JSON.parse(injectPrefill(exec(), 'before').text)).toEqual({ env: 'prod' });
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
