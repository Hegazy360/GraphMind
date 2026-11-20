/**
 * `pnpm test:pg` — the store suites (Circuit journal, Jack, Jack sign-in,
 * accounts, the hosted platform) against a real Postgres, as CI's
 * `postgres-and-site` job runs them.
 *
 *   - PG_TEST_URL set: use that database (it must be a throwaway one).
 *   - Otherwise: start a temporary Postgres from the binaries on PATH
 *     (`initdb`, `pg_ctl`, `createdb`: Homebrew's `postgresql`, apt's
 *     `postgresql`), on a free 127.0.0.1 port, TCP only, in a fresh temp
 *     directory; run the suites; stop it and delete that directory.
 *
 * Builds Circuit and Jack first (the suites import their compiled packages).
 * Exit code: the suites' own.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const shell = process.platform === 'win32';

function run(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', env, shell });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(signal !== null ? 1 : (code ?? 1)));
  });
}

function has(binary) {
  return spawnSync(binary, ['--version'], { stdio: 'ignore', shell }).status === 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  if ((await run('pnpm', ['build:circuit'])) !== 0) return 1;
  if ((await run('pnpm', ['build:jack'])) !== 0) return 1;

  if (process.env.PG_TEST_URL) {
    console.log('test:pg — using PG_TEST_URL');
    return run('pnpm', ['test:stores']);
  }

  const missing = ['initdb', 'pg_ctl', 'createdb'].filter((b) => !has(b));
  if (missing.length > 0) {
    console.error(
      `test:pg: ${missing.join(', ')} not found on PATH. Install Postgres (macOS: brew install postgresql), ` +
        'or set PG_TEST_URL to a throwaway database.',
    );
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), 'graphmind-pg-'));
  const data = join(dir, 'data');
  const port = await freePort();
  const stop = () => {
    spawnSync('pg_ctl', ['-D', data, '-m', 'fast', 'stop'], { stdio: 'ignore', shell });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (spawnSync('initdb', ['-D', data, '-U', 'gm', '--auth=trust'], { stdio: 'ignore', shell }).status !== 0) {
      console.error('test:pg: initdb failed');
      return 1;
    }
    // TCP only (-k ''): a socket path under a long temp dir can exceed the OS limit.
    const started = spawnSync('pg_ctl', ['-D', data, '-o', `-p ${port} -k '' -h 127.0.0.1`, '-l', join(dir, 'pg.log'), '-w', 'start'], {
      stdio: 'ignore',
      shell,
    });
    if (started.status !== 0) {
      console.error(`test:pg: Postgres did not start (log: ${join(dir, 'pg.log')})`);
      return 1;
    }
    if (spawnSync('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'gm', 'gm_test'], { stdio: 'ignore', shell }).status !== 0) {
      console.error('test:pg: createdb failed');
      return 1;
    }
    const url = `postgres://gm@127.0.0.1:${port}/gm_test`;
    console.log(`test:pg — temporary Postgres on 127.0.0.1:${port} (removed afterwards)`);
    return await run('pnpm', ['test:stores'], { ...process.env, PG_TEST_URL: url });
  } finally {
    stop();
  }
}

process.on('SIGINT', () => {});
process.exit(await main());
