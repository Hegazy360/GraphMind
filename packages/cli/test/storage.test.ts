/** Direct SqliteStorage unit tests (tmp-dir DB files). */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';

let dir: string;
let storage: SqliteStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-storage-test-'));
  storage = new SqliteStorage(join(dir, 'nested', 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(runId = 'run_1', count = 3): void {
  storage.ensureRun({ id: runId, app: 'app', startedAt: 100, schemaVersion: 1, source: 'live' });
  for (let seq = 0; seq < count; seq += 1) {
    storage.insertEvent({
      runId,
      seq,
      ts: 100 + seq,
      type: seq === 0 ? 'run.started' : 'node.token',
      nodeId: seq === 0 ? null : 'llm:step',
      payload: { seq },
    });
  }
}

describe('SqliteStorage', () => {
  it('creates parent directories and the database file', () => {
    expect(existsSync(join(dir, 'nested', 'test.db'))).toBe(true);
  });

  it('deduplicates on (runId, seq) via INSERT OR IGNORE', () => {
    seed();
    const duplicate = storage.insertEvent({
      runId: 'run_1',
      seq: 1,
      ts: 999,
      type: 'node.token',
      nodeId: 'llm:step',
      payload: { replayed: true },
    });
    expect(duplicate).toBe(false);
    const page = storage.listEvents('run_1');
    expect(page.total).toBe(3);
    // The original row won; the replay did not overwrite it.
    expect(page.events[1]?.payload).toEqual({ seq: 1 });

    const fresh = storage.insertEvent({
      runId: 'run_1',
      seq: 3,
      ts: 103,
      type: 'node.token',
      nodeId: 'llm:step',
      payload: { seq: 3 },
    });
    expect(fresh).toBe(true);
  });

  it('same seq in different runs does not collide', () => {
    seed('run_a', 2);
    seed('run_b', 2);
    expect(storage.listEvents('run_a').total).toBe(2);
    expect(storage.listEvents('run_b').total).toBe(2);
  });

  it('ensureRun is idempotent; markRunStarted/Finished update the row', () => {
    seed();
    storage.ensureRun({ id: 'run_1', app: 'other', startedAt: 999, schemaVersion: 1, source: 'demo' });
    let run = storage.getRun('run_1');
    expect(run).toMatchObject({ app: 'app', startedAt: 100, source: 'live', status: 'running' });

    storage.markRunStarted('run_1', 'real-app', 105);
    storage.markRunFinished('run_1', 'aborted', 400);
    run = storage.getRun('run_1');
    expect(run).toMatchObject({
      app: 'real-app',
      startedAt: 105,
      finishedAt: 400,
      status: 'aborted',
      eventCount: 3,
      errorCount: 0,
    });
  });

  it('counts node.error events as errors', () => {
    seed();
    storage.insertEvent({
      runId: 'run_1',
      seq: 9,
      ts: 109,
      type: 'node.error',
      nodeId: 'tool:x',
      payload: { nodeId: 'tool:x', error: { name: 'E', message: 'boom' } },
    });
    expect(storage.getRun('run_1')?.errorCount).toBe(1);
    expect(storage.getRun('run_1')?.eventCount).toBe(4);
  });

  it('lists runs most recently started first', () => {
    storage.ensureRun({ id: 'old', app: 'a', startedAt: 10, schemaVersion: 1, source: 'live' });
    storage.ensureRun({ id: 'new', app: 'a', startedAt: 20, schemaVersion: 1, source: 'live' });
    expect(storage.listRuns().map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('paginates events with afterSeq/limit and reports hasMore', () => {
    seed('run_1', 5);
    const page1 = storage.listEvents('run_1', { limit: 2 });
    expect(page1.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(5);

    const page2 = storage.listEvents('run_1', { afterSeq: 1, limit: 2 });
    expect(page2.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page2.hasMore).toBe(true);

    const page3 = storage.listEvents('run_1', { afterSeq: 3, limit: 2 });
    expect(page3.events.map((e) => e.seq)).toEqual([4]);
    expect(page3.hasMore).toBe(false);

    const all = storage.listEvents('run_1');
    expect(all.events).toHaveLength(5);
    expect(all.hasMore).toBe(false);
  });

  it('round-trips payloads (including unknown event types) through JSON', () => {
    storage.ensureRun({ id: 'r', app: 'a', startedAt: 1, schemaVersion: 1, source: 'live' });
    const payload = { nested: { deep: [1, 'two', null, { three: true }] }, unicode: 'héllo ✨' };
    storage.insertEvent({ runId: 'r', seq: 0, ts: 1, type: 'custom.thing', nodeId: null, payload });
    expect(storage.listEvents('r').events[0]?.payload).toEqual(payload);
    expect(storage.listEvents('r').events[0]?.type).toBe('custom.thing');
  });

  it('persists across close + reopen (WAL checkpoint on close)', () => {
    seed('run_keep', 4);
    storage.markRunFinished('run_keep', 'ok', 500);
    const path = storage.path;
    storage.close();

    const reopened = new SqliteStorage(path);
    try {
      expect(reopened.getRun('run_keep')).toMatchObject({ status: 'ok', eventCount: 4 });
      expect(reopened.listEvents('run_keep').events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    } finally {
      reopened.close();
    }
    storage = new SqliteStorage(path); // so afterEach close() has a live handle
  });
});
