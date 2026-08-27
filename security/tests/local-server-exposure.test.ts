/**
 * Not "what does GraphMind record", but "who can read it, and who can drive
 * it". The recorded data is the user's prompts and tool payloads — by design.
 * That makes the access control around the local server part of the same
 * promise.
 *
 * `graphmind serve` binds 127.0.0.1 and has no auth, which is the right
 * default for a local-first tool ONLY if a web page the user happens to be
 * visiting cannot reach it. Two browser mechanisms say otherwise, and both
 * are now closed in packages/cli/src/origin-guard.ts:
 *
 *   - the WebSocket upgrade on `/ws/ui` and `/ingest` is not covered by the
 *     browser's same-origin policy, so the `Origin` header is checked on the
 *     handshake and a foreign one gets a 403;
 *   - the HTTP API can be reached same-origin via DNS rebinding, so a `Host`
 *     that is not a loopback name is refused.
 *
 * A request with NO `Origin` is allowed: that is how non-browser clients (the
 * SDK, curl, these tests) connect, and a web page can never suppress it.
 *
 * Each test below states the property and then shows what it protects: the
 * canary a hostile page would have exfiltrated, the injected tool result it
 * would have fed the agent.
 */
import { connect } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { startServer, SqliteStorage, type GraphMindServer } from 'graphmind-ai';
import { graphmind } from '@graphmind-ai/anthropic';
import { makeCanaries } from '../src/canaries.js';
import { waitUntil } from '../src/harness.js';

const EVIL_ORIGIN = 'https://totally-unrelated-site.example';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function bootServer(): Promise<GraphMindServer> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-exposure-'));
  const server = await startServer({
    port: 0,
    dbPath: join(dir, 'graphmind.db'),
    openBrowser: false,
    log: () => {},
    env: { GRAPHMIND_RETENTION: 'off' },
  });
  cleanups.push(() => server.close());
  return server;
}

/** A viewer socket, optionally claiming to be a random website. */
class Page {
  readonly frames: Record<string, unknown>[] = [];
  private seq = 0;

  private constructor(private readonly ws: WebSocket) {}

  static async open(server: GraphMindServer, origin?: string): Promise<Page> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/ui`,
      origin === undefined ? {} : { headers: { Origin: origin } },
    );
    const page = new Page(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      setTimeout(() => reject(new Error('upgrade timed out')), 5000);
    });
    ws.on('message', (data) => {
      try {
        page.frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    return page;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  control(runId: string, type: string, payload: unknown): void {
    this.send({
      type: 'control',
      envelope: { gm: PROTOCOL_VERSION, seq: this.seq++, ts: Date.now(), runId, type, payload },
    });
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.frames.filter((frame) => frame['type'] === type);
  }

  /**
   * Subscribe to '*' and then to every run that shows up — exactly what the
   * real viewer does, and all a hostile page would need to tail live
   * executions.
   */
  autoSubscribe(): () => void {
    const seen = new Set<string>();
    this.send({ type: 'subscribe', runId: '*' });
    const timer = setInterval(() => {
      for (const frame of this.frames) {
        const ids: string[] = [];
        if (frame['type'] === 'runs' && Array.isArray(frame['runs'])) {
          for (const run of frame['runs'] as { id?: unknown }[]) {
            if (typeof run.id === 'string') ids.push(run.id);
          }
        }
        if (frame['type'] === 'run.update') {
          const run = frame['run'] as { id?: unknown } | undefined;
          if (typeof run?.id === 'string') ids.push(run.id);
        }
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          this.send({ type: 'subscribe', runId: id });
        }
      }
    }, 10);
    return () => clearInterval(timer);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

describe('cross-origin access to the local viewer socket', () => {
  it('/ws/ui refuses an upgrade from a foreign browser Origin', async () => {
    const server = await bootServer();
    await expect(Page.open(server, EVIL_ORIGIN)).rejects.toThrow(/403/);
    // `Origin: null` is what a sandboxed iframe and a file:// page send.
    await expect(Page.open(server, 'null')).rejects.toThrow(/403/);
    // Another process on this machine is still not this server.
    await expect(Page.open(server, 'http://localhost:5199')).rejects.toThrow(/403/);
  }, 60_000);

  it('the run a hostile page wanted is readable to the viewer the CLI serves, and to nobody else', async () => {
    const server = await bootServer();
    const canaries = makeCanaries('EXPOSE');

    // A run happens, holding a secret the user typed into a prompt.
    const gm = graphmind({
      url: `ws://127.0.0.1:${server.port}/ingest`,
      enabled: true,
      app: 'victim-app',
      waitForAttach: 3000,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    const tools = gm.wrapTools({
      readVault: async () => ({ credential: canaries.value('promptSecret') }),
    });
    await gm.run('victim-run', async () => {
      await tools.readVault();
    });
    await gm.dispose();

    // The page never gets a socket at all.
    await expect(Page.open(server, EVIL_ORIGIN)).rejects.toThrow(/403/);

