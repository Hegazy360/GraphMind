/**
 * The M1/M2 invariants from docs/plans/hosted-workflow-platform.md, each as
 * a test: durability (memoized re-invocation, crash recovery via lease),
 * retries with visible attempts, gates (error-pause, breakpoints), the six
 * resume actions, timers, events, approvals, child runs, divergence.
 *
 * The whole suite runs once per JournalStore backend (the pg leg only with
 * PG_TEST_URL set) — see ./backends.ts.
 */
import { describe, expect, it } from 'vitest';
import { workflow, z, type Ctx } from '@graphmind-ai/circuit-sdk';
import type { JsonValue } from '@graphmind-ai/circuit-schema';
import { Executor, HardCrash, ManualClock } from '../src/index.js';
import { BACKENDS, openStore, unavailable } from './backends.js';

describe.each(BACKENDS)('%s', (backend) => {
describe.skipIf(unavailable(backend))('executor', () => {
  async function setup(defs: Parameters<Executor['register']>[0][], opts: { leaseMs?: number; hooks?: { afterStepPersist?: (runId: string, seq: number) => void } } = {}) {
    const clock = new ManualClock();
    const store = await openStore(backend);
    const executor = new Executor({
      store,
      clock,
      leaseMs: opts.leaseMs ?? 30_000,
      owner: 'test-worker',
      workflows: defs,
      ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    });
    return { clock, store, executor };
  }

  describe('durability', () => {
    it('runs to completion; steps are memoized across suspensions', async () => {
      const calls: string[] = [];
      const wf = workflow({ name: 'memo' }, async (ctx: Ctx) => {
        const a = await ctx.step('a', () => {
          calls.push('a');
          return 10;
        });
        await ctx.sleep('nap', '5m');
        const b = await ctx.step('b', () => {
          calls.push('b');
          return a + 5;
        });
        return b;
      });
      const { clock, executor } = await setup([wf]);
      const run = await executor.enqueue('memo', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('suspended');
      expect(calls).toEqual(['a']);

      clock.advance(5 * 60_000 + 1);
      await executor.drain();
      const done = await executor.getRun(run.id);
      expect(done?.status).toBe('completed');
      expect(done?.output).toBe(15);
      // 'a' did NOT re-execute on the second invocation.
      expect(calls).toEqual(['a', 'b']);
    });

    it('idempotency key returns the existing run', async () => {
      const wf = workflow({ name: 'idem' }, async () => 'done');
      const { executor } = await setup([wf]);
      const first = await executor.enqueue('idem', { n: 1 }, { idempotencyKey: 'k1' });
      const second = await executor.enqueue('idem', { n: 2 }, { idempotencyKey: 'k1' });
      expect(second.id).toBe(first.id);
    });

    it('a crashed worker loses nothing: the lease expires and the run finishes elsewhere', async () => {
      let crashed = false;
      const calls: string[] = [];
      const wf = workflow({ name: 'crashy' }, async (ctx: Ctx) => {
        await ctx.step('one', () => {
          calls.push('one');
          return 1;
        });
        await ctx.step('two', () => {
          calls.push('two');
          return 2;
        });
        return 'ok';
      });
      const { clock, executor } = await setup([wf], {
        leaseMs: 30_000,
        hooks: {
          afterStepPersist: () => {
            if (!crashed) {
              crashed = true;
              throw new HardCrash('simulated process death after persisting step one');
            }
          },
        },
      });
      const run = await executor.enqueue('crashy', null);
      await executor.tick();
      // Dead worker: run still 'running', lease held, step one persisted.
      expect((await executor.getRun(run.id))?.status).toBe('running');
      expect(calls).toEqual(['one']);
      // Before lease expiry nothing claims it.
      await executor.tick();
      expect(calls).toEqual(['one']);
      // After expiry it is reclaimed; step one replays without executing.
      clock.advance(30_001);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('completed');
      expect(calls).toEqual(['one', 'two']);
    });

    it('parallel steps in one invocation both journal', async () => {
      const wf = workflow({ name: 'par' }, async (ctx: Ctx) => {
        const [x, y] = await Promise.all([ctx.step('x', () => 1), ctx.step('y', () => 2)]);
        return x + y;
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('par', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe(3);
      expect(await executor.getJournal(run.id)).toHaveLength(2);
    });

    it('the same step name called twice gets distinct ordinals', async () => {
      const wf = workflow({ name: 'twice' }, async (ctx: Ctx) => {
        const a = await ctx.step('poll', () => 1);
        const b = await ctx.step('poll', () => 2);
        return a + b;
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('twice', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe(3);
      expect((await executor.getJournal(run.id)).map((e) => e.ordinal)).toEqual([0, 1]);
    });
  });

  describe('retries', () => {
    it('backs off between attempts and records every try', async () => {
      let failures = 2;
      const wf = workflow({ name: 'flaky', onError: 'fail' }, async (ctx: Ctx) =>
        ctx.step('fetch', { retries: { max: 3, backoff: 'exponential', initialMs: 1_000 } }, () => {
          if (failures-- > 0) throw new Error(`boom ${failures + 1}`);
          return 'recovered';
        }),
      );
      const { clock, executor } = await setup([wf]);
      const run = await executor.enqueue('flaky', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('suspended'); // waiting out backoff #1 (1s)
      clock.advance(1_001);
      await executor.drain(); // attempt 2 fails; backoff #2 (2s)
      clock.advance(2_001);
      await executor.drain();
      const done = await executor.getRun(run.id);
      expect(done?.status).toBe('completed');
      expect(done?.output).toBe('recovered');
      const entry = (await executor.getJournal(run.id))[0];
      expect(entry?.attempts).toHaveLength(3);
      expect(entry?.attempts[0]?.error?.message).toBe('boom 2');
      expect(entry?.attempts[2]?.error).toBeUndefined();
    });

    it("onError 'fail' lets the exhausted error propagate into user code", async () => {
      const wf = workflow({ name: 'caught', onError: 'fail' }, async (ctx: Ctx) => {
        try {
          await ctx.step('danger', () => {
            throw new Error('nope');
          });
          return 'unreachable';
        } catch (err) {
          return `handled: ${(err as Error).message}`;
        }
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('caught', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('handled: nope');
    });
  });

  describe('fix-and-resume (the P1 pillar)', () => {
    const flaky = () =>
      workflow({ name: 'pays' }, async (ctx: Ctx) => {
        const rate = await ctx.step('convert-currency', () => {
          throw new Error('provider 500');
        });
        return { total: (rate as number) * 2 };
      });

    it('exhausted retries pause at an error gate; inject completes the run', async () => {
      const { executor } = await setup([flaky()]);
      const run = await executor.enqueue('pays', null);
      await executor.drain();
      const paused = await executor.getRun(run.id);
      expect(paused?.status).toBe('paused');
      expect(paused?.pausedSeq).toBe(0);
      const entry = (await executor.getJournal(run.id))[0];
      expect(entry?.status).toBe('paused');
      expect(entry?.pausePoint).toBe('error');
      expect(entry?.error?.message).toBe('provider 500');

      await executor.resume(run.id, 0, 'inject', { actor: 'ops@team', output: 21, reason: 'provider was down; value from dashboard' });
      await executor.drain();
      const done = await executor.getRun(run.id);
      expect(done?.status).toBe('completed');
      expect(done?.output).toEqual({ total: 42 });
      // The intervention is on the record, not erased.
      const fixed = (await executor.getJournal(run.id))[0];
      expect(fixed?.interventions).toHaveLength(1);
      expect(fixed?.interventions[0]).toMatchObject({ actor: 'ops@team', action: 'inject', injectedOutput: true });
    });

    it('continue at an error gate lets the original error fail the run', async () => {
      const { executor } = await setup([flaky()]);
      const run = await executor.enqueue('pays', null);
      await executor.drain();
      await executor.resume(run.id, 0, 'continue', { actor: 'ops@team' });
      await executor.drain();
      const done = await executor.getRun(run.id);
      expect(done?.status).toBe('failed');
      expect(done?.error?.message).toBe('provider 500');
    });

    it('retry at an error gate re-executes the step for real', async () => {
      let healthy = false;
      const wf = workflow({ name: 'heals' }, async (ctx: Ctx) =>
        ctx.step('call', () => {
          if (!healthy) throw new Error('outage');
          return 'live value';
        }),
      );
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('heals', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('paused');
      healthy = true;
      await executor.resume(run.id, 0, 'retry', { actor: 'ops@team' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('live value');
      expect((await executor.getJournal(run.id))[0]?.attempts).toHaveLength(2);
    });

    it('skip resolves the step as undefined', async () => {
      const wf = workflow({ name: 'skippy' }, async (ctx: Ctx) => {
        const extra = await ctx.step('optional', () => {
          throw new Error('broken');
        });
        return { extra: (extra as JsonValue | undefined) ?? 'none' };
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('skippy', null);
      await executor.drain();
      await executor.resume(run.id, 0, 'skip', { actor: 'ops@team' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toEqual({ extra: 'none' });
    });

    it('abort finishes the run as aborted', async () => {
      const { executor } = await setup([flaky()]);
      const run = await executor.enqueue('pays', null);
      await executor.drain();
      await executor.resume(run.id, 0, 'abort', { actor: 'ops@team', reason: 'duplicate run' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('aborted');
    });

    it('bulk: one fix resumes every run paused at the same step', async () => {
      const { executor } = await setup([flaky()]);
      const runs = [await executor.enqueue('pays', null), await executor.enqueue('pays', null), await executor.enqueue('pays', null)];
      await executor.drain();
      const resumed = await executor.resumeAllPausedAt('pays', 'convert-currency', 'inject', { actor: 'ops@team', output: 5 });
      expect(resumed).toHaveLength(3);
      await executor.drain();
      for (const run of runs) {
        expect((await executor.getRun(run.id))?.output).toEqual({ total: 10 });
      }
    });

    it('rejects resumes on finished runs and on entries that are not paused', async () => {
      const wf = workflow({ name: 'fine' }, async (ctx: Ctx) => ctx.step('ok', () => 1));
      const { executor } = await setup([wf, flaky()]);
      const finished = await executor.enqueue('fine', null);
      const paused = await executor.enqueue('pays', null);
      await executor.drain();
      await expect(executor.resume(finished.id, 0, 'inject', { actor: 'x', output: 9 })).rejects.toThrow(/only active runs/);
      await expect(executor.resume(paused.id, 7, 'inject', { actor: 'x', output: 9 })).rejects.toThrow(/no journal entry/);
    });
  });

  describe('breakpoints', () => {
    it('before-gate holds the step unexecuted; continue runs it', async () => {
      const calls: string[] = [];
      const wf = workflow({ name: 'bp' }, async (ctx: Ctx) =>
        ctx.step('guarded', () => {
          calls.push('ran');
          return 'real';
        }),
      );
      const { executor } = await setup([wf]);
      await executor.setBreakpoint({ step: 'guarded', point: 'before' });
      const run = await executor.enqueue('bp', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('paused');
      expect(calls).toEqual([]); // the pause is real: nothing in flight
      await executor.clearBreakpoints();
      await executor.resume(run.id, 0, 'continue', { actor: 'dev' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('real');
      expect(calls).toEqual(['ran']);
    });

    it('after-gate holds the result; inject replaces it', async () => {
      const wf = workflow({ name: 'bp-after' }, async (ctx: Ctx) => ctx.step('calc', () => 100));
      const { executor } = await setup([wf]);
      await executor.setBreakpoint({ step: 'calc', point: 'after' });
      const run = await executor.enqueue('bp-after', null);
      await executor.drain();
      const held = (await executor.getJournal(run.id))[0];
      expect(held?.status).toBe('paused');
      expect(held?.pausePoint).toBe('after');
      expect(held?.output).toBe(100);
      await executor.clearBreakpoints();
      await executor.resume(run.id, 0, 'inject', { actor: 'dev', output: 999 });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe(999);
    });
  });

  describe('events, approvals, children', () => {
    it('waitForEvent matches on payload subset and ignores non-matching events', async () => {
      const wf = workflow({ name: 'waits' }, async (ctx: Ctx) => {
        const evt = await ctx.waitForEvent('payment', { name: 'payment.settled', match: { invoiceId: 'inv-7' }, timeout: '3d' });
        return evt === null ? 'timed-out' : 'paid';
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('waits', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('suspended');

      const miss = await executor.publishEvent('payment.settled', { invoiceId: 'other' });
      expect(miss.matchedRuns).toEqual([]);
      const hit = await executor.publishEvent('payment.settled', { invoiceId: 'inv-7', amount: 12 });
      expect(hit.matchedRuns).toEqual([run.id]);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('paid');
    });

    it('waitForEvent resolves null on timeout', async () => {
      const wf = workflow({ name: 'waits-to' }, async (ctx: Ctx) => {
        const evt = await ctx.waitForEvent('payment', { name: 'payment.settled', timeout: '1h' });
        return evt === null ? 'timed-out' : 'paid';
      });
      const { clock, executor } = await setup([wf]);
      const run = await executor.enqueue('waits-to', null);
      await executor.drain();
      clock.advance(3_600_001);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('timed-out');
    });

    it('approval holds the run; approve releases it with the decision', async () => {
      const wf = workflow({ name: 'signoff' }, async (ctx: Ctx) => {
        const ok = await ctx.approval('finance', { approvers: ['role:finance'], timeout: '48h' });
        return ok.approved ? `approved by ${ok.by ?? '?'}` : 'escalated';
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('signoff', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('paused');
      await executor.approve(run.id, 0, { approved: true, by: 'cfo@team' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('approved by cfo@team');
    });

    it('approval times out to denied', async () => {
      const wf = workflow({ name: 'signoff-to' }, async (ctx: Ctx) => {
        const ok = await ctx.approval('finance', { timeout: '48h' });
        return ok.approved ? 'approved' : `denied${ok.timedOut === true ? ' by timeout' : ''}`;
      });
      const { clock, executor } = await setup([wf]);
      const run = await executor.enqueue('signoff-to', null);
      await executor.drain();
      clock.advance(48 * 3_600_000 + 1);
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('denied by timeout');
    });

    it('child workflows settle their parent, including through a fixed failure', async () => {
      const child = workflow({ name: 'child' }, async (ctx: Ctx) =>
        ctx.step('work', () => {
          throw new Error('child broke');
        }),
      );
      const parent = workflow({ name: 'parent' }, async (ctx: Ctx) => {
        const result = await ctx.invoke('delegate', 'child', { job: 1 });
        return { got: result };
      });
      const { executor } = await setup([parent, child]);
      const run = await executor.enqueue('parent', null);
      await executor.drain();
      // Child paused at its own error gate; parent stays suspended.
      const childRun = (await executor.listRuns({ workflow: 'child' }))[0];
      expect(childRun?.status).toBe('paused');
      expect((await executor.getRun(run.id))?.status).toBe('suspended');
      // Fix the child; the fix flows through to the parent.
      await executor.resume(childRun!.id, 0, 'inject', { actor: 'ops', output: 'patched' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('completed');
      expect((await executor.getRun(run.id))?.output).toEqual({ got: 'patched' });
    });
  });

  describe('divergence and limits', () => {
    it('changed code against an in-flight journal fails loudly, never replays silently', async () => {
      const v1 = workflow({ name: 'ship' }, async (ctx: Ctx) => {
        await ctx.step('reserve-stock', () => 'reserved');
        await ctx.sleep('settle', '1h');
        await ctx.step('charge', () => 'charged');
        return 'done';
      });
      const { clock, executor } = await setup([v1]);
      const run = await executor.enqueue('ship', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('suspended');

      // "Deploy" a version whose first step is different.
      const v2 = workflow({ name: 'ship' }, async (ctx: Ctx) => {
        await ctx.step('reserve-inventory', () => 'reserved');
        await ctx.sleep('settle', '1h');
        await ctx.step('charge', () => 'charged');
        return 'done';
      });
      executor.register(v2);
      clock.advance(3_600_001);
      await executor.drain();
      const failed = await executor.getRun(run.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error?.name).toBe('NonDeterminismError');
      expect(failed?.error?.message).toContain('reserve-stock');
      expect(failed?.error?.message).toContain('diverged');
    });

    it('a step result that cannot replay identically is refused', async () => {
      const wf = workflow({ name: 'bad-out', onError: 'fail' }, async (ctx: Ctx) => {
        await ctx.step('weird', () => () => 'a function');
        return 'unreachable';
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('bad-out', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('failed');
      expect((await executor.getRun(run.id))?.error?.name).toBe('NotJsonSerializableError');
    });

    it('whole-run timeout lands as timed_out', async () => {
      const wf = workflow({ name: 'slowpoke', timeout: '1h' }, async (ctx: Ctx) => {
        await ctx.sleep('forever', '2h');
        return 'never';
      });
      const { clock, executor } = await setup([wf]);
      const run = await executor.enqueue('slowpoke', null);
      await executor.drain();
      clock.advance(2 * 3_600_000 + 1);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('timed_out');
    });

    it('input schemas validate at enqueue', async () => {
      const wf = workflow({ name: 'typed', input: z.object({ id: z.string() }) }, async (_ctx, input) => input.id);
      const { executor } = await setup([wf]);
      await expect(executor.enqueue('typed', { id: 7 } as never)).rejects.toThrow();
      const run = await executor.enqueue('typed', { id: 'ok' });
      await executor.drain();
      expect((await executor.getRun(run.id))?.output).toBe('ok');
    });

    it('enqueueing an unregistered workflow throws', async () => {
      const { executor } = await setup([]);
      await expect(executor.enqueue('ghost', null)).rejects.toThrow(/No workflow named 'ghost'/);
    });
  });

  describe('cancel', () => {
    it('aborts a suspended run and defuses its pending waits', async () => {
      const wf = workflow({ name: 'waiter' }, async (ctx: Ctx) => {
        const evt = await ctx.waitForEvent('go', { name: 'go.signal', timeout: '7d' });
        return { got: evt };
      });
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('waiter', null);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('suspended');

      const cancelled = await executor.cancel(run.id, { actor: 'ops@team', reason: 'duplicate' });
      expect(cancelled.status).toBe('aborted');
      expect(cancelled.error?.message).toContain('ops@team');

      // The event the run was waiting for must not resurrect or touch it.
      const after = await executor.publishEvent('go.signal', { x: 1 });
      expect(after.matchedRuns).toEqual([]);
      await executor.drain();
      expect((await executor.getRun(run.id))?.status).toBe('aborted');
      await expect(executor.cancel(run.id, { actor: 'x' })).rejects.toThrow(/only active runs/);
    });

    it('cancelling a paused run routes through the audited abort', async () => {
      const wf = workflow({ name: 'pauser' }, async (ctx: Ctx) =>
        ctx.step('boom', () => {
          throw new Error('x');
        }),
      );
      const { executor } = await setup([wf]);
      const run = await executor.enqueue('pauser', null);
      await executor.drain();
      await executor.cancel(run.id, { actor: 'ops@team' });
      expect((await executor.getRun(run.id))?.status).toBe('aborted');
      expect((await executor.getJournal(run.id))[0]?.interventions.at(-1)).toMatchObject({ action: 'abort', actor: 'ops@team' });
    });
  });

  describe('replaceWorkflows', () => {
    it('swaps the registry wholesale', async () => {
      const a = workflow({ name: 'a' }, async () => 1);
      const b = workflow({ name: 'b' }, async () => 2);
      const { executor } = await setup([a]);
      expect(executor.workflowNames()).toEqual(['a']);
      executor.replaceWorkflows([b]);
      expect(executor.workflowNames()).toEqual(['b']);
      await expect(executor.enqueue('a', null)).rejects.toThrow(/No workflow named 'a'/);
    });
  });
});
});
