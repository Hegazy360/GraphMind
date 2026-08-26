/**
 * Trace import tests: golden-file conversions (exact synthetic envelope
 * sequences for both supported formats), error-span mapping, malformed-file
 * failures, and the full `graphmind import` command against a real server's
 * database (imported runs visible via GET /api/runs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvelope } from '@graphmind/schema';
import { describe, expect, it } from 'vitest';
import type { ParsedCli } from '../src/args.js';
import { runImport, type ImportIo } from '../src/commands/import.js';
import { convertTraceText, ImportError } from '../src/import/index.js';
import { fetchJson, startTestServer } from './helpers.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixturePath = (name: string): string => join(fixturesDir, name);
const fixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');

const goldenOptions = (fileName: string) => ({
  runId: 'run_golden',
  fileName,
  sdk: { name: 'graphmind-import', version: 'test' },
});

function parsedCli(positionals: string[], db?: string): ParsedCli {
  return {
    command: 'import',
    positionals,
    flags: {
      port: undefined,
      db,
      open: true,
      help: false,
      version: false,
    } as ParsedCli['flags'],
    errors: [],
  };
}

function captureIo(): ImportIo & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
  };
}

describe('convertTraceText — golden sequences', () => {
  it('converts an OTLP/JSON AI SDK telemetry export to the exact envelope sequence', () => {
    const { envelopes, summary } = convertTraceText(
      fixture('otlp-ai-sdk.json'),
      goldenOptions('otlp-ai-sdk.json'),
    );
    expect(envelopes).toEqual(JSON.parse(fixture('otlp-ai-sdk.expected.json')));
    for (const envelope of envelopes) {
      expect(parseEnvelope(envelope).kind).toBe('ok');
    }
    expect(summary).toMatchObject({
      runId: 'run_golden',
      app: 'flight-booker',
      format: 'otlp/ai-sdk',
      status: 'ok',
      nodeCount: 4,
      nodeCounts: { agent: 1, llm: 2, tool: 1 },
      errorCount: 0,
      eventCount: 10,
      skippedCount: 1,
      skippedReasons: ['span "POST"'],
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_004_000,
      durationMs: 4000,
    });
  });

  it('converts an OpenInference span export to the exact envelope sequence', () => {
    const { envelopes, summary } = convertTraceText(
      fixture('openinference.json'),
      goldenOptions('openinference.json'),
    );
    expect(envelopes).toEqual(JSON.parse(fixture('openinference.expected.json')));
    for (const envelope of envelopes) {
      expect(parseEnvelope(envelope).kind).toBe('ok');
    }
    expect(summary).toMatchObject({
      app: 'weather-agent',
      format: 'spans/openinference',
      status: 'ok',
      nodeCount: 4,
      nodeCounts: { agent: 1, llm: 1, tool: 1, custom: 1 },
      errorCount: 0,
      skippedCount: 0,
      durationMs: 3000,
    });
  });

  it('accepts the same spans as JSONL (one span object per line)', () => {
    const spans = JSON.parse(fixture('openinference.json')).spans as unknown[];
    const jsonl = spans.map((span) => JSON.stringify(span)).join('\n');
    const { envelopes, summary } = convertTraceText(jsonl, goldenOptions('openinference.json'));
    expect(envelopes).toEqual(JSON.parse(fixture('openinference.expected.json')));
    expect(summary.nodeCount).toBe(4);
  });
});

describe('convertTraceText — error spans', () => {
  it('maps errored spans to node.error + node.finished(error) and errors the run', () => {
    const { envelopes, summary } = convertTraceText(
      fixture('openinference-error.json'),
      goldenOptions('openinference-error.json'),
    );
    for (const envelope of envelopes) {
      expect(parseEnvelope(envelope).kind).toBe('ok');
    }
    expect(envelopes.map((e) => e.type)).toEqual([
      'run.started',
      'node.started', // agent
      'node.started', // tool
      'node.error', // tool (deeper span finishes first)
      'node.finished',
      'node.error', // agent
      'node.finished',
      'run.finished',
    ]);

    const toolError = envelopes[3];
    expect(toolError?.payload).toEqual({
      nodeId: 'tool:get_weather',
      error: {
        name: 'ValueError',
        message: 'city not found: Atlantis',
        stack: expect.stringContaining('Traceback'),
      },
    });
    expect(envelopes[4]?.payload).toMatchObject({
      nodeId: 'tool:get_weather',
      status: 'error',
      instanceId: 's_tool_err',
    });
    expect(envelopes[5]?.payload).toMatchObject({
      nodeId: 'agent:weather-agent',
      error: { name: 'Error', message: 'tool get_weather failed' },
    });
    // A single root span decides the run status; its error rides along.
    expect(envelopes.at(-1)?.payload).toEqual({
      status: 'error',
      error: { name: 'Error', message: 'tool get_weather failed' },
    });
    expect(summary.status).toBe('error');
    expect(summary.errorCount).toBe(2);
  });
});

describe('convertTraceText — unparseable files', () => {
  it('rejects JSON that is neither OTLP nor a span list, naming the shape', () => {
    expect(() =>
      convertTraceText(fixture('malformed.json'), goldenOptions('malformed.json')),
    ).toThrow(ImportError);
    expect(() =>
      convertTraceText(fixture('malformed.json'), goldenOptions('malformed.json')),
    ).toThrow(/unrecognized trace format: .*keys \[hello, spans, note\]/);
  });

  it('rejects non-JSON text', () => {
    expect(() => convertTraceText('this is not json {', goldenOptions('x.txt'))).toThrow(
      /not valid JSON/,
    );
  });

  it('rejects span lists with no recognizable AI spans, listing what was seen', () => {
    const spans = JSON.stringify([
      { name: 'db.query', start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T00:00:01Z' },
    ]);
    expect(() => convertTraceText(spans, goldenOptions('spans.json'))).toThrow(
      /no recognized AI spans in 1 span\(s\) — saw span "db\.query"/,
    );
  });

  it('rejects OTLP files with zero spans', () => {
    expect(() =>
      convertTraceText(JSON.stringify({ resourceSpans: [] }), goldenOptions('empty.json')),
    ).toThrow(/contains no spans/);
  });
});

describe('graphmind import (command)', () => {
  it('imports into the server DB; the run is visible via GET /api/runs with source "import"', async () => {
    const ts = await startTestServer();
    try {
      const io = captureIo();
      const code = await runImport(parsedCli([fixturePath('otlp-ai-sdk.json')], ts.dbPath), io);
      expect(io.errors).toEqual([]);
      expect(code).toBe(0);

      const output = io.logs.join('\n');
      const runId = /as run (imp_[0-9a-f]+)/.exec(output)?.[1];
      expect(runId).toBeDefined();
      expect(output).toContain(`/#/run/${runId}`);
      expect(output).toContain('nodes    4');
      expect(output).toContain('errors   0');
      expect(output).toContain('duration 4.0s');
      expect(output).toContain('skipped  1 unrecognized span(s): span "POST"');

      const runs = await fetchJson(ts.port, '/api/runs');
      expect(runs.status).toBe(200);
      const run = (runs.body.runs as Record<string, unknown>[]).find((r) => r['id'] === runId);
      expect(run).toMatchObject({
        id: runId,
        app: 'flight-booker',
        source: 'import',
        status: 'ok',
        live: false,
        eventCount: 10,
        errorCount: 0,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_004_000,
      });

      const events = await fetchJson(ts.port, `/api/runs/${runId}/events`);
      expect(events.status).toBe(200);
      expect((events.body.events as unknown[]).length).toBe(10);
    } finally {
      await ts.cleanup();
    }
  });

  it('records error runs (status + errorCount) from error-span fixtures', async () => {
    const ts = await startTestServer();
    try {
      const io = captureIo();
      const code = await runImport(
        parsedCli([fixturePath('openinference-error.json')], ts.dbPath),
        io,
      );
      expect(code).toBe(0);
      const runId = /as run (imp_[0-9a-f]+)/.exec(io.logs.join('\n'))?.[1];
      const runs = await fetchJson(ts.port, '/api/runs');
      const run = (runs.body.runs as Record<string, unknown>[]).find((r) => r['id'] === runId);
      expect(run).toMatchObject({ source: 'import', status: 'error', errorCount: 2 });
    } finally {
      await ts.cleanup();
    }
  });

  it('fails cleanly on a malformed file', async () => {
    const io = captureIo();
    const code = await runImport(parsedCli([fixturePath('malformed.json')], ':memory:'), io);
    expect(code).toBe(1);
    expect(io.logs).toEqual([]);
    expect(io.errors.join('\n')).toMatch(/unrecognized trace format/);
  });

  it('fails cleanly on a missing file argument and on an unreadable file', async () => {
    const io = captureIo();
    expect(await runImport(parsedCli([], ':memory:'), io)).toBe(1);
    expect(io.errors[0]).toContain('missing file argument');

    const io2 = captureIo();
    expect(await runImport(parsedCli(['/nope/does-not-exist.json'], ':memory:'), io2)).toBe(1);
    expect(io2.errors[0]).toContain('cannot read /nope/does-not-exist.json');
  });
});
