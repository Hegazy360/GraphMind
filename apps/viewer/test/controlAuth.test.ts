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
    await auth.checkTokenAfterFailedConnect('');
    expect(auth.viewerToken()).toBe(TOKEN);
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 401 });
    }));
    await auth.checkTokenAfterFailedConnect('');
    expect(auth.viewerToken()).toBeUndefined();
    expect(changes).toEqual([undefined]);
    expect(seen[0]?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
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
