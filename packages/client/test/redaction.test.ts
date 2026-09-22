/**
 * Coarse redaction — the four kill switches, as pure logic.
 *
 * `Redactor.apply` is the one function every emitted event passes through
 * (session.ts calls it inside `emitInternal`, before the ring buffer). These
 * tests pin its contract switch by switch, kind by kind, and then run the
 * cross-language conformance fixture (test/fixtures/redaction.json) that the
 * Python and Ruby ports are held to.
 */
import { readFileSync } from 'node:fs';
import type { EventPayloadMap, EventType } from '@graphmind-ai/schema';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  Redactor as RealRedactor,
  envFlagOn,
  resolveRedaction,
  type RedactionSwitches,
} from '../src/redaction.js';

/**
 * `Redactor.apply` returns `undefined` when an event must be dropped (fail
 * closed, see the "fails closed" block). Every contract test below expects an
 * event back, so it runs against this subclass, which turns an unexpected drop
 * into a failure instead of an `undefined` that `.input` would hide.
 */
class Redactor extends RealRedactor {
  override apply<T extends EventType>(type: T, payload: EventPayloadMap[T], runId: string): EventPayloadMap[T] {
    const out = super.apply(type, payload, runId);
    if (out === undefined) throw new Error(`unexpectedly dropped a ${type} event`);
    return out;
  }
}

const ALL_OFF: RedactionSwitches = {
  hideInputs: false,
  hideOutputs: false,
  hideToolArgs: false,
  hideToolResults: false,
};
const on = (partial: Partial<RedactionSwitches>): RedactionSwitches => ({ ...ALL_OFF, ...partial });

const RUN = 'run-1';
const FAILED = { count: 0, keys: ['input', 'output', 'deltas'], failed: true };

function started(
  kind: EventPayloadMap['node.started']['kind'],
  nodeId: string,
  instanceId: string,
  input: unknown = { secret: 'S' },
): EventPayloadMap['node.started'] {
  return { nodeId, kind, name: nodeId.split(':')[1] ?? nodeId, instanceId, input };
}

function finished(
  nodeId: string,
  instanceId: string | undefined,
  output: unknown = { secret: 'S' },
): EventPayloadMap['node.finished'] {
  return {
    nodeId,
    ...(instanceId === undefined ? {} : { instanceId }),
    output,
    durationMs: 12.34,
    status: 'ok',
  };
}

describe('envFlagOn (a privacy switch fails closed on spelling)', () => {
  it('is on for any value except the off spellings — including yes, on and garbage', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', ' true ', ' 1', 'yes', 'on', 'Y', '2', 'truthy', 'enabled']) {
      expect(envFlagOn(v), v).toBe(true);
    }
  });
  it('is off only for unset, empty and 0 / false / off / no (any case, padded)', () => {
    for (const v of [undefined, '', '  ', '0', 'false', 'FALSE', ' off ', 'no', 'No']) {
      expect(envFlagOn(v), String(v)).toBe(false);
    }
  });
});

describe('resolveRedaction: option vs env precedence', () => {
  it('is all-off by default', () => {
    expect(resolveRedaction(undefined, {})).toEqual(ALL_OFF);
    expect(resolveRedaction({}, {})).toEqual(ALL_OFF);
  });

  it('reads each env switch independently', () => {
    expect(resolveRedaction(undefined, { GRAPHMIND_HIDE_INPUTS: '1' })).toEqual(on({ hideInputs: true }));
    expect(resolveRedaction(undefined, { GRAPHMIND_HIDE_OUTPUTS: 'true' })).toEqual(on({ hideOutputs: true }));
    expect(resolveRedaction(undefined, { GRAPHMIND_HIDE_TOOL_ARGS: 'TRUE' })).toEqual(on({ hideToolArgs: true }));
    expect(resolveRedaction(undefined, { GRAPHMIND_HIDE_TOOL_RESULTS: '1' })).toEqual(on({ hideToolResults: true }));
  });

  it('reads each option independently', () => {
    expect(resolveRedaction({ hideInputs: true }, {})).toEqual(on({ hideInputs: true }));
    expect(resolveRedaction({ hideOutputs: true }, {})).toEqual(on({ hideOutputs: true }));
    expect(resolveRedaction({ hideToolArgs: true }, {})).toEqual(on({ hideToolArgs: true }));
    expect(resolveRedaction({ hideToolResults: true }, {})).toEqual(on({ hideToolResults: true }));
  });

  it('either source turning a switch on turns it on: an env switch is a floor code cannot lower', () => {
    // Ops set it in the environment; the app's code says false. Privacy wins.
    expect(resolveRedaction({ hideInputs: false }, { GRAPHMIND_HIDE_INPUTS: '1' })).toEqual(
      on({ hideInputs: true }),
    );
    // Code turns it on while the env says 0 (or nothing). Still on.
    expect(resolveRedaction({ hideOutputs: true }, { GRAPHMIND_HIDE_OUTPUTS: '0' })).toEqual(
      on({ hideOutputs: true }),
    );
    // An env value that is not an off spelling turns the switch on: it must
    // not silently record what the user tried to hide.
    expect(resolveRedaction({ hideToolArgs: false }, { GRAPHMIND_HIDE_TOOL_ARGS: 'nope' })).toEqual(
      on({ hideToolArgs: true }),
    );
    expect(resolveRedaction({ hideToolArgs: false }, { GRAPHMIND_HIDE_TOOL_ARGS: 'no' })).toEqual(ALL_OFF);
  });

  it('ignores garbage options without throwing', () => {
    expect(resolveRedaction({ hideInputs: 'yes' as unknown as boolean }, {})).toEqual(on({ hideInputs: true }));
    expect(resolveRedaction({ hideInputs: 'no' as unknown as boolean }, {})).toEqual(ALL_OFF);
    expect(resolveRedaction(null as unknown as undefined, {})).toEqual(ALL_OFF);
  });
});

