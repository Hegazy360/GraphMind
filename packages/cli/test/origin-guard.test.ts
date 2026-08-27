/**
 * The local server's access control.
 *
 * `graphmind serve` binds 127.0.0.1 and has no auth. That is only a boundary
 * if a web page the user visits cannot reach it — and by default a page can:
 * a WebSocket upgrade is exempt from the same-origin policy, and DNS
 * rebinding turns a foreign origin into a same-origin one for `fetch`.
 *
 * The HTTP half is deliberately exercised over a raw socket: undici (Node's
 * `fetch`) silently drops a caller-supplied `Host` header, so `fetch` cannot
 * express the rebinding request at all.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  checkRequestHeaders,
  isHostAllowed,
  isLoopbackHostname,
  isOriginAllowed,
  normalizeOrigin,
  parseOriginPolicy,
} from '../src/origin-guard.js';
import { startTestServer, type TestServer } from './helpers.js';

const EVIL = 'https://totally-unrelated-site.example';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(env?: Record<string, string>): Promise<TestServer> {
  const ts = await startTestServer(env === undefined ? {} : { env });
  cleanups.push(() => ts.cleanup());
  return ts;
}

interface RawResponse {
  status: number;
  body: string;
}

/** One HTTP/1.1 request with exactly the headers given. No undici filtering. */
function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0);
      const split = text.indexOf('\r\n\r\n');
      resolve({ status, body: split === -1 ? '' : text.slice(split + 4) });
    });
  });
}

/** Open a `/ws/ui` socket with a chosen Origin; resolve on open, reject on 403. */
function openUi(port: number, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/ui`,
      origin === undefined ? {} : { headers: { Origin: origin } },
    );
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('upgrade timed out')), 5000);
  });
}

describe('origin policy (unit)', () => {
  it('normalizes to scheme://host with the default port dropped', () => {
    expect(normalizeOrigin('http://LocalHost:80/')).toBe('http://localhost');
    expect(normalizeOrigin('http://localhost')).toBe('http://localhost');
    expect(normalizeOrigin('http://127.0.0.1:4747')).toBe('http://127.0.0.1:4747');
    // A sandboxed iframe and a file:// page both send this. Never a match.
    expect(normalizeOrigin('null')).toBeUndefined();
    expect(normalizeOrigin('')).toBeUndefined();
  });

  it('knows which host names can only mean this machine', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'app.localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', 'localhost.evil.example', '127.0.0.1.evil.example', '10.0.0.1', 'example.com', '']) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it('allows a missing Origin — that is how non-browser clients connect', () => {
    const policy = parseOriginPolicy({});
    expect(isOriginAllowed(undefined, 4747, policy)).toBe(true);
    expect(isOriginAllowed('', 4747, policy)).toBe(true);
  });

  it('allows only this server\'s own origin by default', () => {
    const policy = parseOriginPolicy({});
    expect(isOriginAllowed('http://127.0.0.1:4747', 4747, policy)).toBe(true);
    expect(isOriginAllowed('http://localhost:4747', 4747, policy)).toBe(true);
    // Same machine, different port: still not this server.
    expect(isOriginAllowed('http://localhost:5199', 4747, policy)).toBe(false);
    expect(isOriginAllowed(EVIL, 4747, policy)).toBe(false);
    expect(isOriginAllowed('null', 4747, policy)).toBe(false);
  });

  it('GRAPHMIND_ALLOWED_ORIGINS opens exactly what it names', () => {
    const policy = parseOriginPolicy({
      GRAPHMIND_ALLOWED_ORIGINS: 'http://localhost:5199, http://127.0.0.1:5199',
    });
    expect(isOriginAllowed('http://localhost:5199', 4747, policy)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5199', 4747, policy)).toBe(true);
    expect(isOriginAllowed('http://localhost:5200', 4747, policy)).toBe(false);
    expect(isOriginAllowed(EVIL, 4747, policy)).toBe(false);
  });

  it('GRAPHMIND_ALLOWED_ORIGINS=* is the documented full opt-out', () => {
    const policy = parseOriginPolicy({ GRAPHMIND_ALLOWED_ORIGINS: '*' });
    expect(isOriginAllowed(EVIL, 4747, policy)).toBe(true);
    expect(isHostAllowed('graphmind.attacker.example', policy)).toBe(true);
  });

  it('accepts a loopback Host on any port (SSH tunnels) and nothing else', () => {
    const policy = parseOriginPolicy({});
    expect(isHostAllowed('127.0.0.1:4747', policy)).toBe(true);
    expect(isHostAllowed('localhost:8888', policy)).toBe(true);
    expect(isHostAllowed('[::1]:4747', policy)).toBe(true);
    expect(isHostAllowed(undefined, policy)).toBe(true); // HTTP/1.0
    expect(isHostAllowed('graphmind.attacker.example', policy)).toBe(false);
    expect(isHostAllowed('graphmind.attacker.example:4747', policy)).toBe(false);
  });

  it('reports Host before Origin, so a rebinding request names the real cause', () => {
    const policy = parseOriginPolicy({});
    const rejection = checkRequestHeaders(
      { host: 'graphmind.attacker.example:4747', origin: 'http://graphmind.attacker.example:4747' },
      4747,
      policy,
    );
    expect(rejection?.kind).toBe('host');
    expect(rejection?.message).toContain('GRAPHMIND_ALLOWED_ORIGINS');
  });
});

describe('WS /ws/ui rejects foreign origins', () => {
  it('refuses the upgrade from a random website with a 403', async () => {
    const { port } = await boot();
    await expect(openUi(port, EVIL)).rejects.toThrow(/403/);
  });

  it('refuses Origin: null (sandboxed iframe, file://)', async () => {
    const { port } = await boot();
    await expect(openUi(port, 'null')).rejects.toThrow(/403/);
  });

  it('refuses another loopback port by default', async () => {
    const { port } = await boot();
    await expect(openUi(port, 'http://localhost:5199')).rejects.toThrow(/403/);
  });

  it('accepts its own origin and a client that sends none', async () => {
    const { port } = await boot();
    const sameOrigin = await openUi(port, `http://127.0.0.1:${port}`);
    sameOrigin.close();
    const viaLocalhost = await openUi(port, `http://localhost:${port}`);
    viaLocalhost.close();
    const nonBrowser = await openUi(port);
    nonBrowser.close();
  });

  it('accepts an allow-listed dev origin', async () => {
    const { port } = await boot({ GRAPHMIND_ALLOWED_ORIGINS: 'http://localhost:5199' });
    const dev = await openUi(port, 'http://localhost:5199');
    dev.close();
  });
});

