/**
 * Regression guard for `sdk: openai@unknown`.
 *
 * `detectOpenAiVersion()` used to be `require('openai/package.json')`. The
 * `openai` package's `exports` map does not list the `./package.json`
 * subpath, so that call throws ERR_PACKAGE_PATH_NOT_EXPORTED on every
 * supported major (verified on 5.23.2, 6.49.0 and 7.7.0) and the adapter fell
 * back to `'unknown'` — which is what the viewer showed for every run anyone
 * ever made with this adapter.
 *
 * Two halves:
 *  1. the end-to-end one — what `run.started` actually carries;
 *  2. the mechanism — `peerVersion` against a synthetic package whose
 *     `exports` hides `./package.json`, i.e. the exact shape that broke.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { peerVersion } from '../src/peer-version.js';
import { chatCompletion, FakeOpenAI } from './helpers/fake-openai.js';
import { waitUntil } from './helpers/fake-viewer.js';
import { setup } from './helpers/setup.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * The installed version, read straight off disk without going through the
 * code under test — `packages/openai/node_modules/openai` is where the peer
 * this suite runs against lives.
 */
function installedOpenAiVersion(): string {
  const manifest = new URL('../node_modules/openai/package.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

describe('the SDK version reported to the viewer', () => {
  it('is the installed openai version, not "unknown"', async () => {
    const server = new FakeOpenAI().onChat(() => ({
      kind: 'json',
      body: chatCompletion({ text: 'ok' }),
    }));
    const { viewer, gm } = await setup(server, {}, {}, cleanups);
    await gm.run('version-check', async () => undefined);
    await waitUntil(() => viewer.ofType('run.started').length > 0);

    const sdk = viewer.ofType('run.started')[0]?.payload['sdk'] as {
      name: string;
      version: string;
    };
    expect(sdk.name).toBe('openai');
    expect(sdk.version).not.toBe('unknown');
    expect(sdk.version).toBe(installedOpenAiVersion());
    // Inside the peer range this package advertises (>=5 <8).
    expect(Number(sdk.version.split('.')[0])).toBeGreaterThanOrEqual(5);
    expect(Number(sdk.version.split('.')[0])).toBeLessThan(8);
  });

  it('reaches the debugger in the hello handshake too', async () => {
    const { viewer, gm } = await setup(new FakeOpenAI(), {}, {}, cleanups);
    expect(await gm.ready({ timeoutMs: 4000 })).toBe(true);
    await waitUntil(() => viewer.ofType('hello').length > 0, 8000, 'hello');
    const sdk = viewer.ofType('hello')[0]?.payload['sdk'] as { name: string; version: string };
    expect(sdk).toEqual({ name: 'openai', version: installedOpenAiVersion() });
  });
});

describe('peerVersion against an exports map that hides ./package.json', () => {
  /** A package laid out exactly like `openai`: no `./package.json` subpath. */
  function makeFixture(name: string, version: string): { from: string; dispose: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    const pkgDir = join(root, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: 'commonjs',
        exports: { '.': './index.js', './version': './version.js' },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(pkgDir, 'version.js'), `exports.VERSION = '${version}';\n`);
    return {
      from: pathToFileURL(join(root, 'consumer.js')).href,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('reads the version the old `require(pkg/package.json)` could not', () => {
    const fixture = makeFixture('hidden-manifest-sdk', '9.9.9');
    cleanups.push(fixture.dispose);

    // The old implementation, verbatim — proves the fixture reproduces the bug.
    expect(() => createRequire(fixture.from)('hidden-manifest-sdk/package.json')).toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
    );

    expect(peerVersion('hidden-manifest-sdk', fixture.from)).toBe('9.9.9');
  });

  it('still uses the ./package.json subpath when a package does expose it', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, 'node_modules', 'open-manifest-sdk');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'open-manifest-sdk',
        version: '1.2.3',
        exports: { '.': './index.js', './package.json': './package.json' },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    const from = pathToFileURL(join(root, 'consumer.js')).href;

    expect(peerVersion('open-manifest-sdk', from)).toBe('1.2.3');
  });

  it('reads an ESM-only package that require() cannot resolve at all', () => {
    // No `require` condition anywhere: `require('pkg')` AND
    // `require('pkg/package.json')` both fail, so the only route left is the
    // `node_modules/<name>/package.json` directory lookup.
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, 'node_modules', 'esm-only-sdk');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'esm-only-sdk',
        version: '3.0.1',
        type: 'module',
        exports: { '.': { import: './index.js' } },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'export default {};\n');
    const from = pathToFileURL(join(root, 'consumer.js')).href;

    const require = createRequire(from);
    expect(() => require('esm-only-sdk/package.json')).toThrow();
    expect(() => require.resolve('esm-only-sdk')).toThrow();

    expect(peerVersion('esm-only-sdk', from)).toBe('3.0.1');
  });

  it('degrades to undefined for a peer that is not installed', () => {
    expect(peerVersion('definitely-not-installed-sdk', import.meta.url)).toBeUndefined();
  });

  it('never returns the version of a DIFFERENT package', () => {
    // A nested manifest with no name (the `{"type":"module"}` marker files
    // shipped in dist/ folders) must not be mistaken for the package's own.
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, 'node_modules', 'nested-marker-sdk');
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'nested-marker-sdk',
        version: '4.5.6',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(pkgDir, 'dist', 'package.json'),
      JSON.stringify({ type: 'commonjs', version: '0.0.0-marker' }),
    );
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'module.exports = {};\n');
    const from = pathToFileURL(join(root, 'consumer.js')).href;

    expect(peerVersion('nested-marker-sdk', from)).toBe('4.5.6');
  });
});

/**
 * The README's "Version support" section drifted: it said the peer range was
 * `>=5 <7` and called v5 untested long after package.json widened to
 * `>=5 <8` and CI started running the floor. Prose about versions rots
 * silently, so it is asserted.
 */
describe('README version support', () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

  it('states the peer range package.json actually declares', () => {
    const declared = (
      JSON.parse(read('package.json')) as { peerDependencies: Record<string, string> }
    ).peerDependencies['openai'];
    const stated = /peer range is \*\*`openai (.+?)`\*\*/.exec(read('README.md'))?.[1];
    expect(stated).toBe(declared);
  });

  it('declares a range that covers the version the suite runs against', () => {
    const declared = (
      JSON.parse(read('package.json')) as { peerDependencies: Record<string, string> }
    ).peerDependencies['openai'];
    const bounds = /^>=(\d+) <(\d+)$/.exec(declared ?? '');
    expect(bounds).not.toBeNull();
    const major = Number(installedOpenAiVersion().split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(Number(bounds?.[1]));
    expect(major).toBeLessThan(Number(bounds?.[2]));
  });
});
