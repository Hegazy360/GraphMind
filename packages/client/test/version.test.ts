/**
 * `hello.versions.client` is this package's real version (it was a hard-coded
 * `0.1.0`). The constant is rewritten by scripts/set-version.mjs; this test
 * fails the moment it drifts from package.json.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_VERSION, createSession } from '../src/index.js';
import { FakeViewer } from './helpers/fake-viewer.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('client version', () => {
  it('CLIENT_VERSION equals package.json', () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
    expect(CLIENT_VERSION).not.toBe('0.1.0');
  });

  it('scripts/set-version.mjs knows how to rewrite it', () => {
    const script = readFileSync(new URL('../../../scripts/set-version.mjs', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
    expect(script).toContain("join(root, 'packages', 'client', 'src', 'version.ts')");
    // The script's pattern, applied to the real file, rewrites the constant.
    const pattern = /^(export const CLIENT_VERSION = )'[^']+'/m;
    expect(script).toContain(String(pattern).slice(1, -2));
    expect(source.replace(pattern, "$1'9.9.9'")).toContain("export const CLIENT_VERSION = '9.9.9';");
  });

  it('hello carries it', async () => {
    const viewer = await FakeViewer.start();
    cleanups.push(() => viewer.close());
    const session = createSession({ url: viewer.url, enabled: true, env: {}, retryIntervalMs: 60_000 });
    cleanups.push(() => session.dispose());
    expect(await session.ready()).toBe(true);
    const hello = await viewer.waitForType('hello');
    expect((hello.payload['versions'] as { client: string }).client).toBe(pkg.version);
  });
});
