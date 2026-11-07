/**
 * The replay tape: matching, ordinals, miss policy, and the honesty rules
 * (a mismatched call is never answered; a lossy entry refuses).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  liveKey,
  parseTape,
  ReplayMissError,
  ReplayTape,
  TAPE_VERSION,
  type ReplayEvent,
  type Tape,
  type TapeEntry,
} from '../src/replay.js';

function entry(
  partial: { [K in keyof TapeEntry]?: TapeEntry[K] | undefined } & Pick<TapeEntry, 'nodeId'>,
): TapeEntry {
  const base: TapeEntry = {
    nodeId: partial.nodeId,
    kind: partial.kind ?? 'tool',
    name: partial.name ?? partial.nodeId.split(':')[1] ?? partial.nodeId,
    ordinal: partial.ordinal ?? 0,
    status: partial.status ?? 'ok',
  };
  // `exactOptionalPropertyTypes`: an explicit `key: undefined` must not
  // become a present-but-undefined property, so optional fields are set
  // only when they actually have a value.
  if (partial.key !== undefined) base.key = partial.key;
  if (partial.seq !== undefined) base.seq = partial.seq;
  if (partial.output !== undefined) base.output = partial.output;
  if (partial.error !== undefined) base.error = partial.error;
  if (partial.usage !== undefined) base.usage = partial.usage;
  if (partial.lossy !== undefined) base.lossy = partial.lossy;
  return base;
}

function tapeOf(...entries: TapeEntry[]): Tape {
  return { graphmindTape: TAPE_VERSION, runId: 'run_1', entries };
}

describe('parseTape', () => {
  it('accepts a well-formed tape', () => {
    const tape = parseTape(JSON.stringify(tapeOf(entry({ nodeId: 'tool:a' }))));
    expect(tape.runId).toBe('run_1');
    expect(tape.entries).toHaveLength(1);
  });

  it('refuses junk, a wrong version, and a tape with no entries', () => {
    expect(() => parseTape('not json')).toThrow(/invalid JSON/);
    expect(() => parseTape('[]')).toThrow(/not supported/); // an array has no version
    expect(() => parseTape('null')).toThrow(/not an object/);
    expect(() => parseTape(JSON.stringify({ graphmindTape: 99, runId: 'r', entries: [] }))).toThrow(
      /not supported/,
    );
    expect(() => parseTape(JSON.stringify({ graphmindTape: TAPE_VERSION, runId: 'r' }))).toThrow(
      /no entries/,
    );
  });
});

describe('ReplayTape.decide', () => {
  it('answers a matching call with the recorded output', () => {
    const key = liveKey('tool:a', { q: 1 });
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a', key, output: { ok: true } })));
    expect(tape.decide('tool:a', 'tool', { q: 1 })).toEqual({ action: 'inject', output: { ok: true } });
  });

  it('serves repeated calls of one node in recorded order', () => {
    const tape = new ReplayTape(
      tapeOf(
        entry({ nodeId: 'tool:a', ordinal: 0, output: 'first' }),
        entry({ nodeId: 'tool:a', ordinal: 1, output: 'second' }),
      ),
    );
    expect(tape.decide('tool:a', 'tool', {})).toMatchObject({ output: 'first' });
    expect(tape.decide('tool:a', 'tool', {})).toMatchObject({ output: 'second' });
  });

  it('replays a recorded throw as a throw decision, not a value', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a', status: 'error', error: { name: 'Boom', message: 'nope' } })),
    );
    const decision = tape.decide('tool:a', 'tool', {});
    expect(decision?.action).toBe('throw');
    const error = (decision as { error: Error }).error;
    expect(error.name).toBe('Boom');
    expect(error.message).toBe('nope');
  });

  it('ignores _meta when matching, as the recorder did', () => {
    const key = liveKey('tool:a', { q: 1, _meta: { progressToken: 1 } });
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a', key, output: 1 })));
    expect(tape.decide('tool:a', 'tool', { q: 1, _meta: { progressToken: 999 } })).toMatchObject({
      action: 'inject',
    });
  });
});

describe('divergence', () => {
  it('refuses to answer a call whose arguments differ from the recording', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a', key: liveKey('tool:a', { q: 1 }), output: 'recorded' })),
    );
    expect(() => tape.decide('tool:a', 'tool', { q: 2 })).toThrow(ReplayMissError);
  });

  it('a call the recording never made is fatal by default', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a' })));
    tape.decide('tool:a', 'tool', {});
    expect(() => tape.decide('tool:a', 'tool', {})).toThrow(/no call #2/);
  });

  it('--on-miss=live lets the call run for real', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a' })), { onMiss: 'live' });
    tape.decide('tool:a', 'tool', {});
    expect(tape.decide('tool:a', 'tool', {})).toBeUndefined();
  });

  it('--on-miss=skip answers with undefined instead of running', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a' })), { onMiss: 'skip' });
    tape.decide('tool:a', 'tool', {});
    expect(tape.decide('tool:a', 'tool', {})).toEqual({ action: 'inject', output: undefined });
  });

  it('an unreadable live input matches on the ordinal rather than claiming equality', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a', key: liveKey('tool:a', { q: 1 }), output: 'x' })),
    );
    const trap = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(tape.decide('tool:a', 'tool', trap)).toMatchObject({ action: 'inject', output: 'x' });
  });
});

describe('lossy entries', () => {
  it('refuse to answer by default rather than feed back a truncated value', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a', output: 'preview…', lossy: true })));
    expect(() => tape.decide('tool:a', 'tool', {})).toThrow(/too large to record in full/);
  });

  it('fall through to a live call with --on-lossy=live', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a', output: 'preview…', lossy: true })), {
      onLossy: 'live',
    });
    expect(tape.decide('tool:a', 'tool', {})).toBeUndefined();
  });
});

describe('reporting', () => {
  it('emits one event per decision for the CLI report', () => {
    const events: ReplayEvent[] = [];
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a', key: liveKey('tool:a', { q: 1 }) })),
      { onMiss: 'live', onEvent: (event) => events.push(event) },
    );
    tape.decide('tool:a', 'tool', { q: 1 });
    tape.decide('tool:a', 'tool', { q: 1 });
    expect(events.map((event) => event.kind)).toEqual(['answered', 'live']);
  });

  it('a throwing reporter never breaks the run', () => {
    const tape = new ReplayTape(tapeOf(entry({ nodeId: 'tool:a', output: 1 })), {
      onEvent: () => {
        throw new Error('reporter exploded');
      },
    });
    expect(tape.decide('tool:a', 'tool', {})).toMatchObject({ action: 'inject' });
  });

  it('reports entries the run never reached', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a', ordinal: 0 }), entry({ nodeId: 'tool:a', ordinal: 1 })),
    );
    tape.decide('tool:a', 'tool', {});
    expect(tape.unconsumed()).toHaveLength(1);
  });

  it('counts entries per kind for the pre-flight', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'tool:a' }), entry({ nodeId: 'llm:step', kind: 'llm' })),
    );
    expect(tape.countOf('tool')).toBe(1);
    expect(tape.countOf('llm')).toBe(1);
  });
});

describe('next', () => {
  it('hands out a node\'s entries in order and then nothing', () => {
    const tape = new ReplayTape(
      tapeOf(entry({ nodeId: 'llm:step', kind: 'llm', ordinal: 0, output: { text: 'a' } }),
             entry({ nodeId: 'llm:step', kind: 'llm', ordinal: 1, output: { text: 'b' } })),
    );
    expect(tape.next('llm:step')?.output).toEqual({ text: 'a' });
    expect(tape.next('llm:step')?.output).toEqual({ text: 'b' });
    expect(tape.next('llm:step')).toBeUndefined();
  });
});

describe('liveKey', () => {
  it('is stable across processes (no per-process salt)', () => {
    expect(liveKey('tool:a', { q: 1 })).toBe(liveKey('tool:a', { q: 1 }));
    expect(liveKey('tool:a', { q: 1 })).toContain('tool:a');
  });

  it('is undefined for an input that cannot be read', () => {
    const trap = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(liveKey('tool:a', trap)).toBeUndefined();
  });
});
