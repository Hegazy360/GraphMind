/**
 * `graphmind record` sanitises exports by default. Through the real server
 * and the real command: a run whose payloads carry secret-shaped keys at
 * several depths, exported four ways — NDJSON and HTML, each with the default
 * and with `--no-redact-secrets` — plus the one summary line the command
 * prints about what it did.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvelopeJson } from '@graphmind-ai/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFlags, type CliFlags, type ParsedCli } from '../src/args.js';
import { runRecord } from '../src/commands/record.js';
import { REDACTED } from '../src/redact-secrets.js';
import { FakeApp, startTestServer, waitUntil, type TestServer } from './helpers.js';

function parsedCli(positionals: string[], flags: Partial<CliFlags>): ParsedCli {
  return { command: 'record', positionals, flags: { ...defaultFlags(), ...flags }, errors: [] };
}

const SECRETS = {
  apiKey: 'sk-live-APIKEY-4f1e',
  auth: 'Bearer AUTH-9a7b',
  token: 'TOKEN-1c2d',
  camel: 'ACCESSTOKEN-camel-77',
  password: 'PASSWORD-3e4f',
  nestedSecret: 'SECRET-in-array-5a6b',
} as const;
/** Values that must SURVIVE: not under a secret-shaped key. */
const KEEP = {
  prompt: 'my password is hunter2', // a value, not a key
  maxTokens: 4096,
  tokenizer: 'cl100k',
  vault: 'VAULT-arg-visible',
} as const;

const RUN = 'run-record-redact';

async function ingestRun(): Promise<TestServer> {
  const ts = await startTestServer();
  const app = await FakeApp.connect(ts.port, { app: 'redact-app' });
  app.send('run.started', RUN, {
    app: 'redact-app',
    sdk: { name: 'ai', version: '7.0.0' },
    meta: { api_key: SECRETS.apiKey, env: 'test' },
  });
  app.send('node.started', RUN, {
    nodeId: 'llm:step',
    kind: 'llm',
    name: 'step',
    instanceId: 'l1',
    input: {
      messages: [{ role: 'user', content: KEEP.prompt }],
      headers: { Authorization: SECRETS.auth, 'content-type': 'application/json' },
      max_tokens: KEEP.maxTokens,
      tokenizer: KEEP.tokenizer,
    },
  });
  app.send('node.finished', RUN, {
    nodeId: 'llm:step',
    instanceId: 'l1',
    output: { text: 'ok', accessToken: SECRETS.camel },
    durationMs: 12,
    status: 'ok',
  });
  app.send('node.started', RUN, {
    nodeId: 'tool:fetch',
    kind: 'tool',
    name: 'fetch',
    instanceId: 't1',
    input: { vault: KEEP.vault, token: SECRETS.token },
  });
  app.send('node.finished', RUN, {
    nodeId: 'tool:fetch',
    instanceId: 't1',
    output: {
      rows: [
        { id: 1, password: SECRETS.password },
        { id: 2, creds: [{ SECRET: SECRETS.nestedSecret }] },
      ],
    },
    durationMs: 3,
    status: 'ok',
  });
  app.send('run.finished', RUN, { status: 'ok' });
  await waitUntil(() => ts.server.storage.listEvents(RUN).total === 6, 'events persisted');
  await app.close();
  await ts.server.close(); // flush the WAL; the db file stays on disk
  return ts;
}

function fakeViewerDist(dir: string): string {
  const viewerDist = join(dir, 'viewer-dist');
  mkdirSync(join(viewerDist, 'assets'), { recursive: true });
  writeFileSync(
    join(viewerDist, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/index-x.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-x.css"></head><body></body></html>',
  );
  writeFileSync(join(viewerDist, 'assets', 'index-x.js'), 'globalThis.__BOOTED__ = 1;');
  writeFileSync(join(viewerDist, 'assets', 'index-x.css'), 'body{}');
  return viewerDist;
}

const logs: string[] = [];
const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  logs.push(args.map(String).join(' '));
});
afterEach(() => {
  logs.length = 0;
});
// Restore at the very end so other suites in the worker are unaffected.
process.once('beforeExit', () => spy.mockRestore());

const allSecrets = Object.values(SECRETS);
const allKept = Object.values(KEEP).map(String);

