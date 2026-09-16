/**
 * The five-surface proof for the kill switches.
 *
 * A real @graphmind-ai/client session (the CLI tests alias it to source)
 * with GRAPHMIND_HIDE_INPUTS + GRAPHMIND_HIDE_OUTPUTS streams a run into a
 * real server. Then every place a payload could reappear is read back and
 * asserted to hold ONLY the placeholder:
 *
 *   1. the WebSocket frames a viewer receives on /ws/ui (replay + tail);
 *   2. the SQLite rows — read as raw bytes, -wal included;
 *   3. `graphmind record` NDJSON;
 *   4. `graphmind record --html`;
 *   5. the read-only MCP server's tool responses (get_run / get_node /
 *      find_errors over the same DB).
 *
 * Surfaces 3 and 4 are exported with `--no-redact-secrets` on purpose: the
 * point is that the client hid the values before they ever left the process,
 * not that the export layer caught them. Names, kinds, timings and token
 * counts must survive on every surface, otherwise the debugger is useless.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, REDACTED } from '@graphmind-ai/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultFlags, type CliFlags, type ParsedCli } from '../src/args.js';
import { runRecord } from '../src/commands/record.js';
import { findErrors, getNode, getRun } from '../src/mcp/tools.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { FakeUI, startTestServer, waitUntil, type TestServer } from './helpers.js';
import type { UiServerMessage } from '../src/ui-protocol.js';

const IN = 'INPUT-CANARY-5f8c2a';
const OUT = 'OUTPUT-CANARY-1d3e9b';
const TOK = 'TOKEN-CANARY-7ab4c0';
const ERR = 'ERROR-CANARY-visible-by-design';

let ts: TestServer;
let runId: string;
let uiFrames: UiServerMessage[];

function parsedCli(positionals: string[], flags: Partial<CliFlags>): ParsedCli {
  return { command: 'record', positionals, flags: { ...defaultFlags(), ...flags }, errors: [] };
}

function bytesOf(path: string): string {
  return existsSync(path) ? readFileSync(path, 'latin1') : '';
}

beforeAll(async () => {
  ts = await startTestServer();
  const session = createSession({
    url: `ws://127.0.0.1:${ts.port}/ingest`,
    appName: 'surfaces-app',
    env: { GRAPHMIND_HIDE_INPUTS: '1', GRAPHMIND_HIDE_OUTPUTS: 'true' },
    logger: () => {},
  });
  expect(await session.ready({ timeoutMs: 5000 })).toBe(true);

  // A viewer that is tailing BEFORE the run starts sees the live frames.
  const ui = await FakeUI.connect(ts.port);

  runId = await session.run('surfaces', async (ctx) => {
    session.emit('node.started', {
      nodeId: 'agent:surfaces',
      kind: 'agent',
      name: 'surfaces',
      instanceId: ctx.runId,
      input: { prompt: IN },
    });
    session.emit('node.started', {
      nodeId: 'llm:step',
      parentId: 'agent:surfaces',
      kind: 'llm',
      name: 'step',
      instanceId: 'l1',
      input: { messages: [{ role: 'user', content: IN }] },
    });
    session.emit('node.token', {
      nodeId: 'llm:step',
      deltas: [
        { t: 'text', v: TOK },
        { t: 'text', v: `${TOK}-2` },
      ],
    });
    session.emit('node.finished', {
      nodeId: 'llm:step',
      instanceId: 'l1',
      output: { text: OUT },
      usage: { inputTokens: 21, outputTokens: 8 },
      durationMs: 123.456,
      status: 'ok',
    });
    session.emit('node.started', {
      nodeId: 'tool:lookup',
      parentId: 'agent:surfaces',
      kind: 'tool',
      name: 'lookup',
      instanceId: 't1',
      input: { q: IN },
    });
    session.emit('node.error', {
      nodeId: 'tool:lookup',
      instanceId: 't1',
      error: { name: 'LookupError', message: ERR },
    });
    session.emit('node.finished', {
      nodeId: 'tool:lookup',
      instanceId: 't1',
      output: { partial: OUT },
      durationMs: 45,
      status: 'error',
    });
    session.emit('node.finished', {
      nodeId: 'agent:surfaces',
      instanceId: ctx.runId,
      output: OUT,
      durationMs: 200,
      status: 'ok',
    });
    return ctx.runId;
  });
  await waitUntil(() => ts.server.storage.listEvents(runId).total === 10, 'events persisted', 5000);
  await session.dispose();

  // Surface 1a: the live tail. Subscribe now for replay as well (1b).
  ui.subscribe(runId);
  await ui.next((m) => m.type === 'replay.end', 'replay.end');
  uiFrames = ui.received.drain();
  await ui.close();
}, 20_000);

afterAll(async () => {
  await ts?.cleanup();
});

describe('surface 1: WebSocket frames on /ws/ui', () => {
  it('carry only the placeholder, with names, kinds, usage and delta counts intact', () => {
    const text = JSON.stringify(uiFrames);
    expect(text).not.toContain(IN);
    expect(text).not.toContain(OUT);
    expect(text).not.toContain(TOK);
    expect(text).toContain(ERR); // node.error is not redacted (documented)
    const events = uiFrames.filter((m): m is Extract<UiServerMessage, { type: 'event' }> => m.type === 'event');
    const started = events.filter((e) => e.envelope.type === 'node.started').map((e) => e.envelope.payload as Record<string, unknown>);
    expect(started.map((p) => [p['kind'], p['name'], p['input']])).toEqual([
      ['agent', 'surfaces', REDACTED],
      ['llm', 'step', REDACTED],
      ['tool', 'lookup', REDACTED],
    ]);
    const finished = events.filter((e) => e.envelope.type === 'node.finished').map((e) => e.envelope.payload as Record<string, unknown>);
    expect(finished.map((p) => p['output'])).toEqual([REDACTED, REDACTED, REDACTED]);
    expect(finished[0]).toMatchObject({ usage: { inputTokens: 21, outputTokens: 8 }, durationMs: 123.46 });
    const tokens = events.filter((e) => e.envelope.type === 'node.token').map((e) => e.envelope.payload as Record<string, unknown>);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.['deltas']).toEqual([
      { t: 'text', v: '', chars: TOK.length },
      { t: 'text', v: '', chars: TOK.length + 2 },
    ]);
    expect(tokens[0]?.['redaction']).toEqual({ count: 2, keys: ['deltas'] });
  });
});

describe('surface 2: the SQLite database, as raw bytes', () => {
  it('holds no input, output or token text anywhere in the db or its WAL', async () => {
    await ts.server.close(); // checkpoint + close so the bytes on disk are complete
    const raw = bytesOf(ts.dbPath) + bytesOf(`${ts.dbPath}-wal`) + bytesOf(`${ts.dbPath}-shm`);
    expect(raw.length).toBeGreaterThan(1000);
    expect(raw).not.toContain(IN);
    expect(raw).not.toContain(OUT);
    expect(raw).not.toContain(TOK);
    expect(raw).toContain(REDACTED);
    expect(raw).toContain('lookup'); // names still there
  });
});

describe('surfaces 3 and 4: graphmind record, exported WITHOUT the export-layer redaction', () => {
  it('NDJSON holds only the placeholder', async () => {
    const out = join(ts.dir, 'surfaces.ndjson');
    expect(await runRecord(parsedCli([runId], { db: ts.dbPath, out, redactSecrets: false }))).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(10);
    expect(text).not.toContain(IN);
    expect(text).not.toContain(OUT);
    expect(text).not.toContain(TOK);
    expect(text).toContain(REDACTED);
    expect(text).toContain('"usage":{"inputTokens":21,"outputTokens":8}');
  });

  it('HTML holds only the placeholder', async () => {
    const viewerDist = join(ts.dir, 'viewer-dist');
    mkdirSync(join(viewerDist, 'assets'), { recursive: true });
    writeFileSync(
      join(viewerDist, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/assets/i.js"></script>' +
        '<link rel="stylesheet" href="/assets/i.css"></head><body></body></html>',
    );
    writeFileSync(join(viewerDist, 'assets', 'i.js'), '1;');
    writeFileSync(join(viewerDist, 'assets', 'i.css'), 'body{}');
    const prev = process.env['GRAPHMIND_VIEWER_DIST'];
    process.env['GRAPHMIND_VIEWER_DIST'] = viewerDist;
    try {
      const out = join(ts.dir, 'surfaces.html');
      expect(await runRecord(parsedCli([runId], { db: ts.dbPath, out, html: true, redactSecrets: false }))).toBe(0);
      const html = readFileSync(out, 'utf8');
      expect(html).toContain('__GRAPHMIND_RUN__');
      expect(html).not.toContain(IN);
      expect(html).not.toContain(OUT);
      expect(html).not.toContain(TOK);
      expect(html).toContain(REDACTED);
    } finally {
      if (prev === undefined) delete process.env['GRAPHMIND_VIEWER_DIST'];
      else process.env['GRAPHMIND_VIEWER_DIST'] = prev;
    }
  });
});

describe('surface 5: the read-only MCP server tools over the same database', () => {
  it('get_run / get_node / find_errors answer with the placeholder and keep the structure', () => {
    const storage = new SqliteStorage(ts.dbPath);
    try {
      const ctx = { storage, viewerBaseUrl: 'http://127.0.0.1:4747' };
      const run = getRun(ctx, { runId });
      const node = getNode(ctx, { runId, nodeId: 'llm:step' });
      const tool = getNode(ctx, { runId, nodeId: 'tool:lookup' });
      const errors = findErrors(ctx, {});
      const text = JSON.stringify([run, node, tool, errors]);
      expect(text).not.toContain(IN);
      expect(text).not.toContain(OUT);
      expect(text).not.toContain(TOK);
      expect(run.nodes.map((n) => [n.kind, n.name, n.status])).toEqual([
        ['agent', 'surfaces', 'ok'],
        ['llm', 'step', 'ok'],
        ['tool', 'lookup', 'error'],
      ]);
      expect(node.instances[0]).toMatchObject({
        input: REDACTED,
        output: REDACTED,
        usage: { inputTokens: 21, outputTokens: 8 },
        durationMs: 123.46,
        status: 'ok',
      });
      expect(tool.instances[0]).toMatchObject({ input: REDACTED, output: REDACTED, error: { message: ERR } });
      expect(errors.errors[0]).toMatchObject({ nodeId: 'tool:lookup', message: ERR });
    } finally {
      storage.close();
    }
  });
});
