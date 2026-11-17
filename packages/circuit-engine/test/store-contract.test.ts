/**
 * The JournalStore contract, run against every backend (./backends.ts).
 * The executor relies on these exact semantics, so a backend that passes
 * here is a drop-in: Patch clearing, claim rules and lease reclaim, dense
 * per-run seqs, absent-vs-null JSON, and list ordering including ties.
 *
 * The Postgres-only block at the bottom covers what SQLite cannot exhibit
 * (single writer): concurrent claimers and concurrent appenders, through two
 * independent connection pools on one schema — two "workers".
 */
import { describe, expect, it } from 'vitest';
import type { JournalEntry, Run } from '@graphmind-ai/circuit-schema';
import { BACKENDS, openPgPair, openStore, pgAvailable, unavailable } from './backends.js';

function run(id: string, over: Partial<Run> = {}): Run {
  return { id, workflow: 'wf', status: 'queued', input: { n: 1 }, createdAt: 1_000, ...over };
}

function entry(runId: string, over: Partial<Omit<JournalEntry, 'seq'>> = {}): Omit<JournalEntry, 'seq'> {
  return {
    runId,
    kind: 'step',
    name: 'a',
    ordinal: 0,
    key: 'step:a',
    status: 'running',
    attempts: [],
    interventions: [],
    startedAt: 5,
    ...over,
  };
}

