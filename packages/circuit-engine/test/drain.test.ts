/**
 * drain({ budgetMs }) — the serverless engine entrypoint: a time-limited
 * function drains what it can, reports `more`, and leaves the rest
 * claimable at once (released leases, not leases that must time out).
 * Plus the write-ordering guarantee the executor gives parallel branches.
 */
import { describe, expect, it } from 'vitest';
import { workflow, type Ctx } from '@graphmind-ai/circuit-sdk';
import { Executor, ManualClock } from '../src/index.js';
import { BACKENDS, openStore, unavailable } from './backends.js';

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin: a step doing real work
  }
};

describe.each(BACKENDS)('%s', (backend) => {
  describe.skipIf(unavailable(backend))('drain', () => {
    it('no-arg drain runs until quiescent and reports no more work', async () => {
      const store = await openStore(backend);
      const wf = workflow({ name: 'quick' }, async (ctx: Ctx) => ctx.step('s', () => 1));
      const executor = new Executor({ store, clock: new ManualClock(), workflows: [wf] });
      await executor.enqueue('quick', null);
      expect(await executor.drain()).toEqual({ more: false });
      expect(await executor.drain()).toEqual({ more: false });
    });

    it('stops claiming once the budget is spent, releases unstarted claims, and resumes later', async () => {
      const store = await openStore(backend);
      const wf = workflow({ name: 'slow' }, async (ctx: Ctx) => ctx.step('work', () => (busy(30), 'ok')));
      const executor = new Executor({ store, clock: new ManualClock(), owner: 'fn-1', workflows: [wf] });
      const runs = [];
      for (let i = 0; i < 6; i++) runs.push(await executor.enqueue('slow', i));

      const first = await executor.drain({ budgetMs: 40 });
      expect(first).toEqual({ more: true });
      const after = await Promise.all(runs.map((r) => executor.getRun(r.id)));
      const done = after.filter((r) => r?.status === 'completed');
      const waiting = after.filter((r) => r?.status === 'queued');
      expect(done.length).toBeGreaterThanOrEqual(1); // always progresses
      expect(done.length).toBeLessThan(6);
      expect(done.length + waiting.length).toBe(6);
      // Nothing left holding a lease: another instance can take it right away.
      for (const r of waiting) expect(r?.leaseOwner).toBeUndefined();

      const other = new Executor({ store, clock: new ManualClock(), owner: 'fn-2', workflows: [wf] });
      expect(await other.drain()).toEqual({ more: false });
      for (const r of runs) expect((await other.getRun(r.id))?.status).toBe('completed');
    });

    it('a budget always invokes at least one run (progress under any budget)', async () => {
      const store = await openStore(backend);
      const wf = workflow({ name: 'one' }, async (ctx: Ctx) => ctx.step('s', () => (busy(5), 1)));
      const executor = new Executor({ store, clock: new ManualClock(), workflows: [wf] });
      const a = await executor.enqueue('one', null);
      await executor.enqueue('one', null);
      expect(await executor.drain({ budgetMs: 0 })).toEqual({ more: true });
      expect((await executor.getRun(a.id))?.status).toBe('completed');
    });

    it('parallel branches journal in call order (seq order = issue order)', async () => {
      const store = await openStore(backend);
      const wf = workflow({ name: 'fan' }, async (ctx: Ctx) => {
        const names = ['a', 'b', 'c', 'd', 'e', 'f'];
        return Promise.all(names.map((n) => ctx.step(n, async () => n)));
      });
      const executor = new Executor({ store, clock: new ManualClock(), workflows: [wf] });
      const run = await executor.enqueue('fan', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      expect((await executor.getJournal(run.id)).map((e) => [e.seq, e.name, e.status])).toEqual(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => [i, n, 'completed']),
      );
    });
  });
});
