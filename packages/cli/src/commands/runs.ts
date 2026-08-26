/**
 * `graphmind runs` — list what is stored, and keep it from growing forever.
 *
 *   graphmind runs                      list recent runs
 *   graphmind runs --prune              apply the retention policy now
 *   graphmind runs --prune --keep 50    ...keeping only the 50 newest
 *   graphmind runs --prune --days 7     ...and only the last 7 days
 *   graphmind runs --clear              delete every run (asks for --yes)
 *   graphmind runs --rm <runId>         delete one run
 */
import { existsSync } from 'node:fs';
import type { ParsedCli } from '../args.js';
import { resolveDbPath } from '../paths.js';
import { SqliteStorage } from '../sqlite-storage.js';
import { DEFAULT_RETENTION } from '../storage.js';
import { recordTelemetry } from '../telemetry.js';

export interface RunsIo {
  log(message: string): void;
  error(message: string): void;
}

function ago(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export async function runRuns(parsed: ParsedCli, io: RunsIo = console): Promise<number> {
  recordTelemetry('runs');

  const dbPath = resolveDbPath(parsed.flags.db);
  if (!existsSync(dbPath)) {
    io.log(`No database at ${dbPath} — nothing recorded yet.`);
    return 0;
  }

  const storage = new SqliteStorage(dbPath);
  try {
    if (parsed.flags.rm !== undefined) {
      const ok = storage.deleteRun(parsed.flags.rm);
      if (!ok) {
        io.error(`graphmind runs: no run "${parsed.flags.rm}"`);
        return 1;
      }
      io.log(`Deleted run ${parsed.flags.rm}`);
      return 0;
    }

    if (parsed.flags.clear === true) {
      if (parsed.flags.yes !== true) {
        const count = storage.listRuns().length;
        io.error(`This deletes all ${count} run(s) in ${dbPath}. Re-run with --yes to confirm.`);
        return 1;
      }
      const result = storage.prune({ keepRuns: 0, keepDays: 0 });
      storage.vacuum();
      io.log(`Deleted ${result.runsDeleted} run(s) and ${result.eventsDeleted} event(s).`);
      return 0;
    }

    if (parsed.flags.prune === true) {
      const keepRuns = parsed.flags.keep ?? DEFAULT_RETENTION.keepRuns;
      const keepDays = parsed.flags.days ?? DEFAULT_RETENTION.keepDays;
      const result = storage.prune({ keepRuns, keepDays });
      storage.vacuum();
      io.log(
        `Kept the ${keepRuns} newest run(s) from the last ${keepDays} day(s); ` +
          `deleted ${result.runsDeleted} run(s) and ${result.eventsDeleted} event(s).`,
      );
      return 0;
    }

    const runs = storage.listRuns();
    if (runs.length === 0) {
      io.log(`No runs stored in ${dbPath}.`);
      return 0;
    }
    const now = Date.now();
    const limit = parsed.flags.keep ?? 25;
    io.log(`${runs.length} run(s) in ${dbPath}\n`);
    io.log(`  ${'RUN'.padEnd(24)} ${'APP'.padEnd(20)} ${'STATUS'.padEnd(9)} ${'EVENTS'.padStart(7)}  STARTED`);
    for (const run of runs.slice(0, limit)) {
      const status = run.status === 'error' ? `${run.status} !` : run.status;
      io.log(
        `  ${run.id.slice(0, 24).padEnd(24)} ${run.app.slice(0, 20).padEnd(20)} ` +
          `${status.padEnd(9)} ${String(run.eventCount).padStart(7)}  ${ago(run.startedAt, now)}` +
          (run.source === 'live' ? '' : `  (${run.source})`),
      );
    }
    if (runs.length > limit) io.log(`  ... and ${runs.length - limit} more (--keep <n> to show more)`);
    io.log('\nOpen one:   graphmind   then click it, or http://127.0.0.1:4747/#/run/<id>');
    io.log('Tidy up:    graphmind runs --prune');
    return 0;
  } finally {
    storage.close();
  }
}
