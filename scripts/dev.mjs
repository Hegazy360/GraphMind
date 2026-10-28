/**
 * `pnpm dev` — the one-command dev loop for working on GraphMind itself.
 *
 * Runs two processes side by side, each line prefixed with its owner:
 *
 *   [server]  the checkout's CLI replaying the bundled demo session, so the
 *             viewer has a real run (with a pause) to show. `--serve` starts
 *             an empty server instead, for attaching your own agent.
 *   [viewer]  the viewer on Vite (port 5199) with hot reload.
 *
 * The server is started with GRAPHMIND_ALLOWED_ORIGINS covering the Vite
 * origin — without that the origin guard 403s the dev viewer's websocket,
 * which is the single most-forgotten incantation of the old workflow.
 *
 *   pnpm dev                 demo server + viewer with hot reload
 *   pnpm dev --serve         empty server + viewer (attach your own agent)
 *   pnpm dev:viewer          viewer only (pairs with ?fixture=1, no server)
 *
 * Builds the workspace packages first when they have never been built; it
 * does not rebuild on changes to packages/* (run `pnpm build:packages`).
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePackagesBuilt, repoRoot } from './ensure-packages-built.mjs';

const VIEWER_DEV_PORT = 5199; // apps/viewer/vite.config.ts, strictPort
const SERVER_PORT = 4747; // packages/cli DEFAULT_PORT, the viewer's dev fallback

const args = new Set(process.argv.slice(2));
const viewerOnly = args.delete('--viewer-only');
const emptyServe = args.delete('--serve');
if (args.size > 0) {
  console.error(`dev.mjs: unknown argument ${[...args][0]} (takes --serve or --viewer-only)`);
  process.exit(1);
}

if (!ensurePackagesBuilt()) process.exit(1);

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // The natural exit (once both children are gone) carries this code; the
  // timer only fires if a child ignores SIGTERM and must be abandoned.
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 2000).unref();
}

/** Spawn with piped output, every line prefixed so the two logs interleave legibly. */
function run(prefix, colorCode, command, cmdArgs, options = {}) {
  const child = spawn(command, cmdArgs, { cwd: repoRoot, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = paint(colorCode, `[${prefix}]`.padEnd(9));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => console.log(`${tag} ${line}`));
  }
  child.on('exit', (code, signal) => {
    if (!shuttingDown) console.log(`${tag} exited (${signal ?? `code ${code}`})`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

if (!viewerOnly) {
  // The Vite origin must be allow-listed or the server 403s its websocket.
  const viteOrigins = `http://localhost:${VIEWER_DEV_PORT},http://127.0.0.1:${VIEWER_DEV_PORT}`;
  const existing = process.env.GRAPHMIND_ALLOWED_ORIGINS;
  run(
    'server',
    36, // cyan
    process.execPath,
    [
      join(repoRoot, 'packages', 'cli', 'dist', 'cli.js'),
      emptyServe ? 'serve' : 'demo',
      '--no-open',
    ],
    {
      env: {
        ...process.env,
        GRAPHMIND_ALLOWED_ORIGINS:
          existing === undefined || existing === '' ? viteOrigins : `${existing},${viteOrigins}`,
      },
    },
  );
}

const viewerDir = join(repoRoot, 'apps', 'viewer');
// vite's `exports` hides its bin script, so go through its package.json.
const vitePkgPath = createRequire(join(viewerDir, 'package.json')).resolve('vite/package.json');
const vitePkg = JSON.parse(readFileSync(vitePkgPath, 'utf8'));
const viteJs = join(dirname(vitePkgPath), typeof vitePkg.bin === 'string' ? vitePkg.bin : vitePkg.bin.vite);
run('viewer', 35, process.execPath, [viteJs], { cwd: viewerDir }); // magenta

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/**
 * A tokenless viewer socket may continue/retry/abort but never inject, edit
 * inputs, or change breakpoints. The server writes its per-start viewer token
 * to `$GRAPHMIND_HOME/run/open-<port>.html`; lift it into a URL on the Vite
 * origin so the hot-reload viewer gets full control too. Local-only, rotates
 * every start — same exposure as the browser `graphmind serve` would open.
 */
function watchForViewerToken(startedAt) {
  const home = process.env.GRAPHMIND_HOME || join(homedir(), '.graphmind');
  const opener = join(home, 'run', `open-${SERVER_PORT}.html`);
  const poll = setInterval(() => {
    try {
      if (statSync(opener).mtimeMs < startedAt) return; // a dead server's file
      const token = /#token=([A-Za-z0-9_.-]+)/.exec(readFileSync(opener, 'utf8'))?.[1];
      if (token === undefined) return;
      clearInterval(poll);
      console.log(
        `${paint(1, '  full-control viewer:')} http://localhost:${VIEWER_DEV_PORT}/#token=${token}\n` +
          '    (without the token the viewer can continue/retry/abort, but not inject or edit)\n',
      );
    } catch {
      // not written yet — keep polling
    }
  }, 300);
  poll.unref();
  setTimeout(() => clearInterval(poll), 15_000).unref();
}
if (!viewerOnly) watchForViewerToken(Date.now());

const banner = [
  '',
  paint(1, '  GraphMind dev loop'),
  `    viewer (hot reload)   http://localhost:${VIEWER_DEV_PORT}`,
  ...(viewerOnly
    ? [`    no server — append ${paint(1, '?fixture=1')} to the URL for a canned run`]
    : [
        `    server${emptyServe ? '' : ' (demo replay)'}   http://127.0.0.1:${SERVER_PORT}`,
        emptyServe
          ? '    point an agent at it, e.g. `pnpm --filter demo-agent start`'
          : '    the demo pauses on its planted bug — resume it from the viewer',
      ]),
  '    Ctrl+C stops everything',
  '',
];
console.log(banner.join('\n'));
