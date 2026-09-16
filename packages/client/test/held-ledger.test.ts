/**
 * HeldLedger: pinning gate holds to node instances. Pure bookkeeping, no
 * sockets — every attribution rule the session relies on is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { HeldLedger } from '../src/held-ledger.js';

const RUN = 'run-1';

/** A ledger on a clock the test advances by hand. */
function make(maxInstances?: number): { ledger: HeldLedger; advance: (ms: number) => void } {
  let t = 1_000;
  const ledger = new HeldLedger(() => t, maxInstances);
  return { ledger, advance: (ms) => void (t += ms) };
}

describe('HeldLedger — the sequential case (exact)', () => {
  it('credits a before-hold to the instance it precedes', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:search', 'call-1');
    ledger.holdOpened('p1', RUN, 'tool:search', 'before');
    advance(38_100.123);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:search', 'call-1')).toBe(38_100.12);
    expect(ledger.trackedInstances).toBe(0);
  });

  it('sums several holds inside one instance (before + error retry + after)', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:flaky', 'call-1');
    ledger.holdOpened('p1', RUN, 'tool:flaky', 'before');
    advance(1000);
    ledger.holdClosed('p1');
    advance(5); // running
    ledger.errored(RUN, 'tool:flaky', 'call-1');
    ledger.holdOpened('p2', RUN, 'tool:flaky', 'error');
    advance(2000);
    ledger.holdClosed('p2');
    // retry → back to before, same instance
    ledger.holdOpened('p3', RUN, 'tool:flaky', 'before');
    advance(300);
    ledger.holdClosed('p3');
    advance(5);
    ledger.holdOpened('p4', RUN, 'tool:flaky', 'after');
    advance(0.5);
    ledger.holdClosed('p4');
    expect(ledger.peek(RUN, 'tool:flaky', 'call-1')).toBe(3300.5);
    expect(ledger.finished(RUN, 'tool:flaky', 'call-1')).toBe(3300.5);
  });

  it('peek reports the running total, including a hold that is open right now', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:a', 'before');
    advance(5000);
    ledger.holdClosed('p1');
    expect(ledger.peek(RUN, 'tool:a', 'i1')).toBe(5000);
    expect(ledger.trackedInstances).toBe(1);
    ledger.holdOpened('p2', RUN, 'tool:a', 'error');
    advance(7000);
    expect(ledger.peek(RUN, 'tool:a', 'i1')).toBe(12_000); // p2 still open
    ledger.holdClosed('p2');
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(12_000);
  });

  it('reports 0 (not undefined) for a tracked instance that was never held', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    advance(50);
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
  });

  it('reports undefined for an instance it never saw start', () => {
    const { ledger } = make();
    expect(ledger.finished(RUN, 'tool:a', 'ghost')).toBeUndefined();
    expect(ledger.peek(RUN, 'tool:a', undefined)).toBeUndefined();
    ledger.started(RUN, 'tool:a', 'i1');
    // A named-but-unknown instance is not silently "the newest one".
    expect(ledger.finished(RUN, 'tool:a', 'i2')).toBeUndefined();
    expect(ledger.trackedInstances).toBe(1);
  });

  it('falls back to the newest open instance when node.finished names none', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'llm:step', 's1');
    ledger.started(RUN, 'llm:step', 's2');
    ledger.holdOpened('p1', RUN, 'llm:step', 'before');
    advance(10);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'llm:step', undefined)).toBe(10); // s2
    expect(ledger.finished(RUN, 'llm:step', undefined)).toBe(0); // s1
    expect(ledger.finished(RUN, 'llm:step', undefined)).toBeUndefined();
  });

  it('a hold still open when the instance finishes is credited up to now (it is inside durationMs)', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:a', 'before');
    advance(700);
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(700);
    expect(ledger.openHolds).toBe(0);
    advance(9999);
    ledger.holdClosed('p1'); // late close: nothing left to credit
    ledger.started(RUN, 'tool:a', 'i2');
    expect(ledger.finished(RUN, 'tool:a', 'i2')).toBe(0);
  });
});