describe.each(BACKENDS)('%s', (backend) => {
  describe.skipIf(unavailable(backend))('JournalStore contract', () => {
    it('round-trips a run with every optional field, and keeps absent fields absent', async () => {
      const store = await openStore(backend);
      const full = run('r1', {
        output: { ok: true, list: [1, 'two', null] },
        error: { name: 'E', message: 'm' },
        idempotencyKey: 'k',
        parentRunId: 'p',
        parentSeq: 3,
        forkedFrom: { runId: 'o', fromSeq: 2 },
        wakeAt: 9_000_000_000_000,
        leaseOwner: 'w',
        leaseExpiresAt: 2_000,
        pausedSeq: 1,
        startedAt: 1_001,
        finishedAt: 1_002,
      });
      expect(await store.createRun(full)).toEqual(full);
      expect(await store.getRun('r1')).toEqual(full);
      await store.createRun(run('r2'));
      expect(await store.getRun('r2')).toEqual(run('r2'));
      expect(await store.getRun('nope')).toBeUndefined();
    });

    it('distinguishes a JSON null output from an absent one', async () => {
      const store = await openStore(backend);
      await store.createRun(run('a', { input: null, output: null }));
      await store.createRun(run('b', { input: 'text' }));
      const a = await store.getRun('a');
      expect(a?.input).toBeNull();
      expect('output' in a!).toBe(true);
      expect(a?.output).toBeNull();
      const b = await store.getRun('b');
      expect(b?.input).toBe('text');
      expect('output' in b!).toBe(false);
    });

    it('createRun with a taken idempotency key returns the existing run', async () => {
      const store = await openStore(backend);
      const first = await store.createRun(run('r1', { idempotencyKey: 'k' }));
      const again = await store.createRun(run('r2', { idempotencyKey: 'k', input: 'other' }));
      expect(again.id).toBe(first.id);
      expect(await store.getRun('r2')).toBeUndefined();
      expect((await store.findByIdempotencyKey('wf', 'k'))?.id).toBe('r1');
      // Keys are per workflow.
      expect((await store.createRun(run('r3', { workflow: 'other', idempotencyKey: 'k' }))).id).toBe('r3');
    });

    it('listRuns: newest first, insertion order breaks ties, filters, default limit 100', async () => {
      const store = await openStore(backend);
      await store.createRun(run('old', { createdAt: 1 }));
      await store.createRun(run('t1', { createdAt: 5 }));
      await store.createRun(run('t2', { createdAt: 5, status: 'paused' }));
      await store.createRun(run('t3', { createdAt: 5, workflow: 'x' }));
      expect((await store.listRuns()).map((r) => r.id)).toEqual(['t3', 't2', 't1', 'old']);
      expect((await store.listRuns({ workflow: 'wf' })).map((r) => r.id)).toEqual(['t2', 't1', 'old']);
      expect((await store.listRuns({ status: 'paused' })).map((r) => r.id)).toEqual(['t2']);
      expect((await store.listRuns({ workflow: 'wf', status: 'queued', limit: 1 })).map((r) => r.id)).toEqual(['t1']);
      for (let i = 0; i < 105; i++) await store.createRun(run(`m${i}`, { createdAt: 10 + i }));
      expect(await store.listRuns()).toHaveLength(100);
    });

    it('updateRun: present-undefined clears, absent is untouched, JSON columns update', async () => {
      const store = await openStore(backend);
      await store.createRun(run('r', { wakeAt: 50, pausedSeq: 2, output: 'x', error: { name: 'E', message: 'm' } }));
      await store.updateRun('r', { status: 'running', wakeAt: undefined, output: { y: [1] } });
      const r = await store.getRun('r');
      expect(r?.status).toBe('running');
      expect(r?.wakeAt).toBeUndefined();
      expect(r?.pausedSeq).toBe(2);
      expect(r?.output).toEqual({ y: [1] });
      await store.updateRun('r', { error: undefined, output: undefined, pausedSeq: undefined });
      const cleared = await store.getRun('r');
      expect('error' in cleared!).toBe(false);
      expect('output' in cleared!).toBe(false);
      expect(cleared?.pausedSeq).toBeUndefined();
      await store.updateRun('r', {}); // no-op, no SQL error
    });

    it('claimDue: the due rules, lease reclaim, ordering and limit', async () => {
      const store = await openStore(backend);
      const now = 10_000;
      await store.createRun(run('queued-late', { createdAt: 300 }));
      await store.createRun(run('queued-early', { createdAt: 100 }));
      await store.createRun(run('queued-tie', { createdAt: 100 }));
      await store.createRun(run('sleep-due', { status: 'suspended', wakeAt: 200, createdAt: 1 }));
      await store.createRun(run('sleep-future', { status: 'suspended', wakeAt: now + 1_000 }));
      await store.createRun(run('suspended-no-wake', { status: 'suspended' }));
      await store.createRun(run('paused-human', { status: 'paused' }));
      await store.createRun(run('paused-timeout', { status: 'paused', wakeAt: now }));
      await store.createRun(run('done', { status: 'completed' }));
      await store.createRun(run('leased', { leaseOwner: 'other', leaseExpiresAt: now + 1_000 }));
      await store.createRun(run('crashed', { status: 'running', leaseOwner: 'dead', leaseExpiresAt: now, createdAt: 400 }));

      const claimed = await store.claimDue(now, 'me', 500, 100);
      expect(claimed.map((r) => r.id)).toEqual([
        'queued-early',
        'queued-tie',
        'sleep-due',
        'queued-late',
        'crashed',
        'paused-timeout',
      ]);
      for (const c of claimed) {
        expect(c.leaseOwner).toBe('me');
        expect(c.leaseExpiresAt).toBe(now + 500);
        expect((await store.getRun(c.id))?.leaseOwner).toBe('me');
      }
      // Held leases are not claimable again until they expire.
      expect(await store.claimDue(now + 499, 'other', 500, 100)).toEqual([]);
      const reclaimed = await store.claimDue(now + 500, 'other', 500, 2);
      expect(reclaimed.map((r) => r.id)).toEqual(['queued-early', 'queued-tie']);

      await store.releaseLease('queued-late');
      const released = await store.getRun('queued-late');
      expect(released?.leaseOwner).toBeUndefined();
      expect(released?.leaseExpiresAt).toBeUndefined();
      expect((await store.claimDue(now + 1, 'third', 500, 10)).map((r) => r.id)).toEqual(['queued-late']);
      // Expiry is inclusive: a lease ending at T is claimable at T.
      expect((await store.claimDue(now + 1_000, 'fourth', 500, 10)).map((r) => r.id)).toContain('leased');
    });

    it('appendEntry: dense seqs per run, round-trips every field', async () => {
      const store = await openStore(backend);
      const a0 = await store.appendEntry(entry('A'));
      const b0 = await store.appendEntry(entry('B'));
      const full = entry('A', {
        kind: 'wait',
        name: 'w',
        ordinal: 1,
        key: 'wait:w:x',
        status: 'suspended',
        pausePoint: 'before',
        input: [1, { a: 'b' }],
        output: null,
        error: { name: 'E', message: 'm' },
        attempts: [{ startedAt: 1, finishedAt: 2, error: { name: 'E', message: 'x' } }],
        interventions: [{ actor: 'me', action: 'retry', at: 3 }],
        wakeAt: 7,
        waitEvent: 'evt',
        waitMatch: { id: 'x' },
        expiresAt: 8,
        childRunId: 'c',
        finishedAt: 9,
      });
      const a1 = await store.appendEntry(full);
      expect([a0.seq, b0.seq, a1.seq]).toEqual([0, 0, 1]);
      expect(a1).toEqual({ ...full, seq: 1 });
      expect(await store.getEntry('A', 1)).toEqual({ ...full, seq: 1 });
      expect((await store.listJournal('A')).map((e) => e.seq)).toEqual([0, 1]);
      expect(await store.getEntry('A', 5)).toBeUndefined();
      expect(await store.listJournal('none')).toEqual([]);
      const plain = await store.getEntry('A', 0);
      expect(plain).toEqual({ ...entry('A'), seq: 0 });
      expect('output' in plain!).toBe(false);
    });

    it('updateEntry follows Patch semantics', async () => {
      const store = await openStore(backend);
      await store.appendEntry(entry('A', { wakeAt: 5, error: { name: 'E', message: 'm' }, pausePoint: 'error' }));
      await store.updateEntry('A', 0, {
        status: 'completed',
        error: undefined,
        pausePoint: undefined,
        output: { done: true },
        attempts: [{ startedAt: 1 }],
      });
      const e = await store.getEntry('A', 0);
      expect(e?.status).toBe('completed');
      expect(e?.wakeAt).toBe(5);
      expect('error' in e!).toBe(false);
      expect('pausePoint' in e!).toBe(false);
      expect(e?.output).toEqual({ done: true });
      expect(e?.attempts).toEqual([{ startedAt: 1 }]);
    });

    it('waits: registration order, replace moves to the end, remove', async () => {
      const store = await openStore(backend);
      await store.addWait({ runId: 'z', seq: 0, eventName: 'e', match: { k: 1 }, expiresAt: 10 });
      await store.addWait({ runId: 'a', seq: 3, eventName: 'e', match: undefined, expiresAt: 11 });
      await store.addWait({ runId: 'm', seq: 0, eventName: 'other', match: undefined, expiresAt: 12 });
      expect(await store.findWaits('e')).toEqual([
        { runId: 'z', seq: 0, eventName: 'e', match: { k: 1 }, expiresAt: 10 },
        { runId: 'a', seq: 3, eventName: 'e', match: undefined, expiresAt: 11 },
      ]);
      await store.addWait({ runId: 'z', seq: 0, eventName: 'e', match: { k: 2 }, expiresAt: 20 });
      expect(await store.findWaits('e')).toEqual([
        { runId: 'a', seq: 3, eventName: 'e', match: undefined, expiresAt: 11 },
        { runId: 'z', seq: 0, eventName: 'e', match: { k: 2 }, expiresAt: 20 },
      ]);
      await store.removeWait('a', 3);
      expect((await store.findWaits('e')).map((w) => w.runId)).toEqual(['z']);
      expect(await store.findWaits('nothing')).toEqual([]);
    });

    it('events insert; a duplicate id is rejected', async () => {
      const store = await openStore(backend);
      await store.insertEvent({ id: 'e1', name: 'n', data: { a: 1 }, receivedAt: 1 });
      await expect(store.insertEvent({ id: 'e1', name: 'n', data: null, receivedAt: 2 })).rejects.toThrow();
    });

    it('breakpoints keep their order and clear', async () => {
      const store = await openStore(backend);
      await store.setBreakpoint({ step: 'b', point: 'before' });
      await store.setBreakpoint({ workflow: 'w', point: 'after' });
      await store.setBreakpoint({ kind: 'mcp', point: 'error' });
      expect(await store.listBreakpoints()).toEqual([
        { step: 'b', point: 'before' },
        { workflow: 'w', point: 'after' },
        { kind: 'mcp', point: 'error' },
      ]);
      await store.clearBreakpoints();
      expect(await store.listBreakpoints()).toEqual([]);
    });
  });
});

