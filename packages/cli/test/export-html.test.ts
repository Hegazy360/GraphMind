import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRunHtml } from '../src/export-html.js';
import type { StoredEvent } from '../src/storage.js';

let dir: string;
let viewerDist: string;

/** The shape Vite emits: an index.html naming the entry chunk by hash. */
const viewerIndexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>GraphMind</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-export-'));
  viewerDist = join(dir, 'viewer-dist');
  mkdirSync(join(viewerDist, 'assets'), { recursive: true });
  writeFileSync(join(viewerDist, 'index.html'), viewerIndexHtml);
  writeFileSync(join(viewerDist, 'assets', 'index-abc.js'), 'globalThis.__BOOTED__ = true;');
  writeFileSync(join(viewerDist, 'assets', 'index-abc.css'), 'body{background:#0a0a0c}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const event = (seq: number, type: string, payload: Record<string, unknown>): StoredEvent => ({
  runId: 'run-1',
  seq,
  ts: 1_700_000_000_000 + seq,
  type,
  nodeId: (payload['nodeId'] as string) ?? null,
  payload,
});

const build = (events: StoredEvent[]) =>
  buildRunHtml({
    runId: 'run-1',
    app: 'support-agent',
    events,
    schemaVersion: 1,
    viewerDist,
    version: '9.9.9',
  });

describe('buildRunHtml', () => {
  it('inlines the viewer and the run, with no external references', () => {
    const html = build([
      event(0, 'run.started', { app: 'support-agent', sdk: { name: 'test', version: '1' } }),
      event(1, 'node.started', { nodeId: 'tool:x', kind: 'tool', name: 'x', instanceId: 'i1' }),
    ]);
    expect(html).toContain('globalThis.__BOOTED__ = true;');
    expect(html).toContain('body{background:#0a0a0c}');
    expect(html).toContain('window.__GRAPHMIND_RUN__ =');
    // Self-contained: nothing to fetch at open time.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });

  it('carries every envelope with its wire shape', () => {
    const html = build([event(7, 'node.finished', { nodeId: 'tool:x', durationMs: 12, status: 'ok' })]);
    const json = html.slice(html.indexOf('__GRAPHMIND_RUN__ =') + 19, html.indexOf('</script>'));
    const envelopes = JSON.parse(json.trim().replace(/;$/, '')) as Record<string, unknown>[];
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ gm: 1, seq: 7, runId: 'run-1', type: 'node.finished' });
  });

  it('escapes payload content that would otherwise break out of the script tag', () => {
    const html = build([
      event(0, 'node.finished', {
        nodeId: 'tool:x',
        durationMs: 1,
        status: 'ok',
        output: '</script><img src=x onerror=alert(1)>',
      }),
    ]);
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('fails clearly when the viewer bundle is missing', () => {
    expect(() =>
      buildRunHtml({
        runId: 'r',
        app: 'a',
        events: [],
        schemaVersion: 1,
        viewerDist: join(dir, 'nope'),
        version: '1',
      }),
    ).toThrow(/cannot read the viewer entry point/);
  });

  // Regression: assets/ holds more than one .js file (the viewer lazily
  // imports a stress generator, so Vite emits `synthetic-<hash>.js` next to
  // `index-<hash>.js`). Picking "the first name ending in .js" inlined
  // whichever readdir happened to return first and exported a blank page.
  it('inlines the entry named by index.html, not whatever .js readdir finds first', () => {
    // Written first so it sorts before (and is returned before) the entry.
    writeFileSync(
      join(viewerDist, 'assets', 'aaa-decoy.js'),
      'globalThis.__WRONG_BUNDLE__ = true;',
    );
    writeFileSync(join(viewerDist, 'assets', 'synthetic-xyz.js'), 'globalThis.__LAZY__ = true;');
    const html = build([event(0, 'run.started', { app: 'a', sdk: { name: 't', version: '1' } })]);
    expect(html).toContain('globalThis.__BOOTED__ = true;');
    expect(html).not.toContain('__WRONG_BUNDLE__');
    expect(html).not.toContain('__LAZY__');
  });

  it('fails loudly when index.html names no module script', () => {
    writeFileSync(join(viewerDist, 'index.html'), '<!doctype html><html><body></body></html>');
    expect(() => build([])).toThrow(/names no <script type="module"/);
  });

  it('fails loudly when index.html names no stylesheet', () => {
    writeFileSync(
      join(viewerDist, 'index.html'),
      '<!doctype html><script type="module" src="/assets/index-abc.js"></script>',
    );
    expect(() => build([])).toThrow(/names no <link rel="stylesheet"/);
  });

  it('fails loudly when the file index.html names is absent', () => {
    rmSync(join(viewerDist, 'assets', 'index-abc.js'));
    expect(() => build([])).toThrow(/is not readable/);
  });

  it('refuses a viewer build that points at a remote asset', () => {
    writeFileSync(
      join(viewerDist, 'index.html'),
      '<script type="module" src="https://cdn.example/app.js"></script>' +
        '<link rel="stylesheet" href="/assets/index-abc.css">',
    );
    expect(() => build([])).toThrow(/remote asset/);
  });

  it('refuses a reference that escapes the viewer directory', () => {
    writeFileSync(join(dir, 'outside.js'), 'globalThis.__ESCAPED__ = true;');
    writeFileSync(
      join(viewerDist, 'index.html'),
      '<script type="module" src="../outside.js"></script>' +
        '<link rel="stylesheet" href="/assets/index-abc.css">',
    );
    expect(() => build([])).toThrow(/escapes/);
  });
});
