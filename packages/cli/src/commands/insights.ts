/**
 * `graphmind insights [--app <name>] [--json] [--include-replays]` — what to
 * change in your agent, from what its recorded runs prove.
 *
 * One block per app: the behaviour trend's verdict, then ranked
 * recommendations with their evidence (runs, counts, an example), the change
 * to make, and the metric that should move. Same numbers as the MCP tools
 * `get_insights` / `suggest_improvements` and the viewer's Insights page.
 */
import { existsSync } from 'node:fs';
import type { ParsedCli } from '../args.js';
import { formatInsights, loadInsights, trendSummary } from '../insights.js';
import { resolveDbPath } from '../paths.js';
import { SqliteStorage } from '../sqlite-storage.js';
import { recordTelemetry } from '../telemetry.js';

export interface InsightsIo {
  out(text: string): void;
  error(message: string): void;
}

const defaultIo: InsightsIo = { out: (t) => void process.stdout.write(t), error: (m) => console.error(m) };

export async function runInsights(parsed: ParsedCli, io: InsightsIo = defaultIo): Promise<number> {
  recordTelemetry('insights');
  if (parsed.positionals.length > 0) {
    io.error(`graphmind insights: unexpected argument "${parsed.positionals[0]}" (use --app <name> for one app)`);
    return 1;
  }
  const dbPath = resolveDbPath(parsed.flags.db);
  if (!existsSync(dbPath)) {
    io.out(`No database at ${dbPath} — nothing recorded yet.\n`);
    return 0;
  }
  const storage = new SqliteStorage(dbPath);
  try {
    const apps = loadInsights(storage, {
      ...(parsed.flags.app !== undefined ? { app: parsed.flags.app } : {}),
      ...(parsed.flags.includeReplays ? { includeReplays: true } : {}),
    });
    if (parsed.flags.app !== undefined && apps.length === 0) {
      io.error(`graphmind insights: no runs for app "${parsed.flags.app}" (graphmind runs lists what is stored).`);
      return 1;
    }
    if (parsed.flags.json) {
      io.out(`${JSON.stringify({ apps: apps.map((a) => ({ app: a.app, trend: trendSummary(a.trend), recommendations: a.recommendations })) }, null, 2)}\n`);
    } else {
      io.out(formatInsights(apps));
    }
    return 0;
  } finally {
    storage.close();
  }
}
