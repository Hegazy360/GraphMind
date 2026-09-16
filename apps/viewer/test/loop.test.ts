/**
 * Loop hold in the store: the reducer keeps `reason`/`loop` off exec.paused
 * (and ignores a malformed one), every execution remembers the seq of its
 * node.started, and the helpers the banner and the inspector block read
 * agree on which calls made up the streak.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@graphmind-ai/schema';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import {
  LOOP_ARGS,
  LOOP_FINGERPRINT,
  LOOP_NODES,
  LOOP_OUTPUT,
  LOOP_REPEATS,
  LOOP_RUN_ID,
  generateLoopRun,
  identicalCalls,
  loopBannerText,
} from '../src/store/loop.js';
import { RUN, ev, resetCounters, started } from './helpers.js';
import type { RunState } from '../src/store/types.js';

beforeEach(resetCounters);

function build(events: ReturnType<typeof ev>[], runId = RUN): RunState {
  const runs = events.reduce<RunsMap>((acc, e) => applyEvent(acc, e, 'fixture'), {});
  const run = runs[runId];
  if (run === undefined) throw new Error('no run');
  return run;
}

const LOOP = { repeats: 3, firstSeq: 2, lastSeq: 6, fingerprint: 'ab'.repeat(16) };

describe('applyEvent: exec.paused reason/loop', () => {
  it('stores reason and loop from a loop hold, and the seq of every node.started', () => {
    const run = build([
      started('tool:s', 'tool', { instanceId: 'a', seq: 2 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'a', durationMs: 1, status: 'ok', output: 1 }, { seq: 3 }),
      started('tool:s', 'tool', { instanceId: 'b', seq: 4 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'b', durationMs: 1, status: 'ok', output: 1 }, { seq: 5 }),
      started('tool:s', 'tool', { instanceId: 'c', seq: 6 }),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:s', point: 'before', reason: 'loop', loop: LOOP }, { seq: 7 }),
    ]);
    const pause = run.pauses['p1'];
    expect(pause?.reason).toBe('loop');
    expect(pause?.loop).toEqual(LOOP);
    expect(pause?.active).toBe(true);
    expect(run.nodes['tool:s']?.executions.map((e) => e.seq)).toEqual([2, 4, 6]);
    expect(run.nodes['tool:s']?.activePauseId).toBe('p1');
  });

  it('keeps reason without loop for the other reasons, and neither when the sender is older', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'error', reason: 'error' }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }),
      ev('exec.paused', { pauseId: 'p2', nodeId: 'tool:a', point: 'before' }),
    ]);
    expect(run.pauses['p1']).toMatchObject({ reason: 'error' });
    expect(run.pauses['p1']).not.toHaveProperty('loop');
    expect(run.pauses['p2']).not.toHaveProperty('reason');
    expect(run.pauses['p2']).not.toHaveProperty('loop');
  });

  it('ignores a malformed loop object and an unknown reason instead of rendering garbage', () => {
    const bad = [
      { repeats: 3 },
      { repeats: -1, firstSeq: 1, lastSeq: 2, fingerprint: 'x' },
      { repeats: 3, firstSeq: 5, lastSeq: 2, fingerprint: 'x' },
      { repeats: 3, firstSeq: 1, lastSeq: 2, fingerprint: 7 },
      { repeats: 'three', firstSeq: 1, lastSeq: 2, fingerprint: 'x' },
      'loop',
      null,
    ];
    bad.forEach((loop, i) => {
      resetCounters();
      const run = build([
        started('tool:a', 'tool'),
        ev('exec.paused', {
          pauseId: 'p1',
          nodeId: 'tool:a',
          point: 'before',
          reason: 'loop',
          loop: loop as never,
        }),
      ]);
      expect(run.pauses['p1']?.reason, `case ${i}`).toBe('loop');
      expect(run.pauses['p1'], `case ${i}`).not.toHaveProperty('loop');
      expect(run.pauses['p1']?.active).toBe(true);
    });
    const unknown = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before', reason: 'because' as never }),
    ]);
    expect(unknown.pauses['p1']).not.toHaveProperty('reason');
  });

  it('a resumed loop hold keeps its reason for history', () => {
    const run = build([
      started('tool:s', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:s', point: 'before', reason: 'loop', loop: LOOP }),
      ev('exec.resumed', { pauseId: 'p1', action: 'abort' }),
    ]);
    expect(run.pauses['p1']).toMatchObject({ active: false, resolvedAction: 'abort', reason: 'loop', loop: LOOP });
  });
});

describe('loopBannerText', () => {
  it('reads "Loop: 3× name with identical arguments" live and past tense when replayed', () => {
    const run = build([
      started('tool:searchFlights', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:searchFlights', point: 'before', reason: 'loop', loop: LOOP }),
    ]);
    const node = run.nodes['tool:searchFlights'];
    const pause = run.pauses['p1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    expect(loopBannerText(node, pause)).toBe('Loop: 3× searchFlights with identical arguments');
    expect(loopBannerText(node, pause, true)).toBe('Was held — loop: 3× searchFlights with identical arguments');
  });

  it('is undefined for every other pause, so the ordinary label stays', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'error', reason: 'error' }),
    ]);
    const node = run.nodes['tool:a'];
    const pause = run.pauses['p1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    expect(loopBannerText(node, pause)).toBeUndefined();
  });

  it('survives a loop hold whose loop object was dropped as malformed', () => {
    const run = build([
      started('tool:a', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:a', point: 'before', reason: 'loop', loop: 'x' as never }),
    ]);
    const node = run.nodes['tool:a'];
    const pause = run.pauses['p1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    expect(loopBannerText(node, pause)).toBe('Loop: a with identical arguments');
  });
});

describe('identicalCalls', () => {
  it('selects the executions whose node.started seq falls in firstSeq..lastSeq, marks the held one and repeated outputs', () => {
    const run = build([
      started('tool:s', 'tool', { instanceId: 'old', seq: 1, input: { q: 'other' } }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'old', durationMs: 1, status: 'ok', output: { r: 0 } }),
      started('tool:s', 'tool', { instanceId: 'a', seq: 10 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'a', durationMs: 1, status: 'ok', output: { r: 1, list: [1, 2] } }),
      started('tool:s', 'tool', { instanceId: 'b', seq: 20 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'b', durationMs: 1, status: 'ok', output: { list: [1, 2], r: 1 } }),
      started('tool:s', 'tool', { instanceId: 'c', seq: 30 }),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:s',
        point: 'before',
        reason: 'loop',
        loop: { repeats: 3, firstSeq: 10, lastSeq: 30, fingerprint: 'f' },
      }),
    ]);
    const node = run.nodes['tool:s'];
    const pause = run.pauses['p1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    const calls = identicalCalls(node, pause.loop);
    expect(calls.map((c) => c.exec.instanceId)).toEqual(['a', 'b', 'c']);
    expect(calls.map((c) => c.index)).toEqual([2, 3, 4]);
    expect(calls.map((c) => c.current)).toEqual([false, false, true]);
    // Key order does not matter for "same output": {r, list} == {list, r}.
    expect(calls.map((c) => c.sameOutputAsPrevious)).toEqual([false, true, false]);
  });

  // Verifier pass: under GRAPHMIND_HIDE_OUTPUTS every output is the same
  // placeholder string, which is not evidence that the tool answered the same
  // thing — the block must not claim "same output as the call before".
  it('never calls hidden (redacted) outputs "the same output"', () => {
    const run = build([
      started('tool:s', 'tool', { instanceId: 'a', seq: 10 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'a', durationMs: 1, status: 'ok', output: '__REDACTED__' }),
      started('tool:s', 'tool', { instanceId: 'b', seq: 20 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'b', durationMs: 1, status: 'ok', output: '__REDACTED__' }),
      started('tool:s', 'tool', { instanceId: 'c', seq: 30 }),
      ev('node.finished', { nodeId: 'tool:s', instanceId: 'c', durationMs: 1, status: 'ok', output: '__REDACTED__' }),
      started('tool:s', 'tool', { instanceId: 'd', seq: 40 }),
      ev('exec.paused', {
        pauseId: 'p1',
        nodeId: 'tool:s',
        point: 'before',
        reason: 'loop',
        loop: { repeats: 4, firstSeq: 10, lastSeq: 40, fingerprint: '__REDACTED__' },
      }),
    ]);
    const node = run.nodes['tool:s'];
    const pause = run.pauses['p1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    // The redacted fingerprint is still a usable loop record.
    expect(pause.loop?.fingerprint).toBe('__REDACTED__');
    const calls = identicalCalls(node, pause.loop);
    expect(calls.map((c) => c.exec.instanceId)).toEqual(['a', 'b', 'c', 'd']);
    expect(calls.map((c) => c.sameOutputAsPrevious)).toEqual([false, false, false, false]);
  });

  it('falls back to the last `repeats` executions when a stream carries no seqs', () => {
    const run = build([
      started('tool:s', 'tool', { instanceId: 'a' }),
      started('tool:s', 'tool', { instanceId: 'b' }),
      started('tool:s', 'tool', { instanceId: 'c' }),
    ]);
    const node = run.nodes['tool:s'];
    if (node === undefined) throw new Error('missing');
    const legacy = { ...node, executions: node.executions.map(({ seq: _seq, ...rest }) => rest) };
    const calls = identicalCalls(legacy, { repeats: 2, firstSeq: 100, lastSeq: 200, fingerprint: 'f' });
    expect(calls.map((c) => c.exec.instanceId)).toEqual(['b', 'c']);
    expect(calls[calls.length - 1]?.current).toBe(true);
    expect(identicalCalls(node, undefined)).toEqual([]);
  });
});

describe('generateLoopRun (the fixture behind the browser test)', () => {
  it('is a schema-valid stream that ends held on a loop, with real seqs in loop.firstSeq..lastSeq', () => {
    const events = generateLoopRun(1_000_000);
    for (const e of events) {
      const parsed = parseEnvelope(e);
      expect(parsed.kind, `${e.type}#${e.seq}`).toBe('ok');
    }
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i));
    const last = events[events.length - 1];
    expect(last?.type).toBe('exec.paused');
    expect(last?.payload).toMatchObject({
      nodeId: LOOP_NODES.flights,
      point: 'before',
      reason: 'loop',
      loop: { repeats: LOOP_REPEATS, fingerprint: LOOP_FINGERPRINT },
    });

    const runs = events.reduce<RunsMap>((acc, e) => {
      const parsed = parseEnvelope(e);
      return parsed.kind === 'ok' ? applyEvent(acc, parsed.envelope as never, 'fixture') : acc;
    }, {});
    const run = runs[LOOP_RUN_ID];
    if (run === undefined) throw new Error('no run');
    const node = run.nodes[LOOP_NODES.flights];
    const pause = run.pauses['pause-loop-1'];
    if (node === undefined || pause === undefined) throw new Error('missing');
    expect(node.executions).toHaveLength(3);
    expect(node.executions.every((e) => JSON.stringify(e.input) === JSON.stringify(LOOP_ARGS))).toBe(true);
    const calls = identicalCalls(node, pause.loop);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.exec.output).toEqual(LOOP_OUTPUT);
    expect(calls[1]?.sameOutputAsPrevious).toBe(true);
    expect(calls[2]?.current).toBe(true);
    expect(calls[2]?.exec.status).toBe('running');
    expect(loopBannerText(node, pause)).toBe('Loop: 3× searchFlights with identical arguments');
  });
});
