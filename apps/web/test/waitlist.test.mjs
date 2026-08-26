// Unit tests for api/waitlist.ts with a mocked @vercel/blob.
// Run from apps/web:  node --experimental-test-module-mocks --test test/
// Requires Node >= 22.13 (type stripping + module mocks), matching the repo engines field.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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

const { default: handler } = await import('../api/waitlist.ts');

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
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

test('non-POST methods return 405 (GET, OPTIONS)', async () => {
  for (const method of ['GET', 'OPTIONS', 'PUT', 'DELETE']) {
    const res = await call(method, undefined);
    assert.equal(res.statusCode, 405, `${method} should 405`);
    assert.equal(res.body.ok, false);
    assert.equal(res.headers.allow, 'POST');
  }
});

test('invalid emails return 400', async () => {
  withToken('test-token');
  const invalid = [
    undefined,
    null,
    {},
    { email: '' },
    { email: '   ' },
    { email: 'not-an-email' },
    { email: 'missing@tld' },
    { email: 'two words@example.com' },
    { email: 42 },
    { email: 'a'.repeat(250) + '@example.com' }, // over 254 chars
    'not json {{',
  ];
  for (const body of invalid) {
    const res = await call('POST', body);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} should 400`);
    assert.deepEqual(res.body, { ok: false, error: 'invalid email' });
  }
  assert.equal(putCalls.length, 0, 'no blob writes for invalid input');
});

test('missing BLOB_READ_WRITE_TOKEN returns 503', async () => {
  withToken(undefined);
  const res = await call('POST', { email: 'dev@example.com' });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, error: 'not configured' });
  assert.equal(putCalls.length, 0);
});

test('valid email returns 200 and writes an idempotent blob key', async () => {
  withToken('test-token');
  const res = await call('POST', { email: '  Dev@Example.COM ' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  assert.equal(putCalls.length, 1);
  const { pathname, body, options } = putCalls[0];
  const expectedHash = createHash('sha256').update('dev@example.com').digest('hex');
  assert.equal(pathname, `waitlist/${expectedHash}.json`);
  assert.deepEqual(options, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  const stored = JSON.parse(body);
  assert.equal(stored.email, 'dev@example.com');
  assert.ok(!Number.isNaN(Date.parse(stored.ts)), 'ts is a valid timestamp');
});

test('re-subscribing the same email still returns 200 with the same key', async () => {
  withToken('test-token');
  const res = await call('POST', { email: 'dev@example.com' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].pathname, putCalls[1].pathname);
});

test('string JSON bodies are accepted', async () => {
  withToken('test-token');
  const res = await call('POST', JSON.stringify({ email: 'string-body@example.com' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('blob write failure returns 500', async () => {
  withToken('test-token');
  putShouldThrow = true;
  try {
    const res = await call('POST', { email: 'dev@example.com' });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { ok: false, error: 'storage error' });
  } finally {
    putShouldThrow = false;
  }
});
