import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseEnvelope } from '@graphmind-ai/schema';
import { defaultFlags, type ParsedCli } from '../src/args.js';
import { runRuns } from '../src/commands/runs.js';
import { startServer } from '../src/server.js';
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

  /**
   * A payload schema is per message type: `node.finished` needs `nodeId`,
   * `durationMs` and `status`. Replacing the whole payload with a marker made
   * the stored envelope fail its own schema on replay, so the viewer dropped
   * it and the node stayed "running" forever after a reload. Only the
   * oversized FIELD may be marked.
   */
  it('keeps the structural fields of an oversized node.finished and marks only the big one', () => {
    const payload = {
      nodeId: 'tool:scrape',
      status: 'ok',
      durationMs: 1,
      output: 'x'.repeat(600 * 1024),
    };
    const result = serializePayload(payload);

    expect(result.truncated).toBe(true);
    const kept = result.payload as Record<string, unknown>;
    expect(kept['nodeId']).toBe('tool:scrape');
    expect(kept['status']).toBe('ok');
    expect(kept['durationMs']).toBe(1);
    expect(kept['fields']).toEqual(['output']);
    // Type-preserving: a string field comes back as a (short) string, not as
    // a marker object. Replacing it wholesale is what used to make a large
    // `node.error` fail its own schema and vanish from the viewer.
    expect(typeof kept['output']).toBe('string');
    expect(kept['output']).toMatch(/^x+…\[graphmind: truncated\]$/);
    expect(isTruncatedPayload(kept)).toBe(true);
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    // The whole point: the trimmed envelope is still one the viewer parses.
    const envelope = { gm: 1, seq: 3, ts: 1_700_000_000_000, runId: 'r', type: 'node.finished', payload: kept };
    expect(parseEnvelope(envelope).kind).toBe('ok');
  });

  /**
   * The case that made type preservation non-negotiable, and it needs no
   * attacker — a provider returning a large error body is enough.
   *
   * `node.error` carries `error: {name, message}`, both REQUIRED strings. A
   * >512KB message made `error` the biggest field; replacing it with a marker
   * object made the stored envelope fail `ErrorInfoSchema`, so the viewer
   * dropped it on replay. A debugger silently losing precisely the error
   * event is the worst failure this thing has.
   */
  it('keeps an oversized node.error valid: the debugger must not lose the error', () => {
    const payload = {
      nodeId: 'tool:fetch',
      error: {
        name: 'ProviderError',
        message: `upstream said: ${'E'.repeat(600 * 1024)}`,
        stack: 'at fetch (index.ts:1:1)',
      },
    };
    const result = serializePayload(payload);

    expect(result.truncated).toBe(true);
    const kept = result.payload as Record<string, unknown>;
    expect(kept['nodeId']).toBe('tool:fetch');
    const error = kept['error'] as Record<string, unknown>;
    // The shape survives: name intact, message still a string, stack intact.
    expect(error['name']).toBe('ProviderError');
    expect(typeof error['message']).toBe('string');
    expect(error['message']).toMatch(/^upstream said: E+…\[graphmind: truncated\]$/);
    expect(error['stack']).toBe('at fetch (index.ts:1:1)');
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);

    const envelope = { gm: 1, seq: 4, ts: 1_700_000_000_000, runId: 'r', type: 'node.error', payload: kept };
    expect(parseEnvelope(envelope).kind).toBe('ok');
  });

  it('is idempotent, so applying the guard twice cannot compound', () => {
    const once = serializePayload({ nodeId: 'n', status: 'ok', durationMs: 1, output: 'x'.repeat(600 * 1024) });
    const twice = serializePayload(once.payload);
    expect(twice.truncated).toBe(false);
    expect(twice.payload).toBe(once.payload);
    expect(twice.json).toBe(once.json);
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

/** db + wal + shm: the whole footprint, which is what fills a laptop. */
function bytesOnDisk(path: string): number {
  let total = 0;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      total += statSync(file).size;
    } catch {
      // absent
    }
  }
  return total;
}

describe('vacuum reclaims disk', () => {
  function seedFat(runs: number, eventsPerRun: number): void {
    const blob = 'x'.repeat(20_000);
    const now = Date.now();
    for (let r = 0; r < runs; r += 1) {
      storage.ensureRun({ id: `fat-${r}`, app: 'app', startedAt: now - r * 1000, schemaVersion: 1, source: 'live' });
      for (let seq = 0; seq < eventsPerRun; seq += 1) {
        storage.insertEvent({
          runId: `fat-${r}`,
          seq,
          ts: now,
          type: 'node.finished',
          nodeId: 'n',
          payload: { nodeId: 'n', status: 'ok', durationMs: 1, output: blob },
        });
      }
      storage.markRunFinished(`fat-${r}`, 'ok', now);
    }
  }

  it('prune alone leaves the pages in the file; vacuum gives the disk back', () => {
    seedFat(40, 25); // ~20MB of payloads
    const before = bytesOnDisk(db);
    expect(before).toBeGreaterThan(10_000_000);

    const pruned = storage.prune({ keepRuns: 1, keepDays: 365 });
    expect(pruned.runsDeleted).toBe(39);
    // Deleting rows is not reclaiming space: the file has not shrunk.
    expect(bytesOnDisk(db)).toBeGreaterThan(before * 0.9);

    storage.vacuum();
    // VACUUM without the WAL checkpoint that follows it leaves the main file
    // at full size and a WAL holding the whole rewritten copy — the footprint
    // gets WORSE. Asserting on the total is what catches that.
    expect(bytesOnDisk(db)).toBeLessThan(before / 4);
  });

  it('leaves the surviving data intact', () => {
    seedFat(5, 5);
    storage.prune({ keepRuns: 2, keepDays: 365 });
    storage.vacuum();
    expect(storage.listRuns().map((r) => r.id)).toEqual(['fat-0', 'fat-1']);
    expect(storage.listEvents('fat-0').events).toHaveLength(5);
  });
});