describe('HeldLedger — holds that belong to nobody', () => {
  it('ignores a hold that opens when no instance of the node is open', () => {
    const { ledger, advance } = make();
    // LangGraph: node.finished, THEN the error gate.
    ledger.started(RUN, 'tool:a', 'i1');
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
    ledger.holdOpened('p1', RUN, 'tool:a', 'error');
    advance(40_000);
    ledger.holdClosed('p1');
    expect(ledger.openHolds).toBe(0);
    // The next instance's durationMs never contained that hold.
    ledger.started(RUN, 'tool:a', 'i2');
    expect(ledger.finished(RUN, 'tool:a', 'i2')).toBe(0);
  });

  it('ignores a hold for a node that never emitted node.started (raw client use)', () => {
    const { ledger, advance } = make();
    ledger.holdOpened('p1', RUN, 'custom:x', 'before');
    advance(100);
    ledger.holdClosed('p1');
    expect(ledger.openHolds).toBe(0);
    expect(ledger.finished(RUN, 'custom:x', undefined)).toBeUndefined();
  });

  it('a close for an unknown pauseId is a no-op', () => {
    const { ledger } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdClosed('never-opened');
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
  });

  it('a clock that goes backwards cannot produce negative held time', () => {
    let t = 1000;
    const ledger = new HeldLedger(() => t);
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:a', 'before');
    t = 900;
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
  });
});

describe('HeldLedger — isolation', () => {
  it('keeps runs apart even for the same nodeId and instanceId', () => {
    const { ledger, advance } = make();
    ledger.started('run-a', 'tool:x', 'i1');
    ledger.started('run-b', 'tool:x', 'i1');
    ledger.holdOpened('p1', 'run-a', 'tool:x', 'before');
    advance(500);
    ledger.holdClosed('p1');
    expect(ledger.finished('run-b', 'tool:x', 'i1')).toBe(0);
    expect(ledger.finished('run-a', 'tool:x', 'i1')).toBe(500);
  });

  it('keeps logical nodes apart within a run', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.started(RUN, 'tool:b', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:b', 'before');
    advance(250);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
    expect(ledger.finished(RUN, 'tool:b', 'i1')).toBe(250);
  });

  it('a restarted instanceId starts from zero', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:a', 'before');
    advance(900);
    ledger.holdClosed('p1');
    ledger.started(RUN, 'tool:a', 'i1');
    expect(ledger.trackedInstances).toBe(1);
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBe(0);
  });
});

