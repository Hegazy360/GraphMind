/**
 * Projects on disk and the `.env` file: where the builder writes, what it
 * refuses to touch, and the guarantee that a key goes in and never comes out.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_KEY_RE,
  EnvFileError,
  envKeysPresent,
  parseEnvFile,
  serializeEnv,
  validateEnvUpdates,
  writeEnvFile,
} from '../src/builder/env-file.js';
import {
  ProjectError,
  SPEC_FILE,
  createProject,
  listProjects,
  readProject,
  requireProject,
  resolveProjectDir,
  resolveWorkflowsDir,
} from '../src/builder/projects.js';
import { defaultSpec, parseSpec, type WorkflowSpec } from '../src/builder/spec.js';

const SECRET = 'sk-test-0123456789abcdefTHISISASECRET';
const isWindows = process.platform === 'win32';

let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'graphmind-builder-home-'));
  env = { GRAPHMIND_HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function spec(extra: Partial<WorkflowSpec> = {}): WorkflowSpec {
  const parsed = parseSpec({ ...defaultSpec(), ...extra });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.spec;
}

describe('.env file', () => {
  it('parses KEY=VALUE with quotes, comments, blanks and export prefixes', () => {
    const text = [
      '# a comment',
      '',
      'A=plain',
      'B="double quoted # not a comment"',
      "C='single'",
      'export D=exported',
      'E=with # trailing comment',
      'lower=ignored',
      'NOEQUALS',
      '=novalue',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      A: 'plain',
      B: 'double quoted # not a comment',
      C: 'single',
      D: 'exported',
      E: 'with',
    });
  });

  it('serializes sorted, quoting only what needs it, and round-trips', () => {
    const entries = { Z: 'simple', A: 'has space', Q: 'quote"inside', H: 'hash # inside' };
    const text = serializeEnv(entries);
    expect(text.split('\n')).toEqual(['A="has space"', 'H="hash # inside"', `Q='quote"inside'`, 'Z=simple', '']);
    expect(parseEnvFile(text)).toEqual(entries);
  });

  it('writes owner-only, merges, and removes on empty', () => {
    const path = join(home, '.env');
    let result = writeEnvFile(path, { OPENAI_API_KEY: SECRET, GRAPHMIND_URL: 'ws://127.0.0.1:4747/ingest' });
    expect(result.written).toEqual(['GRAPHMIND_URL', 'OPENAI_API_KEY']);
    if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(readFileSync(path, 'utf8'))['OPENAI_API_KEY']).toBe(SECRET);

    result = writeEnvFile(path, { ANTHROPIC_API_KEY: 'another-secret-value', GRAPHMIND_URL: '' });
    expect(result.written).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.removed).toEqual(['GRAPHMIND_URL']);
    const after = parseEnvFile(readFileSync(path, 'utf8'));
    expect(after['OPENAI_API_KEY']).toBe(SECRET); // merged, not replaced
    expect(after['GRAPHMIND_URL']).toBeUndefined();
    expect(envKeysPresent(path)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    // no temp file left behind
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reports names only, never values', () => {
    const path = join(home, '.env');
    writeEnvFile(path, { OPENAI_API_KEY: SECRET });
    expect(JSON.stringify(envKeysPresent(path))).not.toContain(SECRET);
  });

  it('refuses bad names, non-strings, multi-line values and too many entries', () => {
    expect(() => validateEnvUpdates({ 'lower-case': 'x' })).toThrow(EnvFileError);
    expect(() => validateEnvUpdates({ OK: 42 })).toThrow(EnvFileError);
    expect(() => validateEnvUpdates({ OK: 'line1\nOTHER=injected' })).toThrow(EnvFileError);
    expect(() => validateEnvUpdates({ OK: 'x'.repeat(5000) })).toThrow(EnvFileError);
    expect(() => validateEnvUpdates({ OK: 'back\\slash' })).toThrow(EnvFileError);
    expect(() => validateEnvUpdates({ OK: `both "quotes" and 'quotes'` })).toThrow(EnvFileError);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`K${i}`, 'v']));
    expect(() => validateEnvUpdates(many)).toThrow(EnvFileError);
    expect(validateEnvUpdates({ OPENAI_API_KEY: SECRET })).toEqual({ OPENAI_API_KEY: SECRET });
    expect(ENV_KEY_RE.test('ANTHROPIC_API_KEY')).toBe(true);
  });
});

describe('project directories', () => {
  it('defaults to $GRAPHMIND_HOME/workflows/<name>', () => {
    expect(resolveProjectDir(spec({ name: 'demo' }), undefined, env)).toBe(join(home, 'workflows', 'demo'));
    expect(resolveWorkflowsDir(env)).toBe(join(home, 'workflows'));
  });

  it('refuses relative paths, the root and the home directory', () => {
    expect(() => resolveProjectDir(spec(), 'relative/dir', env)).toThrow(ProjectError);
    expect(() => resolveProjectDir(spec(), parse(home).root, env)).toThrow(ProjectError);
    expect(() => resolveProjectDir(spec(), homedir(), env)).toThrow(ProjectError);
    expect(resolveProjectDir(spec(), join(home, 'elsewhere'), env)).toBe(join(home, 'elsewhere'));
  });
});

describe('createProject', () => {
  it('writes the files, the spec file and an owner-only .env; the result names keys, never values', () => {
    const result = createProject({ spec: spec(), secrets: { ANTHROPIC_API_KEY: SECRET }, env, platform: 'posix' });
    expect(result.dir).toBe(join(home, 'workflows', 'my-agent'));
    for (const file of result.files) expect(existsSync(join(result.dir, file))).toBe(true);
    expect(result.files).toContain(SPEC_FILE);
    expect(result.files).toContain('src/main.ts');
    expect(result.envWritten).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const envPath = join(result.dir, '.env');
    expect(parseEnvFile(readFileSync(envPath, 'utf8'))['ANTHROPIC_API_KEY']).toBe(SECRET);
    if (!isWindows) {
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'workflows')).mode & 0o777).toBe(0o700);
    }
    // the spec file carries no secret and reopens as the same spec
    const specText = readFileSync(join(result.dir, SPEC_FILE), 'utf8');
    expect(specText).not.toContain(SECRET);
    const stored = readProject(result.dir);
    expect(stored?.spec).toEqual(spec());
    expect(stored?.generator).toMatch(/^graphmind-ai@/);
    // nothing else in the project mentions the key either
    for (const file of result.files) {
      expect(readFileSync(join(result.dir, file), 'utf8'), file).not.toContain(SECRET);
    }
  });

  it('works without secrets and reports an existing .env by name', () => {
    const first = createProject({ spec: spec(), env });
    expect(first.envWritten).toEqual([]);
    expect(existsSync(join(first.dir, '.env'))).toBe(false);
    writeEnvFile(join(first.dir, '.env'), { ANTHROPIC_API_KEY: SECRET });
    const again = createProject({ spec: spec(), env, overwrite: true });
    expect(again.envWritten).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('refuses a non-empty directory unless overwrite is set, and overwrite never touches .env or extra files', () => {
    const first = createProject({ spec: spec(), secrets: { ANTHROPIC_API_KEY: SECRET }, env });
    writeFileSync(join(first.dir, 'notes.md'), 'mine');
    expect(() => createProject({ spec: spec(), env })).toThrow(ProjectError);
    try {
      createProject({ spec: spec(), env });
    } catch (error) {
      expect((error as ProjectError).code).toBe('exists');
    }
    const second = createProject({ spec: spec({ prompt: 'changed' }), env, overwrite: true });
    expect(second.dir).toBe(first.dir);
    expect(readFileSync(join(first.dir, 'notes.md'), 'utf8')).toBe('mine');
    expect(parseEnvFile(readFileSync(join(first.dir, '.env'), 'utf8'))['ANTHROPIC_API_KEY']).toBe(SECRET);
    expect(readFileSync(join(first.dir, 'src', 'main.ts'), 'utf8')).toContain('"changed"');
  });

  it('accepts an explicit absolute directory', () => {
    const dir = join(home, 'somewhere', 'else');
    const result = createProject({ spec: spec(), dir, env });
    expect(result.dir).toBe(dir);
    expect(existsSync(join(dir, SPEC_FILE))).toBe(true);
  });

  it('rejects bad secrets before writing anything', () => {
    expect(() => createProject({ spec: spec(), secrets: { bad: 'x' }, env })).toThrow(ProjectError);
    expect(existsSync(join(home, 'workflows', 'my-agent'))).toBe(false);
  });
});

describe('listing and reopening', () => {
  it('lists the projects the builder made, newest first, with installed and env flags', () => {
    let tick = 0;
    const now = () => new Date(2026, 9, 18, 12, 0, tick++);
    createProject({ spec: spec({ name: 'older' }), env, now });
    const newer = createProject({ spec: spec({ name: 'newer', target: 'py-openai', provider: 'openai' }), secrets: { OPENAI_API_KEY: SECRET }, env, now });
    mkdirSync(join(newer.dir, '.venv'));
    // noise the lister must ignore
    mkdirSync(join(home, 'workflows', 'not-a-project'));
    writeFileSync(join(home, 'workflows', 'stray.txt'), 'x');

    const list = listProjects(env);
    expect(list.map((p) => p.name)).toEqual(['newer', 'older']);
    expect(list[0]).toMatchObject({
      target: 'py-openai',
      provider: 'openai',
      toolCount: 2,
      installed: true,
      envKeys: ['OPENAI_API_KEY'],
    });
    expect(list[1]?.installed).toBe(false);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it('requireProject accepts only an absolute path to a builder project', () => {
    const created = createProject({ spec: spec(), env });
    expect(requireProject(created.dir).spec.name).toBe('my-agent');
    expect(() => requireProject('relative')).toThrow(ProjectError);
    expect(() => requireProject(home)).toThrow(ProjectError);
    expect(() => requireProject(undefined)).toThrow(ProjectError);
    // a tampered spec file is not a project
    writeFileSync(join(created.dir, SPEC_FILE), '{"spec": {"name": "../escape"}}');
    expect(readProject(created.dir)).toBeUndefined();
  });
});