describe('WS /ingest rejects foreign origins', () => {
  it('refuses an upgrade from a page, accepts the SDK (no Origin)', async () => {
    const { port } = await boot();
    const evil = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`, { headers: { Origin: EVIL } });
      ws.once('open', () => reject(new Error('upgrade should have been refused')));
      ws.once('error', () => resolve());
    });
    await evil;

    const sdk = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    sdk.close();
  });
});

describe('HTTP API rejects rebound hosts', () => {
  it('refuses a request whose Host names an attacker domain', async () => {
    const { port } = await boot();
    const response = await rawRequest(port, '/api/runs', { Host: 'graphmind.attacker.example' });
    expect(response.status).toBe(403);
    expect(response.body).toContain('DNS rebinding');
  });

  it('refuses a cross-origin fetch even when the Host is loopback', async () => {
    const { port } = await boot();
    const response = await rawRequest(port, '/api/runs', {
      Host: `127.0.0.1:${port}`,
      Origin: EVIL,
    });
    expect(response.status).toBe(403);
  });

  it('still answers the viewer it serves itself, and plain non-browser clients', async () => {
    const { port } = await boot();
    const sameOrigin = await rawRequest(port, '/api/runs', {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    });
    expect(sameOrigin.status).toBe(200);
    const curl = await rawRequest(port, '/health', { Host: `localhost:${port}` });
    expect(curl.status).toBe(200);
  });

  it('leaves an SSH-tunnelled Host (loopback name, other port) alone', async () => {
    const { port } = await boot();
    const tunnelled = await rawRequest(port, '/health', { Host: 'localhost:8888' });
    expect(tunnelled.status).toBe(200);
  });
});
