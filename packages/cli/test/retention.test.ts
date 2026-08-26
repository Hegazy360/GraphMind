import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultFlags, type ParsedCli } from '../src/args.js';
import { runRuns } from '../src/commands/runs.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { MAX_PAYLOAD_BYTES, isTruncatedPayload, serializePayload } from '../src/storage.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let db: string;
let storage: SqliteStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-retention-'));
  db = join(dir, 'runs.db');
  storage = new SqliteStorage(db);
});
afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRun(id: string, startedAt: number, opts: { finished?: boolean; events?: number } = {}) {
  storage.ensureRun({ id, app: 'app', startedAt, schemaVersion: 1, source: 'live' });
  for (let seq = 0; seq < (opts.events ?? 3); seq += 1) {
    storage.insertEvent({ runId: id, seq, ts: startedAt + seq, type: 'node.started', nodeId: 'n', payload: { seq } });
  }
  if (opts.finished !== false) storage.markRunFinished(id, 'ok', startedAt + 100);
}

describe('payload guards', () => {
  it('passes normal payloads through untouched', () => {
    const payload = { input: 'hello', nested: { a: 1 } };
    const result = serializePayload(payload);
    expect(result.truncated).toBe(false);
    expect(result.payload).toBe(payload);
  });

  it('replaces oversized payloads with a marker that keeps a preview', () => {
    const huge = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1000) };
    const result = serializePayload(huge);
    expect(result.truncated).toBe(true);
    expect(isTruncatedPayload(result.payload)).toBe(true);
    const marker = result.payload as { bytes: number; preview: string };
    expect(marker.bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(marker.preview.length).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(result.json)).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it('survives a cyclic payload instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const result = serializePayload(cyclic);
    expect(result.truncated).toBe(true);
    expect(isTruncatedPayload(result.payload)).toBe(true);
  });

  it('stores an oversized event as the marker', () => {
    seedRun('r1', Date.now(), { events: 0 });
    storage.insertEvent({
      runId: 'r1',
      seq: 99,
      ts: Date.now(),
      type: 'node.finished',
      nodeId: 'n',
      payload: { blob: 'y'.repeat(MAX_PAYLOAD_BYTES + 10) },
    });
    const stored = storage.listEvents('r1').events.find((e) => e.seq === 99);
    expect(isTruncatedPayload(stored?.payload)).toBe(true);
  });
});

describe('prune', () => {
  it('keeps the newest runs and drops the rest, with their events', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) seedRun(`run-${i}`, now - i * 1000, { events: 4 });
    const result = storage.prune({ keepRuns: 3, keepDays: 365, now });
    expect(result.runsDeleted).toBe(7);
    expect(result.eventsDeleted).toBe(28);
    expect(storage.listRuns().map((r) => r.id)).toEqual(['run-0', 'run-1', 'run-2']);
    expect(storage.listEvents('run-9').events).toEqual([]);
  });

  it('drops runs older than the day window even when under the count cap', () => {
    const now = Date.now();
    seedRun('fresh', now - 1 * DAY);
    seedRun('stale', now - 40 * DAY);
    const result = storage.prune({ keepRuns: 100, keepDays: 30, now });
    expect(result.runsDeleted).toBe(1);
    expect(storage.listRuns().map((r) => r.id)).toEqual(['fresh']);
  });

  it('never prunes a run that is still streaming inside the window', () => {
    const now = Date.now();
    seedRun('live-now', now - 60_000, { finished: false });
    for (let i = 0; i < 5; i += 1) seedRun(`old-${i}`, now - (i + 1) * 1000);
    const result = storage.prune({ keepRuns: 1, keepDays: 30, now });
    expect(storage.listRuns().map((r) => r.id)).toContain('live-now');
    expect(result.runsDeleted).toBeGreaterThan(0);
  });

  it('is a no-op when everything fits the policy', () => {
    seedRun('a', Date.now());
    expect(storage.prune({ keepRuns: 10, keepDays: 30 })).toEqual({ runsDeleted: 0, eventsDeleted: 0 });
  });

  it('deleteRun removes one run and reports unknown ids', () => {
    seedRun('gone', Date.now());
    expect(storage.deleteRun('gone')).toBe(true);
    expect(storage.deleteRun('never')).toBe(false);
    expect(storage.listRuns()).toEqual([]);
  });
});

describe('graphmind runs', () => {
  const parsed = (flags: Partial<ReturnType<typeof defaultFlags>>): ParsedCli => ({
    command: 'runs',
    positionals: [],
    flags: { ...defaultFlags(), db, ...flags },
    errors: [],
  });
  const sink = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
  };

  it('lists runs with counts', async () => {
    seedRun('run-abc', Date.now(), { events: 7 });
    const s = sink();
    storage.close();
    expect(await runRuns(parsed({}), s.io)).toBe(0);
    const text = s.out.join('\n');
    expect(text).toContain('run-abc');
    expect(text).toContain('7');
  });

  it('prunes on request', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) seedRun(`r${i}`, now - i * 1000);
    storage.close();
    const s = sink();
    expect(await runRuns(parsed({ prune: true, keep: 2 }), s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('deleted 3 run(s)');
    storage = new SqliteStorage(db);
    expect(storage.listRuns()).toHaveLength(2);
  });

  it('refuses --clear without --yes', async () => {
    seedRun('r', Date.now());
    storage.close();
    const s = sink();
    expect(await runRuns(parsed({ clear: true }), s.io)).toBe(1);
    expect(s.err.join('\n')).toContain('--yes');
    storage = new SqliteStorage(db);
    expect(storage.listRuns()).toHaveLength(1);
  });

  it('clears everything with --yes', async () => {
    seedRun('r', Date.now());
    storage.close();
    const s = sink();
    expect(await runRuns(parsed({ clear: true, yes: true }), s.io)).toBe(0);
    storage = new SqliteStorage(db);
    expect(storage.listRuns()).toEqual([]);
  });

  it('--rm deletes one run and errors on unknown ids', async () => {
    seedRun('keep', Date.now());
    seedRun('drop', Date.now() - 5);
    storage.close();
    const s = sink();
    expect(await runRuns(parsed({ rm: 'drop' }), s.io)).toBe(0);
    expect(await runRuns(parsed({ rm: 'nope' }), s.io)).toBe(1);
    storage = new SqliteStorage(db);
    expect(storage.listRuns().map((r) => r.id)).toEqual(['keep']);
  });

  it('says so when there is no database yet', async () => {
    const s = sink();
    const code = await runRuns(
      { command: 'runs', positionals: [], flags: { ...defaultFlags(), db: join(dir, 'nope.db') }, errors: [] },
      s.io,
    );
    expect(code).toBe(0);
    expect(s.out.join('\n')).toContain('nothing recorded yet');
  });
});
