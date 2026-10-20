/**
 * `/api/builder/*` over a real server: viewer-token only (401 without, 403
 * for the agent token), preview and create, `.env` by name only, and the
 * job endpoints' refusals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/builder/env-file.js';
import { SPEC_FILE } from '../src/builder/projects.js';
import { defaultSpec } from '../src/builder/spec.js';
import { startTestServer, type TestServer } from './helpers.js';

const SECRET = 'sk-ant-api03-VERYSECRETVALUE0123456789abcdef';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(): Promise<TestServer & { home: string }> {
  const ts = await startTestServer();
  // GRAPHMIND_HOME points at the test's temp dir, so projects land there.
  const home = join(ts.dir, 'home');
  await ts.server.close();
  const withHome = await startTestServer({ env: { GRAPHMIND_HOME: home } });
  cleanups.push(() => withHome.cleanup());
  cleanups.push(() => ts.cleanup());
  return { ...withHome, home };
}

async function api(
  port: number,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

describe('access', () => {
  it('needs a credential on GET too (401), refuses the agent token (403), accepts the viewer token', async () => {
    const { port, server } = await boot();
    const none = await api(port, '/api/builder/targets');
    expect(none.status).toBe(401);
    expect(none.body.error).toBe('unauthorized');

    const agent = await api(port, '/api/builder/targets', { token: server.tokens.agent });
    expect(agent.status).toBe(403);
    expect(agent.body.message).toContain('graphmind init');

    const viewer = await api(port, '/api/builder/targets', { token: server.tokens.viewer });
    expect(viewer.status).toBe(200);
    expect(viewer.body.targets.map((t: { id: string }) => t.id)).toEqual([
      'ts-ai-sdk',
      'ts-anthropic',
      'ts-openai',
      'py-openai',
      'py-anthropic',
    ]);
    expect(viewer.body.defaultSpec.name).toBe('my-agent');
    expect(typeof viewer.body.workflowsDir).toBe('string');
  });

  it('refuses a bogus token on every builder route, POST included', async () => {
    const { port } = await boot();
    for (const [path, body] of [
      ['/api/builder/preview', { spec: defaultSpec() }],
      ['/api/builder/projects', { spec: defaultSpec() }],
      ['/api/builder/jobs', { dir: '/nope' }],
    ] as const) {
      const r = await api(port, path, { token: 'gmv_notarealtoken0000000000000000', body });
      expect(r.status, path).toBe(401);
    }
    expect((await api(port, '/api/builder/projects')).status).toBe(401);
    expect((await api(port, '/api/builder/jobs/job_x')).status).toBe(401);
  });
});

describe('preview', () => {
  it('returns the files Create would write, and validation issues with paths', async () => {
    const { port, server } = await boot();
    const token = server.tokens.viewer;
    const ok = await api(port, '/api/builder/preview', { token, body: { spec: defaultSpec('py-openai') } });
    expect(ok.status).toBe(200);
    expect(ok.body.files.map((f: { path: string }) => f.path)).toContain('main.py');
    expect(ok.body.start).toMatch(/python/);
    expect(ok.body.envKeys[0].name).toBe('OPENAI_API_KEY');

    const bad = await api(port, '/api/builder/preview', {
      token,
      body: { spec: { ...defaultSpec(), name: 'Bad Name', tools: [{ name: 'class', description: 'x' }] } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid-spec');
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['name', 'tools.0.name']));

    const notJson = await fetch(`http://127.0.0.1:${port}/api/builder/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: 'spec=1',
    });
    expect(notJson.status).toBe(400);
  });
});

describe('create, env and listing', () => {
  it('writes the project under GRAPHMIND_HOME, keeps the key out of every response, and lists it', async () => {
    const { port, server, home } = await boot();
    const token = server.tokens.viewer;
    const created = await api(port, '/api/builder/projects', {
      token,
      body: { spec: defaultSpec(), secrets: { ANTHROPIC_API_KEY: SECRET } },
    });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(SECRET);
    expect(created.body.dir).toBe(join(home, 'workflows', 'my-agent'));
    expect(created.body.envWritten).toEqual(['ANTHROPIC_API_KEY']);
    expect(created.body.project.envKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(created.body.install).toEqual(['npm install']);
    expect(existsSync(join(created.body.dir, SPEC_FILE))).toBe(true);
    expect(parseEnvFile(readFileSync(join(created.body.dir, '.env'), 'utf8'))['ANTHROPIC_API_KEY']).toBe(SECRET);

    const again = await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec() } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('exists');

    const envGet = await api(port, `/api/builder/projects/env?dir=${encodeURIComponent(created.body.dir)}`, { token });
    expect(envGet.status).toBe(200);
    expect(envGet.body.keys).toEqual(['ANTHROPIC_API_KEY']);
    expect(envGet.text).not.toContain(SECRET);

    const envPost = await api(port, '/api/builder/projects/env', {
      token,
      body: { dir: created.body.dir, secrets: { GRAPHMIND_URL: 'ws://127.0.0.1:4747/ingest', ANTHROPIC_API_KEY: '' } },
    });
    expect(envPost.status).toBe(200);
    expect(envPost.body.written).toEqual(['GRAPHMIND_URL']);
    expect(envPost.body.removed).toEqual(['ANTHROPIC_API_KEY']);
    expect(envPost.body.keys).toEqual(['GRAPHMIND_URL']);

    const badEnv = await api(port, '/api/builder/projects/env', {
      token,
      body: { dir: created.body.dir, secrets: { ANTHROPIC_API_KEY: 'a\nb' } },
    });
    expect(badEnv.status).toBe(400);

    const list = await api(port, '/api/builder/projects', { token });
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: { name: string }) => p.name)).toEqual(['my-agent']);
    expect(list.body.projects[0].envKeys).toEqual(['GRAPHMIND_URL']);
    expect(list.body.jobs).toEqual([]);
    expect(list.text).not.toContain(SECRET);
  });

  it('rejects bad input shapes', async () => {
    const { port, server } = await boot();
    const token = server.tokens.viewer;
    expect((await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec(), dir: 42 } })).status).toBe(400);
    expect((await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec(), secrets: [1] } })).status).toBe(400);
    expect((await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec(), dir: 'relative' } })).status).toBe(400);
    expect((await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec(), secrets: { bad: 'x' } } })).status).toBe(400);
    expect((await api(port, '/api/builder/projects/env', { token, body: { dir: '/not/a/project', secrets: {} } })).status).toBe(404);
  });
});

describe('jobs', () => {
  it('refuses to run anything that is not a builder project, and 404s unknown jobs', async () => {
    const { port, server, dir } = await boot();
    const token = server.tokens.viewer;
    const notProject = await api(port, '/api/builder/jobs', { token, body: { dir } });
    expect(notProject.status).toBe(404);
    expect(notProject.body.error).toBe('not-a-project');
    expect((await api(port, '/api/builder/jobs', { token, body: { dir: 'relative' } })).status).toBe(400);
    expect((await api(port, '/api/builder/jobs/job_nope', { token })).status).toBe(404);
    expect((await api(port, '/api/builder/jobs/job_nope/stop', { token, method: 'POST', body: {} })).status).toBe(404);
  });
});
