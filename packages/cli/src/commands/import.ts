/**
 * `graphmind import <file>` — load an OTel/OpenInference trace export as a
 * run (best-effort, labeled: the run is stored with source "import" so the
 * viewer applies its imported treatment). The conversion itself lives in
 * ../import/; this command adds file I/O, run-id generation, storage
 * insertion, and the printed summary + deep link.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import type { ParsedCli } from '../args.js';
import { convertTraceText, ImportError } from '../import/index.js';
import { DEFAULT_PORT, resolveDbPath } from '../paths.js';
import { SqliteStorage } from '../sqlite-storage.js';
import { recordTelemetry } from '../telemetry.js';
import { VERSION } from '../version.js';

/** Console-shaped sink so tests can capture output. */
export interface ImportIo {
  log(message: string): void;
  error(message: string): void;
}

export async function runImport(parsed: ParsedCli, io: ImportIo = console): Promise<number> {
  recordTelemetry('import');

  const file = parsed.positionals[0];
  if (file === undefined) {
    io.error('graphmind import: missing file argument');
    io.error('Usage: graphmind import <trace-file.json> [--db <path>]');
    return 1;
  }
  if (parsed.positionals.length > 1) {
    io.error(`graphmind import: unexpected argument "${parsed.positionals[1]}"`);
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.error(
      `graphmind import: cannot read ${file} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return 1;
  }

  const runId = `imp_${randomBytes(6).toString('hex')}`;
  let result;
  try {
    result = convertTraceText(text, {
      runId,
      fileName: basename(file),
      sdk: { name: 'graphmind-import', version: VERSION },
    });
  } catch (error) {
    if (error instanceof ImportError) {
      io.error(`graphmind import: ${file}: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const { envelopes, summary } = result;
  const dbPath = resolveDbPath(parsed.flags.db);
  const storage = new SqliteStorage(dbPath);
  try {
    storage.ensureRun({
      id: runId,
      app: summary.app,
      startedAt: summary.startedAt,
      schemaVersion: PROTOCOL_VERSION,
      source: 'import',
    });
    for (const envelope of envelopes) {
      const nodeId = (envelope.payload as { nodeId?: unknown }).nodeId;
      storage.insertEvent({
        runId,
        seq: envelope.seq,
        ts: envelope.ts,
        type: envelope.type,
        nodeId: typeof nodeId === 'string' ? nodeId : null,
        payload: envelope.payload,
      });
    }
    storage.markRunStarted(runId, summary.app, summary.startedAt);
    storage.markRunFinished(runId, summary.status, summary.finishedAt);
  } finally {
    storage.close();
  }

  const port = parsed.flags.port ?? DEFAULT_PORT;
  const kinds = Object.entries(summary.nodeCounts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ');
  io.log(`Imported ${basename(file)} as run ${runId} (best-effort, source: import)`);
  io.log(`  format   ${summary.format}`);
  io.log(`  app      ${summary.app}`);
  io.log(`  nodes    ${summary.nodeCount} (${kinds})`);
  io.log(`  errors   ${summary.errorCount}`);
  io.log(`  events   ${summary.eventCount}`);
  io.log(`  duration ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.skippedCount > 0) {
    const shown = summary.skippedReasons.slice(0, 5).join(', ');
    const more = summary.skippedReasons.length > 5 ? ', ...' : '';
    io.log(`  skipped  ${summary.skippedCount} unrecognized span(s): ${shown}${more}`);
  }
  io.log(`  db       ${dbPath}`);
  io.log(`  open     http://127.0.0.1:${port}/#/run/${runId}`);
  io.log('Start (or refresh) the viewer with `graphmind` to see the imported run.');
  return 0;
}
