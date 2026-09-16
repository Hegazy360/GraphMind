#!/usr/bin/env node
/**
 * Count GraphMind's tests, suite by suite, so any number the README or the
 * docs quote can be re-derived with one command instead of being guessed.
 *
 *   node apps/docs/scripts/count-tests.mjs          # collect only (fast, ~1 min)
 *   node apps/docs/scripts/count-tests.mjs --run    # also RUN every suite and report passes
 *   node apps/docs/scripts/count-tests.mjs --json   # machine-readable
 *
 * What "a test" means here, per runner — each is the runner's own unit:
 *   vitest      one `it`/`test` case after `.each` expansion (`vitest list`)
 *   playwright  one spec case (`playwright test --list`)
 *   pytest      one collected item, parametrize expanded (`pytest --collect-only`)
 *   minitest    one run (`rake test` summary line — minitest has no collect mode)
 *   node:test   one `test()` (`node --test` summary)
 * Checks that are not test cases (the soak battery, the e2e smoke's
 * assertions) are listed separately and never added to the total.
 *
 * Environment: PYTHON (default python/.venv/bin/python), RUBY_BIN (directory
 * holding ruby/bundle; default: whatever is on PATH). Needs built packages
 * for the suites that read dist (run `pnpm -r --filter './packages/**' build`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN = process.argv.includes('--run');
const JSON_OUT = process.argv.includes('--json');

function sh(cmd, args, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GRAPHMIND_TELEMETRY: '0', DO_NOT_TRACK: '1', ...extraEnv },
    shell: process.platform === 'win32',
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const VITEST_SUITES = [
  'packages/schema',
  'packages/client',
  'packages/ai-sdk',
  'packages/anthropic',
  'packages/openai',
  'packages/langgraph',
  'packages/mcp',
  'packages/cli',
  'apps/viewer',
  'security',
];

const rows = [];

function vitestCount(dir) {
  const cwd = join(ROOT, dir);
  const listed = sh('npx', ['vitest', 'list', '--json'], cwd);
  let collected;
  try {
    const start = listed.out.indexOf('[');
    const end = listed.out.lastIndexOf(']');
    collected = JSON.parse(listed.out.slice(start, end + 1)).length;
  } catch {
    collected = undefined;
  }
  let passed;
  let skipped;
  let failed;
  if (RUN) {
    const ran = sh('npx', ['vitest', 'run'], cwd);
    const m = /Tests\s+(.*?)\((\d+)\)/.exec(ran.out.replace(/\x1b\[[0-9;]*m/g, ''));
    if (m) {
      passed = Number(/(\d+) passed/.exec(m[1])?.[1] ?? 0);
      skipped = Number(/(\d+) skipped/.exec(m[1])?.[1] ?? 0);
      failed = Number(/(\d+) failed/.exec(m[1])?.[1] ?? 0);
      // `vitest list` omits cases a runtime `skipIf` removes; the run's own
      // total is the authoritative count when we have it.
      collected = Number(m[2]);
    }
  }
  return { suite: `${dir} (vitest)`, collected, passed, skipped, failed };
}

for (const dir of VITEST_SUITES) rows.push(vitestCount(dir));

// Playwright: the viewer in a real browser.
{
  const cwd = join(ROOT, 'apps/viewer');
  const listed = sh('npx', ['playwright', 'test', '--list'], cwd);
  const m = /Total:\s+(\d+) tests?/.exec(listed.out);
  rows.push({
    suite: 'apps/viewer e2e (playwright)',
    collected: m ? Number(m[1]) : undefined,
    note: RUN ? 'not run by this script (needs a browser build; run `pnpm --filter viewer test:e2e`)' : undefined,
  });
}

// node:test suites.
for (const [suite, cwd, args] of [
  ['apps/web (node:test)', join(ROOT, 'apps/web'), ['--experimental-test-module-mocks', '--test', 'test/waitlist.test.mjs', 'test/telemetry.test.mjs']],
  ['scripts/release (node:test)', ROOT, ['--test', 'scripts/release/test/release-scripts.test.mjs']],
]) {
  const ran = sh(process.execPath, args, cwd);
  const tests = /(?:ℹ|#) tests (\d+)/.exec(ran.out);
  const pass = /(?:ℹ|#) pass (\d+)/.exec(ran.out);
  const fail = /(?:ℹ|#) fail (\d+)/.exec(ran.out);
  rows.push({
    suite,
    collected: tests ? Number(tests[1]) : undefined,
    passed: pass ? Number(pass[1]) : undefined,
    failed: fail ? Number(fail[1]) : undefined,
    note: 'node:test has no collect mode, so this suite is always run',
  });
}

// Python.
{
  const py = process.env.PYTHON ?? join(ROOT, 'python/.venv/bin/python');
  const cwd = join(ROOT, 'python');
  if (existsSync(py)) {
    const listed = sh(py, ['-m', 'pytest', '--collect-only', '-q'], cwd);
    const m = /(\d+) tests? collected/.exec(listed.out);
    const row = { suite: 'python (pytest)', collected: m ? Number(m[1]) : undefined };
    if (RUN) {
      const ran = sh(py, ['-m', 'pytest', '-q'], cwd);
      row.passed = Number(/(\d+) passed/.exec(ran.out)?.[1] ?? NaN);
      row.failed = Number(/(\d+) failed/.exec(ran.out)?.[1] ?? 0);
      row.skipped = Number(/(\d+) skipped/.exec(ran.out)?.[1] ?? 0);
    }
    rows.push(row);
  } else {
    rows.push({ suite: 'python (pytest)', note: `no interpreter at ${py} (set PYTHON)` });
  }
}

// Ruby: minitest cannot collect without running, so it always runs.
{
  const bin = process.env.RUBY_BIN;
  const bundle = bin ? join(bin, 'bundle') : 'bundle';
  const env = bin ? { PATH: `${bin}:${process.env.PATH}` } : {};
  const ran = sh(bundle, ['exec', 'rake', 'test'], join(ROOT, 'ruby'), env);
  const m = /(\d+) runs, (\d+) assertions, (\d+) failures, (\d+) errors, (\d+) skips/.exec(ran.out);
  rows.push({
    suite: 'ruby (minitest)',
    collected: m ? Number(m[1]) : undefined,
    passed: m ? Number(m[1]) - Number(m[3]) - Number(m[4]) - Number(m[5]) : undefined,
    failed: m ? Number(m[3]) + Number(m[4]) : undefined,
    skipped: m ? Number(m[5]) : undefined,
    note: m ? `${m[2]} assertions; minitest has no collect mode, so this suite is always run` : 'could not run (set RUBY_BIN)',
  });
}

// Checks that are not test cases, reported but never summed.
const extras = [];
{
  const e2e = readFileSync(join(ROOT, 'examples/e2e/src/e2e.ts'), 'utf8');
  extras.push({ what: 'examples/e2e smoke — check() call sites', count: (e2e.match(/\bcheck\(/g) ?? []).length });
}

const total = rows.reduce((sum, row) => sum + (row.collected ?? 0), 0);
const missing = rows.filter((row) => row.collected === undefined).map((row) => row.suite);

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, total, missing, extras }, null, 2));
} else {
  const pad = (s, n) => String(s ?? '—').padEnd(n);
  console.log(pad('suite', 34), pad('tests', 7), RUN ? `${pad('passed', 7)}${pad('failed', 7)}skipped` : '');
  for (const row of rows) {
    console.log(
      pad(row.suite, 34),
      pad(row.collected, 7),
      RUN ? `${pad(row.passed, 7)}${pad(row.failed, 7)}${row.skipped ?? '—'}` : '',
      row.note ? ` ${row.note}` : '',
    );
  }
  console.log(pad('TOTAL', 34), total, missing.length ? `(missing: ${missing.join(', ')})` : '');
  for (const extra of extras) console.log(`not counted: ${extra.what}: ${extra.count}`);
}
// With --run, a suite that failed — or ran without a readable summary (a crash
// before the runner printed its totals) — is a failure of this script too, so
// a CI step or a release checklist cannot quote a number from a red run.
// Playwright is listed, never run here, so it is exempt.
const unhealthy = RUN
  ? rows
      .filter((row) => !row.suite.includes('(playwright)'))
      .filter((row) => (row.failed ?? 0) > 0 || !Number.isFinite(row.passed))
      .map((row) => row.suite)
  : [];
if (unhealthy.length > 0 && !JSON_OUT) console.log(`failed or unreadable: ${unhealthy.join(', ')}`);
process.exitCode = missing.length > 0 || unhealthy.length > 0 ? 1 : 0;
