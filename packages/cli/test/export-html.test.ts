import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRunHtml } from '../src/export-html.js';
import type { StoredEvent } from '../src/storage.js';

let dir: string;
let viewerDist: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-export-'));
  viewerDist = join(dir, 'viewer-dist');
  mkdirSync(join(viewerDist, 'assets'), { recursive: true });
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
    ).toThrow();
  });
});