describe('Redactor: switches off', () => {
  it('returns the very same payload object (zero cost on the hot path)', () => {
    const r = new Redactor(ALL_OFF);
    const p = started('tool', 'tool:x', '1');
    expect(r.apply('node.started', p, RUN)).toBe(p);
    const f = finished('tool:x', '1');
    expect(r.apply('node.finished', f, RUN)).toBe(f);
    expect(r.active).toBe(false);
    expect(r.trackedInstances).toBe(0);
  });
});

describe('Redactor: HIDE_INPUTS', () => {
  const r = () => new Redactor(on({ hideInputs: true }));

  it('replaces node.started.input on every kind and marks the event', () => {
    for (const kind of ['agent', 'llm', 'tool', 'chain', 'retriever', 'server', 'resource', 'prompt', 'custom'] as const) {
      const out = r().apply('node.started', started(kind, `${kind}:n`, '1', { k: 'v' }), RUN);
      expect(out.input, kind).toBe(REDACTED);
      expect(out['redaction'], kind).toEqual({ count: 1, keys: ['input'] });
      expect(out.kind).toBe(kind);
      expect(out.name).toBe('n');
      expect(out.instanceId).toBe('1');
    }
  });

  it('does not touch outputs, deltas (other than tool-args), errors or run events', () => {
    const red = r();
    expect(red.apply('node.finished', finished('llm:x', '1', { text: 'T' }), RUN).output).toEqual({ text: 'T' });
    const tok = red.apply(
      'node.token',
      { nodeId: 'llm:x', deltas: [{ t: 'text', v: 'visible' }, { t: 'reasoning', v: 'r' }] },
      RUN,
    );
    expect(tok.deltas).toEqual([{ t: 'text', v: 'visible' }, { t: 'reasoning', v: 'r' }]);
    expect(tok['redaction']).toBeUndefined();
    const err: EventPayloadMap['node.error'] = { nodeId: 'llm:x', error: { name: 'E', message: 'secret S' } };
    expect(red.apply('node.error', err, RUN)).toBe(err);
    const rs: EventPayloadMap['run.started'] = { app: 'a', sdk: { name: 's', version: '1' }, meta: { secret: 'S' } };
    expect(red.apply('run.started', rs, RUN)).toBe(rs);
    const paused: EventPayloadMap['exec.paused'] = { pauseId: 'p', nodeId: 'llm:x', point: 'before' };
    expect(red.apply('exec.paused', paused, RUN)).toBe(paused);
  });

  it('hides streamed tool-args deltas (they are the next tool call input)', () => {
    const tok = r().apply(
      'node.token',
      { nodeId: 'llm:x', deltas: [{ t: 'text', v: 'ok' }, { t: 'tool-args', v: '{"q":"S"}' }] },
      RUN,
    );
    expect(tok.deltas).toEqual([{ t: 'text', v: 'ok' }, { t: 'tool-args', v: '', chars: 9 }]);
    expect(tok['redaction']).toEqual({ count: 1, keys: ['deltas'] });
  });

  it('leaves an absent input alone (no placeholder invented, no marker)', () => {
    const p: EventPayloadMap['node.started'] = { nodeId: 'server:s', kind: 'server', name: 's', instanceId: 's' };
    const out = r().apply('node.started', p, RUN);
    expect('input' in out).toBe(false);
    expect(out['redaction']).toBeUndefined();
  });

  it('treats an explicit undefined input as absent but null as a value', () => {
    const u = r().apply(
      'node.started',
      { nodeId: 'llm:x', kind: 'llm', name: 'x', instanceId: '1', input: undefined },
      RUN,
    );
    expect(u.input).toBeUndefined();
    expect(u['redaction']).toBeUndefined();
    const n = r().apply('node.started', started('llm', 'llm:x', '2', null), RUN);
    expect(n.input).toBe(REDACTED);
    expect(n['redaction']).toEqual({ count: 1, keys: ['input'] });
  });

  it('never re-redacts or re-counts a field that is already the placeholder', () => {
    const p = { ...started('llm', 'llm:x', '1', REDACTED), redaction: { count: 1, keys: ['input'] } };
    const out = r().apply('node.started', p, RUN);
    expect(out.input).toBe(REDACTED);
    expect(out['redaction']).toEqual({ count: 1, keys: ['input'] });
  });

  it('does not mutate the adapter payload it was handed', () => {
    const input = { prompt: 'S' };
    const p = started('llm', 'llm:x', '1', input);
    const before = JSON.stringify(p);
    const out = r().apply('node.started', p, RUN);
    expect(out).not.toBe(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(input.prompt).toBe('S');
  });
});

describe('Redactor: HIDE_OUTPUTS', () => {
  const r = () => new Redactor(on({ hideOutputs: true }));

  it('replaces node.finished.output on every kind; keeps usage, duration, status, loose fields', () => {
    const red = r();
    for (const kind of ['agent', 'llm', 'tool', 'custom'] as const) {
      red.apply('node.started', started(kind, `${kind}:n`, '1', {}), RUN);
      const out = red.apply(
        'node.finished',
        { ...finished(`${kind}:n`, '1', { text: 'S' }), usage: { inputTokens: 7, outputTokens: 3 }, heldMs: 5, method: 'm' },
        RUN,
      );
      expect(out.output, kind).toBe(REDACTED);
      expect(out['redaction'], kind).toEqual({ count: 1, keys: ['output'] });
      expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
      expect(out.durationMs).toBe(12.34);
      expect(out.status).toBe('ok');
      expect(out['heldMs']).toBe(5);
      expect(out['method']).toBe('m');
    }
  });

  it('empties every token delta but keeps the count of deltas and their lengths', () => {
    const out = r().apply(
      'node.token',
      {
        nodeId: 'llm:x',
        deltas: [
          { t: 'text', v: 'Hello, ' },
          { t: 'text', v: 'world' },
          { t: 'reasoning', v: 'hmm' },
          { t: 'tool-args', v: '{}' },
          { t: 'text', v: '' },
        ],
      },
      RUN,
    );
    expect(out.deltas).toHaveLength(5);
    expect(out.deltas.map((d) => d.v)).toEqual(['', '', '', '', '']);
    expect(out.deltas.map((d) => d['chars'])).toEqual([7, 5, 3, 2, undefined]);
    expect(out.deltas.map((d) => d.t)).toEqual(['text', 'text', 'reasoning', 'tool-args', 'text']);
    // Four deltas had text to hide; the empty one did not.
    expect(out['redaction']).toEqual({ count: 4, keys: ['deltas'] });
    expect(JSON.stringify(out)).not.toMatch(/Hello|world|hmm/);
  });

  it('leaves a batch that had no text alone', () => {
    const p: EventPayloadMap['node.token'] = { nodeId: 'llm:x', deltas: [{ t: 'text', v: '' }] };
    const out = r().apply('node.token', p, RUN);
    // Equal, not the same object: with a switch on the redactor always works
    // on a one-read snapshot, so what it inspected is exactly what is sent.
    expect(out).toEqual(p);
    expect(out['redaction']).toBeUndefined();
  });

  it('leaves inputs and node.error alone — error messages may echo data, and that is documented', () => {
    const red = r();
    expect(red.apply('node.started', started('tool', 'tool:x', '1', { secret: 'S' }), RUN).input).toEqual({ secret: 'S' });
    const err: EventPayloadMap['node.error'] = { nodeId: 'tool:x', error: { name: 'E', message: 'echo S' } };
    expect(red.apply('node.error', err, RUN)).toBe(err);
  });

  it('leaves an absent output alone and treats null as a value', () => {
    const red = r();
    const none = red.apply('node.finished', { nodeId: 'a:b', durationMs: 1, status: 'ok' }, RUN);
    expect('output' in none).toBe(false);
    expect(none['redaction']).toBeUndefined();
    const nul = red.apply('node.finished', finished('a:b', '1', null), RUN);
    expect(nul.output).toBe(REDACTED);
  });
});

describe('Redactor: HIDE_TOOL_ARGS', () => {
  const r = () => new Redactor(on({ hideToolArgs: true }));

  it('replaces input only when the kind is tool', () => {
    const red = r();
    expect(red.apply('node.started', started('tool', 'tool:x', '1', { q: 'S' }), RUN).input).toBe(REDACTED);
    for (const kind of ['agent', 'llm', 'chain', 'retriever', 'server', 'resource', 'prompt', 'custom'] as const) {
      const out = red.apply('node.started', started(kind, `${kind}:n`, '1', { q: 'S' }), RUN);
      expect(out.input, kind).toEqual({ q: 'S' });
      expect(out['redaction'], kind).toBeUndefined();
    }
  });

  it('hides streamed tool-args deltas on the LLM node but not text or reasoning', () => {
    const out = r().apply(
      'node.token',
      { nodeId: 'llm:x', deltas: [{ t: 'text', v: 'a' }, { t: 'tool-args', v: '{"q":"S"}' }, { t: 'reasoning', v: 'b' }] },
      RUN,
    );
    expect(out.deltas).toEqual([{ t: 'text', v: 'a' }, { t: 'tool-args', v: '', chars: 9 }, { t: 'reasoning', v: 'b' }]);
    expect(out['redaction']).toEqual({ count: 1, keys: ['deltas'] });
  });

  it('never touches outputs', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', '1'), RUN);
    expect(red.apply('node.finished', finished('tool:x', '1', { r: 'S' }), RUN).output).toEqual({ r: 'S' });
  });
});

