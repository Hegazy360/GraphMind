/**
 * scripts/jack-ensure-built.mjs — every launch script runs it, so stale
 * dist/ can never be served silently again (the M4 "empty dashboard" bug:
 * new ui/ files served by a two-day-old server).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/jack-ensure-built.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'jack-ensure-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pkg(name: string, srcAge: number, distAge: number | null) {
  const dir = join(root, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), '');
  const now = Date.now() / 1000;
  utimesSync(join(dir, 'src', 'index.ts'), now - srcAge, now - srcAge);
  if (distAge !== null) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), '');
    utimesSync(join(dir, 'dist', 'index.js'), now - distAge, now - distAge);
  }
}
// A root whose `build:jack` just records that it ran.
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', private: true, scripts: { 'build:jack': 'node -e "require(\'fs\').writeFileSync(\'built.flag\', \'1\')"' } }));
const run = () => spawnSync(process.execPath, [script], { env: { ...process.env, JACK_ROOT: root }, encoding: 'utf8' });

describe('jack-ensure-built', () => {
  it('does nothing (and prints nothing) when every dist/ is newer than its source', () => {
    pkg('jack-schema', 100, 10);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('');
  });

  it('rebuilds when source is newer than dist/ — and says which package and why, on stderr only', () => {
    pkg('jack-cli', 10, 3600); // edited 10 s ago, built an hour ago
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/older than its source — rebuilding first/);
    expect(r.stderr).toMatch(/packages\/jack-cli \(source changed/);
    expect(r.stderr).toMatch(/rebuilt\./);
    expect(r.stdout).toBe(''); // `jack preview --stdio` owns stdout
  });

  it('rebuilds a package that was never built', () => {
    pkg('jack-auth', 10, null);
    expect(run().stderr).toMatch(/packages\/jack-auth \(never built\)/);
  });

  it('JACK_SKIP_BUILD_CHECK bypasses it', () => {
    const r = spawnSync(process.execPath, [script], { env: { ...process.env, JACK_ROOT: root, JACK_SKIP_BUILD_CHECK: '1' }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });
});
