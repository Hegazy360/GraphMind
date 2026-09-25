/**
 * The viewer half of the control credential (contract C3): the `#token=`
 * fragment is taken out of the URL, kept per origin, presented only to this
 * page's own server (subprotocol / Bearer), and dropped when the server
 * refuses it. Plus the audit line: who released a pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, type RunsMap } from '../src/store/applyEvent.js';
import { buildTimeline } from '../src/store/timeline.js';
import { resumerLabel } from '../src/store/types.js';
import { RUN, ev, resetCounters, started } from './helpers.js';

const TOKEN = `gmv_${'a1'.repeat(16)}`;

interface FakeWindow {
  location: { hash: string; pathname: string; search: string; host: string; href: string };
  replaced: string[];
  store: Map<string, string>;
}

function installBrowser(href: string): FakeWindow {
  const url = new URL(href);
  const state: FakeWindow = {
    location: { hash: url.hash, pathname: url.pathname, search: url.search, host: url.host, href: url.href },
    replaced: [],
    store: new Map(),
  };
  vi.stubGlobal('location', state.location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, next: string) => {
      state.replaced.push(next);
      const hashAt = next.indexOf('#');
      state.location.hash = hashAt === -1 ? '' : next.slice(hashAt);
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => state.store.get(k) ?? null,
    setItem: (k: string, v: string) => void state.store.set(k, v),
    removeItem: (k: string) => void state.store.delete(k),
  });
  return state;
}

async function freshAuth() {
  vi.resetModules();
  return await import('../src/connection/auth.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the #token= fragment', () => {
  it('is taken out of the address bar and kept', async () => {
    const browser = installBrowser(`http://127.0.0.1:4747/#token=${TOKEN}`);
    const auth = await freshAuth();
    expect(auth.captureTokenFromLocation()).toBe(TOKEN);
    expect(browser.replaced).toEqual(['/']);
    expect(browser.location.hash).toBe('');
    expect(browser.store.get('graphmind.viewerToken')).toBe(TOKEN);
    expect(auth.viewerToken()).toBe(TOKEN);
  });

  it('keeps a deep link that follows the token, and leaves an ordinary hash alone', async () => {
    const browser = installBrowser(`http://127.0.0.1:4747/?x=1#token=${TOKEN}&/run/abc`);
    const auth = await freshAuth();
    auth.captureTokenFromLocation();
    expect(browser.replaced).toEqual(['/?x=1#/run/abc']);
    const other = installBrowser('http://127.0.0.1:4747/#/run/abc');
    const again = await freshAuth();
    expect(again.captureTokenFromLocation()).toBeUndefined();
    expect(other.replaced).toEqual([]);
  });

  it('ignores a malformed token but still strips it from the URL', async () => {
    const browser = installBrowser('http://127.0.0.1:4747/#token=<script>');
    const auth = await freshAuth();
    expect(auth.captureTokenFromLocation()).toBeUndefined();
    expect(browser.replaced).toEqual(['/']);
    expect(browser.store.size).toBe(0);
  });
});

describe('presenting the token', () => {
  it('only to the server that served the page: subprotocol for the socket, Bearer for HTTP', async () => {
    installBrowser('http://127.0.0.1:4747/');
    const auth = await freshAuth();
    auth.setViewerToken(TOKEN);
    expect(auth.socketProtocols('ws://127.0.0.1:4747/ws/ui')).toEqual(['graphmind.v1', `gm.auth.${TOKEN}`]);
    expect(auth.authHeaders('/api/demo/start')).toEqual({ authorization: `Bearer ${TOKEN}` });
    // Another server (?server=, ?ws=, the dev proxy): never.
    expect(auth.socketProtocols('ws://127.0.0.1:9999/ws/ui')).toBeUndefined();
    expect(auth.authHeaders('http://evil.example/api')).toEqual({});
  });

  it('without a token the socket offers no subprotocol at all (0.5-compatible)', async () => {
    installBrowser('http://127.0.0.1:4747/');
    const auth = await freshAuth();
    expect(auth.socketProtocols('ws://127.0.0.1:4747/ws/ui')).toBeUndefined();
    expect(auth.authHeaders('/api/x')).toEqual({});
  });

  it('a stale token is dropped only when the server says 401, not when it is unreachable', async () => {
    installBrowser('http://127.0.0.1:4747/');
    const auth = await freshAuth();
    auth.setViewerToken(TOKEN);
    const changes: (string | undefined)[] = [];
    auth.onViewerTokenChange((t) => changes.push(t));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await auth.checkTokenAfterFailedConnect(TOKEN);
    expect(auth.viewerToken()).toBe(TOKEN);
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 401 });
    }));
    await auth.checkTokenAfterFailedConnect(TOKEN);
    expect(auth.viewerToken()).toBeUndefined();
    expect(changes).toEqual([undefined]);
    expect(seen[0]?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });
});

describe('the token never leaves this page\'s server, and a refusal only drops the token it was about', () => {
  const T1 = `gmv_${'11'.repeat(16)}`;
  const T2 = `gmv_${'22'.repeat(16)}`;
  const KEY = 'graphmind.viewerToken';

  /** Records every request; answers /api/session like a server that knows only `valid` (a viewer token). */
  function serverKnowing(valid: string | undefined, principal = 'viewer') {
    const sent: { url: string; authorization: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        sent.push({ url: String(input), authorization });
        if (authorization !== undefined && authorization !== `Bearer ${valid}`) return new Response('{}', { status: 401 });
        return new Response(JSON.stringify({ principal: authorization === undefined ? 'anonymous' : principal }), { status: 200 });
      }),
    );
    return sent;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('a failed connect under ?ws=<same host, bad path>&server=<other host> checks the token with this page\'s server only', async () => {
    installBrowser('http://127.0.0.1:4747/?ws=ws://127.0.0.1:4747/nope&server=attacker.example');
    const auth = await freshAuth();
    const conn = await import('../src/connection/ServerConnection.js');
    auth.setViewerToken(TOKEN);
    const serverUrl = conn.resolveServerUrl(location.search);
    expect(serverUrl).toBe('ws://127.0.0.1:4747/nope');
    // The socket to the same host carries the token, so its failure is checked.
    expect(auth.socketProtocols(serverUrl)).toEqual(['graphmind.v1', `gm.auth.${TOKEN}`]);
    const sent = serverKnowing(TOKEN);
    // Whatever the caller hands it — the token the socket presented, or (as
    // 0.6.0-rc did) the `?server=` http base — the check goes to this page's
    // own server and nowhere else.
    const check = auth.checkTokenAfterFailedConnect as (arg: string | undefined) => Promise<void>;
    for (const arg of [auth.tokenFor(serverUrl), conn.resolveHttpBase(location.search)]) await check(arg);
    expect(sent.length).toBeGreaterThan(0);
    const offHost = sent.filter((r) => new URL(r.url, location.href).host !== '127.0.0.1:4747' && r.authorization !== undefined);
    expect(offHost, JSON.stringify(offHost)).toEqual([]);
  });

  it('a 401 for the token this tab presented never erases a newer token another tab stored', async () => {
    const browser = installBrowser(`http://127.0.0.1:4747/#token=${T1}`);
    const auth = await freshAuth();
    auth.captureTokenFromLocation(); // this tab: T1 in memory
    const changes: (string | undefined)[] = [];
    auth.onViewerTokenChange((t) => changes.push(t));
    // `graphmind serve` restarted; its new tab stored T2 in the shared per-origin slot.
    browser.store.set(KEY, T2);
    serverKnowing(T2);
    await auth.checkTokenAfterFailedConnect(T1);
    expect(browser.store.get(KEY)).toBe(T2);
    expect(auth.viewerToken()).toBe(T2);
    // ...and this tab now presents T2 instead of retrying T1 until it gives up.
    expect(changes).toEqual([T2]);
    expect(auth.socketProtocols('ws://127.0.0.1:4747/ws/ui')).toEqual(['graphmind.v1', `gm.auth.${T2}`]);
  });

  it('checks the token the socket presented, not whatever storage holds now', async () => {
    const browser = installBrowser('http://127.0.0.1:4747/');
    const auth = await freshAuth();
    browser.store.set(KEY, T2);
    const sent = serverKnowing(T2);
    await auth.checkTokenAfterFailedConnect(T1);
    expect(sent.map((r) => r.authorization)).toEqual([`Bearer ${T1}`]);
  });

  it('adopts a token another tab stores (a storage event), so a stale tab reconnects with it', async () => {
    const browser = installBrowser(`http://127.0.0.1:4747/#token=${T1}`);
    const handlers: ((event: { key: string | null }) => void)[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (event: { key: string | null }) => void) => {
        if (type === 'storage') handlers.push(fn);
      },
    });
    const auth = await freshAuth();
    auth.captureTokenFromLocation();
    const changes: (string | undefined)[] = [];
    auth.onViewerTokenChange((t) => changes.push(t));
    expect(handlers).toHaveLength(1);
    browser.store.set(KEY, T2);
    for (const handler of handlers) handler({ key: KEY });
    expect(auth.viewerToken()).toBe(T2);
    expect(changes).toEqual([T2]);
    // Other keys, and a removal, change nothing.
    for (const handler of handlers) handler({ key: 'graphmind.theme' });
    browser.store.delete(KEY);
    for (const handler of handlers) handler({ key: KEY });
    expect(auth.viewerToken()).toBe(T2);
    expect(changes).toEqual([T2]);
  });

  it('a #token= another site navigated to never replaces a working token unless this server confirms it', async () => {
    const forged = 'AAAAAAAAAAAAAAAA';
    const browser = installBrowser(`http://127.0.0.1:4747/#token=${forged}`);
    browser.store.set(KEY, T1);
    serverKnowing(T1);
    const auth = await freshAuth();
    auth.captureTokenFromLocation();
    await settle();
    expect(browser.location.hash).toBe(''); // still stripped from the URL
    expect(browser.store.get(KEY)).toBe(T1);
    expect(auth.viewerToken()).toBe(T1);

    // An agent token is not a viewer credential either.
    installBrowser(`http://127.0.0.1:4747/#token=${T2}`).store.set(KEY, T1);
    serverKnowing(T2, 'agent');
    const again = await freshAuth();
    again.captureTokenFromLocation();
    await settle();
    expect(again.viewerToken()).toBe(T1);

    // A restarted server's own new token IS confirmed, and replaces the old one.
    const restarted = installBrowser(`http://127.0.0.1:4747/#token=${T2}`);
    restarted.store.set(KEY, T1);
    serverKnowing(T2);
    const fresh = await freshAuth();
    fresh.captureTokenFromLocation();
    await settle();
    expect(restarted.store.get(KEY)).toBe(T2);
    expect(fresh.viewerToken()).toBe(T2);
  });
});