describe('Redactor: HIDE_TOOL_RESULTS', () => {
  const r = () => new Redactor(on({ hideToolResults: true }));

  it('replaces output only on instances whose node.started said kind tool', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', '1'), RUN);
    red.apply('node.started', started('llm', 'llm:y', '1'), RUN);
    expect(red.apply('node.finished', finished('tool:x', '1', { r: 'S' }), RUN).output).toBe(REDACTED);
    const llm = red.apply('node.finished', finished('llm:y', '1', { text: 'S' }), RUN);
    expect(llm.output).toEqual({ text: 'S' });
    expect(llm['redaction']).toBeUndefined();
  });

  it('never touches inputs', () => {
    expect(r().apply('node.started', started('tool', 'tool:x', '1', { q: 'S' }), RUN).input).toEqual({ q: 'S' });
  });

  it('resolves concurrent instances of one tool by instanceId and forgets them once finished', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', 'a'), RUN);
    red.apply('node.started', started('tool', 'tool:x', 'b'), RUN);
    expect(red.trackedInstances).toBe(2);
    expect(red.apply('node.finished', finished('tool:x', 'b', 'S'), RUN).output).toBe(REDACTED);
    expect(red.trackedInstances).toBe(1);
    expect(red.apply('node.finished', finished('tool:x', 'a', 'S'), RUN).output).toBe(REDACTED);
    expect(red.trackedInstances).toBe(0);
  });

  it('keeps runs apart: the same nodeId in another run has its own kind', () => {
    const red = r();
    red.apply('node.started', started('tool', 'x:thing', '1'), 'run-A');
    red.apply('node.started', started('llm', 'x:thing', '1'), 'run-B');
    expect(red.apply('node.finished', finished('x:thing', '1', 'S'), 'run-A').output).toBe(REDACTED);
    expect(red.apply('node.finished', finished('x:thing', '1', 'S'), 'run-B').output).toBe('S');
  });

  it('node.error does not close the instance; the node.finished that follows is still redacted', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', '1'), RUN);
    red.apply('node.error', { nodeId: 'tool:x', instanceId: '1', error: { name: 'E', message: 'm' } }, RUN);
    expect(red.apply('node.finished', finished('tool:x', '1', null), RUN).output).toBe(REDACTED);
  });

  it('falls back to the node\'s latest kind when node.finished carries no instanceId', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', '1'), RUN);
    expect(red.apply('node.finished', finished('tool:x', undefined, 'S'), RUN).output).toBe(REDACTED);
    red.apply('node.started', started('llm', 'llm:y', '1'), RUN);
    expect(red.apply('node.finished', finished('llm:y', undefined, 'S'), RUN).output).toBe('S');
  });

  it('falls back to the tool: nodeId prefix for an instance it never saw start', () => {
    const red = r();
    expect(red.apply('node.finished', finished('tool:ghost', 'x', 'S'), RUN).output).toBe(REDACTED);
    expect(red.apply('node.finished', finished('llm:ghost', 'x', 'S'), RUN).output).toBe('S');
    expect(red.apply('node.finished', finished('ghost', 'x', 'S'), RUN).output).toBe('S');
  });

  it('hides a tool node\'s streamed chunks but not an LLM node\'s text', () => {
    const red = r();
    red.apply('node.started', started('tool', 'tool:x', '1'), RUN);
    red.apply('node.started', started('llm', 'llm:y', '1'), RUN);
    expect(red.apply('node.token', { nodeId: 'tool:x', deltas: [{ t: 'text', v: 'chunk' }] }, RUN).deltas).toEqual([
      { t: 'text', v: '', chars: 5 },
    ]);
    expect(red.apply('node.token', { nodeId: 'llm:y', deltas: [{ t: 'text', v: 'chunk' }] }, RUN).deltas).toEqual([
      { t: 'text', v: 'chunk' },
    ]);
  });

  it('is bounded: more open instances than the cap evicts the oldest without throwing', () => {
    const red = new Redactor(on({ hideToolResults: true }), 3);
    for (let i = 0; i < 10; i += 1) red.apply('node.started', started('tool', 'tool:x', String(i)), RUN);
    expect(red.trackedInstances).toBe(3);
    // The evicted ones still resolve through the node's latest kind.
    expect(red.apply('node.finished', finished('tool:x', '0', 'S'), RUN).output).toBe(REDACTED);
  });
});

