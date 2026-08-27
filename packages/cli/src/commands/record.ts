/**
 * `graphmind record <runId> [--out <file>]` — export a persisted run's
 * envelope stream from storage to NDJSON (one wire envelope per line, the
 * same shape `graphmind demo` replays and `WS /ingest` accepts).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedCli } from '../args.js';
import { buildRunHtml } from '../export-html.js';
import { resolveDbPath, resolveViewerDist } from '../paths.js';
import { SqliteStorage } from '../sqlite-storage.js';
import { recordTelemetry } from '../telemetry.js';
import { VERSION } from '../version.js';

function safeFileName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '-');
}

export async function runRecord(parsed: ParsedCli): Promise<number> {
  recordTelemetry('record');

  const runId = parsed.positionals[0];
  if (runId === undefined || runId === '') {
    console.error('usage: graphmind record <runId> [--out <file>]');
    return 1;
  }
  if (parsed.positionals.length > 1) {
    console.error(`unexpected argument "${parsed.positionals[1]}"`);
    return 1;
  }

  const dbPath = resolveDbPath(parsed.flags.db, process.env as Record<string, string | undefined>);
  if (!existsSync(dbPath)) {
    console.error(`graphmind record: no database at ${dbPath} — has a server run yet?`);
    return 1;
  }

  const storage = new SqliteStorage(dbPath);
  try {
    const run = storage.getRun(runId);
    if (run === undefined) {
      console.error(`graphmind record: run "${runId}" not found in ${dbPath}`);
      const known = storage.listRuns().slice(0, 10);
      if (known.length > 0) {
        console.error('recent runs:');
        for (const r of known) console.error(`  ${r.id}  (${r.app}, ${r.status}, ${r.eventCount} events)`);
      }
      return 1;
    }
    const page = storage.listEvents(runId);

    if (parsed.flags.html) {
      const viewerDist = resolveViewerDist(undefined);
      if (!existsSync(viewerDist)) {
        console.error(
          `graphmind record --html: the built viewer is missing at ${viewerDist}. ` +
            'Install the published package (npx graphmind-ai) or run `pnpm build:viewer`.',
        );
        return 1;
      }
      const htmlPath = resolve(parsed.flags.out ?? `graphmind-run-${safeFileName(runId)}.html`);
      let html: string;
      try {
        html = buildRunHtml({
          runId,
          app: run.app,
          events: page.events,
          schemaVersion: run.schemaVersion,
          viewerDist,
          version: VERSION,
        });
      } catch (error) {
        console.error(
          `graphmind record --html: could not read the viewer bundle (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return 1;
      }
      writeFileSync(htmlPath, html);
      const kb = Math.round(Buffer.byteLength(html) / 1024);
      console.log(`exported run ${runId} (${page.events.length} events) → ${htmlPath} (${kb} KB)`);
      console.log('Open it in any browser, or send it to someone — it needs no server.');
      console.log('It contains this run\'s prompts, tool inputs and outputs: check before sharing.');
      return 0;
    }

    const outPath = resolve(parsed.flags.out ?? `graphmind-run-${safeFileName(runId)}.ndjson`);
    const ndjson =
      page.events
        .map((event) =>
          JSON.stringify({
            gm: run.schemaVersion,
            seq: event.seq,
            ts: event.ts,
            runId: event.runId,
            type: event.type,
            payload: event.payload,
          }),
        )
        .join('\n') + '\n';
    writeFileSync(outPath, ndjson);
    console.log(`recorded ${page.events.length} events of run ${runId} → ${outPath}`);
    return 0;
  } finally {
    storage.close();
  }
}
