// Unit tests for api/telemetry.ts with a mocked @vercel/blob.
// Run from apps/web:  node --experimental-test-module-mocks --test test/
// Requires Node >= 22.13 (type stripping + module mocks), matching the repo engines field.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const putCalls = [];
let putShouldThrow = false;

mock.module('@vercel/blob', {
  exports: {
    put: async (pathname, body, options) => {
      if (putShouldThrow) throw new Error('blob unavailable');
      putCalls.push({ pathname, body, options });
      return { url: `https://example.public.blob.vercel-storage.com/${pathname}` };
    },
  },
});

const { default: handler } = await import('../api/telemetry.ts');

const INSTALL_ID = '3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d';

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    ended: false,
    headers: {},
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

async function call(method, body) {
  const res = makeRes();
  await handler({ method, body }, res);
  return res;
}

function withToken(value) {
  if (value === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = value;
}

function validBody(overrides = {}) {
  return { event: 'serve', installId: INSTALL_ID, version: '0.0.1', ...overrides };
}

test('non-POST methods return 405 (GET, OPTIONS)', async () => {
  for (const method of ['GET', 'OPTIONS', 'PUT', 'DELETE']) {
    const res = await call(method, undefined);
    assert.equal(res.statusCode, 405, `${method} should 405`);
    assert.equal(res.body.ok, false);
    assert.equal(res.headers.allow, 'POST');
  }
});

test('invalid payloads return 400 and never reach blob storage', async () => {
  withToken('test-token');
  const invalid = [
    undefined,
    null,
    {},
    [],
    'not json {{',
    validBody({ event: undefined }),
    validBody({ event: '' }),
    validBody({ event: 'Serve' }), // uppercase
    validBody({ event: 'run_ingested' }), // underscore
    validBody({ event: 'a'.repeat(64) }), // too long
    validBody({ event: 'x/../escape' }), // path characters
    validBody({ event: 42 }),
    validBody({ installId: undefined }),
    validBody({ installId: 'not-a-uuid' }),
    validBody({ installId: INSTALL_ID + '0' }),
    validBody({ installId: 7 }),
    validBody({ version: undefined }),
    validBody({ version: 'lol' }),
    validBody({ version: '1.2' }),
    validBody({ version: '1.2.3.4' }),
    validBody({ version: 1 }),
    JSON.stringify(validBody({ padding: 'x'.repeat(2048) })), // over the body size cap
  ];
  for (const body of invalid) {
    const res = await call('POST', body);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)?.slice(0, 80)} should 400`);
    assert.deepEqual(res.body, { ok: false, error: 'invalid payload' });
  }
  assert.equal(putCalls.length, 0, 'no blob writes for invalid input');
});

test('missing BLOB_READ_WRITE_TOKEN returns 503', async () => {
  withToken(undefined);
  const res = await call('POST', validBody());
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, error: 'not configured' });
  assert.equal(putCalls.length, 0);
});

test('valid event returns 204 with no body and writes the expected blob', async () => {
  withToken('test-token');
  const res = await call('POST', validBody());
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(res.body, null, 'success must not echo anything back');

  assert.equal(putCalls.length, 1);
  const { pathname, body, options } = putCalls[0];
  assert.match(
    pathname,
    new RegExp(`^telemetry/serve/\\d{4}-\\d{2}-\\d{2}/${INSTALL_ID}-[0-9a-f]{8}\\.json$`),
  );
  assert.deepEqual(options, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  const stored = JSON.parse(body);
  assert.deepEqual(Object.keys(stored).sort(), ['event', 'installId', 'ts', 'version']);
  assert.equal(stored.event, 'serve');
  assert.equal(stored.installId, INSTALL_ID);
  assert.equal(stored.version, '0.0.1');
  assert.ok(!Number.isNaN(Date.parse(stored.ts)), 'ts is a valid timestamp');
});

test('client ts is ignored: the server stamps its own timestamp', async () => {
  withToken('test-token');
  const res = await call('POST', validBody({ ts: '1999-01-01T00:00:00.000Z' }));
  assert.equal(res.statusCode, 204);
  const stored = JSON.parse(putCalls.at(-1).body);
  assert.notEqual(stored.ts, '1999-01-01T00:00:00.000Z');
  assert.ok(Date.parse(stored.ts) > Date.parse('2026-01-01'), 'ts is server time');
});

test('string JSON bodies and uppercase install ids are accepted (id normalized)', async () => {
  withToken('test-token');
  const res = await call('POST', JSON.stringify(validBody({ installId: INSTALL_ID.toUpperCase() })));
  assert.equal(res.statusCode, 204);
  const stored = JSON.parse(putCalls.at(-1).body);
  assert.equal(stored.installId, INSTALL_ID);
});

test('repeat events get distinct random-suffixed keys', async () => {
  withToken('test-token');
  const before = putCalls.length;
  await call('POST', validBody());
  await call('POST', validBody());
  assert.equal(putCalls.length, before + 2);
  assert.notEqual(putCalls.at(-1).pathname, putCalls.at(-2).pathname);
});

test('blob write failure returns 500', async () => {
  withToken('test-token');
  putShouldThrow = true;
  try {
    const res = await call('POST', validBody());
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { ok: false, error: 'storage error' });
  } finally {
    putShouldThrow = false;
  }
});