describe('startup retention', () => {
  /** Old enough that the default 30-day window drops it. */
  const ANCIENT = Date.now() - 400 * DAY;

  it('runs after the port is bound, not before it', async () => {
    for (let i = 0; i < 30; i += 1) seedRun(`old-${i}`, ANCIENT - i * 1000, { events: 2 });
    storage.close();

    const logs: string[] = [];
    const server = await startServer({
      port: 0,
      dbPath: db,
      log: (m) => logs.push(m),
      env: {},
    });
    try {
      // The listener answers before retention has had a chance to run.
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
      await server.retentionDone;
      expect(logs.join('\n')).toContain('Pruned 30 old run(s)');
      const runs = (await (await fetch(`${server.url}/api/runs`)).json()) as { runs: unknown[] };
      expect(runs.runs).toEqual([]);
    } finally {
      await server.close();
    }
    storage = new SqliteStorage(db);
  });

  it('reclaims the disk the sweep freed', async () => {
    const blob = 'x'.repeat(20_000);
    for (let r = 0; r < 30; r += 1) {
      storage.ensureRun({ id: `old-${r}`, app: 'a', startedAt: ANCIENT - r * 1000, schemaVersion: 1, source: 'live' });
      for (let seq = 0; seq < 25; seq += 1) {
        storage.insertEvent({
          runId: `old-${r}`,
          seq,
          ts: ANCIENT,
          type: 'node.finished',
          nodeId: 'n',
          payload: { nodeId: 'n', status: 'ok', durationMs: 1, output: blob },
        });
      }
      storage.markRunFinished(`old-${r}`, 'ok', ANCIENT);
    }
    storage.close();
    const before = bytesOnDisk(db);
    expect(before).toBeGreaterThan(10_000_000);

    const server = await startServer({ port: 0, dbPath: db, log: () => {}, env: {} });
    await server.retentionDone;
    await server.close();

    expect(bytesOnDisk(db)).toBeLessThan(before / 4);
    storage = new SqliteStorage(db);
  });

  it('is skipped entirely when GRAPHMIND_RETENTION=off', async () => {
    seedRun('ancient', ANCIENT);
    storage.close();
    const server = await startServer({
      port: 0,
      dbPath: db,
      log: () => {},
      env: { GRAPHMIND_RETENTION: 'off' },
    });
    await server.retentionDone;
    await server.close();
    storage = new SqliteStorage(db);
    expect(storage.listRuns().map((r) => r.id)).toEqual(['ancient']);
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

describe('unserializable payloads', () => {
  // Found by CI: Linux trips JSON.stringify's stack depth on payloads macOS
  // serializes fine, and replacing the whole payload made the stored envelope
  // fail its own schema — the viewer then dropped the event on replay and the
  // node hung "running" forever.
  const deeplyNested = () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < 200_000; i += 1) {
      const next: Record<string, unknown> = {};
      cursor['n'] = next;
      cursor = next;
    }
    return root;
  };

  it('keeps the schema-required fields when one field cannot be serialized', () => {
    const result = serializePayload({
      nodeId: 'tool:x',
      instanceId: 'i1',
      durationMs: 5,
      status: 'ok',
      output: deeplyNested(),
    });
    expect(result.truncated).toBe(true);
    const stored = JSON.parse(result.json) as Record<string, unknown>;
    expect(stored['nodeId']).toBe('tool:x');
    expect(stored['durationMs']).toBe(5);
    expect(stored['status']).toBe('ok');
    expect(stored['fields']).toEqual(['output']);
    expect(isTruncatedPayload(stored['output'])).toBe(true);
  });

  it('produces an envelope the viewer can still parse', () => {
    const result = serializePayload({
      nodeId: 'tool:x',
      durationMs: 1,
      status: 'ok',
      output: deeplyNested(),
    });
    const parsed = parseEnvelope({
      gm: PROTOCOL_VERSION,
      seq: 1,
      ts: Date.now(),
      runId: 'r1',
      type: 'node.finished',
      payload: JSON.parse(result.json),
    });
    expect(parsed.kind).toBe('ok');
  });

  it('does the same for a cyclic field', () => {
    const cyclic: Record<string, unknown> = { self: null };
    cyclic['self'] = cyclic;
    const result = serializePayload({ nodeId: 'tool:y', durationMs: 1, status: 'ok', output: cyclic });
    const stored = JSON.parse(result.json) as Record<string, unknown>;
    expect(stored['nodeId']).toBe('tool:y');
    expect(stored['fields']).toEqual(['output']);
  });
});
