/**
 * The HTTP surface of the control plane (contract C3): security headers on
 * every response, the resume endpoint's CSRF shape (Bearer + JSON + POST, no
 * CORS), the long-polls and their cap, and the credential files a running
 * server leaves for the CLI and the browser.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_WAITS, MAX_TOKENLESS_WAITS, applySecurityHeaders } from '../src/control-http.js';
import { readRunFile } from '../src/run-files.js';
import type { ServerOptions } from '../src/server.js';
import { getJson, heldApp, postResume, rawRequest, sleep } from './control-helpers.js';
import { FakeApp, startTestServer, waitUntil, type TestServer } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(options: ServerOptions = {}): Promise<TestServer> {
  const ts = await startTestServer(options);
  cleanups.push(() => ts.cleanup());
  return ts;
}

const isPosix = process.platform !== 'win32';

function expectSecurityHeaders(headers: Headers | Record<string, string>, api: boolean, label: string): void {
  const get = (name: string): string | null =>
    headers instanceof Headers ? headers.get(name) : (headers[name] ?? null);
  expect(get('content-security-policy'), label).toContain("frame-ancestors 'none'");
  expect(get('x-frame-options'), label).toBe('DENY');
  expect(get('referrer-policy'), label).toBe('no-referrer');
  expect(get('x-content-type-options'), label).toBe('nosniff');
  if (api) expect(get('cache-control'), label).toBe('no-store');
  for (const cors of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials']) {
    expect(get(cors), `${label}: ${cors}`).toBeNull();
  }
}

describe('security headers on every response', () => {
  it('HTML (placeholder page), API, health, 404, 401, 405 and origin refusals', async () => {
    const ts = await boot();
    const base = `http://127.0.0.1:${ts.port}`;
    const cases: [string, RequestInit, boolean][] = [
      ['/', {}, false],
      ['/some/route', {}, false],
      ['/missing.js', {}, false],
      ['/health', {}, false],
      ['/api/runs', {}, true],
      ['/api/pauses', {}, true],
      ['/api/runs/nope/events', {}, true],
      ['/api/runs/r/pauses/p/resume', {}, true],
      ['/api/runs/r/pauses/p/resume', { method: 'POST' }, true],
      ['/api/demo/start', { method: 'POST' }, true],
    ];
    for (const [path, init, api] of cases) {
      const response = await fetch(`${base}${path}`, init);
      expectSecurityHeaders(response.headers, api, `${init.method ?? 'GET'} ${path} (${response.status})`);
    }
    const refused = await rawRequest(ts.port, 'GET', '/api/runs', { Host: `127.0.0.1:${ts.port}`, Origin: 'https://evil.example' });
    expect(refused.status).toBe(403);
    expectSecurityHeaders(refused.headers, true, 'origin refusal');
  });

  it('the built viewer and its static assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graphmind-viewer-dist-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>viewer</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const ts = await boot({ viewerDist: dir });
    for (const path of ['/', '/assets/app.js', '/deep/link', '/assets/missing.css']) {
      const response = await fetch(`http://127.0.0.1:${ts.port}${path}`);
      expectSecurityHeaders(response.headers, false, `${path} (${response.status})`);
    }
  });

  it('a refused WebSocket upgrade carries them too', async () => {
    const ts = await boot();
    const response = await rawRequest(ts.port, 'GET', '/ws/ui', {
      Host: `127.0.0.1:${ts.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Protocol': 'graphmind.v1, gm.auth.wrong',
    });
    expect(response.status).toBe(401);
    expectSecurityHeaders(response.headers, true, 'refused upgrade');
  });

  it('merges frame-ancestors into an existing CSP instead of replacing it', () => {
    const headers = new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors *" });
    applySecurityHeaders(headers, '/');
    expect(headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    const other = new Headers({ 'content-security-policy': "script-src 'self';" });
    applySecurityHeaders(other, '/x');
    expect(other.get('content-security-policy')).toBe("script-src 'self'; frame-ancestors 'none'");
    expect(other.get('cache-control')).toBeNull();
  });
});

describe('the resume endpoint is not reachable cross-site', () => {
  it('GET, HEAD, PUT, DELETE and OPTIONS on the control path are 405 and change nothing; no CORS preflight answer', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`http://127.0.0.1:${ts.port}/api/runs/${held.runId}/pauses/p1/resume`, {
        method,
        headers: { authorization: `Bearer ${ts.server.tokens.agent}` },
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const preflight = await rawRequest(ts.port, 'OPTIONS', `/api/runs/${held.runId}/pauses/p1/resume`, {
      Host: `127.0.0.1:${ts.port}`,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    });
    expect(preflight.status).toBe(405);
    expect(Object.keys(preflight.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    await sleep(100);
    expect(held.resumes).toEqual([]);
    expect(ts.server.hub.registry.get(held.runId, 'p1')?.state).toBe('open');
    await held.app.close();
  });

  it('form-encodable bodies (text/plain, urlencoded, multipart) are refused, with or without a token', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    const path = `/api/runs/${held.runId}/pauses/p1/resume`;
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-seq']) {
      const withToken = await rawRequest(ts.port, 'POST', path, {
        Host: `127.0.0.1:${ts.port}`,
        'Content-Type': type,
        Authorization: `Bearer ${ts.server.tokens.agent}`,
      }, '{"action":"continue"}');
      expect(withToken.status, type).toBe(415);
      const without = await rawRequest(ts.port, 'POST', path, { Host: `127.0.0.1:${ts.port}`, 'Content-Type': type }, 'action=continue');
      expect(without.status, type).toBe(401);
    }
    expect(held.resumes).toEqual([]);
    await held.app.close();
  });

  it('never reads ?token= or cookies; a browser Origin or a rebinding Host is refused even with a valid token', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    const path = `/api/runs/${held.runId}/pauses/p1/resume`;
    const body = '{"action":"continue"}';
    const query = await rawRequest(ts.port, 'POST', `${path}?token=${ts.server.tokens.agent}`, {
      Host: `127.0.0.1:${ts.port}`,
      'Content-Type': 'application/json',
    }, body);
    expect(query.status).toBe(401);
    const cookie = await rawRequest(ts.port, 'POST', path, {
      Host: `127.0.0.1:${ts.port}`,
      'Content-Type': 'application/json',
      Cookie: `token=${ts.server.tokens.agent}; graphmind_token=${ts.server.tokens.viewer}`,
    }, body);
    expect(cookie.status).toBe(401);
    const foreign = await rawRequest(ts.port, 'POST', path, {
      Host: `127.0.0.1:${ts.port}`,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ts.server.tokens.agent}`,
    }, body);
    expect(foreign.status).toBe(403);
    const rebound = await rawRequest(ts.port, 'POST', path, {
      Host: `graphmind.attacker.example:${ts.port}`,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ts.server.tokens.agent}`,
    }, body);
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain('DNS rebinding');
    expect(held.resumes).toEqual([]);
    await held.app.close();
  });

  it('every non-GET /api route needs a credential; a wrong one is 401 with WWW-Authenticate', async () => {
    const ts = await boot();
    for (const path of ['/api/demo/start', '/api/runs', '/api/anything-new']) {
      const response = await fetch(`http://127.0.0.1:${ts.port}${path}`, { method: 'POST' });
      expect(response.status, path).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    const wrong = await postResume(ts.port, 'r', 'p', { action: 'continue' }, 'gma_0000');
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toContain('unknown');
  });

  it('bad bodies are 400, oversized ones 413, and neither reaches the app', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    const token = ts.server.tokens.agent;
    expect((await postResume(ts.port, held.runId, 'p1', 'not json', token)).status).toBe(400);
    expect((await postResume(ts.port, held.runId, 'p1', '[1]', token)).status).toBe(400);
    expect((await postResume(ts.port, held.runId, 'p1', { action: 'explode' }, token)).status).toBe(400);
    expect((await postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 999_999 }, token)).status).toBe(400);
    expect((await postResume(ts.port, held.runId, 'p1', { action: 'continue', requestId: 5 }, token)).status).toBe(400);
    const huge = await postResume(ts.port, held.runId, 'p1', { action: 'inject', output: 'x'.repeat(17 * 1024 * 1024) }, token);
    expect(huge.status).toBe(413);
    expect(held.resumes).toEqual([]);
    await held.app.close();
  });

  it('GET /api/session says who a token is (and 401s an unknown one)', async () => {
    const ts = await boot({ allowControl: 'inject', editInput: false });
    const anon = await getJson(ts.port, '/api/session');
    expect(anon.body).toMatchObject({ principal: 'anonymous', agentLevel: 'inject', editInput: false, hubCapabilities: ['pause-registry'] });
    const agent = await getJson(ts.port, '/api/session', { authorization: `Bearer ${ts.server.tokens.agent}` });
    expect(agent.body.principal).toBe('agent');
    const bad = await getJson(ts.port, '/api/session', { authorization: 'Bearer nope' });
    expect(bad.status).toBe(401);
  });
});

describe('long-polls', () => {
  it('POST …/resume waits for the answer and times out as 202 {outcome: timeout}', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    const started = Date.now();
    const answer = await postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 1_000 }, ts.server.tokens.agent);
    const elapsed = Date.now() - started;
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ outcome: 'timeout', code: 'no-answer', runId: held.runId, pauseId: 'p1' });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
    await held.app.close();
  });

  it('GET /api/pauses?wait= returns as soon as a pause opens, or reports timedOut', async () => {
    const ts = await boot();
    const empty = await getJson(ts.port, '/api/pauses?wait=0.5');
    expect(empty.body).toEqual({ pauses: [], timedOut: true });
    const pending = getJson(ts.port, '/api/pauses?wait=10');
    await sleep(200);
    const started = Date.now();
    const held = await heldApp(ts.port);
    const answer = await pending;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(answer.body.pauses.map((p: { pauseId: string }) => p.pauseId)).toEqual(['p1']);
    expect(answer.body.timedOut).toBeUndefined();
    // Scoped to a run that has ended: returns at once with the run's status.
    held.app.send('run.finished', held.runId, { status: 'ok' });
    await waitUntil(() => ts.server.hub.getRunInfo(held.runId)?.status === 'ok', 'finished');
    const ended = await getJson(ts.port, `/api/pauses?runId=${held.runId}&wait=10`);
    expect(ended.body).toMatchObject({ pauses: [], run: { id: held.runId, status: 'ok' } });
    expect((await getJson(ts.port, '/api/pauses?wait=-1')).status).toBe(400);
    await held.app.close();
  });

  it('at most 16 long-polls at once: the 17th is 429 and is NOT forwarded', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    for (let i = 2; i <= 17; i += 1) held.hold(`p${i}`);
    await waitUntil(() => ts.server.hub.listPauses().length === 17, '17 pauses');
    const pending = [];
    for (let i = 1; i <= 16; i += 1) {
      pending.push(postResume(ts.port, held.runId, `p${i}`, { action: 'continue', timeoutMs: 2_000 }, ts.server.tokens.agent));
    }
    await waitUntil(() => held.resumes.length === 16, '16 forwarded');
    const refused = await postResume(ts.port, held.runId, 'p17', { action: 'continue' }, ts.server.tokens.agent);
    expect(refused.status).toBe(429);
    const waitRefused = await getJson(ts.port, '/api/pauses?runId=other&wait=5');
    expect(waitRefused.status).toBe(429);
    expect(held.resumes).toHaveLength(16);
    expect(ts.server.hub.registry.get(held.runId, 'p17')?.state).toBe('open');
    const answers = await Promise.all(pending);
    expect(answers.every((a) => a.status === 202 && a.body.outcome === 'timeout')).toBe(true);
    // Slots are free again.
    const after = await postResume(ts.port, held.runId, 'p17', { action: 'continue', timeoutMs: 1_000 }, ts.server.tokens.agent);
    expect(after.status).toBe(202);
    await held.app.close();
  }, 20_000);

  it('GET /api/pauses?runId=&wait= wakes when the run is reconciled to abandoned (the app died), not at its deadline', async () => {
    const ts = await boot({ abandonGraceMs: 200 });
    const app = await FakeApp.connect(ts.port, { app: 'dies' });
    app.send('run.started', 'run-dies', { app: 'dies', sdk: { name: 'test', version: '0.0.0' } });
    app.send('node.started', 'run-dies', { nodeId: 'llm:step', kind: 'llm', name: 'step', instanceId: 'i1' });
    await waitUntil(() => ts.server.hub.getRunInfo('run-dies')?.status === 'running', 'running');
    const pending = getJson(ts.port, '/api/pauses?runId=run-dies&wait=5');
    await sleep(200); // parked
    const crashedAt = Date.now();
    app.ws.terminate(); // no run.finished
    const answer = await pending;
    expect(answer.body).toMatchObject({ pauses: [], run: { id: 'run-dies', status: 'abandoned' } });
    expect(answer.body.timedOut).toBeUndefined();
    expect(Date.now() - crashedAt, 'woken by the abandon, ~grace after the crash').toBeLessThan(2_000);
  });

  it('tokenless long-polls can never take the slots an authenticated resume needs (a local process, or a page\'s <img>)', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'echo' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    /** A raw GET left hanging; `answered()` is what the server sent back so far. */
    const hanging = (path: string, headers: Record<string, string>): Promise<{ answered: () => string }> =>
      new Promise((resolve, reject) => {
        let text = '';
        const socket: Socket = connect(ts.port, '127.0.0.1', () => {
          const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
          socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
          resolve({ answered: () => text });
        });
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
        });
        socket.on('error', (error) => {
          if (text === '') reject(error);
        });
        cleanups.push(() => {
          socket.destroy();
        });
      });
    const waits: { answered: () => string }[] = [];
    for (let i = 0; i < MAX_CONCURRENT_WAITS; i += 1) {
      // Half from a local process; half shaped like a cross-site <img>/no-cors
      // GET (no Origin, loopback *.localhost Host), spread over host aliases.
      const browser = i % 2 === 1;
      waits.push(
        await hanging(`/api/pauses?runId=nope-${i}&wait=120`, {
          Host: browser ? `${['a', 'b', 'c'][i % 3]}.localhost:${ts.port}` : `127.0.0.1:${ts.port}`,
          ...(browser ? { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'cross-site' } : {}),
        }),
      );
    }
    await sleep(300);
    const refused = waits.filter((w) => w.answered().startsWith('HTTP/1.1 429'));
    expect(refused).toHaveLength(MAX_CONCURRENT_WAITS - MAX_TOKENLESS_WAITS);
    expect(waits.filter((w) => w.answered() === '')).toHaveLength(MAX_TOKENLESS_WAITS);
    // The coding agent's resume still goes through.
    const answer = await postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 5_000 }, ts.server.tokens.agent);
    expect({ status: answer.status, outcome: answer.body.outcome }).toEqual({ status: 200, outcome: 'resumed' });
    expect(held.resumes.map((r) => r.pauseId)).toEqual(['p1']);
    // And so does a long-poll that presents a credential (graphmind wait does).
    const authenticated = await fetch(`http://127.0.0.1:${ts.port}/api/pauses?runId=other&wait=0.5`, {
      headers: { authorization: `Bearer ${ts.server.tokens.agent}` },
    });
    expect(authenticated.status).toBe(200);
    await held.app.close();
  }, 20_000);

  it('a waiting resume is answered when the app disconnects', async () => {
    const ts = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitUntil(() => ts.server.hub.registry.get(held.runId, 'p1') !== undefined, 'held');
    const pending = postResume(ts.port, held.runId, 'p1', { action: 'continue', timeoutMs: 20_000 }, ts.server.tokens.agent);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    await held.app.close();
    const answer = await pending;
    expect(answer.body).toMatchObject({ outcome: 'timeout', code: 'app-disconnected' });
  });
});

