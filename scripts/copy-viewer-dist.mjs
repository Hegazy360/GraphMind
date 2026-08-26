/**
 * Copies the built viewer SPA into the CLI package so `graphmind` can serve
 * it (decision #9: the viewer build ships inside the CLI via `files`).
 *
 * A Node script instead of `rm -rf && cp -R` so the root `build:viewer`
 * script also works on Windows, where pnpm runs package scripts via cmd.exe.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'apps', 'viewer', 'dist');
const target = join(root, 'packages', 'cli', 'viewer-dist');

if (!existsSync(join(source, 'index.html'))) {
  console.error(`copy-viewer-dist: no built viewer at ${source} — run \`pnpm --filter viewer run build\` first`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copy-viewer-dist: ${source} -> ${target}`);
