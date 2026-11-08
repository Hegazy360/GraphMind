/**
 * M4 invariants: hermetic replay (nothing executes, nothing escapes),
 * fixtures as regression tests, the deploy check, and fork/substitute.
 */
import { describe, expect, it } from 'vitest';
import { workflow, type Ctx } from '@graphmind-ai/circuit-sdk';
import {
  checkDeploy,
  Executor,
  exportFixture,
  ManualClock,
  replayFixture,
  SqliteJournalStore,
} from '../src/index.js';

function setup(defs: Parameters<Executor['register']>[0][]) {
  const clock = new ManualClock();
  const store = new SqliteJournalStore(':memory:');
  const executor = new Executor({ store, clock, owner: 'test', workflows: defs });
  return { clock, store, executor };
}

const makeTrip = (calls: string[]) =>
  workflow({ name: 'trip' }, async (ctx: Ctx) => {
    const yen = await ctx.step('fetch-price', () => {
      calls.push('fetch-price');
      return 402_000;
    });
    const usd = await ctx.step('convert-currency', () => {
      calls.push('convert-currency');
      return yen / 150;
    });
    return { usd: Math.round(usd as number) };
  });

describe('fixtures (recorded run as regression test)', () => {
  async function record() {
    const calls: string[] = [];
    const { store, executor } = setup([makeTrip(calls)]);
    const run = executor.enqueue('trip', null);
    await executor.drain();
    return { fixture: exportFixture(store, run.id), calls };
  }

  it('passes against unchanged code — executing nothing', async () => {
    const { fixture } = await record();
    const replayCalls: string[] = [];
    const verdict = await replayFixture(makeTrip(replayCalls), fixture);
    expect(verdict).toEqual({ kind: 'pass' });
    expect(replayCalls).toEqual([]); // hermetic: no step function ran
  });

  it('flags a changed final output as a regression', async () => {
    const { fixture } = await record();
    const changed = workflow({ name: 'trip' }, async (ctx: Ctx) => {
      const yen = await ctx.step('fetch-price', () => 0);
      const usd = await ctx.step('convert-currency', () => 0);
      return { usd: Math.round((usd as number) * 100), yen }; // different shape
    });
    const verdict = await replayFixture(changed, fixture);
    expect(verdict.kind).toBe('output-changed');
  });

  it('flags a renamed step as divergence, naming both sides', async () => {
    const { fixture } = await record();
    const renamed = workflow({ name: 'trip' }, async (ctx: Ctx) => {
      await ctx.step('fetch-quote', () => 0);
      await ctx.step('convert-currency', () => 0);
      return {};
    });
    const verdict = await replayFixture(renamed, fixture);
    expect(verdict.kind).toBe('diverged');
    if (verdict.kind === 'diverged' && verdict.divergence.type === 'novel-call') {
      expect(verdict.divergence.actual.name).toBe('fetch-quote');
      expect(verdict.divergence.unreplayed.name).toBe('fetch-price');
    } else {
      throw new Error(`expected novel-call divergence, got ${JSON.stringify(verdict)}`);
    }
  });

  it('asks for a re-record when code adds new trailing work', async () => {
    const { fixture } = await record();
    const extended = workflow({ name: 'trip' }, async (ctx: Ctx) => {
      await ctx.step('fetch-price', () => 0);
      await ctx.step('convert-currency', () => 0);
      await ctx.step('notify', () => 'sent');
      return {};
    });
    const verdict = await replayFixture(extended, fixture);
    expect(verdict.kind).toBe('incomplete');
  });
});

describe('deploy check', () => {
  const v1 = () =>
    workflow({ name: 'ship' }, async (ctx: Ctx) => {
      await ctx.step('reserve-stock', () => 'reserved');
      await ctx.sleep('settle', '1h');
      await ctx.step('charge', () => 'charged');
      return 'done';
    });

  it('clears an unchanged deploy and names every run a change would break', async () => {
    const { store, executor } = setup([v1()]);
    const inflight = executor.enqueue('ship', null);
    await executor.drain(); // now suspended at the sleep
    expect(executor.getRun(inflight.id)?.status).toBe('suspended');

    const same = await checkDeploy([v1()], store);
    expect(same.checked).toBe(1);
    expect(same.broken).toEqual([]);

    const renamed = workflow({ name: 'ship' }, async (ctx: Ctx) => {
      await ctx.step('reserve-inventory', () => 'reserved');
      await ctx.sleep('settle', '1h');
      await ctx.step('charge', () => 'charged');
      return 'done';
    });
    const report = await checkDeploy([renamed], store);
    expect(report.broken).toHaveLength(1);
    expect(report.broken[0]?.runId).toBe(inflight.id);
    expect(report.broken[0]?.outcome.kind).toBe('diverged');
    // The in-flight run itself was never touched.
    expect(executor.getRun(inflight.id)?.status).toBe('suspended');
  });
});

describe('fork (what-if)', () => {
  it('substitutes a step output and runs everything after it for real', async () => {
    const liveCalls: string[] = [];
    const buggy = workflow({ name: 'budget' }, async (ctx: Ctx) => {
      const rate = await ctx.step('convert-currency', () => 150_0); // planted bug: inverted rate
      const total = await ctx.step('total', () => {
        liveCalls.push('total');
        return (rate as number) * 40;
      });
      return { total };
    });
    const { executor } = setup([buggy]);
    const original = executor.enqueue('budget', null);
    await executor.drain();
    expect(executor.getRun(original.id)?.output).toEqual({ total: 60_000 });

    const fork = executor.fork(original.id, { actor: 'dev@team', substitute: { seq: 0, output: 10 } });
    await executor.drain();
    const forked = executor.getRun(fork.id);
    expect(forked?.status).toBe('completed');
    expect(forked?.output).toEqual({ total: 400 }); // downstream step genuinely re-ran
    expect(liveCalls).toEqual(['total', 'total']);
    expect(forked?.forkedFrom).toEqual({ runId: original.id, fromSeq: 0 });
    // The substitution is audited on the forked journal.
    expect(executor.getJournal(fork.id)[0]?.interventions.at(-1)).toMatchObject({
      actor: 'dev@team',
      action: 'inject',
    });
    // Original run untouched.
    expect(executor.getRun(original.id)?.output).toEqual({ total: 60_000 });
  });

  it('uptoSeq replays the prefix and re-executes the rest', async () => {
    const calls: string[] = [];
    const wf = makeTrip(calls);
    const { executor } = setup([wf]);
    const original = executor.enqueue('trip', null);
    await executor.drain();
    calls.length = 0;
    const fork = executor.fork(original.id, { actor: 'dev', uptoSeq: 1 });
    await executor.drain();
    expect(executor.getRun(fork.id)?.status).toBe('completed');
    expect(calls).toEqual(['convert-currency']); // step 0 replayed, step 1 re-ran
  });

  it('refuses a pointless identical fork', async () => {
    const { executor } = setup([makeTrip([])]);
    const run = executor.enqueue('trip', null);
    await executor.drain();
    expect(() => executor.fork(run.id, { actor: 'dev' })).toThrow(/uptoSeq and\/or substitute/);
  });
});