describe('Redactor: combined switches', () => {
  it('all four together hide every payload while names, kinds, timings and counts survive', () => {
    const red = new Redactor(on({ hideInputs: true, hideOutputs: true, hideToolArgs: true, hideToolResults: true }));
    const s = red.apply('node.started', started('llm', 'llm:step', '1', { messages: ['S'] }), RUN);
    const t = red.apply('node.token', { nodeId: 'llm:step', deltas: [{ t: 'text', v: 'SS' }] }, RUN);
    const f = red.apply(
      'node.finished',
      { ...finished('llm:step', '1', { text: 'S' }), usage: { inputTokens: 1, outputTokens: 2 } },
      RUN,
    );
    const all = JSON.stringify([s, t, f]);
    expect(all).not.toContain('S"');
    expect(all).not.toContain('SS');
    expect(s).toMatchObject({ nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: '1', input: REDACTED });
    expect(t.deltas).toEqual([{ t: 'text', v: '', chars: 2 }]);
    expect(f).toMatchObject({ output: REDACTED, durationMs: 12.34, usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it('merges an existing redaction summary instead of clobbering it', () => {
    const red = new Redactor(on({ hideOutputs: true }));
    const out = red.apply(
      'node.finished',
      { ...finished('llm:x', '1', 'S'), redaction: { count: 2, keys: ['messages', 'output'] } },
      RUN,
    );
    expect(out['redaction']).toEqual({ count: 3, keys: ['messages', 'output'] });
  });

  it('survives a hostile existing redaction field', () => {
    const red = new Redactor(on({ hideOutputs: true }));
    const hostile = { ...finished('llm:x', '1', 'S'), redaction: 'garbage' } as unknown as EventPayloadMap['node.finished'];
    const out = red.apply('node.finished', hostile, RUN);
    expect(out.output).toBe(REDACTED);
    expect(out['redaction']).toEqual({ count: 1, keys: ['output'] });
  });

  it('never throws: a payload that is not an object is dropped (fail closed), odd deltas fail closed', () => {
    // Was "comes back untouched" before redaction failed closed: a string
    // payload under HIDE_INPUTS can be the very input the switch hides.
    const red = new RealRedactor(on({ hideInputs: true, hideOutputs: true }));
    for (const junk of [null, undefined, 42, 'str', []]) {
      expect(red.apply('node.started', junk as unknown as EventPayloadMap['node.started'], RUN)).toBeUndefined();
      expect(red.apply('node.finished', junk as unknown as EventPayloadMap['node.finished'], RUN)).toBeUndefined();
      expect(red.apply('node.token', junk as unknown as EventPayloadMap['node.token'], RUN)).toBeUndefined();
    }
    const weirdDeltas = { nodeId: 'llm:x', deltas: 'not-an-array' } as unknown as EventPayloadMap['node.token'];
    expect(red.apply('node.token', weirdDeltas, RUN)).toEqual({ nodeId: 'llm:x', deltas: [], redaction: FAILED });
    const nullDelta = { nodeId: 'llm:x', deltas: [null, { t: 'text', v: 'S' }, { t: 'text' }] } as unknown as EventPayloadMap['node.token'];
    const out = red.apply('node.token', nullDelta, RUN);
    expect(out?.deltas).toEqual([null, { t: 'text', v: '', chars: 1 }, { t: 'text' }]);
  });
});

// ── the cross-language conformance fixture ──────────────────────────────────

interface FixtureEvent {
  type: EventType;
  payload?: Record<string, unknown>;
  dropped?: true;
}
interface FixtureCase {
  name: string;
  switches: Partial<RedactionSwitches>;
  in: FixtureEvent[];
  out: FixtureEvent[];
}
interface Fixture {
  placeholder: string;
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/redaction.json', import.meta.url), 'utf8'),
) as Fixture;

describe('conformance fixture (shared with the Python and Ruby ports)', () => {
  it('uses the shared placeholder', () => {
    expect(fixture.placeholder).toBe(REDACTED);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(6);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const red = new RealRedactor(on(c.switches));
    expect(c.in.length).toBe(c.out.length);
    const produced = c.in.map((event) => {
      const out = red.apply(event.type, event.payload as EventPayloadMap[typeof event.type], 'fixture-run');
      // A dropped event is `{type, dropped: true}` in the fixture.
      if (out === undefined) return { type: event.type, dropped: true };
      return {
        type: event.type,
        // Round-trip through JSON so `undefined`-valued keys compare like the
        // fixture (the wire is JSON; that is what the other languages see).
        payload: JSON.parse(JSON.stringify(out)) as Record<string, unknown>,
      };
    });
    expect(produced).toEqual(c.out);
  });

  it('is not vacuous: every case with a switch on changes at least one event', () => {
    for (const c of fixture.cases) {
      const anyOn = Object.values(c.switches).some(Boolean);
      const changed = JSON.stringify(c.in) !== JSON.stringify(c.out);
      expect(changed, c.name).toBe(anyOn);
    }
  });
});

// ── Adversarial verification (W7) ────────────────────────────────────────────
describe('verifier: the redacted event is always valid on the wire', () => {
  it('replaces an existing summary whose count is not a non-negative integer instead of merging it', async () => {
    const { EventPayloadSchemas } = await import('@graphmind-ai/schema');
    const red = new Redactor(on({ hideOutputs: true, hideInputs: true }));
    for (const count of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const out = red.apply(
        'node.finished',
        { ...finished('llm:x', '1', 'S'), redaction: { count, keys: ['input'] } } as unknown as EventPayloadMap['node.finished'],
        RUN,
      );
      expect(out.output, String(count)).toBe(REDACTED);
      // The hub drops an envelope whose payload fails the schema: a merged
      // `count: 2.5` would have lost the node.finished (and the placeholder) entirely.
      expect(EventPayloadSchemas['node.finished'].safeParse(out).success, String(count)).toBe(true);
      expect(out['redaction'], String(count)).toEqual({ count: 1, keys: ['input', 'output'] });
    }
    const valid = red.apply(
      'node.started',
      { ...started('tool', 'tool:y', '1'), redaction: { count: 2, keys: ['meta', 7] } } as unknown as EventPayloadMap['node.started'],
      RUN,
    );
    expect(valid['redaction']).toEqual({ count: 3, keys: ['meta', 'input'] });
  });
});

describe('verifier: what HIDE_TOOL_ARGS / HIDE_TOOL_RESULTS do NOT cover (documented)', () => {
  // In an agent loop the model's next request carries the previous tool call
  // and its result as messages (`tool_use` / `tool_result`), so they are part
  // of the LLM node's input. The tool-only switches hide the TOOL node's own
  // fields and nothing else; keeping those values out of the recording
  // entirely needs HIDE_INPUTS (and HIDE_OUTPUTS for the model's tool_use
  // blocks). Pinned so the ports and the docs agree on it.
  const llmStep = (): EventPayloadMap['node.started'] =>
    started('llm', 'llm:step', 's1', {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: { email: 'ARG' } }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'RESULT' }] },
      ],
    });

  it('the tool-only switches leave an LLM node input that echoes tool args and results untouched', () => {
    const red = new Redactor(on({ hideToolArgs: true, hideToolResults: true }));
    const input = llmStep();
    // Equal (a snapshot, see "fails closed"), unredacted, unmarked.
    expect(red.apply('node.started', input, RUN)).toEqual(input);
  });

  it('HIDE_INPUTS is the switch that removes them', () => {
    const red = new Redactor(on({ hideInputs: true }));
    const out = red.apply('node.started', llmStep(), RUN);
    expect(JSON.stringify(out)).not.toContain('ARG');
    expect(JSON.stringify(out)).not.toContain('RESULT');
  });
});

