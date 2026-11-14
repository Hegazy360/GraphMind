#!/usr/bin/env node
// Make sure Jack's compiled output (dist/) is at least as new as its source
// before anything runs it. dist/ is git-ignored, so pulling or syncing new
// source never updates it — without this check, `pnpm jack serve` would
// silently run whatever was built last (that is exactly how an M4 checkout
// ended up serving the M2 server with the M4 dashboard page).
//
// Fast path: a few stat() calls. Stale or missing → `pnpm build:jack`.
// Everything is printed to stderr: `jack preview --stdio` owns stdout.
// Set JACK_SKIP_BUILD_CHECK=1 to bypass.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// JACK_ROOT: for tests of this script only.
const root = process.env.JACK_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  'packages/accounts',
  'packages/ui',
  'packages/jack-schema',
  'packages/jack-openapi',
  'packages/jack-runtime',
  'packages/jack-auth',
  'packages/jack-verify',
  'apps/jack-api',
  'packages/jack-cli',
  'examples/jack-tasks',
];

function newest(dir) {
  let max = 0;
  if (!existsSync(dir)) return max;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) max = Math.max(max, newest(p));
    else max = Math.max(max, statSync(p).mtimeMs);
  }
  return max;
}

if (!process.env.JACK_SKIP_BUILD_CHECK) {
  const stale = [];
  for (const pkg of PACKAGES) {
    const dir = join(root, pkg);
    if (!existsSync(join(dir, 'src'))) continue;
    const built = newest(join(dir, 'dist'));
    const inputs = Math.max(newest(join(dir, 'src')), ...['package.json', 'tsconfig.build.json'].map((f) => (existsSync(join(dir, f)) ? statSync(join(dir, f)).mtimeMs : 0)));
    if (built === 0) stale.push(`${pkg} (never built)`);
    else if (inputs > built) stale.push(`${pkg} (source changed ${new Date(inputs).toLocaleString()}, built ${new Date(built).toLocaleString()})`);
  }
  if (stale.length > 0) {
    console.error('jack: the compiled code is older than its source — rebuilding first:');
    for (const s of stale) console.error(`  · ${relative(root, join(root, s))}`);
    const r = spawnSync('pnpm', ['run', '--silent', 'build:jack'], { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });
    if (r.status !== 0) {
      console.error('jack: the build failed (see above). Fix it, or run `pnpm build:jack` to see the errors.');
      process.exit(r.status ?? 1);
    }
    console.error('jack: rebuilt.');
  }
}
