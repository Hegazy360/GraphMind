/**
 * `pnpm cli <args>` — run the checkout's graphmind CLI without remembering
 * where the compiled entry lives (`node packages/cli/dist/cli.js ...`).
 * Builds the workspace packages first when they have never been built.
 *
 *   pnpm cli --help
 *   pnpm demo              (alias for `pnpm cli demo`)
 *   pnpm cli runs
 *   pnpm cli record <runId> --out bug.ndjson
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePackagesBuilt, repoRoot } from './ensure-packages-built.mjs';

if (!ensurePackagesBuilt()) process.exit(1);

// `serve`/`demo` serve a placeholder page when the viewer has never been
// copied into the CLI package — say so up front instead of letting the
// browser deliver the news. (`pnpm dev` is the loop that avoids this.)
const args = process.argv.slice(2);
const command = args[0];
const wantsServer =
  (command === undefined || command === 'serve' || command === 'demo' || command.startsWith('-')) &&
  !args.some((a) => a === '-h' || a === '--help' || a === '-v' || a === '--version');
if (wantsServer && !existsSync(join(repoRoot, 'packages', 'cli', 'viewer-dist', 'index.html'))) {
  console.error(
    'note: packages/cli/viewer-dist is missing, so the server will show a placeholder page.\n' +
      '      `pnpm build:viewer` puts the real viewer there; `pnpm dev` runs it with hot reload.',
  );
}

const cliJs = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const child = spawn(process.execPath, [cliJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
// Ctrl+C reaches the child through the shared terminal; the CLI handles it
// (demo/serve shut down cleanly), so the parent only mirrors the exit code.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : (code ?? 1)));
