/**
 * The workflow builder's credential path, attacked with a planted key.
 *
 * The builder is the one place in GraphMind where an API key is TYPED INTO
 * THE PRODUCT: the Build page posts it to `/api/builder/projects`, which
 * either writes it to the project's `.env` or (`persistSecrets: false`)
 * holds it in memory for the session. From there it must reach exactly one
 * thing — the child process's environment — and nothing else: no HTTP
 * response, no project listing, no spec file, no generated source, no
 * server log line, and for a session key, no file ANYWHERE. The routes are
 * open to any caller the origin guard admits — the builder needs no
 * credential (packages/cli/src/builder/routes.ts says why) — unless the
 * operator set GRAPHMIND_BUILDER_REQUIRE_TOKEN=1, and then they are closed to anything
 * but the viewer token: a tokenless local process and the agent token are
 * both refused, GETs included (listing projects reveals what is on disk).
 *
 * Runs against the published build (`graphmind-ai` dist), like the rest of
 * this suite.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSpec, startServer, type GraphMindServer } from 'graphmind-ai';
import { NONCE } from '../src/canaries.js';

const KEY = `sk-ant-api03-CANARYBUILDERKEY${NONCE}`;
const URL_SECRET = `ws://127.0.0.1:4747/ingest?canary=${NONCE}`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(): Promise<{ server: GraphMindServer; home: string; logs: string[] }> {
  const home = mkdtempSync(join(tmpdir(), 'graphmind-builder-exposure-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const logs: string[] = [];
  const server = await startServer({
    port: 0,
    dbPath: join(home, 'graphmind.db'),
    log: (line) => logs.push(line),
    env: { GRAPHMIND_HOME: home, GRAPHMIND_RETENTION: 'off', GRAPHMIND_TELEMETRY: '0' },
  });
  cleanups.push(() => server.close());
  return { server, home, logs };
}

async function call(
  url: string,
  path: string,
  opts: { token?: string; body?: unknown; method?: string } = {},
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${url}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** Every file under `dir`, recursively, except `.env` itself. */
function filesExcludingEnv(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesExcludingEnv(path));
    else if (entry.name !== '.env') out.push(path);
  }
  return out;
}

