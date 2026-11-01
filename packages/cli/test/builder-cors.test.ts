/**
 * The dev viewer's cross-origin problem, at the level it bites.
 *
 * `pnpm dev` serves the viewer from Vite on another port, so every Build page
 * call to `/api/builder/*` is cross-origin. A browser discards such a response
 * unless the server names the asking origin — which is why the page could
 * neither preview code nor create, run or probe anything from the dev loop,
 * however valid its token was.
 *
 * The opt-in is the one the operator already makes for the websocket
 * (`GRAPHMIND_ALLOWED_ORIGINS`), and it is the only way to earn a CORS header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

const DEV_ORIGIN = 'http://localhost:5199';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(allowed?: string): Promise<TestServer> {
  const ts = await startTestServer(allowed === undefined ? {} : { env: { GRAPHMIND_ALLOWED_ORIGINS: allowed } });
  cleanups.push(() => ts.cleanup());
  return ts;
}

function call(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe('CORS on the builder API', () => {
  it('sends no CORS header to anyone when nothing is allow-listed', async () => {
    const { port, server } = await boot();
    for (const origin of [DEV_ORIGIN, 'https://evil.example', `http://127.0.0.1:${port}`]) {
      const response = await call(port, '/api/builder/targets', {
        headers: { origin, authorization: `Bearer ${server.tokens.viewer}` },
      });
      expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('lets an allow-listed origin read the answer, with or without a token', async () => {
    const { port, server } = await boot(DEV_ORIGIN);
    const anonymous = await call(port, '/api/builder/targets', { headers: { origin: DEV_ORIGIN } });
    // The CORS header says "your browser may read this"; the builder asks
    // for no credential, so the dev viewer needs nothing else.
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);

    const authorized = await call(port, '/api/builder/targets', {
      headers: { origin: DEV_ORIGIN, authorization: `Bearer ${server.tokens.viewer}` },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);
    // Cached per origin, and never shared with one that did not ask.
    expect(authorized.headers.get('vary')?.toLowerCase()).toContain('origin');
    expect(authorized.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers the preflight without a credential, naming only what the viewer needs', async () => {
    const { port } = await boot(DEV_ORIGIN);
    const preflight = await call(port, '/api/builder/preview', {
      method: 'OPTIONS',
      headers: {
        origin: DEV_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    // A browser sends no Authorization on a preflight: 401 here would be a deadlock.
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('refuses an origin that was not allow-listed, and tells its browser nothing', async () => {
    const { port, server } = await boot(DEV_ORIGIN);
    const response = await call(port, '/api/builder/targets', {
      headers: { origin: 'https://evil.example', authorization: `Bearer ${server.tokens.viewer}` },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await call(port, '/api/builder/preview', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});