describe('integrator: option switches fail closed', () => {
  it('true, 1, "1", "true" (any case, padded) turn an option switch on; everything else is off', async () => {
    const { optionFlagOn, resolveRedaction } = await import('../src/redaction.js');
    for (const on of [true, 1, '1', 'true', 'TRUE', ' True ', 'yes', 'on']) {
      expect(optionFlagOn(on), JSON.stringify(on)).toBe(true);
    }
    for (const off of [false, 0, '0', 'false', 'off', 'no', '', null, undefined, 2, {}, []]) {
      expect(optionFlagOn(off), JSON.stringify(off)).toBe(false);
    }
    // A JS config that says hideInputs: 'true' must not silently record inputs.
    const s = resolveRedaction({ hideInputs: 'true', hideToolResults: 1 } as never, {});
    expect(s).toEqual({ hideInputs: true, hideOutputs: false, hideToolArgs: false, hideToolResults: true });
  });
});

// ── Redaction fails closed on internal error (integrator decision, BINDING) ───
// Before: when any switch was on and redaction threw (a payload whose getters
// or Proxy traps throw), `apply` returned the RAW payload and it was sent.
describe('fails closed: a redaction failure never emits an unredacted value', () => {
  const SECRET = 'SECRET-CANARY-5f1e';

  /** Validate a payload exactly as the hub does: as a whole envelope. */
  async function validOnTheWire(type: EventType, payload: unknown): Promise<boolean> {
    const { parseEnvelope, createEnvelope } = await import('@graphmind-ai/schema');
    const json = JSON.stringify(createEnvelope<EventType>({ type, payload: payload as never, seq: 1, runId: 'run_x' }));
    return parseEnvelope(JSON.parse(json)).kind === 'ok';
  }

  /** A payload object whose `get` throws for the named keys, and counts reads. */
  function trapped<T extends object>(target: T, throwOn: string[]): { proxy: T; reads: Map<string, number> } {
    const reads = new Map<string, number>();
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === 'string') reads.set(key, (reads.get(key) ?? 0) + 1);
        if (typeof key === 'string' && throwOn.includes(key)) throw new Error(`trap: ${key} ${SECRET}`);
        return Reflect.get(t, key, receiver);
      },
    });
    return { proxy, reads };
  }

  function redactorWithWarnings(switches: Partial<RedactionSwitches>) {
    const warnings: { key: string; message: string }[] = [];
    const red = new RealRedactor(on(switches), undefined, (key, message) => warnings.push({ key, message }));
    return { red, warnings };
  }

  it('node.started whose input read throws: failed form, identity copied, input never read again, valid envelope', async () => {
    const { red, warnings } = redactorWithWarnings({ hideInputs: true });
    const { proxy, reads } = trapped(
      { nodeId: 'tool:lookup', parentId: 'agent:a', kind: 'tool', name: 'lookup', instanceId: 'i1', input: { email: SECRET }, extra: SECRET },
      ['input'],
    );
    const out = red.apply('node.started', proxy as EventPayloadMap['node.started'], RUN);
    expect(out).toEqual({
      nodeId: 'tool:lookup',
      parentId: 'agent:a',
      kind: 'tool',
      name: 'lookup',
      instanceId: 'i1',
      input: REDACTED,
      redaction: FAILED,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // The one read that threw; the failed form never touches `input` again.
    expect(reads.get('input')).toBe(1);
    expect(await validOnTheWire('node.started', out)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).not.toContain(SECRET);
    // The instance's kind was still learned: its node.finished is redacted under HIDE_TOOL_RESULTS.
    const tr = new RealRedactor(on({ hideToolResults: true }));
    tr.apply('node.started', trapped({ nodeId: 'tool:q', kind: 'tool', name: 'q', instanceId: 'k', input: 1 }, ['input']).proxy as never, RUN);
    expect(tr.apply('node.finished', { nodeId: 'llm-looking-id', instanceId: 'k', output: 'x', durationMs: 1, status: 'ok' }, RUN)?.output).toBe('x');
    expect(tr.apply('node.finished', { nodeId: 'tool:q', instanceId: 'k', output: SECRET, durationMs: 1, status: 'ok' }, RUN)?.output).toBe(REDACTED);
  });

  it('node.finished whose output read throws keeps timing, status, usage, heldMs; output hidden', async () => {
    const { red } = redactorWithWarnings({ hideOutputs: true });
    const { proxy, reads } = trapped(
      { nodeId: 'llm:x', instanceId: 'i2', output: { text: SECRET }, durationMs: 3.5, heldMs: 1.25, status: 'error', usage: { inputTokens: 9, outputTokens: 2 }, note: SECRET },
      ['output'],
    );
    const out = red.apply('node.finished', proxy as EventPayloadMap['node.finished'], RUN);
    expect(out).toEqual({
      nodeId: 'llm:x',
      instanceId: 'i2',
      durationMs: 3.5,
      heldMs: 1.25,
      status: 'error',
      usage: { inputTokens: 9, outputTokens: 2 },
      output: REDACTED,
      redaction: FAILED,
    });
    expect(reads.get('output')).toBe(1);
    expect(await validOnTheWire('node.finished', out)).toBe(true);
  });

  it('node.token whose deltas read throws: deltas [] and nodeId kept', async () => {
    const { red } = redactorWithWarnings({ hideToolArgs: true });
    const { proxy, reads } = trapped({ nodeId: 'llm:x', instanceId: 'i3', deltas: [{ t: 'tool-args', v: SECRET }] }, ['deltas']);
    const out = red.apply('node.token', proxy as EventPayloadMap['node.token'], RUN);
    expect(out).toEqual({ nodeId: 'llm:x', instanceId: 'i3', deltas: [], redaction: FAILED });
    expect(reads.get('deltas')).toBe(1);
    expect(await validOnTheWire('node.token', out)).toBe(true);
  });

  it('a getter that throws only on a REQUIRED identity field drops the event with one warning; on an optional one it is omitted', async () => {
    const { red, warnings } = redactorWithWarnings({ hideInputs: true });
    const base = { nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'i', parentId: 'p', input: SECRET };
    for (const key of ['nodeId', 'kind', 'name', 'instanceId']) {
      const { proxy } = trapped({ ...base }, [key]);
      expect(red.apply('node.started', proxy as EventPayloadMap['node.started'], RUN), key).toBeUndefined();
    }
    expect(warnings.filter((w) => w.key === 'redaction:dropped')).toHaveLength(4);
    for (const w of warnings) expect(w.message).not.toContain(SECRET);

    const { proxy } = trapped({ ...base }, ['parentId']);
    const out = red.apply('node.started', proxy as EventPayloadMap['node.started'], RUN);
    expect(out).toEqual({ nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'i', input: REDACTED, redaction: FAILED });
    expect(await validOnTheWire('node.started', out)).toBe(true);

    // node.finished: durationMs / status are required too; usage / heldMs optional.
    const fin = { nodeId: 'llm:x', output: SECRET, durationMs: 1, status: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, heldMs: 0 };
    for (const key of ['nodeId', 'durationMs', 'status']) {
      expect(red.apply('node.finished', trapped({ ...fin }, [key]).proxy as never, RUN), key).toBeUndefined();
    }
    const noUsage = new RealRedactor(on({ hideOutputs: true })).apply('node.finished', trapped({ ...fin }, ['usage', 'heldMs']).proxy as never, RUN);
    expect(noUsage).toEqual({ nodeId: 'llm:x', durationMs: 1, status: 'ok', output: REDACTED, redaction: FAILED });
  });

  it('a failed form whose required fields are schema-invalid is dropped; invalid optional fields are omitted', async () => {
    const red = new RealRedactor(on({ hideInputs: true, hideOutputs: true }));
    const throwing = (extra: Record<string, unknown>) => trapped({ input: SECRET, output: SECRET, deltas: [SECRET], ...extra }, ['input', 'output', 'deltas']).proxy;
    expect(red.apply('node.started', throwing({ nodeId: 5, kind: 'tool', name: 'a', instanceId: 'i' }) as never, RUN)).toBeUndefined();
    expect(red.apply('node.started', throwing({ nodeId: 'a', kind: 'bogus', name: 'a', instanceId: 'i' }) as never, RUN)).toBeUndefined();
    expect(red.apply('node.finished', throwing({ nodeId: 'a', durationMs: -1, status: 'ok' }) as never, RUN)).toBeUndefined();
    expect(red.apply('node.finished', throwing({ nodeId: 'a', durationMs: Number.NaN, status: 'ok' }) as never, RUN)).toBeUndefined();
    expect(red.apply('node.finished', throwing({ nodeId: 'a', durationMs: 1, status: 'weird' }) as never, RUN)).toBeUndefined();
    expect(red.apply('node.token', throwing({ nodeId: null }) as never, RUN)).toBeUndefined();
    const out = red.apply(
      'node.finished',
      throwing({ nodeId: 'a', instanceId: 7, durationMs: 0, status: 'aborted', heldMs: -3, usage: { inputTokens: 1.5, outputTokens: 1 } }) as never,
      RUN,
    );
    expect(out).toEqual({ nodeId: 'a', durationMs: 0, status: 'aborted', output: REDACTED, redaction: FAILED });
    expect(await validOnTheWire('node.finished', out)).toBe(true);
    const started = red.apply('node.started', throwing({ nodeId: 'a', kind: 'custom', name: 'a', instanceId: 'i', parentId: {} }) as never, RUN);
    expect(started).toEqual({ nodeId: 'a', kind: 'custom', name: 'a', instanceId: 'i', input: REDACTED, redaction: FAILED });
  });

  it('a Proxy whose every trap throws, a revoked Proxy, and a throwing warn sink never throw into the caller', () => {
    const everyTrap = new Proxy({}, {
      get: () => { throw new Error('get'); },
      has: () => { throw new Error('has'); },
      ownKeys: () => { throw new Error('ownKeys'); },
      getOwnPropertyDescriptor: () => { throw new Error('gOPD'); },
      getPrototypeOf: () => { throw new Error('proto'); },
    });
    const { proxy: revokedTarget, revoke } = Proxy.revocable({ nodeId: 'a', input: SECRET }, {});
    revoke();
    const red = new RealRedactor(on({ hideInputs: true }), undefined, () => {
      throw new Error('sink');
    });
    for (const payload of [everyTrap, revokedTarget]) {
      for (const type of ['node.started', 'node.finished', 'node.token'] as const) {
        let out: unknown = 'not called';
        expect(() => {
          out = red.apply(type, payload as never, RUN);
        }).not.toThrow();
        expect(out).toBeUndefined();
      }
    }
  });

  it('closes the non-throwing ways past the switch: a lying `has` trap, an own toJSON, a getter that changes its answer', () => {
    const red = new RealRedactor(on({ hideInputs: true, hideOutputs: true }));
    // `'input' in p` says no, JSON.stringify still finds it.
    const liar = new Proxy(
      { nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'i', input: SECRET },
      { has: (t, k) => (k === 'input' ? false : Reflect.has(t, k)) },
    );
    expect(JSON.stringify(red.apply('node.started', liar as never, RUN))).not.toContain(SECRET);
    // An own toJSON would replace the whole payload at serialisation time.
    const withToJSON = {
      nodeId: 'llm:x', output: SECRET, durationMs: 1, status: 'ok',
      toJSON() { return { nodeId: 'llm:x', output: SECRET, durationMs: 1, status: 'ok' }; },
    };
    const outFinished = red.apply('node.finished', withToJSON as never, RUN);
    expect(JSON.stringify(outFinished)).not.toContain(SECRET);
    expect(JSON.parse(JSON.stringify(outFinished))).toMatchObject({ output: REDACTED });
    // A getter that is undefined when inspected and secret when serialised.
    let n = 0;
    const flaky = {
      nodeId: 'tool:a', kind: 'tool', name: 'a', instanceId: 'i',
      get input() { n += 1; return n === 1 ? undefined : SECRET; },
    };
    expect(JSON.stringify(red.apply('node.started', flaky as never, RUN))).not.toContain(SECRET);
    // Same for a delta whose `v` is not a string when inspected, then a string.
    let m = 0;
    const flakyDelta = { t: 'text', get v() { m += 1; return m === 1 ? 5 : SECRET; } };
    expect(JSON.stringify(red.apply('node.token', { nodeId: 'llm:x', deltas: [flakyDelta] } as never, RUN))).not.toContain(SECRET);
    let d = 0;
    const flakyText = { t: 'text', get v() { d += 1; return d === 1 ? '' : SECRET; } };
    expect(JSON.stringify(red.apply('node.token', { nodeId: 'llm:x', deltas: [flakyText] } as never, RUN))).not.toContain(SECRET);
  });

  it('with every switch off the redactor is not involved: a hostile payload passes through as the same object', () => {
    const red = new RealRedactor(ALL_OFF, undefined, () => {
      throw new Error('never called');
    });
    const { proxy, reads } = trapped({ nodeId: 'a', input: SECRET }, ['input']);
    expect(red.apply('node.started', proxy as never, RUN)).toBe(proxy);
    expect(red.apply('node.started', 'str' as never, RUN)).toBe('str');
    expect(reads.size).toBe(0);
  });

  it('other event types are never inspected, even with a switch on', () => {
    const red = new RealRedactor(on({ hideInputs: true, hideOutputs: true }));
    const { proxy, reads } = trapped({ nodeId: 'a', error: { name: 'E', message: 'm' } }, ['nodeId', 'error']);
    expect(red.apply('node.error', proxy as never, RUN)).toBe(proxy);
    expect(red.apply('run.started', 'str' as never, RUN)).toBe('str');
    expect(reads.size).toBe(0);
  });
});