describe('builder: a typed key reaches .env and nothing else', () => {
  it('no response, listing, spec file, source file or log line carries the key', async () => {
    const { server, home, logs } = await boot();
    const token = server.tokens.viewer;
    const responses: string[] = [];
    const track = async (path: string, opts: Parameters<typeof call>[2]) => {
      const r = await call(server.url, path, opts);
      responses.push(`${path}: ${r.text}`);
      return r;
    };

    const created = await track('/api/builder/projects', {
      token,
      body: { spec: defaultSpec(), secrets: { ANTHROPIC_API_KEY: KEY, GRAPHMIND_URL: URL_SECRET } },
    });
    expect(created.status).toBe(201);
    const dir: string = created.json.dir;
    expect(dir.startsWith(join(home, 'workflows'))).toBe(true);

    // It IS on disk, where it belongs, owner-only.
    const envPath = join(dir, '.env');
    expect(readFileSync(envPath, 'utf8')).toContain(KEY);
    if (process.platform !== 'win32') expect(statSync(envPath).mode & 0o777).toBe(0o600);

    // Every other surface.
    await track(`/api/builder/projects/env?dir=${encodeURIComponent(dir)}`, { token });
    await track('/api/builder/projects', { token });
    await track('/api/builder/preview', { token, body: { spec: defaultSpec() } });
    await track('/api/builder/projects/env', { token, body: { dir, secrets: { OPENAI_API_KEY: `${KEY}-second` } } });
    await track('/api/builder/projects', { token, body: { spec: defaultSpec(), overwrite: true } });
    // A failed create echoes its error message: must not quote the value.
    await track('/api/builder/projects', { token, body: { spec: defaultSpec(), secrets: { ANTHROPIC_API_KEY: `${KEY}\nINJECTED=1` } } });

    for (const response of responses) {
      expect(response, 'HTTP response').not.toContain(KEY);
      expect(response, 'HTTP response').not.toContain(NONCE);
    }
    for (const file of filesExcludingEnv(dir)) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(NONCE);
    }
    expect(logs.join('\n'), 'server log').not.toContain(NONCE);
    expect(existsSync(join(dir, 'graphmind.workflow.json'))).toBe(true);
  });

  it('a session-only key is written nowhere at all, and can be forgotten on demand', async () => {
    const { server, home, logs } = await boot();
    const token = server.tokens.viewer;
    const responses: string[] = [];
    const track = async (path: string, opts: Parameters<typeof call>[2]) => {
      const r = await call(server.url, path, opts);
      responses.push(`${path}: ${r.text}`);
      return r;
    };

    const created = await track('/api/builder/projects', {
      token,
      body: { spec: defaultSpec(), secrets: { ANTHROPIC_API_KEY: KEY }, persistSecrets: false },
    });
    expect(created.status).toBe(201);
    expect(created.json.sessionKeys).toEqual(['ANTHROPIC_API_KEY']);
    const dir: string = created.json.dir;

    // The same key again, after the fact, still memory-only.
    await track('/api/builder/projects/env', {
      token,
      body: { dir, secrets: { OPENAI_API_KEY: `${KEY}-second` }, persist: false },
    });
    await track(`/api/builder/projects/env?dir=${encodeURIComponent(dir)}`, { token });
    await track('/api/builder/projects', { token });

    // Not in .env — there is no .env — and not in any file under the home.
    expect(existsSync(join(dir, '.env'))).toBe(false);
    for (const file of filesExcludingEnv(home)) {
      // the SQLite file is binary; read it as text anyway and look for the canary
      expect(readFileSync(file, 'latin1'), file).not.toContain(NONCE);
    }
    for (const response of responses) {
      expect(response, 'HTTP response').not.toContain(KEY);
      expect(response, 'HTTP response').not.toContain(NONCE);
    }
    expect(logs.join('\n'), 'server log').not.toContain(NONCE);

    // Forget drops it immediately, and says only which names went.
    const forgotten = await call(server.url, '/api/builder/projects/env/forget', { token, body: { dir } });
    expect(forgotten.json.forgotten.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(forgotten.text).not.toContain(NONCE);
    const after = await call(server.url, `/api/builder/projects/env?dir=${encodeURIComponent(dir)}`, { token });
    expect(after.json.sessionKeys).toEqual([]);
  });

  it('is open without a token by default, and closed to all but the viewer token under GRAPHMIND_BUILDER_REQUIRE_TOKEN=1', async () => {
    const paths: [string, unknown][] = [
      ['/api/builder/targets', undefined],
      ['/api/builder/projects', undefined],
      ['/api/builder/jobs/job_x', undefined],
      ['/api/builder/preview', { spec: defaultSpec() }],
      ['/api/builder/projects', { spec: defaultSpec() }],
      ['/api/builder/jobs', { dir: '/x' }],
      ['/api/builder/projects/env/forget', { dir: '/x' }],
    ];
    const { server } = await boot();
    for (const [path, body] of paths) {
      const anon = await call(server.url, path, body === undefined ? {} : { body });
      expect([200, 201, 202, 400, 404], `anonymous ${path}`).toContain(anon.status);
    }

    const home = mkdtempSync(join(tmpdir(), 'graphmind-builder-strict-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const strict = await startServer({
      port: 0,
      dbPath: join(home, 'graphmind.db'),
      log: () => {},
      env: { GRAPHMIND_HOME: home, GRAPHMIND_RETENTION: 'off', GRAPHMIND_TELEMETRY: '0', GRAPHMIND_BUILDER_REQUIRE_TOKEN: '1' },
    });
    cleanups.push(() => strict.close());
    for (const [path, body] of paths) {
      const anon = await call(strict.url, path, body === undefined ? {} : { body });
      expect(anon.status, `strict anonymous ${path}`).toBe(401);
      const agent = await call(strict.url, path, { token: strict.tokens.agent, ...(body === undefined ? {} : { body }) });
      expect(agent.status, `strict agent ${path}`).toBe(403);
      const viewer = await call(strict.url, path, { token: strict.tokens.viewer, ...(body === undefined ? {} : { body }) });
      expect([200, 201, 202, 400, 404], `strict viewer ${path}`).toContain(viewer.status);
    }
    // A browser is told it may read a builder answer only where the operator
    // allow-listed its origin (GRAPHMIND_ALLOWED_ORIGINS, for the viewer's dev
    // server). This server allow-listed nothing, so nobody is told anything —
    // whatever token the request carried, and whatever origin it claimed.
    for (const origin of [undefined, 'https://evil.example', server.url, 'null']) {
      const probe = await fetch(`${server.url}/api/builder/targets`, {
        headers: {
          authorization: `Bearer ${server.tokens.viewer}`,
          ...(origin === undefined ? {} : { origin }),
        },
      });
      expect(probe.headers.get('access-control-allow-origin'), String(origin)).toBeNull();
      expect(probe.headers.get('access-control-allow-credentials'), String(origin)).toBeNull();
    }
  });

  it('runs only directories it created, so the job route cannot start arbitrary commands', async () => {
    const { server, home } = await boot();
    const token = server.tokens.viewer;
    const notOurs = await call(server.url, '/api/builder/jobs', { token, body: { dir: home } });
    expect(notOurs.status).toBe(404);
    expect(notOurs.json.error).toBe('not-a-project');
    const relative = await call(server.url, '/api/builder/jobs', { token, body: { dir: 'workflows/x' } });
    expect(relative.status).toBe(400);
  });
});
