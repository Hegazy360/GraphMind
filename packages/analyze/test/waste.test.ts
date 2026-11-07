import { describe, expect, it } from 'vitest';
import type { ExecutionSample } from '../src/sample.js';
import { scanWaste } from '../src/waste.js';

let nextSeq = 0;

function tool(name: string, input: unknown, extra: Partial<ExecutionSample> = {}): ExecutionSample {
  nextSeq += 1;
  return {
    nodeId: `tool:${name}`,
    kind: 'tool',
    name,
    seq: nextSeq,
    status: 'ok',
    input,
    ...extra,
  };
}

function llm(): ExecutionSample {
  nextSeq += 1;
  return { nodeId: 'llm:step', kind: 'llm', name: 'step', seq: nextSeq, status: 'ok' };
}

describe('scanWaste: repeats', () => {
  it('finds a streak of identical calls and wastes all but the first', () => {
    const scan = scanWaste([tool('read', { f: 'a' }), tool('read', { f: 'a' }), tool('read', { f: 'a' })]);
    expect(scan.toolCalls).toBe(3);
    expect(scan.wastedIndices.size).toBe(2);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]).toMatchObject({ kind: 'repeat', count: 3, wasted: 2, names: ['read'] });
  });

  it('does not count different inputs, different nodes, or non-tools', () => {
    const scan = scanWaste([tool('read', { f: 'a' }), tool('read', { f: 'b' }), llm(), tool('grep', { f: 'a' })]);
    expect(scan.wastedIndices.size).toBe(0);
    expect(scan.incidents).toHaveLength(0);
  });

  it('a non-tool between two identical calls breaks nothing it should not: consecutive means consecutive among tool calls', () => {
    const scan = scanWaste([tool('read', { f: 'a' }), llm(), tool('read', { f: 'a' })]);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]?.wasted).toBe(1);
  });

  it('ignores _meta differences, as the live guard does', () => {
    const scan = scanWaste([
      tool('read', { f: 'a', _meta: { progressToken: 1 } }),
      tool('read', { f: 'a', _meta: { progressToken: 2 } }),
    ]);
    expect(scan.incidents).toHaveLength(1);
  });

  it('carries the envelope seq span', () => {
    nextSeq = 100;
    const scan = scanWaste([tool('read', { f: 'a' }), tool('read', { f: 'a' })]);
    expect(scan.incidents[0]).toMatchObject({ firstSeq: 101, lastSeq: 102 });
  });
});

describe('scanWaste: cycles', () => {
  it('finds an A→B→A→B cycle', () => {
    const scan = scanWaste([
      tool('search', { q: 1 }),
      tool('fetch', { u: 2 }),
      tool('search', { q: 1 }),
      tool('fetch', { u: 2 }),
      tool('search', { q: 1 }),
      tool('fetch', { u: 2 }),
    ]);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]).toMatchObject({ kind: 'cycle', period: 2, laps: 3, wasted: 4, count: 6 });
    expect(scan.incidents[0]?.names).toEqual(['search', 'fetch']);
    expect(scan.wastedIndices.size).toBe(4);
  });

  it('does not report a uniform lap as a cycle (that is a repeat)', () => {
    const scan = scanWaste([
      tool('read', { f: 'a' }),
      tool('read', { f: 'a' }),
      tool('read', { f: 'a' }),
      tool('read', { f: 'a' }),
    ]);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]?.kind).toBe('repeat');
    expect(scan.wastedIndices.size).toBe(3);
  });

  it('counts a partial trailing lap as wasted work', () => {
    const scan = scanWaste([
      tool('a', 1),
      tool('b', 2),
      tool('c', 3),
      tool('a', 1),
      tool('b', 2),
      tool('c', 3),
      tool('a', 1),
    ]);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]).toMatchObject({ kind: 'cycle', period: 3, wasted: 4 });
  });
});

describe('scanWaste: error repeats', () => {
  it('needs three identical failures in a row (live-guard parity)', () => {
    const fail = (q: number) => tool('flaky', { q }, { status: 'error', errorMessage: 'ETIMEDOUT' });
    expect(scanWaste([fail(1), fail(2)]).incidents).toHaveLength(0);
    const scan = scanWaste([fail(1), fail(2), fail(3)]);
    expect(scan.incidents).toHaveLength(1);
    expect(scan.incidents[0]).toMatchObject({ kind: 'error-repeat', count: 3, wasted: 2, errorMessage: 'ETIMEDOUT' });
  });

  it('does not double-count a streak that is also an input repeat', () => {
    const fail = () => tool('flaky', { q: 1 }, { status: 'error', errorMessage: 'boom' });
    const scan = scanWaste([fail(), fail(), fail()]);
    // One union of wasted calls, one incident (the repeat got there first).
    expect(scan.wastedIndices.size).toBe(2);
    expect(scan.incidents).toHaveLength(1);
  });

  it('different errors break the streak', () => {
    const scan = scanWaste([
      tool('flaky', { q: 1 }, { status: 'error', errorMessage: 'a' }),
      tool('flaky', { q: 2 }, { status: 'error', errorMessage: 'b' }),
      tool('flaky', { q: 3 }, { status: 'error', errorMessage: 'a' }),
    ]);
    expect(scan.incidents).toHaveLength(0);
  });
});

describe('scanWaste: unreadable inputs', () => {
  it('excludes a call whose input cannot be canonicalized, and counts it', () => {
    const trap = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    const scan = scanWaste([tool('read', trap), tool('read', trap)]);
    expect(scan.unreadableCalls).toBe(2);
    expect(scan.incidents).toHaveLength(0);
  });
});