    // The viewer GraphMind itself serves is same-origin, and still works —
    // proving the canary really is sitting there, one 403 away.
    const viewer = await Page.open(server, `http://127.0.0.1:${server.port}`);
    cleanups.push(() => viewer.close());
    viewer.send({ type: 'subscribe', runId: '*' });
    await waitUntil(() => viewer.ofType('runs').length > 0, 5000, 'a runs snapshot');
    const runs = viewer.ofType('runs')[0]?.['runs'] as { id: string }[] | undefined;
    const runId = runs?.[0]?.id;
    expect(runId).toBeDefined();
    if (runId === undefined) return;
    viewer.send({ type: 'subscribe', runId });
    await waitUntil(() => viewer.ofType('replay.end').length > 0, 5000, 'the replay to finish');
    expect(JSON.stringify(viewer.frames)).toContain(canaries.value('promptSecret'));
  }, 60_000);

  it('a foreign origin cannot arm a breakpoint or inject a tool result', async () => {
    const server = await bootServer();

    // Step 1: the page tries to arm a breakpoint on the victim's tool. It
    // cannot even open the socket, so nothing is armed.
    await expect(Page.open(server, EVIL_ORIGIN)).rejects.toThrow(/403/);

    // A same-origin viewer watches, so an injection attempt would be visible.
    const viewer = await Page.open(server, `http://localhost:${server.port}`);
    cleanups.push(() => viewer.close());
    const stopSubscribing = viewer.autoSubscribe();
    cleanups.push(stopSubscribing);

    // Step 2: the victim app runs its tool.
    const gm = graphmind({
      url: `ws://127.0.0.1:${server.port}/ingest`,
      enabled: true,
      app: 'victim-app',
      waitForAttach: 5000,
      retryIntervalMs: 60_000,
      logger: () => {},
    });
    const tools = gm.wrapTools({
      transferFunds: async () => ({ status: 'sent-to-the-real-account' }),
    });

    const result = await gm.run('victim-run', async () => tools.transferFunds());
    await gm.dispose();
    stopSubscribing();

    // Nothing ever paused, so nothing could be substituted: the agent acted on
    // its own tool's answer.
    const pauses = viewer
      .ofType('event')
      .filter((frame) => (frame['envelope'] as { type?: string } | undefined)?.type === 'exec.paused');
    expect(pauses).toHaveLength(0);
    expect(result).toEqual({ status: 'sent-to-the-real-account' });
  }, 60_000);

  it('/ingest refuses a browser Origin but still accepts the SDK', async () => {
    const server = await bootServer();
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ingest`, {
          headers: { Origin: EVIL_ORIGIN },
        });
        ws.once('open', () => {
          ws.close();
          resolve();
        });
        ws.once('error', reject);
      }),
    ).rejects.toThrow(/403/);

    const sdk = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ingest`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    sdk.close();
  }, 60_000);
});

/**
 * One HTTP/1.1 request with exactly the headers given.
 *
 * `fetch` cannot be used for the rebinding case: undici silently drops a
 * caller-supplied `Host`, so a test written with `fetch` would be asserting on
 * a request it never sent.
 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
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

describe('cross-origin access to the local HTTP API', () => {
  it('sends no CORS headers and refuses the cross-origin request outright', async () => {
    const server = await bootServer();
    const res = await fetch(`${server.url}/api/runs`, { headers: { Origin: EVIL_ORIGIN } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.text()).toContain('GRAPHMIND_ALLOWED_ORIGINS');
  }, 30_000);

  it('refuses requests with a foreign Host header (DNS rebinding)', async () => {
    const server = await bootServer();
    const rebound = await rawRequest(server.port, '/api/runs', {
      Host: 'graphmind.attacker.example',
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain('DNS rebinding');

    const events = await rawRequest(server.port, '/api/runs/anything/events', {
      Host: 'graphmind.attacker.example',
    });
    expect(events.status).toBe(403);
  }, 30_000);

  it('still answers loopback callers, including an SSH-tunnelled port', async () => {
    const server = await bootServer();
    expect((await rawRequest(server.port, '/api/runs', { Host: `127.0.0.1:${server.port}` })).status).toBe(200);
    expect((await rawRequest(server.port, '/health', { Host: 'localhost:8888' })).status).toBe(200);
    expect((await fetch(`${server.url}/api/runs`)).status).toBe(200);
  }, 30_000);
});

describe('on-disk permissions of the recorded database', () => {
  function modeOf(path: string): number {
    return statSync(path).mode & 0o777;
  }

  // POSIX modes are largely inert on Windows; the code path no-ops there.
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('the database and its directory are owner-only (0600 / 0700)', () => {
    const base = mkdtempSync(join(tmpdir(), 'graphmind-perms-'));
    // Let GraphMind create the directory itself, the way it creates
    // ~/.graphmind on first run.
    const dbPath = join(base, 'dot-graphmind', 'graphmind.db');
    const storage = new SqliteStorage(dbPath);
    // Every prompt and tool payload the user ever recorded lives in this file
    // — and in the -wal beside it.
    expect(modeOf(`${dbPath}-wal`) & 0o077).toBe(0);
    storage.close();
    expect(modeOf(dbPath) & 0o077).toBe(0);
    expect(modeOf(join(base, 'dot-graphmind')) & 0o077).toBe(0);
  });
});
