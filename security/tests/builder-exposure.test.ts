/**
 * The workflow builder's credential path, attacked with a planted key.
 *
 * The builder is the one place in GraphMind where an API key is TYPED INTO
 * THE PRODUCT: the Build page posts it to `/api/builder/projects`, which
 * writes it to the project's `.env`. From there it must reach exactly one
 * thing — the child process's environment — and nothing else: no HTTP
 * response, no project listing, no spec file, no generated source, no
 * server log line. And the routes themselves must be closed to anything
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

  it('is closed to a tokenless caller and to the agent token, GETs included', async () => {
    const { server } = await boot();
    const paths: [string, unknown][] = [
      ['/api/builder/targets', undefined],
      ['/api/builder/projects', undefined],
      ['/api/builder/jobs/job_x', undefined],
      ['/api/builder/preview', { spec: defaultSpec() }],
      ['/api/builder/projects', { spec: defaultSpec() }],
      ['/api/builder/jobs', { dir: '/x' }],
    ];
    for (const [path, body] of paths) {
      const anon = await call(server.url, path, body === undefined ? {} : { body });
      expect(anon.status, `anonymous ${path}`).toBe(401);
      const agent = await call(server.url, path, { token: server.tokens.agent, ...(body === undefined ? {} : { body }) });
      expect(agent.status, `agent ${path}`).toBe(403);
      const viewer = await call(server.url, path, { token: server.tokens.viewer, ...(body === undefined ? {} : { body }) });
      expect([200, 201, 202, 400, 404], `viewer ${path}`).toContain(viewer.status);
    }
    // No builder route ever sets a CORS header a page could use.
    const probe = await fetch(`${server.url}/api/builder/targets`, { headers: { authorization: `Bearer ${server.tokens.viewer}` } });
    expect(probe.headers.get('access-control-allow-origin')).toBeNull();
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
