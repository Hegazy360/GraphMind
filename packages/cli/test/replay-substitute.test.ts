/**
 * `--substitute`: parsing the argument, applying it to a tape, and where
 * the cut lands. The runtime consequence of a cut (calls past it run for
 * real) is proved in packages/ai-sdk/test/replay.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAPE_VERSION, type Tape, type TapeEntry } from '@graphmind-ai/client';
import { applySubstitutions, parseSubstitution, SubstituteError } from '../src/replay/substitute.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-subst-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(partial: Partial<TapeEntry> & Pick<TapeEntry, 'nodeId' | 'seq'>): TapeEntry {
  const base: TapeEntry = {
    nodeId: partial.nodeId,
    kind: partial.kind ?? 'tool',
    name: partial.name ?? partial.nodeId.split(':')[1] ?? partial.nodeId,
    ordinal: partial.ordinal ?? 0,
    status: partial.status ?? 'ok',
  };
  if (partial.seq !== undefined) base.seq = partial.seq;
  if (partial.output !== undefined) base.output = partial.output;
  if (partial.error !== undefined) base.error = partial.error;
  if (partial.lossy !== undefined) base.lossy = partial.lossy;
  return base;
}

/** llm#0 → tool:convert#0 → llm#1 → tool:check#0 → llm#2 */
function sampleTape(): Tape {
  return {
    graphmindTape: TAPE_VERSION,
    runId: 'run_1',
    entries: [
      entry({ nodeId: 'llm:step', kind: 'llm', seq: 1, ordinal: 0, output: { text: 'a' } }),
      entry({ nodeId: 'tool:convert', seq: 3, ordinal: 0, output: { usd: 60_000_000 } }),
      entry({ nodeId: 'llm:step', kind: 'llm', seq: 5, ordinal: 1, output: { text: 'b' } }),
      entry({ nodeId: 'tool:check', seq: 7, ordinal: 0, output: { ok: false } }),
      entry({ nodeId: 'llm:step', kind: 'llm', seq: 9, ordinal: 2, output: { text: 'c' } }),
    ],
  };
}

describe('parseSubstitution', () => {
  it('reads nodeId and a JSON value', () => {
    expect(parseSubstitution('tool:convert={"usd":2693.4}')).toEqual({
      nodeId: 'tool:convert',
      ordinal: 0,
      value: { usd: 2693.4 },
    });
  });

  it('reads an explicit call number', () => {
    expect(parseSubstitution('tool:convert#2=null')).toMatchObject({ nodeId: 'tool:convert', ordinal: 2 });
  });

  it('reads a value from @file', () => {
    const path = join(dir, 'fix.json');
    writeFileSync(path, '{"usd": 1}');
    expect(parseSubstitution(`tool:convert=@${path}`).value).toEqual({ usd: 1 });
  });

  it('accepts scalars and nulls, not just objects', () => {
    expect(parseSubstitution('tool:x=42').value).toBe(42);
    expect(parseSubstitution('tool:x="hi"').value).toBe('hi');
    expect(parseSubstitution('tool:x=null').value).toBeNull();
  });

  it('refuses a missing "=", a missing nodeId, a bad ordinal and bad JSON', () => {
    expect(() => parseSubstitution('tool:convert')).toThrow(/needs <nodeId>/);
    expect(() => parseSubstitution('=1')).toThrow(/needs <nodeId>|needs a nodeId/);
    expect(() => parseSubstitution('tool:x#abc=1')).toThrow(/not a call number/);
    expect(() => parseSubstitution('tool:x={nope}')).toThrow(/not valid JSON/);
  });

  it('names the missing file rather than failing obscurely', () => {
    expect(() => parseSubstitution('tool:x=@/nope/missing.json')).toThrow(/cannot read/);
  });
});

describe('applySubstitutions', () => {
  it('replaces the recorded output and cuts the tape at that call', () => {
    const tape = applySubstitutions(sampleTape(), [
      { nodeId: 'tool:convert', ordinal: 0, value: { usd: 2693.4 } },
    ]);
    expect(tape.cutSeq).toBe(3);
    expect(tape.substituted).toEqual([{ nodeId: 'tool:convert', ordinal: 0 }]);
    expect(tape.entries.find((e) => e.nodeId === 'tool:convert')?.output).toEqual({ usd: 2693.4 });
  });

  it('leaves the original tape untouched', () => {
    const original = sampleTape();
    applySubstitutions(original, [{ nodeId: 'tool:convert', ordinal: 0, value: 'changed' }]);
    expect(original.cutSeq).toBeUndefined();
    expect(original.entries[1]?.output).toEqual({ usd: 60_000_000 });
  });

  it('cuts at the EARLIEST substitution when several are given', () => {
    const tape = applySubstitutions(sampleTape(), [
      { nodeId: 'tool:check', ordinal: 0, value: { ok: true } },
      { nodeId: 'tool:convert', ordinal: 0, value: { usd: 1 } },
    ]);
    expect(tape.cutSeq).toBe(3);
  });

  it('turns a call that threw into one that returns', () => {
    const base = sampleTape();
    base.entries[1] = entry({
      nodeId: 'tool:convert',
      seq: 3,
      status: 'error',
      error: { name: 'Boom', message: 'nope' },
    });
    const tape = applySubstitutions(base, [{ nodeId: 'tool:convert', ordinal: 0, value: { usd: 1 } }]);
    const target = tape.entries.find((e) => e.nodeId === 'tool:convert');
    expect(target?.status).toBe('ok');
    expect(target?.error).toBeUndefined();
  });

  it('clears the lossy flag — your value is not the recorder is truncated one', () => {
    const base = sampleTape();
    base.entries[1] = entry({ nodeId: 'tool:convert', seq: 3, output: 'preview…', lossy: true });
    const tape = applySubstitutions(base, [{ nodeId: 'tool:convert', ordinal: 0, value: 'whole' }]);
    expect(tape.entries.find((e) => e.nodeId === 'tool:convert')?.lossy).toBeUndefined();
  });

  it('refuses a node the run never called, and says what it did call', () => {
    expect(() =>
      applySubstitutions(sampleTape(), [{ nodeId: 'tool:nope', ordinal: 0, value: 1 }]),
    ).toThrow(/has no "tool:nope".*tool:convert/s);
  });

  it('refuses a call number the run never reached', () => {
    expect(() =>
      applySubstitutions(sampleTape(), [{ nodeId: 'tool:convert', ordinal: 3, value: 1 }]),
    ).toThrow(/call #4 of "tool:convert"/);
  });

  it('refuses to substitute a model step', () => {
    expect(() =>
      applySubstitutions(sampleTape(), [{ nodeId: 'llm:step', ordinal: 0, value: 1 }]),
    ).toThrow(/model step, not a call you can answer/);
  });

  it('is a no-op with no substitutions', () => {
    const tape = sampleTape();
    expect(applySubstitutions(tape, [])).toBe(tape);
  });
});
