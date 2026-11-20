/**
 * Insights over a real SQLite store: the shared loader, `graphmind insights`,
 * the MCP tools and GET /api/insights all report the same recommendations,
 * with the store's status (abandoned) and source (replay) respected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs as parseCli } from '../src/args.js';
import { runInsights } from '../src/commands/insights.js';
import { loadInsights } from '../src/insights.js';
import { getInsights, suggestImprovements } from '../src/mcp/tools.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { fetchJson, startTestServer, type TestServer } from './helpers.js';

const dirs: string[] = [];
let server: TestServer | undefined;
afterEach(async () => {
  await server?.cleanup();
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `n` runs of trip-planner whose checkBudget throws the same error; plus noise the analysis must handle. */
function seed(storage: SqliteStorage, n = 4): void {
  let t = Date.UTC(2026, 10, 1);
  const run = (id: string, opts: { source?: 'live' | 'demo'; fail: boolean; finish?: boolean; app?: string }) => {
    t += 60_000;
    const app = opts.app ?? 'trip-planner';
    storage.ensureRun({ id, app, startedAt: t, schemaVersion: 1, source: opts.source ?? 'live' });
    let seq = 0;
    const put = (type: string, payload: unknown, nodeId: string | null = null) =>
      storage.insertEvent({ runId: id, seq: seq++, ts: t + seq, type, nodeId, payload });
    put('run.started', { app, sdk: { name: 'ai', version: '7.0.0' } });
    put('node.started', { nodeId: 'tool:checkBudget', kind: 'tool', name: 'checkBudget', instanceId: `${id}-t`, input: { total: 60_000_000 } }, 'tool:checkBudget');
    if (opts.fail) put('node.error', { nodeId: 'tool:checkBudget', error: { name: 'Error', message: 'Trip total exceeds the budget' } }, 'tool:checkBudget');
    put('node.finished', { nodeId: 'tool:checkBudget', output: opts.fail ? null : { ok: true }, durationMs: 20, status: opts.fail ? 'error' : 'ok' }, 'tool:checkBudget');
    if (opts.finish !== false) {
      put('run.finished', { status: opts.fail ? 'error' : 'ok' });
      storage.markRunFinished(id, opts.fail ? 'error' : 'ok', t + 100);
    } else {
      storage.markRunAbandoned(id, t + 100);
    }
  };
  for (let i = 0; i < n; i += 1) run(`run-${i}`, { fail: true, finish: i !== 0 });
  run('run-ok', { fail: false });
  run('other-1', { fail: false, app: 'other-agent' });
}

function tempStorage(): { storage: SqliteStorage; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gm-insights-'));
  dirs.push(dir);
  const dbPath = join(dir, 'graphmind.db');
  return { storage: new SqliteStorage(dbPath), dbPath };
}

describe('insights', () => {
  it('loadInsights: one entry per app, the urgent one first, abandoned runs reported as such', () => {
    const { storage } = tempStorage();
    seed(storage);
    const apps = loadInsights(storage);
    expect(apps.map((a) => a.app)).toEqual(['trip-planner', 'other-agent']);
    const trip = apps[0]!;
    expect(trip.trend.runs).toBe(5);
    expect(trip.trend.notes.join(' ')).toContain('1 run(s) were abandoned');
    expect(trip.recommendations[0]).toMatchObject({ id: 'R-tool-error-repeat', target: { name: 'checkBudget' }, evidence: { runs: 4 } });
    expect(apps[1]!.recommendations).toEqual([]);
    expect(loadInsights(storage, { app: 'other-agent' }).map((a) => a.app)).toEqual(['other-agent']);
    storage.close();
  });

  it('`graphmind insights` prints the recommendation, --json is machine-readable, an unknown app fails', async () => {
    const { storage, dbPath } = tempStorage();
    seed(storage);
    storage.close();
    const io = () => {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { out: (t: string) => out.push(t), error: (m: string) => err.push(m) } };
    };
    const text = io();
    expect(await runInsights(parseCli(['insights', '--db', dbPath]), text.io)).toBe(0);
    const printed = text.out.join('');
    expect(printed).toContain('trip-planner — 5 runs');
    expect(printed).toContain('[high] checkBudget failed 4 times with the same error');
    expect(printed).toContain('rule:     R-tool-error-repeat');

    const json = io();
    expect(await runInsights(parseCli(['insights', '--db', dbPath, '--json', '--app', 'trip-planner']), json.io)).toBe(0);
    const parsed = JSON.parse(json.out.join(''));
    expect(parsed.apps).toHaveLength(1);
    expect(parsed.apps[0].trend.points).toBeUndefined(); // summary, not the per-run series
    expect(parsed.apps[0].recommendations[0].id).toBe('R-tool-error-repeat');

    const missing = io();
    expect(await runInsights(parseCli(['insights', '--db', dbPath, '--app', 'nope']), missing.io)).toBe(1);
    expect(missing.err.join('')).toContain('no runs for app "nope"');
  });

  it('MCP tools: get_insights summarizes, suggest_improvements adds viewer links to the evidence', () => {
    const { storage } = tempStorage();
    seed(storage);
    const ctx = { storage, viewerBaseUrl: 'http://127.0.0.1:4747' };
    const insights = getInsights(ctx, {});
    expect(insights.apps[0]).toMatchObject({ app: 'trip-planner', runs: 5, recommendationCount: 1 });
    const suggestions = suggestImprovements(ctx, { app: 'trip-planner' });
    const rec = suggestions.apps[0]!.recommendations[0]!;
    expect(rec.evidence.links[0]).toBe('http://127.0.0.1:4747/#/run/run-0');
    expect(suggestImprovements(ctx, { app: 'nope' }).note).toBe('no runs for app "nope"');
    expect(() => getInsights(ctx, { app: 42 })).toThrow('"app" must be a non-empty string');
    storage.close();
  });

  it('GET /api/insights serves the same thing to the viewer', async () => {
    server = await startTestServer();
    seed(server.server.storage as SqliteStorage);
    const all = await fetchJson(server.port, '/api/insights');
    expect(all.status).toBe(200);
    expect(all.body.apps.map((a: { app: string }) => a.app)).toEqual(['trip-planner', 'other-agent']);
    const one = await fetchJson(server.port, '/api/insights?app=other-agent');
    expect(one.body.apps).toHaveLength(1);
  });
});
