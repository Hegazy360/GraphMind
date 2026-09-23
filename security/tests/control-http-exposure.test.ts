/**
 * The control plane's HTTP surface and credential delivery, attacked
 * (Phase 7, contract C3; refute-security.md S2, S11, S15).
 *
 *   S2   clickjacking: a page frames the viewer and gets a click on "Run
 *        edited" — every response forbids framing
 *   S11  a top-level GET navigation carries no Origin and a loopback Host,
 *        so it passes the origin guard: no GET may mutate, a form cannot
 *        reach the resume endpoint, and no CORS preflight is ever answered
 *   S15  the token must not leak through argv (`ps`), stdout that lands in
 *        CI logs or agent transcripts (`serve --json`), or the server log
 *
 * Everything runs against the published build (`graphmind-ai` dist and
 * `dist/cli.js`), like the rest of this suite.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { startServer, type GraphMindServer } from 'graphmind-ai';
import { CLI_ENTRY } from '../src/harness.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(extra: Parameters<typeof startServer>[0] = {}, logs: string[] = []): Promise<GraphMindServer> {
  const dir = temp('graphmind-http-exposure-');
  const server = await startServer({
    port: 0,
    dbPath: join(dir, 'graphmind.db'),
    log: (line) => logs.push(line),
    ...extra,
    env: { GRAPHMIND_RETENTION: 'off', GRAPHMIND_TELEMETRY: '0', ...extra.env },
  });
  cleanups.push(() => server.close());
  return server;
}

async function until(predicate: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Raw {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function raw(port: number, method: string, path: string, headers: Record<string, string>, body = ''): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close');
      socket.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    let text = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const parsed: Record<string, string> = {};
      for (const line of head.split('\r\n').slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0), headers: parsed, body: split === -1 ? '' : text.slice(split + 4) });
    });
  });
}

/** An app on /ingest holding pause p1, recording every exec.resume it receives. */
async function heldApp(server: GraphMindServer, runId = 'run-held') {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ingest`);
  const resumes: unknown[] = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as { type?: string; payload?: unknown };
    if (frame.type === 'exec.resume') resumes.push(frame.payload);
  });
  await new Promise((resolve) => ws.once('open', resolve));
  cleanups.push(() => ws.close());
  let seq = 0;
  const send = (type: string, id: string, payload: unknown): void =>
    ws.send(JSON.stringify({ gm: PROTOCOL_VERSION, seq: seq++, ts: Date.now(), runId: id, type, payload }));
  send('hello', '*', { versions: { protocol: PROTOCOL_VERSION, client: 'x' }, capabilities: ['pause', 'inject', 'edit-input', 'run-claim'] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  send('run.started', runId, { app: 'held', sdk: { name: 'x', version: '0' } });
  send('exec.paused', runId, { pauseId: 'p1', nodeId: 'tool:x', point: 'before', editable: true });
  await until(() => server.hub.listPauses(runId).length === 1, 5_000, 'held');
  return { resumes, runId };
}

const FRAMING = ["frame-ancestors 'none'", 'DENY'];

describe('S2: the viewer cannot be framed', () => {
  it('HTML, static assets, API answers and errors all forbid framing', async () => {
    const dist = temp('graphmind-viewer-');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><button>Run edited</button>');
    writeFileSync(join(dist, 'app.js'), '1');
    const server = await boot({ viewerDist: dist });
    for (const path of ['/', '/#/run/x', '/app.js', '/nope.png', '/api/runs', '/api/pauses', '/health']) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.headers.get('content-security-policy'), path).toContain(FRAMING[0]);
      expect(response.headers.get('x-frame-options'), path).toBe(FRAMING[1]);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
      if (path.startsWith('/api')) expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

describe('S11: nothing cross-site can resume a pause', () => {
  it('a top-level GET navigation (no Origin, loopback Host) to the control path is 405 and mutates nothing', async () => {
    const server = await boot({ allowControl: 'edit' });
    const app = await heldApp(server);
    const nav = await raw(server.port, 'GET', `/api/runs/${app.runId}/pauses/p1/resume?action=continue`, {
      Host: `127.0.0.1:${server.port}`,
      Accept: 'text/html',
      'Sec-Fetch-Mode': 'navigate',
    });
    expect(nav.status).toBe(405);
    const img = await raw(server.port, 'GET', `/api/runs/${app.runId}/pauses/p1/resume`, { Host: `localhost:${server.port}` });
    expect(img.status).toBe(405);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.resumes).toEqual([]);
    expect(server.hub.listPauses(app.runId)[0]?.state).toBe('open');
  });

  it('an HTML form POST (text/plain, urlencoded, multipart) never reaches the app — not even with a token in the body', async () => {
    const server = await boot({ allowControl: 'edit' });
    const app = await heldApp(server);
    for (const [type, body] of [
      ['text/plain', `{"action":"continue","token":"${server.tokens.agent}"}`],
      ['application/x-www-form-urlencoded', `action=continue&token=${server.tokens.agent}`],
      ['multipart/form-data; boundary=b', `--b\r\nContent-Disposition: form-data; name="action"\r\n\r\ncontinue\r\n--b--`],
    ] as const) {
      const response = await raw(server.port, 'POST', `/api/runs/${app.runId}/pauses/p1/resume`, {
        Host: `127.0.0.1:${server.port}`,
        'Content-Type': type,
      }, body);
      expect(response.status, type).toBe(401);
    }
    expect(app.resumes).toEqual([]);
  });

  it('a CORS preflight is never answered with CORS headers; responses never carry them', async () => {
    const server = await boot({ allowControl: 'edit' });
    const app = await heldApp(server);
    const preflight = await raw(server.port, 'OPTIONS', `/api/runs/${app.runId}/pauses/p1/resume`, {
      Host: `127.0.0.1:${server.port}`,
      Origin: `http://127.0.0.1:${server.port}`,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    });
    expect(preflight.status).toBe(405);
    const post = await fetch(`${server.url}/api/runs/${app.runId}/pauses/p1/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.tokens.agent}` },
      body: JSON.stringify({ action: 'continue', timeoutMs: 1_000 }),
    });
    for (const [name] of [...Object.entries(preflight.headers), ...post.headers.entries()]) {
      expect(name.toLowerCase().startsWith('access-control-'), name).toBe(false);
    }
  });

  it('a DNS-rebinding Host is refused even with a valid token', async () => {
    const server = await boot({ allowControl: 'edit' });
    const app = await heldApp(server);
    const rebound = await raw(server.port, 'POST', `/api/runs/${app.runId}/pauses/p1/resume`, {
      Host: `rebind.attacker.example:${server.port}`,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.tokens.viewer}`,
    }, '{"action":"continue","input":{"x":1}}');
    expect(rebound.status).toBe(403);
    expect(app.resumes).toEqual([]);
  });
});

describe('S15: the token never leaves through argv, stdout or the log', () => {
  it('the browser is opened with the redirect FILE, never with a #token= URL on the command line', async () => {
    if (process.platform === 'win32') return;
    const bin = temp('graphmind-fake-browser-');
    const record = join(bin, 'argv.txt');
    for (const name of ['open', 'xdg-open']) {
      const script = join(bin, name);
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${record}"\n`);
      chmodSync(script, 0o755);
    }
    const oldPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${delimiter}${oldPath ?? ''}`;
    cleanups.push(() => {
      process.env['PATH'] = oldPath;
    });
    const home = temp('graphmind-home-');
    const logs: string[] = [];
    const server = await boot({ runFile: true, openBrowser: true, env: { GRAPHMIND_HOME: home } }, logs);
    await until(() => existsSync(record), 5_000, 'fake browser invoked');
    const argv = readFileSync(record, 'utf8').trim();
    expect(argv).toBe(server.openerPath);
    expect(argv).not.toContain(server.tokens.viewer);
    expect(argv).not.toContain('#token=');
    // The file it points at is private and holds the fragment URL.
    expect(statSync(argv).mode & 0o077).toBe(0);
    expect(readFileSync(argv, 'utf8')).toContain(`/#token=${server.tokens.viewer}`);
    expect(logs.join('\n')).not.toMatch(/gm[va]_[0-9a-f]{32}/);
  });

  it('`graphmind serve --json` prints {port, url, pid, version} only; the agent token stays in the 0600 file', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
      });
    });
    const home = temp('graphmind-serve-json-');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GRAPHMIND')) env[k] = v;
    Object.assign(env, { GRAPHMIND_HOME: home, GRAPHMIND_TELEMETRY: '0', GRAPHMIND_RETENTION: 'off' });
    const child = spawn(process.execPath, [CLI_ENTRY, 'serve', '--json', '--no-open', '--port', String(port), '--db', join(home, 'g.db'), '--allow-control=edit'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(() => {
      child.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    await until(() => stdout.includes('\n'), 15_000, 'serve --json');
    const info = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(['pid', 'port', 'url', 'version']);
    const file = join(home, 'run', `serve-${port}.json`);
    const content = JSON.parse(readFileSync(file, 'utf8')) as { agentToken: string };
    expect(statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? statSync(file).mode & 0o777 : 0o600);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    expect(stdout + stderr).not.toContain(content.agentToken);
    expect(stdout + stderr).not.toMatch(/gm[va]_[0-9a-f]{32}/);
    expect(existsSync(file)).toBe(false);
  }, 30_000);
});
