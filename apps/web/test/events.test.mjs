// Unit tests for api/events.ts (the homepage funnel) with a mocked @vercel/blob.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const putCalls = [];
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
mock.module('@vercel/blob', {
  [NODE_MAJOR >= 24 ? 'exports' : 'namedExports']: {
    put: async (pathname, body, options) => {
      putCalls.push({ pathname, body: JSON.parse(body), options });
      return { url: `https://example.public.blob.vercel-storage.com/${pathname}` };
    },
  },
});
const { default: handler, parseWebEvent } = await import('../api/events.ts');

function makeRes() {
  const res = { statusCode: null, body: null, ended: false, headers: {}, setHeader(n, v) { res.headers[n.toLowerCase()] = v; }, status(c) { res.statusCode = c; return res; }, json(p) { res.body = p; }, end() { res.ended = true; } };
  return res;
}
const call = async (method, body) => { const res = makeRes(); await handler({ method, body }, res); return res; };
const valid = (o = {}) => ({ event: 'cta-click', sid: 'k3j9x2m7q1', where: 'hero', ...o });

test('non-POST is 405', async () => {
  for (const m of ['GET', 'OPTIONS']) assert.equal((await call(m)).statusCode, 405);
});

test('only the named events, a short session id and word-shaped labels get through', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 't';
  const bad = [undefined, {}, [], 'nope', valid({ event: 'pageview' }), valid({ event: 'CTA-CLICK' }), valid({ sid: 'x' }), valid({ sid: 'has space!' }),
    valid({ where: 'Hero Button' }), valid({ which: 'x/../y' }), valid({ email: 'a@b.co' }) === undefined ? null : JSON.stringify(valid({ pad: 'x'.repeat(600) }))];
  for (const b of bad) {
    const res = await call('POST', b);
    assert.equal(res.statusCode, 400, JSON.stringify(b)?.slice(0, 60));
  }
  assert.equal(putCalls.length, 0);
  // Unknown keys are ignored, never stored.
  assert.deepEqual(parseWebEvent(valid({ email: 'a@b.co' })), { event: 'cta-click', sid: 'k3j9x2m7q1', where: 'hero' });
});

test('missing token is 503; a valid event is 204 and stored under events/<event>/<day>/', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  assert.equal((await call('POST', valid())).statusCode, 503);
  process.env.BLOB_READ_WRITE_TOKEN = 't';
  const res = await call('POST', valid({ which: 'circuit' }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(putCalls.length, 1);
  const { pathname, body, options } = putCalls[0];
  assert.match(pathname, /^events\/cta-click\/\d{4}-\d{2}-\d{2}\/k3j9x2m7q1-[0-9a-f]{8}\.json$/);
  assert.deepEqual(Object.keys(body).sort(), ['event', 'sid', 'ts', 'where', 'which']);
  assert.equal(options.access, 'private');
});