describe('HeldLedger — ancestors: a child hold is inside the parent too', () => {
  it('credits a tool hold to the open agent node above it', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:trip', 'run-1');
    ledger.started(RUN, 'llm:step', 's1', 'agent:trip');
    expect(ledger.finished(RUN, 'llm:step', 's1')).toBe(0); // the step ends before tools run
    ledger.started(RUN, 'tool:search', 'c1', 'llm:step'); // ai-sdk: tools hang off the step
    ledger.holdOpened('p1', RUN, 'tool:search', 'before');
    advance(40_000);
    ledger.holdClosed('p1');
    advance(2.4);
    expect(ledger.finished(RUN, 'tool:search', 'c1')).toBe(40_000);
    // llm:step is closed, so the walk continues through it to the agent.
    expect(ledger.finished(RUN, 'agent:trip', 'run-1')).toBe(40_000);
  });

  it('walks a deep chain (LangGraph: graph → chain → tool)', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'graph:g', 'g1');
    ledger.started(RUN, 'chain:c', 'c1', 'graph:g');
    ledger.started(RUN, 'chain:inner', 'i1', 'chain:c');
    ledger.started(RUN, 'tool:t', 't1', 'chain:inner');
    ledger.holdOpened('p1', RUN, 'tool:t', 'before');
    advance(1500);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 't1')).toBe(1500);
    expect(ledger.finished(RUN, 'chain:inner', 'i1')).toBe(1500);
    expect(ledger.finished(RUN, 'chain:c', 'c1')).toBe(1500);
    expect(ledger.finished(RUN, 'graph:g', 'g1')).toBe(1500);
  });

  it('two children held at once count ONCE in the parent (union, not sum)', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:a', 'r1');
    ledger.started(RUN, 'tool:weather', 'w1', 'agent:a');
    ledger.holdOpened('pw', RUN, 'tool:weather', 'before');
    advance(1000);
    ledger.started(RUN, 'tool:currency', 'c1', 'agent:a');
    ledger.holdOpened('pc', RUN, 'tool:currency', 'before');
    advance(2000); // both open
    ledger.holdClosed('pw');
    advance(500); // only currency open
    ledger.holdClosed('pc');
    expect(ledger.finished(RUN, 'tool:weather', 'w1')).toBe(3000);
    expect(ledger.finished(RUN, 'tool:currency', 'c1')).toBe(2500);
    // Wall time the agent was held for at all: 1000 + 2000 + 500.
    expect(ledger.finished(RUN, 'agent:a', 'r1')).toBe(3500);
  });

  it('a parent that finishes while a child is still held is credited up to that moment', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:a', 'r1');
    ledger.started(RUN, 'tool:t', 't1', 'agent:a');
    ledger.holdOpened('p1', RUN, 'tool:t', 'before');
    advance(300);
    expect(ledger.finished(RUN, 'agent:a', 'r1')).toBe(300);
    advance(700);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 't1')).toBe(1000);
  });

  it('a parent that started AFTER the hold opened is not credited', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:t', 't1', 'agent:a');
    ledger.holdOpened('p1', RUN, 'tool:t', 'before');
    advance(100);
    ledger.started(RUN, 'agent:a', 'r1'); // odd ordering, but must not explode or over-credit
    advance(400);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'agent:a', 'r1')).toBe(0);
    expect(ledger.finished(RUN, 'tool:t', 't1')).toBe(500);
  });

  it('credits the run root (instanceId === runId) even when the held node declared no parent', () => {
    // Python's @gm.tool and Ruby's Wrap emit tools without a parentId; the
    // agent node's instanceId is the runId in every SDK.
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:agent', RUN);
    ledger.started(RUN, 'tool:search', 'c1');
    ledger.holdOpened('p1', RUN, 'tool:search', 'before');
    advance(38_100);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:search', 'c1')).toBe(38_100);
    expect(ledger.finished(RUN, 'agent:agent', RUN)).toBe(38_100);
  });

  it('does not double-count the root when it is also reached through parentId', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:agent', RUN);
    ledger.started(RUN, 'tool:t', 't1', 'agent:agent');
    ledger.holdOpened('p1', RUN, 'tool:t', 'before');
    advance(100);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'agent:agent', RUN)).toBe(100);
  });

  it('a root that already finished is not credited', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:agent', RUN);
    expect(ledger.finished(RUN, 'agent:agent', RUN)).toBe(0);
    ledger.started(RUN, 'tool:t', 't1');
    ledger.holdOpened('p1', RUN, 'tool:t', 'before');
    advance(100);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 't1')).toBe(100);
    expect(ledger.trackedInstances).toBe(0);
  });

  it('a hold that opens after the held node finished still credits its open ancestors and the run root (LangGraph after/error gates fire after node.finished)', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:graph', RUN);
    ledger.started(RUN, 'chain:node', 'n1', 'agent:graph');
    ledger.started(RUN, 'tool:t', 't1', 'chain:node');
    expect(ledger.finished(RUN, 'tool:t', 't1')).toBe(0); // handler: node.finished first…
    ledger.holdOpened('p1', RUN, 'tool:t', 'error'); // …then the error gate
    expect(ledger.openHolds).toBe(1);
    advance(40_000);
    ledger.holdClosed('p1');
    expect(ledger.openHolds).toBe(0);
    // The graph retries the tool: that instance never contained the hold.
    ledger.started(RUN, 'tool:t', 't2', 'chain:node');
    expect(ledger.finished(RUN, 'tool:t', 't2')).toBe(0);
    // But the LangGraph node and the agent were running the whole time the
    // developer sat at the gate — their durationMs includes those 40 s.
    expect(ledger.finished(RUN, 'chain:node', 'n1')).toBe(40_000);
    expect(ledger.finished(RUN, 'agent:graph', RUN)).toBe(40_000);
  });

  it('a hold for a node that never emitted node.started still credits an open run root', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'agent:agent', RUN);
    ledger.holdOpened('p1', RUN, 'custom:raw-gate', 'before');
    advance(250);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'custom:raw-gate', undefined)).toBeUndefined();
    expect(ledger.finished(RUN, 'agent:agent', RUN)).toBe(250);
  });

  it('survives a parentId cycle without looping', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'a', 'a1', 'b');
    ledger.started(RUN, 'b', 'b1', 'a');
    ledger.holdOpened('p1', RUN, 'a', 'before');
    advance(10);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'a', 'a1')).toBe(10);
    expect(ledger.finished(RUN, 'b', 'b1')).toBe(10);
  });
});

