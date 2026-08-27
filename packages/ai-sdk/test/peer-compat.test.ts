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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { graphmind } from '../src/index.js';
import { AdapterCore } from '../src/core.js';
import { createDebugMiddleware, MIDDLEWARE_SPEC_VERSION } from '../src/middleware.js';
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
