/**
 * Shared by the dev-loop scripts (dev.mjs, cli.mjs): the workspace packages
 * publish `dist/` through their `exports`, so nothing in the repo — the CLI,
 * the viewer dev server, the examples — runs until they are built once.
 *
 * Builds when the output is missing OR older than the source that produced
 * it. "Did I rebuild?" is not a question anyone should have to hold in their
 * head while debugging something else: an edit to `packages/*` followed by
 * `pnpm dev` used to run the previous build, silently.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** One built file per package that something in the dev loop imports. */
const sentinels = [
  join(repoRoot, 'packages', 'cli', 'dist', 'cli.js'),
  join(repoRoot, 'packages', 'schema', 'dist', 'index.js'),
  join(repoRoot, 'packages', 'client', 'dist', 'index.js'),
];

/** The newest mtime under `dir`, skipping what is not source. */
function newestMtime(dir, skip = new Set(['node_modules', 'dist', '.turbo'])) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path, skip));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

export function packagesAreBuilt() {
  if (!sentinels.every((file) => existsSync(file))) return false;
  // Stale counts as unbuilt: a source edit after the last build is exactly
  // the case where running the old dist wastes an afternoon.
  const packagesDir = join(repoRoot, 'packages');
  let names;
  try {
    names = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return true;
  }
  for (const name of names) {
    const dist = join(packagesDir, name, 'dist');
    if (!existsSync(dist)) continue;
    if (newestMtime(join(packagesDir, name)) > newestMtime(dist)) return false;
  }
  return true;
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
    console.error('(packages already built and up to date)');
    return true;
  }
  console.error('Building the workspace packages (missing or out of date)...');
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
