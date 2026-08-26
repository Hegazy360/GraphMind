/**
 * `graphmind record`: ingest a run through the real server, export it to
 * NDJSON, and prove the bytes round-trip — every line parses as a schema
 * envelope and re-ingesting the file reproduces the run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvelopeJson } from '@graphmind-ai/schema';
import { describe, expect, it } from 'vitest';
import type { CliFlags, ParsedCli } from '../src/args.js';
import { runRecord } from '../src/commands/record.js';
import { FakeApp, startTestServer, waitUntil } from './helpers.js';

function parsedCli(positionals: string[], flags: Partial<CliFlags>): ParsedCli {
  return {
    command: 'record',
    positionals,
    flags: {
      port: undefined,
      db: undefined,
      open: true,
      help: false,
      version: false,
      live: false,
      out: undefined,
      install: false,
      write: false,
      ...flags,
    },
    errors: [],
  };
}

describe('graphmind record', () => {
  it('round-trips: ingest -> record -> re-import parses and reproduces the run', async () => {
    const ts = await startTestServer();
    const runId = 'run-record-rt';
    const app = await FakeApp.connect(ts.port, { app: 'recorder-app' });
    app.send('run.started', runId, {
      app: 'recorder-app',
      sdk: { name: 'ai', version: '7.0.0' },
    });
    app.send('node.started', runId, {
      nodeId: 'tool:frobnicate',
      kind: 'tool',
      name: 'frobnicate',
      instanceId: 'call-1',
      input: { level: 11 },
    });
    app.send('node.token', runId, {
      nodeId: 'tool:frobnicate',
      deltas: [{ t: 'text', v: 'frobnicating…' }],
    });
    app.send('node.finished', runId, {
      nodeId: 'tool:frobnicate',
      output: { done: true },
      durationMs: 12,
      status: 'ok',
    });
    app.send('run.finished', runId, { status: 'ok' });
    await waitUntil(
      () => ts.server.storage.listEvents(runId).total === 5,
      'events persisted',
    );
    const stored = ts.server.storage.listEvents(runId).events;
    await app.close();
    await ts.server.close(); // flush the WAL; the db file stays on disk

    const outPath = join(ts.dir, 'exported.ndjson');
    const code = await runRecord(parsedCli([runId], { db: ts.dbPath, out: outPath }));
    expect(code).toBe(0);

    // Every exported line is a valid wire envelope…
    const bytes = readFileSync(outPath, 'utf8');
    const lines = bytes.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBe(5);
    const envelopes = lines.map((line) => {
      const result = parseEnvelopeJson(line);
      expect(result.kind).toBe('ok');
      return result.kind === 'ok' ? result.envelope : undefined;
    });
    // …and matches what storage held (same seq/type/payload).
    envelopes.forEach((envelope, i) => {
      expect(envelope).toMatchObject({
        runId,
        seq: stored[i]?.seq,
        type: stored[i]?.type,
        payload: stored[i]?.payload,
      });
    });

    // Re-import: replay the exported bytes through a fresh server's ingest.
    const ts2 = await startTestServer();
    try {
      const app2 = await FakeApp.connect(ts2.port, { app: 'recorder-app' });
      for (const line of lines) app2.sendRaw(line);
      await waitUntil(
        () => ts2.server.storage.listEvents(runId).total === 5,
        're-imported events persisted',
      );
      const reimported = ts2.server.storage.getRun(runId);
      expect(reimported).toMatchObject({ status: 'ok', app: 'recorder-app' });
      await app2.close();
    } finally {
      await ts2.cleanup();
    }
  });

  it('fails cleanly for a missing run or missing database', async () => {
    const ts = await startTestServer();
    await ts.server.close();
    expect(await runRecord(parsedCli(['nope'], { db: ts.dbPath }))).toBe(1);
    expect(
      await runRecord(parsedCli(['nope'], { db: join(ts.dir, 'not-there.db') })),
    ).toBe(1);
    expect(await runRecord(parsedCli([], { db: ts.dbPath }))).toBe(1);
  });
});
