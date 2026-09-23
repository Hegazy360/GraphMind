/**
 * The attack CVE-2025-49596 (MCP Inspector, CVSS 9.4) made concrete: a web
 * page the developer happens to have open talks to an unauthenticated
 * localhost service and drives it. For GraphMind the equivalent would be a
 * page sending `exec.resume` — continuing, aborting, or INJECTING a result
 * into an agent the developer is holding at a gate.
 *
 * origin-guard.test.ts proves foreign origins are refused at the door. This
 * file proves the consequence end to end against a REAL held gate: with an
 * app paused, nothing a browser-originated request can do on either the
 * WebSocket or the HTTP surface reaches the app — and the same gate is then
 * resumed by a legitimate viewer, so the hold the test relied on was real.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeApp, FakeUI, fetchJson, startTestServer, waitUntil, type TestServer } from './helpers.js';

const EVIL = 'https://totally-unrelated-site.example';
const REBOUND_HOST = 'graphmind.attacker.example';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(): Promise<TestServer> {
  const ts = await startTestServer();
  cleanups.push(() => ts.cleanup());
  return ts;
}

interface RawResponse {
  status: number;
  body: string;
}

/** One raw HTTP/1.1 request with exactly these headers (undici filters Host). */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close');
      socket.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
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

/** Try to open /ws/ui as a page would; resolve with what happened. */
function attemptUiUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<{ opened: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ opened: false, error: 'timeout' });
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      // Should never get here — but if it did, try the attack anyway so the
      // assertion below fails on the app side, not just here.
      ws.send(JSON.stringify({
        type: 'control',
        envelope: { gm: 1, seq: 0, ts: Date.now(), runId: 'run_held', type: 'exec.resume', payload: { pauseId: 'p1', action: 'inject', output: { pwned: true } } },
      }));
      setTimeout(() => {
        ws.close();
        resolve({ opened: true });
      }, 50);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      resolve({ opened: false, error: error.message });
    });
  });
}

/** An app holding one gate on run `run_held`, with ownership persisted. */
async function holdGate(port: number): Promise<FakeApp> {
  const app = await FakeApp.connect(port, { app: 'victim-agent' });
  app.send('run.started', 'run_held', { app: 'victim-agent', sdk: { name: 'ai', version: '7.0.0' } });
  app.send('exec.paused', 'run_held', { pauseId: 'p1', nodeId: 'tool:transfer', point: 'before' });
  await waitUntil(
    async () => (await fetchJson(port, '/api/runs/run_held/events')).body.total === 2,
    'held run persisted (ownership established)',
  );
  return app;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a browser page cannot resume a held gate', () => {
  it('WebSocket: every browser-originated upgrade is refused, the gate stays held, and a real viewer can still resume it', async () => {
    const { port } = await boot();
    const app = await holdGate(port);

    const attempts = [
      { Origin: EVIL },
      { Origin: 'null' },
      { Origin: 'http://localhost:5199' }, // another local port is still another origin
      { Origin: `http://127.0.0.1:${port}`, Host: `${REBOUND_HOST}:${port}` }, // same-origin-looking, rebound Host
      { Origin: EVIL, Host: `${REBOUND_HOST}:${port}` },
    ];
    for (const headers of attempts) {
      const outcome = await attemptUiUpgrade(port, headers);
      expect(outcome.opened, JSON.stringify(headers)).toBe(false);
      expect(outcome.error, JSON.stringify(headers)).toMatch(/403/);
    }

    // The app never saw a resume: the gate is exactly as held as before.
    await sleep(200);
    expect(app.received.peekAll().filter((e) => e.type === 'exec.resume')).toEqual([]);

    // Non-vacuity: the viewer GraphMind serves itself CAN resume this gate.
    const ui = await FakeUI.connect(port);
    ui.control('exec.resume', 'run_held', { pauseId: 'p1', action: 'continue' });
    const resume = await app.nextControl((e) => e.type === 'exec.resume');
    expect(resume.payload).toMatchObject({ pauseId: 'p1', action: 'continue' });
    await ui.close();
    await app.close();
  });

  it('HTTP: a browser-originated POST is refused before any handler runs — /api/demo/start does not start a run', async () => {
    const { port } = await boot();
    const app = await holdGate(port);

    const foreign = await rawRequest(port, 'POST', '/api/demo/start', {
      Host: `127.0.0.1:${port}`,
      Origin: EVIL,
      'Content-Type': 'application/json',
    }, '{}');
    expect(foreign.status).toBe(403);
    expect(foreign.body).toContain('may not talk to this GraphMind server');

    const rebound = await rawRequest(port, 'POST', '/api/demo/start', {
      Host: `${REBOUND_HOST}:${port}`,
      Origin: `http://${REBOUND_HOST}:${port}`,
      'Content-Type': 'application/json',
    }, '{}');
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain('DNS rebinding');

    // A "simple" cross-site POST (no preflight in a browser) with a form body:
    // still refused, still by the Origin header the page cannot remove.
    const simple = await rawRequest(port, 'POST', '/api/demo/start', {
      Host: `localhost:${port}`,
      Origin: 'null',
      'Content-Type': 'text/plain',
    }, 'x');
    expect(simple.status).toBe(403);

    // No route executed: the only run on this server is still the held one.
    await sleep(200);
    const runs = (await fetchJson(port, '/api/runs')).body.runs as { id: string; source: string }[];
    expect(runs.map((r) => r.id)).toEqual(['run_held']);
    expect(runs.some((r) => r.source === 'demo')).toBe(false);
    expect(app.received.peekAll().filter((e) => e.type === 'exec.resume')).toEqual([]);
    await app.close();
  });

  it('HTTP: a browser-originated request to the resume endpoint (or a guessed one) is 403 (guard), never 401/404', async () => {
    const { port } = await boot();
    for (const [method, path] of [
      // The real control endpoint since 0.6 (contract C3) ...
      ['POST', '/api/runs/run_held/pauses/p1/resume'],
      // ... and guesses at others.
      ['POST', '/api/runs/run_held/resume'],
      ['PUT', '/api/runs/run_held'],
      ['DELETE', '/api/runs/run_held'],
      ['POST', '/ingest'],
      ['GET', '/api/runs/run_held/events'],
    ] as const) {
      const response = await rawRequest(port, method, path, {
        Host: `127.0.0.1:${port}`,
        Origin: EVIL,
        'Content-Type': 'application/json',
      }, '{"action":"continue"}');
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    // Without a browser Origin, a non-GET /api route still needs a credential
    // (0.6): 401 before any router decides whether the route exists.
    const direct = await rawRequest(port, 'POST', '/api/runs/run_held/resume', { Host: `127.0.0.1:${port}` });
    expect(direct.status).toBe(401);
    const real = await rawRequest(port, 'POST', '/api/runs/run_held/pauses/p1/resume', {
      Host: `127.0.0.1:${port}`,
      'Content-Type': 'application/json',
    }, '{"action":"continue"}');
    expect(real.status).toBe(401);
  });
});