describe.skipIf(!pgAvailable)('PgJournalStore (Postgres only)', () => {
  it('two concurrent claimers never get the same run', async () => {
    const { a, b } = await openPgPair();
    for (let i = 0; i < 60; i++) await a.createRun(run(`r${String(i).padStart(2, '0')}`, { createdAt: i }));
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).claimDue(1_000, `w${i}`, 60_000, 10)),
    );
    const ids = claims.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every run went to exactly one claimer, and the store agrees on who.
    expect(ids.length).toBe(60);
    for (const [i, batch] of claims.entries()) {
      for (const r of batch) expect((await a.getRun(r.id))?.leaseOwner).toBe(`w${i}`);
    }
    expect(await b.claimDue(1_000, 'late', 60_000, 10)).toEqual([]);
  });

  it('concurrent appends to one run give dense, unique seqs', async () => {
    const { a, b } = await openPgPair();
    const appended = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).appendEntry(entry('R', { name: `s${i}` }))),
    );
    const seqs = appended.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const journal = await a.listJournal('R');
    expect(journal.map((e) => e.seq)).toEqual(seqs);
    // Each returned seq is the row actually stored for that entry.
    for (const e of appended) expect(journal[e.seq]?.name).toBe(e.name);
  });

  it('migrate is idempotent, qualifies tables by schema, and enables RLS everywhere', async () => {
    const { a, b, schema } = await openPgPair();
    expect(await a.migrate()).toEqual([]);
    expect(await b.migrate()).toEqual([]);
    const { testSql } = await import('@graphmind-ai/db');
    const t = await testSql();
    try {
      const rows = await t!.sql.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> '_migrations' ORDER BY c.relname`,
        [schema],
      );
      expect(rows).toEqual(
        ['breakpoints', 'events', 'journal', 'runs', 'waits'].map((relname) => ({ relname, relrowsecurity: true })),
      );
    } finally {
      await t!.drop();
    }
  });
});
