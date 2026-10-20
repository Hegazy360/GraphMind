/**
 * Where a generated project's adapter and interpreter come from.
 *
 *  - from a checkout (these tests ARE one), adapters are local tarballs and
 *    the Python SDK is a path, so a project installs before the version is
 *    published; from an npm install they are registry pins;
 *  - Python is resolved to an interpreter >= 3.10 (uv first), never to the
 *    3.9 macOS ships; a machine with none fails the job with the fix named.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandsFor, generateProject } from '../src/builder/codegen/index.js';
import { LOCAL_NPM_PACKAGES, detectCheckout, packLocalPackages, resetLocalPackagesCache, resolveLocalPackages } from '../src/builder/local-packages.js';
import { createProject } from '../src/builder/projects.js';
import { ProjectRunner, type JobPhase } from '../src/builder/runner.js';
import { defaultSpec, parseSpec } from '../src/builder/spec.js';
import { NO_PYTHON_MESSAGE, pythonCommands, pythonVersion, resolvePython } from '../src/builder/toolchain.js';
import { waitUntil } from './helpers.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'graphmind-toolchain-'));
  resetLocalPackagesCache();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetLocalPackagesCache();
});

const REPO = resolve(import.meta.dirname, '..', '..', '..');

describe('checkout detection', () => {
  it('recognises this repository and nothing else', () => {
    expect(detectCheckout()).toBe(REPO);
    expect(detectCheckout(home)).toBeUndefined();
  });

  it('GRAPHMIND_BUILDER_REGISTRY=1 forces the published pins', () => {
    expect(resolveLocalPackages({ GRAPHMIND_HOME: home, GRAPHMIND_BUILDER_REGISTRY: '1' })).toBeUndefined();
  });
});

describe('local packages', () => {
  // Needs the packages built (CI builds them before the tests; so does CONTRIBUTING).
  const built = LOCAL_NPM_PACKAGES.every((name) => existsSync(join(REPO, 'packages', name, 'dist', 'index.js')));

  it.skipIf(!built)('packs every adapter and points generated projects at the tarballs', () => {
    const local = packLocalPackages(REPO, join(home, '.packages'));
    expect(Object.keys(local.npm).sort()).toEqual(['@graphmind-ai/anthropic', '@graphmind-ai/client', '@graphmind-ai/openai', '@graphmind-ai/schema', '@graphmind-ai/sdk']);
    for (const path of Object.values(local.npm)) expect(existsSync(path)).toBe(true);
    expect(local.pythonRequirement).toMatch(/^graphmind-ai @ file:\/\/.*\/python$/);

    const ts = generateProject(parseOk({ ...defaultSpec('ts-anthropic'), provider: 'anthropic' }), 'posix', { local });
    expect(ts.source).toBe('checkout');
    const pkg = JSON.parse(ts.files.find((f) => f.path === 'package.json')?.content ?? '{}') as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    expect(pkg.dependencies['@graphmind-ai/anthropic']).toBe(`file:${local.npm['@graphmind-ai/anthropic']}`);
    expect(pkg.dependencies['@anthropic-ai/sdk']).toMatch(/^\^/); // provider SDKs still from the registry
    expect(pkg.overrides['@graphmind-ai/client']).toBe(`file:${local.npm['@graphmind-ai/client']}`);
    expect(pkg.overrides['@graphmind-ai/schema']).toBe(`file:${local.npm['@graphmind-ai/schema']}`);
    expect(ts.files.find((f) => f.path === 'README.md')?.content).toContain('comes from the local checkout');

    const py = generateProject(parseOk(defaultSpec('py-openai')), 'posix', { local });
    expect(py.files.find((f) => f.path === 'requirements.txt')?.content.split('\n')[0]).toBe(local.pythonRequirement);

    // createProject threads it through, and the registry form is untouched without it
    const created = createProject({ spec: parseOk(defaultSpec()), env: { GRAPHMIND_HOME: home }, local, platform: 'posix' });
    expect(readFileSync(join(created.dir, 'package.json'), 'utf8')).toContain('file:');
    const registry = generateProject(parseOk(defaultSpec()), 'posix');
    expect(registry.source).toBe('registry');
    expect(registry.files.find((f) => f.path === 'package.json')?.content).not.toContain('file:');
    expect(registry.files.find((f) => f.path === 'package.json')?.content).not.toContain('overrides');
  });

  it.skipIf(!built)('resolves once per process for a workflows directory', () => {
    const env = { GRAPHMIND_HOME: home };
    const first = resolveLocalPackages(env);
    expect(first).toBeDefined();
    expect(resolveLocalPackages(env)).toBe(first);
  });

  it('names the fix when the checkout is not built', () => {
    expect(() => packLocalPackages(home, join(home, 'out'))).toThrow(/pnpm -r --filter/);
  });
});

describe('python toolchain', () => {
  it('reports a version for a real interpreter and nothing for a missing one', () => {
    const real = pythonVersion(process.execPath); // node answers nothing useful: not python
    expect(real).toBeUndefined();
    expect(pythonVersion('/definitely/not/here/python')).toBeUndefined();
  });

  it('honours GRAPHMIND_PYTHON before anything else', () => {
    const chain = resolvePython({ GRAPHMIND_PYTHON: '/my/python3.12' }, 'posix');
    expect(chain).toEqual({ kind: 'interpreter', bin: '/my/python3.12', version: undefined, describe: 'GRAPHMIND_PYTHON=/my/python3.12' });
  });

  it('builds uv and plain-interpreter command sets, never shell strings', () => {
    const uv = pythonCommands({ kind: 'uv', bin: 'uv', version: undefined, describe: 'uv' }, 'posix');
    expect(uv.install[0]?.argv).toEqual(['uv', 'venv', '--quiet', '--python', '>=3.10', '.venv']);
    expect(uv.install[1]?.argv).toEqual(['uv', 'pip', 'install', '--quiet', '--python', '.venv/bin/python', '-r', 'requirements.txt']);
    expect(uv.start.argv).toEqual(['.venv/bin/python', 'main.py']);
    const plain = pythonCommands({ kind: 'interpreter', bin: 'python3.12', version: '3.12', describe: 'x' }, 'win32');
    expect(plain.install[0]?.argv).toEqual(['python3.12', '-m', 'venv', '.venv']);
    expect(plain.start.argv[0]).toBe('.venv\\Scripts\\python.exe');
    expect(commandsFor('py-openai', 'posix', uvChain()).install[0]?.argv[0]).toBe('uv');
    expect(commandsFor('py-openai', 'posix').install[0]?.argv[0]).toBe('python3'); // README form, no toolchain
  });

  it('fails a Python job up front, with the fix, when no interpreter qualifies', async () => {
    const created = createProject({ spec: parseOk(defaultSpec('py-openai')), env: { GRAPHMIND_HOME: home } });
    const runner = new ProjectRunner({ ingestUrl: () => 'ws://127.0.0.1:1/ingest', python: null, parentEnv: { PATH: '' } });
    const job = runner.start(created.dir);
    await waitUntil(() => runner.get(job.id)?.phase === 'failed', 'failed job');
    const text = runner.lines(job.id).map((l) => l.text).join('\n');
    expect(text).toContain(NO_PYTHON_MESSAGE);
    expect(text).not.toContain('$ '); // nothing was spawned
    runner.dispose();
  });

  it('names the interpreter it chose in the job log', async () => {
    const created = createProject({ spec: parseOk(defaultSpec('py-openai')), env: { GRAPHMIND_HOME: home } });
    // A fake "uv" that is really node: the job runs, and the first log line says which Python was picked.
    const runner = new ProjectRunner({
      ingestUrl: () => 'ws://127.0.0.1:1/ingest',
      python: { kind: 'interpreter', bin: process.execPath, version: '3.12', describe: 'fake python (test)' },
      parentEnv: { PATH: process.env['PATH'] ?? '' },
    });
    const job = runner.start(created.dir);
    await waitUntil(() => {
      const phase = runner.get(job.id)?.phase as JobPhase | undefined;
      return phase !== undefined && phase !== 'installing' && phase !== 'running';
    }, 'job end', 20_000);
    const text = runner.lines(job.id).map((l) => l.text).join('\n');
    expect(text).toContain('python: fake python (test)');
    expect(text).toContain(`$ ${process.execPath} -m venv .venv`);
    runner.dispose();
  });
});

function parseOk(input: unknown) {
  const parsed = parseSpec(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.spec;
}

function uvChain() {
  return { kind: 'uv' as const, bin: 'uv', version: undefined, describe: 'uv' };
}
