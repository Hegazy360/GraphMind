/**
 * Shared by the dev-loop scripts (dev.mjs, cli.mjs): the workspace packages
 * publish `dist/` through their `exports`, so nothing in the repo — the CLI,
 * the viewer dev server, the examples — runs until they are built once.
 *
 * Builds only when the output is missing, so `pnpm dev` stays fast on the
 * second run. It does NOT detect stale output; after editing `packages/*`,
 * run `pnpm build:packages` (the hint below is printed on the fast path).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** One built file per package that something in the dev loop imports. */
const sentinels = [
  join(repoRoot, 'packages', 'cli', 'dist', 'cli.js'),
  join(repoRoot, 'packages', 'schema', 'dist', 'index.js'),
  join(repoRoot, 'packages', 'client', 'dist', 'index.js'),
];

export function packagesAreBuilt() {
  return sentinels.every((file) => existsSync(file));
}

/**
 * Build `./packages/**` if any sentinel is missing. Returns false (after
 * printing the error) when the build fails, so callers can exit(1) without
 * a stack trace on top of tsc's own output.
 */
export function ensurePackagesBuilt() {
  // stderr throughout: `pnpm cli pauses --json | jq` must see only the CLI's
  // stdout.
  if (packagesAreBuilt()) {
    console.error('(packages already built — run `pnpm build:packages` after editing packages/*)');
    return true;
  }
  console.error('First run: building the workspace packages (pnpm build:packages)...');
  const result = spawnSync('pnpm', ['-r', '--filter', './packages/**', 'run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    // pnpm is pnpm.cmd on Windows; a shell resolves it either way.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error('ensure-packages-built: `pnpm -r --filter ./packages/** run build` failed.');
    return false;
  }
  return true;
}