describe('graphmind record: --redact-secrets (default)', () => {
  it('NDJSON: every secret-shaped key is replaced, look-alikes and values survive, the summary line is printed', async () => {
    const ts = await ingestRun();
    try {
      const outPath = join(ts.dir, 'out.ndjson');
      expect(await runRecord(parsedCli([RUN], { db: ts.dbPath, out: outPath }))).toBe(0);
      const text = readFileSync(outPath, 'utf8');
      for (const s of allSecrets) expect(text, s).not.toContain(s);
      for (const k of allKept) expect(text, k).toContain(k);
      expect(text).toContain(REDACTED);

      const lines = text.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(6);
      const parsed = lines.map((line) => {
        const r = parseEnvelopeJson(line);
        expect(r.kind).toBe('ok');
        return r.kind === 'ok' ? r.envelope : undefined;
      });
      expect(parsed[0]?.payload).toMatchObject({ meta: { api_key: REDACTED, env: 'test' } });
      expect(parsed[1]?.payload).toMatchObject({
        input: {
          headers: { Authorization: REDACTED, 'content-type': 'application/json' },
          max_tokens: 4096,
          tokenizer: 'cl100k',
        },
      });
      expect(parsed[2]?.payload).toMatchObject({ output: { text: 'ok', accessToken: REDACTED } });
      expect(parsed[3]?.payload).toMatchObject({ input: { vault: KEEP.vault, token: REDACTED } });
      expect(parsed[4]?.payload).toMatchObject({
        output: { rows: [{ id: 1, password: REDACTED }, { id: 2, creds: [{ SECRET: REDACTED }] }] },
      });
      // 6 values under 6 distinct spellings: api_key, Authorization, accessToken, token, password, SECRET
      expect(logs).toContain('redacted 6 values under 6 distinct keys (--no-redact-secrets keeps them)');
    } finally {
      await ts.cleanup();
    }
  });

  it('--no-redact-secrets keeps every value and says so', async () => {
    const ts = await ingestRun();
    try {
      const outPath = join(ts.dir, 'raw.ndjson');
      expect(await runRecord(parsedCli([RUN], { db: ts.dbPath, out: outPath, redactSecrets: false }))).toBe(0);
      const text = readFileSync(outPath, 'utf8');
      for (const s of allSecrets) expect(text, s).toContain(s);
      expect(text).not.toContain(REDACTED);
      expect(logs.some((l) => l.startsWith('secrets NOT redacted (--no-redact-secrets)'))).toBe(true);
      expect(logs.some((l) => l.startsWith('redacted '))).toBe(false);
    } finally {
      await ts.cleanup();
    }
  });

  it('--html: same rule, same counts, default on; --no-redact-secrets keeps them', async () => {
    const ts = await ingestRun();
    const viewerDist = fakeViewerDist(ts.dir);
    const prev = process.env['GRAPHMIND_VIEWER_DIST'];
    process.env['GRAPHMIND_VIEWER_DIST'] = viewerDist;
    try {
      const htmlPath = join(ts.dir, 'out.html');
      expect(await runRecord(parsedCli([RUN], { db: ts.dbPath, out: htmlPath, html: true }))).toBe(0);
      const html = readFileSync(htmlPath, 'utf8');
      expect(html).toContain('__GRAPHMIND_RUN__');
      for (const s of allSecrets) expect(html, s).not.toContain(s);
      for (const k of allKept) expect(html, k).toContain(k);
      expect(html).toContain(REDACTED);
      expect(logs).toContain('redacted 6 values under 6 distinct keys (--no-redact-secrets keeps them)');
      // The sharing warning still follows the summary.
      expect(logs.some((l) => l.includes('check before sharing'))).toBe(true);

      logs.length = 0;
      const rawPath = join(ts.dir, 'raw.html');
      expect(
        await runRecord(parsedCli([RUN], { db: ts.dbPath, out: rawPath, html: true, redactSecrets: false })),
      ).toBe(0);
      const raw = readFileSync(rawPath, 'utf8');
      for (const s of allSecrets) expect(raw, s).toContain(s);
      expect(raw).not.toContain(REDACTED);
      expect(logs.some((l) => l.startsWith('secrets NOT redacted'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['GRAPHMIND_VIEWER_DIST'];
      else process.env['GRAPHMIND_VIEWER_DIST'] = prev;
      await ts.cleanup();
    }
  });

  it('a run with nothing secret-shaped exports unchanged and reports zero', async () => {
    const ts = await startTestServer();
    const app = await FakeApp.connect(ts.port, { app: 'clean-app' });
    const runId = 'run-clean';
    app.send('run.started', runId, { app: 'clean-app', sdk: { name: 'ai', version: '7' } });
    app.send('node.started', runId, {
      nodeId: 'tool:x',
      kind: 'tool',
      name: 'x',
      instanceId: '1',
      input: { max_tokens: 5, tokens: [1, 2], text: 'token password secret' },
    });
    app.send('run.finished', runId, { status: 'ok' });
    await waitUntil(() => ts.server.storage.listEvents(runId).total === 3, 'persisted');
    const stored = ts.server.storage.listEvents(runId).events;
    await app.close();
    await ts.server.close();
    try {
      const outPath = join(ts.dir, 'clean.ndjson');
      expect(await runRecord(parsedCli([runId], { db: ts.dbPath, out: outPath }))).toBe(0);
      const lines = readFileSync(outPath, 'utf8').split('\n').filter((l) => l !== '');
      lines.forEach((line, i) => {
        expect(JSON.parse(line)).toMatchObject({ payload: stored[i]?.payload });
      });
      expect(logs).toContain('redacted 0 values under 0 distinct keys (--no-redact-secrets keeps them)');
    } finally {
      await ts.cleanup();
    }
  });
});

// ── Adversarial verification (W7) ────────────────────────────────────────────
// Reproduced through the real server + the real command before the fix: a
// mixed-case key the case-insensitive binding rule matches (`PassWord`,
// `APIkey`) and a secret nested deeper than the old 256-level walk cap were
// both exported in clear by default, with the summary claiming "redacted 0/1".
describe('verifier: graphmind record leaks nothing the binding rule covers', () => {
  it('NDJSON and HTML: mixed-case keys and a 400-level-deep secret are redacted by default', async () => {
    const ts = await startTestServer();
    const app = await FakeApp.connect(ts.port, { app: 'leak-app' });
    const runId = 'run-verifier-leaks';
    let deep: unknown = { api_key: 'DEEP-400-CANARY', keep: 'DEEP-KEEP-visible' };
    for (let i = 0; i < 400; i += 1) deep = { child: deep };
    app.send('run.started', runId, { app: 'leak-app', sdk: { name: 'ai', version: '7' } });
    app.send('node.started', runId, {
      nodeId: 'tool:cfg',
      kind: 'tool',
      name: 'cfg',
      instanceId: '1',
      input: { PassWord: 'MIXED-PassWord-CANARY', APIkey: 'MIXED-APIkey-CANARY', 'x-APIkey': 'MIXED-x-APIkey-CANARY', deep },
    });
    app.send('run.finished', runId, { status: 'ok' });
    await waitUntil(() => ts.server.storage.listEvents(runId).total === 3, 'persisted');
    await app.close();
    await ts.server.close();
    const viewerDist = fakeViewerDist(ts.dir);
    const prev = process.env['GRAPHMIND_VIEWER_DIST'];
    process.env['GRAPHMIND_VIEWER_DIST'] = viewerDist;
    const canaries = ['MIXED-PassWord-CANARY', 'MIXED-APIkey-CANARY', 'MIXED-x-APIkey-CANARY', 'DEEP-400-CANARY'];
    try {
      const ndjsonPath = join(ts.dir, 'leaks.ndjson');
      expect(await runRecord(parsedCli([runId], { db: ts.dbPath, out: ndjsonPath }))).toBe(0);
      const ndjson = readFileSync(ndjsonPath, 'utf8');
      for (const c of canaries) expect(ndjson, c).not.toContain(c);
      expect(ndjson).toContain('DEEP-KEEP-visible');
      expect(logs).toContain('redacted 4 values under 4 distinct keys (--no-redact-secrets keeps them)');

      logs.length = 0;
      const htmlPath = join(ts.dir, 'leaks.html');
      expect(await runRecord(parsedCli([runId], { db: ts.dbPath, out: htmlPath, html: true }))).toBe(0);
      const html = readFileSync(htmlPath, 'utf8');
      for (const c of canaries) expect(html, c).not.toContain(c);
      expect(html).toContain('DEEP-KEEP-visible');
      expect(logs).toContain('redacted 4 values under 4 distinct keys (--no-redact-secrets keeps them)');
    } finally {
      if (prev === undefined) delete process.env['GRAPHMIND_VIEWER_DIST'];
      else process.env['GRAPHMIND_VIEWER_DIST'] = prev;
      await ts.cleanup();
    }
  });
});