describe('the audit line: who released a pause', () => {
  beforeEach(resetCounters);

  function reduce(events: ReturnType<typeof ev>[]): RunsMap {
    return events.reduce((runs, event) => applyEvent(runs, event, 'live'), {} as RunsMap);
  }

  it('records the server-stamped principal and operator, and shows "by agent" on the timeline', () => {
    const runs = reduce([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }),
      started('tool:x', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' }),
      ev('exec.resumed', {
        pauseId: 'p1',
        action: 'continue',
        principal: 'agent',
        operator: 'claude code',
        edited: { after: { q: 1 } },
      }),
    ]);
    const pause = runs[RUN]?.pauses['p1'];
    expect(pause).toMatchObject({ resolvedBy: 'agent', resolvedOperator: 'claude code', resolvedEdited: true });
    const run = runs[RUN];
    if (run === undefined) throw new Error('no run');
    const markers = buildTimeline(run, Date.now()).markers;
    expect(markers.some((m) => m.label === 'before → continue (edited) · by agent')).toBe(true);
  });

  it('an app-side release (no principal) says nothing about who', () => {
    const runs = reduce([
      ev('run.started', { app: 'a', sdk: { name: 'ai', version: '7' } }),
      started('tool:x', 'tool'),
      ev('exec.paused', { pauseId: 'p1', nodeId: 'tool:x', point: 'before' }),
      ev('exec.resumed', { pauseId: 'p1', action: 'continue' }),
    ]);
    expect(runs[RUN]?.pauses['p1']?.resolvedBy).toBeUndefined();
  });

  it('names each principal plainly', () => {
    expect(resumerLabel('agent')).toBe('agent');
    expect(resumerLabel('viewer')).toBe('viewer');
    expect(resumerLabel('anonymous')).toBe('tokenless viewer');
    expect(resumerLabel('<b>x</b>')).toBe('unknown');
  });
});
