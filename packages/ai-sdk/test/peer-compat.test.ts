/**
 * The package advertises `ai >=6 <8`. These guard the two things that broke
 * that promise without any single-version test noticing:
 *
 *  1. the middleware object omitted `specificationVersion`, which ai@7 makes
 *     optional but ai@6 REQUIRES — so `tsc` failed for anyone whose tree
 *     resolved ai@6, even though every runtime path was fine;
 *  2. the fixtures hard-coded `MockLanguageModelV4` from 'ai/test', an export
 *     that only exists on ai@7, so three of the four test files died at
 *     module load on ai@6.
 *
 * Neither could be caught by running the suite on one major, so both are
 * asserted structurally here.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind } from '../src/index.js';
import { AdapterCore } from '../src/core.js';
import { createDebugMiddleware, MIDDLEWARE_SPEC_VERSION } from '../src/middleware.js';
import { peerVersion } from '../src/peer-version.js';
import { FakeViewer, waitUntil } from './helpers/fake-viewer.js';
import { MockLanguageModel, aiVersion, supportsToolTimeout } from './helpers/sdk-compat.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeCore(): AdapterCore {
  const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
  cleanups.push(() => gm.dispose());
  return new AdapterCore(gm.session);
}

describe('middleware spec version (ai@6 requires it, ai@7 tolerates it)', () => {
  it("declares specificationVersion: 'v3', the only value both majors accept", () => {
    const middleware = createDebugMiddleware(makeCore());
    expect(middleware.specificationVersion).toBe('v3');
    expect(MIDDLEWARE_SPEC_VERSION).toBe('v3');

    // Compile-time half of the guard: ai@6's LanguageModelV3Middleware makes
    // this property required and pins the literal. The declared return type
    // of createDebugMiddleware has to satisfy that on ai@7 as well.
    const requiredByAi6: { readonly specificationVersion: 'v3' } = middleware;
    expect(requiredByAi6.specificationVersion).toBe('v3');
  });

  it('still exposes the three hooks wrapLanguageModel destructures', () => {
    const middleware = createDebugMiddleware(makeCore());
    expect(typeof middleware.transformParams).toBe('function');
    expect(typeof middleware.wrapStream).toBe('function');
    expect(typeof middleware.wrapGenerate).toBe('function');
  });

  it('wrapModel accepts the middleware on the installed major', () => {
    const gm = graphmind({ enabled: true, webSocket: undefined, logger: () => {} });
    cleanups.push(() => gm.dispose());
    const model = new MockLanguageModel({});
    const wrapped = gm.wrapModel(model);
    // Really wrapped (not the identity fallback wrapModel uses when
    // wrapLanguageModel throws), and the MODEL's spec version is the SDK's
    // own — the middleware's declared version never leaks into it.
    expect(wrapped).not.toBe(model);
    expect(typeof wrapped.doStream).toBe('function');
    expect(wrapped.specificationVersion).toBe(model.specificationVersion);
  });
});

describe('cross-major fixtures', () => {
  const helpersDir = dirname(fileURLToPath(import.meta.url));

  it('resolves a mock language model from whatever ai/test the tree installed', () => {
    expect(typeof MockLanguageModel).toBe('function');
    const model = new MockLanguageModel({});
    expect(typeof model.doStream).toBe('function');
    expect(['v3', 'v4']).toContain(model.specificationVersion);
    expect(aiVersion).toMatch(/^[67]\./);
    // The capability probe agrees with the major: per-tool timeouts are ai@7+.
    expect(supportsToolTimeout).toBe(aiVersion.startsWith('7.'));
  });

  it("only sdk-compat.ts imports 'ai/test' (the mock's name differs per major)", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(helpersDir);

    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n'"`]*\/\/.*$/gm, '');

    const offenders: string[] = [];
    for (const file of files) {
      // sdk-compat.ts is the one place allowed to reach into 'ai/test'.
      if (file.endsWith('sdk-compat.ts')) continue;
      if (/from\s*['"]ai\/test['"]/.test(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(relative(helpersDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The `sdk` field the viewer labels every run with.
 *
 * The sibling OpenAI adapter reported `openai@unknown` for its whole life
 * because it read the peer's version through `require('openai/package.json')`
 * and `openai`'s `exports` map does not list that subpath. `ai` does list it
 * today, so this adapter was never wrong — but nothing stops `ai` from
 * dropping it in a minor, and the failure is silent. Both halves are pinned
 * here: what the run actually carries, and the on-disk fallback that makes it
 * independent of any exports map.
 */
describe('the SDK version reported to the viewer', () => {
  it('is the installed `ai` version, not "unknown"', async () => {
    const viewer = await FakeViewer.start();
    const gm = graphmind({ url: viewer.url, enabled: true, retryIntervalMs: 60_000 });
    cleanups.push(async () => {
      await gm.dispose();
      await viewer.close();
    });

    await gm.run('version-check', async () => undefined);
    await waitUntil(() => viewer.ofType('run.started').length > 0, 8000, 'run.started');

    const sdk = viewer.ofType('run.started')[0]?.payload['sdk'] as {
      name: string;
      version: string;
    };
    expect(sdk).toEqual({ name: 'ai', version: aiVersion });
    expect(sdk.version).not.toBe('unknown');
    // Inside the peer range this package advertises (>=6 <8).
    expect(Number(sdk.version.split('.')[0])).toBeGreaterThanOrEqual(6);
    expect(Number(sdk.version.split('.')[0])).toBeLessThan(8);
  });

  it('survives an exports map that hides ./package.json (the openai shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-peer-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pkgDir = join(root, 'node_modules', 'hidden-manifest-sdk');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'hidden-manifest-sdk',
        version: '9.9.9',
        type: 'commonjs',
        exports: { '.': './index.js' },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    const from = pathToFileURL(join(root, 'consumer.js')).href;

    // The old implementation, verbatim — proves the fixture reproduces it.
    expect(() => createRequire(from)('hidden-manifest-sdk/package.json')).toThrow(
      /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
    );
    expect(peerVersion('hidden-manifest-sdk', from)).toBe('9.9.9');
  });

  it('degrades to undefined for a peer that is not installed', () => {
    expect(peerVersion('definitely-not-installed-sdk', import.meta.url)).toBeUndefined();
  });
});