describe('HeldLedger — overlapping instances of one node (heuristic)', () => {
  it('before-holds go to the most recently started open instance', () => {
    // ai@7 runs parallel tool calls concurrently: start A, hold A, start B,
    // hold B — each hold immediately follows its own node.started.
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:search', 'A');
    ledger.holdOpened('pA', RUN, 'tool:search', 'before');
    ledger.started(RUN, 'tool:search', 'B');
    ledger.holdOpened('pB', RUN, 'tool:search', 'before');
    advance(2000);
    ledger.holdClosed('pA');
    advance(2000);
    ledger.holdClosed('pB');
    expect(ledger.finished(RUN, 'tool:search', 'A')).toBe(2000);
    expect(ledger.finished(RUN, 'tool:search', 'B')).toBe(4000);
  });

  it('error-holds prefer the instance node.error named, whatever its start order', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:t', 'A');
    ledger.started(RUN, 'tool:t', 'B');
    ledger.errored(RUN, 'tool:t', 'A'); // the OLDER one failed
    ledger.holdOpened('p1', RUN, 'tool:t', 'error');
    advance(700);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 'B')).toBe(0);
    expect(ledger.finished(RUN, 'tool:t', 'A')).toBe(700);
  });

  it('an error mark is consumed by one hold, then the newest rule applies again', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:t', 'A');
    ledger.started(RUN, 'tool:t', 'B');
    ledger.errored(RUN, 'tool:t', 'A');
    ledger.holdOpened('p1', RUN, 'tool:t', 'error');
    advance(100);
    ledger.holdClosed('p1');
    ledger.holdOpened('p2', RUN, 'tool:t', 'error'); // nothing marked now → newest (B)
    advance(50);
    ledger.holdClosed('p2');
    expect(ledger.finished(RUN, 'tool:t', 'A')).toBe(100);
    expect(ledger.finished(RUN, 'tool:t', 'B')).toBe(50);
  });

  it('node.error without an instanceId marks the newest open instance', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:t', 'A');
    ledger.started(RUN, 'tool:t', 'B');
    ledger.errored(RUN, 'tool:t', undefined);
    ledger.holdOpened('p1', RUN, 'tool:t', 'error');
    advance(9);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 'A')).toBe(0);
    expect(ledger.finished(RUN, 'tool:t', 'B')).toBe(9);
  });

  it('after-holds go to the oldest open instance', () => {
    const { ledger, advance } = make();
    ledger.started(RUN, 'tool:t', 'A');
    ledger.started(RUN, 'tool:t', 'B');
    ledger.holdOpened('p1', RUN, 'tool:t', 'after');
    advance(300);
    ledger.holdClosed('p1');
    expect(ledger.finished(RUN, 'tool:t', 'A')).toBe(300);
    expect(ledger.finished(RUN, 'tool:t', 'B')).toBe(0);
  });
});

describe('HeldLedger — bounds', () => {
  it('evicts the oldest tracked instance past the cap and never grows unbounded', () => {
    const { ledger, advance } = make(3);
    ledger.started(RUN, 'tool:a', 'i1');
    ledger.holdOpened('p1', RUN, 'tool:a', 'before');
    ledger.started(RUN, 'tool:a', 'i2');
    ledger.started(RUN, 'tool:a', 'i3');
    ledger.started(RUN, 'tool:a', 'i4'); // evicts i1 (and unpins its hold)
    expect(ledger.trackedInstances).toBe(3);
    expect(ledger.openHolds).toBe(0);
    expect(ledger.finished(RUN, 'tool:a', 'i1')).toBeUndefined();
    advance(1000);
    ledger.holdClosed('p1'); // late close of the evicted hold: dropped
    expect(ledger.finished(RUN, 'tool:a', 'i2')).toBe(0);
    expect(ledger.finished(RUN, 'tool:a', 'i3')).toBe(0);
    expect(ledger.finished(RUN, 'tool:a', 'i4')).toBe(0);
    expect(ledger.trackedInstances).toBe(0);
  });

  it('handles a burst of instances that never finish without leaking past the cap', () => {
    const { ledger } = make(500);
    for (let i = 0; i < 5000; i += 1) ledger.started(RUN, `tool:${i % 17}`, `i${i}`, 'agent:a');
    expect(ledger.trackedInstances).toBe(500);
  });
});