describe('credential files', () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'graphmind-home-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('writes serve-<port>.json (0600, dir 0700) with the agent token only, and removes it on close', async () => {
    const gmHome = home();
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: gmHome } });
    const runDir = join(gmHome, 'run');
    const file = join(runDir, `serve-${ts.port}.json`);
    const opener = join(runDir, `open-${ts.port}.html`);
    expect(ts.server.runFilePath).toBe(file);
    expect(ts.server.openerPath).toBe(opener);
    const content = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(content).sort()).toEqual(['agentToken', 'pid', 'port', 'url', 'version']);
    expect(content).toMatchObject({
      port: ts.port,
      pid: process.pid,
      url: `http://127.0.0.1:${ts.port}`,
      agentToken: ts.server.tokens.agent,
    });
    expect(readFileSync(file, 'utf8')).not.toContain(ts.server.tokens.viewer);
    if (isPosix) {
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(opener).mode & 0o777).toBe(0o600);
    }
    const read = readRunFile({ GRAPHMIND_HOME: gmHome }, ts.port);
    expect(read.ok && read.content.agentToken).toBe(ts.server.tokens.agent);
    await ts.cleanup();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(opener)).toBe(false);
  });

  it('delivers the viewer token only in the #fragment of a 0600 redirect file', async () => {
    const gmHome = home();
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: gmHome } });
    cleanups.push(() => ts.cleanup());
    const html = readFileSync(ts.server.openerPath as string, 'utf8');
    expect(html).toContain(`http://127.0.0.1:${ts.port}/#token=${ts.server.tokens.viewer}`);
    expect(html).not.toContain('?token=');
    expect(html).not.toContain(ts.server.tokens.agent);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('tightens an existing loose run directory and refuses to trust a readable credential file', async () => {
    if (!isPosix) return;
    const gmHome = home();
    const { chmodSync } = await import('node:fs');
    mkdirSync(join(gmHome, 'run'), { mode: 0o755 });
    chmodSync(join(gmHome, 'run'), 0o755);
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: gmHome } });
    cleanups.push(() => ts.cleanup());
    expect(statSync(join(gmHome, 'run')).mode & 0o777).toBe(0o700);
    chmodSync(ts.server.runFilePath as string, 0o644);
    const read = readRunFile({ GRAPHMIND_HOME: gmHome }, ts.port);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe('insecure');
  });

  it('does not delete a newer server\'s file on the same port', async () => {
    const gmHome = home();
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: gmHome } });
    const file = ts.server.runFilePath as string;
    writeFileSync(file, JSON.stringify({ port: ts.port, pid: 1, url: 'x', agentToken: 'gma_newer', version: '0' }), { mode: 0o600 });
    await ts.cleanup();
    expect(existsSync(file)).toBe(true);
  });

  it('a server that cannot write its files still serves (fail-open) and says so', async () => {
    const gmHome = home();
    writeFileSync(join(gmHome, 'run'), 'not a directory');
    const logs: string[] = [];
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: gmHome }, log: (line) => logs.push(line) });
    cleanups.push(() => ts.cleanup());
    expect(ts.server.runFilePath).toBeUndefined();
    expect(logs.some((line) => line.includes('could not write the control credential files'))).toBe(true);
    expect((await getJson(ts.port, '/health')).status).toBe(200);
  });
});
