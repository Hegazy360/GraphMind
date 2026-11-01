/**
 * Session-only keys: the Build page's "do not write this down" option.
 *
 * What is tested here is the promise made to the engineer: a key sent with
 * `persist: false` reaches the run and nothing else — no `.env`, no file
 * anywhere under the project, no HTTP response, no log line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSecrets } from '../src/builder/secret-store.js';
import { defaultSpec } from '../src/builder/spec.js';
import { startTestServer, type TestServer } from './helpers.js';

const SECRET = 'sk-ant-api03-SESSIONONLYVALUE0123456789abcdef';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(): Promise<TestServer & { home: string }> {
  const probe = await startTestServer();
  const home = join(probe.dir, 'home');
  await probe.server.close();
  const server = await startTestServer({ env: { GRAPHMIND_HOME: home } });
  cleanups.push(() => server.cleanup());
  cleanups.push(() => probe.cleanup());
  return { ...server, home };
}

async function api(
  port: number,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Every file under `dir`, read as text. */
function allText(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out += allText(path);
    else {
      try {
        out += readFileSync(path, 'utf8');
      } catch {
        // binary or unreadable: it did not come from us
      }
    }
  }
  return out;
}

describe('the session store', () => {
  it('holds values by name, hands them out only to the runner, and forgets them', () => {
    const store = new SessionSecrets();
    expect(store.set('/p', { ANTHROPIC_API_KEY: SECRET })).toEqual(['ANTHROPIC_API_KEY']);
    expect(store.names('/p')).toEqual(['ANTHROPIC_API_KEY']);
    expect(store.values('/p')).toEqual({ ANTHROPIC_API_KEY: SECRET });
    expect(store.dirs()).toEqual(['/p']);
    expect(store.clear('/p')).toEqual(['ANTHROPIC_API_KEY']);
    expect(store.names('/p')).toEqual([]);
    expect(store.values('/p')).toEqual({});
  });

  it('never serializes a value', () => {
    const store = new SessionSecrets();
    store.set('/p', { ANTHROPIC_API_KEY: SECRET });
    expect(JSON.stringify({ store })).not.toContain(SECRET);
    expect(JSON.stringify(store)).not.toContain(SECRET);
  });

  it('expires an entry and refuses what a .env could not hold', () => {
    let now = 1_000;
    const store = new SessionSecrets({ ttlMs: 100, now: () => now });
    store.set('/p', { K: SECRET });
    now += 101;
    expect(store.names('/p')).toEqual([]);
    expect(store.values('/p')).toEqual({});
    expect(() => store.set('/p', { 'lower case': 'x' })).toThrow();
    expect(() => store.set('/p', { K: 'one\ntwo' })).toThrow();
    expect(() => store.set('/p', { K: 42 as unknown as string })).toThrow();
  });

  it('treats the empty string as "forget this one"', () => {
    const store = new SessionSecrets();
    store.set('/p', { A: 'aaaaaa', B: 'bbbbbb' });
    expect(store.set('/p', { A: '' })).toEqual(['B']);
  });
});

describe('a key the engineer asked us not to write down', () => {
  it('never reaches the disk, and the response only ever names it', async () => {
    const { port, server, home } = await boot();
    const token = server.tokens.viewer;
    const created = await api(port, '/api/builder/projects', {
      token,
      body: { spec: defaultSpec(), secrets: { ANTHROPIC_API_KEY: SECRET }, persistSecrets: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.sessionKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(created.body.envWritten).toEqual([]);
    expect(JSON.stringify(created.body)).not.toContain(SECRET);

    const dir: string = created.body.dir;
    // Nothing under the project holds the value, and no .env was created.
    expect(allText(dir)).not.toContain(SECRET);
    expect(allText(home)).not.toContain(SECRET);

    const read = await api(port, `/api/builder/projects/env?dir=${encodeURIComponent(dir)}`, { token });
    expect(read.body.keys).toEqual([]);
    expect(read.body.sessionKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(read.body)).not.toContain(SECRET);

    const listed = await api(port, '/api/builder/projects', { token });
    expect(listed.body.projects[0]?.sessionKeys).toEqual(['ANTHROPIC_API_KEY']);

    const forgotten = await api(port, '/api/builder/projects/env/forget', { token, body: { dir } });
    expect(forgotten.body.forgotten).toEqual(['ANTHROPIC_API_KEY']);
    const after = await api(port, `/api/builder/projects/env?dir=${encodeURIComponent(dir)}`, { token });
    expect(after.body.sessionKeys).toEqual([]);
  });

  it('is still an option after the project exists, without touching .env', async () => {
    const { port, server } = await boot();
    const token = server.tokens.viewer;
    const created = await api(port, '/api/builder/projects', { token, body: { spec: defaultSpec() } });
    const dir: string = created.body.dir;
    const sent = await api(port, '/api/builder/projects/env', {
      token,
      body: { dir, secrets: { ANTHROPIC_API_KEY: SECRET }, persist: false },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.sessionKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(sent.body.written).toEqual([]);
    expect(allText(dir)).not.toContain(SECRET);

    // The default is still "write it to .env".
    const persisted = await api(port, '/api/builder/projects/env', {
      token,
      body: { dir, secrets: { OPENAI_API_KEY: 'sk-written-to-disk-0123456789' } },
    });
    expect(persisted.body.written).toEqual(['OPENAI_API_KEY']);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('OPENAI_API_KEY=');
    expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain(SECRET);
  });
});
