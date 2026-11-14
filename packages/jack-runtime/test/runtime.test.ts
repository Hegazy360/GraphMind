/**
 * M2 runtime: a manifest served over Streamable HTTP to the official SDK
 * client (2.4), against a real HTTP upstream on 127.0.0.1.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseManifest, type Manifest } from '@graphmind-ai/jack-schema';
import {
  buildRequest,
  createToolHttpHandler,
  headerCredentials,
  isPrivateAddress,
  pick,
  sendUpstream,
  type CallRecord,
  type ToolServerOptions,
} from '../src/index.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const seen: Seen[] = [];
let upstream: HttpServer;
let origin = '';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/items/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/items/'.length));
        if (id === 'missing') {
          res.writeHead(404, { 'content-type': 'application/problem+json' });
          return res.end(JSON.stringify({ title: 'Not found', detail: `no item ${id}` }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id, name: `Item ${id}`, secretInternalField: 'x' }));
      }
      if (url.pathname === '/items' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        const n = Number(url.searchParams.get('limit') ?? 3);
        return res.end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, blob: 'z'.repeat(50) })) }));
      }
      if (url.pathname.startsWith('/items/') && req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/slow') return setTimeout(() => res.end('late'), 2_000);
      if (url.pathname === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        return res.end();
      }
      if (url.pathname === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      if (url.pathname === '/huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ x: 'y'.repeat(200_000) }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

const tool = (over: Record<string, unknown>) => ({
  description: 'A tool used by the runtime tests, with a long enough description.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...over,
});

function manifest(): Manifest {
  return parseManifest({
    version: 1,
    name: 'Test API',
    description: 'Items service used by the runtime tests.',
    upstream: origin,
    tools: [
      tool({
        name: 'get_item',
        annotations: { readOnlyHint: true, title: 'Get item' },
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        http: { method: 'GET', path: '/items/{id}', params: [{ arg: 'id', in: 'path' }] },
        response: { pick: '$.{id,name}' },
      }),
      tool({
        name: 'list_items',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, tag: { type: 'array', items: { type: 'string' } } },
          additionalProperties: false,
        },
        http: { method: 'GET', path: '/items', params: [{ arg: 'limit', in: 'query' }, { arg: 'tag', in: 'query' }] },
        response: { pick: '$.data[*].{id,name}', maxBytes: 1_000 },
      }),
      tool({
        name: 'delete_item',
        annotations: { destructiveHint: true, title: 'Delete item' },
        confirm: true,
        requiredScopes: ['items:write'],
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        http: { method: 'DELETE', path: '/items/{id}', params: [{ arg: 'id', in: 'path' }] },
      }),
      tool({
        name: 'create_item',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, xreq: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        http: {
          method: 'POST',
          path: '/items',
          params: [
            { arg: 'name', in: 'body' },
            { arg: 'xreq', in: 'header', name: 'X-Request-Id' },
          ],
        },
      }),
      tool({ name: 'slow', http: { method: 'GET', path: '/slow', timeoutMs: 1_000 } }),
      tool({ name: 'redirect', http: { method: 'GET', path: '/redirect' } }),
      tool({ name: 'binary', http: { method: 'GET', path: '/binary' } }),
      tool({ name: 'huge', http: { method: 'GET', path: '/huge' } }),
    ],
  });
}

type Confirm = 'accept' | 'decline' | 'never-asked';

async function connect(opts: Partial<ToolServerOptions> = {}, confirm: Confirm = 'accept') {
  const records: CallRecord[] = [];
  const handler = createToolHttpHandler({
    manifest: manifest(),
    egress: 'any',
    credentials: headerCredentials({ authorization: 'Bearer upstream-key-123' }),
    onCall: (r) => records.push(r),
    ...opts,
  });
  let asked = 0;
  const client = new Client(
    { name: 'jack-test', version: '1' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  client.setRequestHandler('elicitation/create', async () => {
    asked++;
    return confirm === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://jack.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return { ...r, text: r.content.map((c) => c.text).join('\n') };
  };
  return { client, call, records, asked: () => asked, close: () => client.close() };
}

describe('protocol', () => {
  it('speaks 2026-07-28 and lists tools with annotations and the server instructions', async () => {
    const c = await connect();
    expect(c.client.getNegotiatedProtocolVersion?.() ?? '2026-07-28').toBe('2026-07-28');
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toContain('get_item');
    const del = tools.find((t) => t.name === 'delete_item');
    expect(del?.annotations).toMatchObject({ destructiveHint: true, title: 'Delete item' });
    expect(c.client.getInstructions()).toBe('Items service used by the runtime tests.');
    await c.close();
  });

  it('rejects 2025-era requests (legacy: reject)', async () => {
    const handler = createToolHttpHandler({ manifest: manifest(), egress: 'any' });
    const res = await handler.fetch(
      new Request('http://jack.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
        }),
      }),
    );
    const text = await res.text();
    expect(text).toMatch(/2026-07-28/);
    expect(text).toMatch(/"error"/);
  });
});

describe('tool calls', () => {
  it('builds the request from the mapping, attaches credentials, and picks fields', async () => {
    const c = await connect();
    seen.length = 0;
    const r = await c.call('get_item', { id: 'a/b ?x' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id: 'a/b ?x', name: 'Item a/b ?x' }); // secretInternalField picked away
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/items/a%2Fb%20%3Fx' });
    expect(seen[0]!.headers.authorization).toBe('Bearer upstream-key-123');
    expect(c.records[0]).toMatchObject({ tool: 'get_item', status: 'ok', upstreamStatus: 200 });
    await c.close();
  });

  it('query arrays repeat; body and header params land in their slots', async () => {
    const c = await connect();
    seen.length = 0;
    await c.call('list_items', { limit: 2, tag: ['a', 'b'] });
    expect(seen[0]!.url).toBe('/items?limit=2&tag=a&tag=b');
    await c.call('create_item', { name: 'New', xreq: 'req-1' });
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/items', body: '{"name":"New"}' });
    expect(seen[1]!.headers['x-request-id']).toBe('req-1');
    expect(seen[1]!.headers['content-type']).toBe('application/json');
    await c.close();
  });

  it('invalid arguments never reach the API, and the model is told why', async () => {
    const c = await connect();
    seen.length = 0;
    const r = await c.call('list_items', { limit: 0, extra: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid arguments for list_items/);
    expect(r.text).toMatch(/limit must be >= 1|additional properties/);
    expect(seen).toHaveLength(0);
    expect(c.records[0]?.status).toBe('invalid_arguments');
    const dot = await c.call('get_item', { id: '..' });
    expect(dot.text).toMatch(/not a valid path value/);
    await c.close();
  });

  it('upstream errors come back as isError with the API explanation', async () => {
    const c = await connect();
    const r = await c.call('get_item', { id: 'missing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/HTTP 404/);
    expect(r.text).toMatch(/no item missing/);
    expect(c.records[0]).toMatchObject({ status: 'upstream_error', upstreamStatus: 404 });
    await c.close();
  });

  it('truncation, binary, redirects, timeouts and the download cap', async () => {
    const c = await connect({ maxResponseBytes: 100_000 });
    const list = await c.call('list_items', { limit: 200 });
    expect(list.text).toMatch(/\[Truncated by Jack: the response was \d+ bytes and this tool returns at most 1000/);
    expect(list.structuredContent).toBeUndefined();
    expect((await c.call('binary')).text).toMatch(/4 bytes of image\/png/);
    const redirect = await c.call('redirect');
    expect(redirect.isError).toBe(true);
    expect(redirect.text).toMatch(/does not follow redirects/);
    expect((await c.call('slow')).text).toMatch(/did not answer within 1s/);
    expect((await c.call('huge')).text).toMatch(/larger than 100000 bytes/);
    expect(c.records.map((r) => r.status)).toEqual(['ok', 'ok', 'upstream_error', 'timeout', 'too_large']);
    await c.close();
  });
});

describe('confirmation (MRTR)', () => {
  it('asks once, then runs the call when the user accepts', async () => {
    const c = await connect({}, 'accept');
    seen.length = 0;
    const r = await c.call('delete_item', { id: 'x1' });
    expect(c.asked()).toBe(1);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/HTTP 204/);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['DELETE /items/x1']);
    await c.close();
  });

  it('does nothing when the user declines', async () => {
    const c = await connect({}, 'decline');
    seen.length = 0;
    const r = await c.call('delete_item', { id: 'x2' });
    expect(c.asked()).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not approve/);
    expect(seen).toHaveLength(0);
    expect(c.records.at(-1)?.status).toBe('declined');
    await c.close();
  });

  it('a pre-filled "confirm" without our signed state is ignored, and forged state is refused', async () => {
    const handler = createToolHttpHandler({ manifest: manifest(), egress: 'any' });
    seen.length = 0;
    const post = (params: Record<string, unknown>) =>
      handler.fetch(
        new Request('http://jack.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-method': 'tools/call',
            'mcp-name': 'delete_item',
            'mcp-protocol-version': '2026-07-28',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
              name: 'delete_item',
              arguments: { id: 'x3' },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
              },
              ...params,
            },
          }),
        }),
      );
    const prefilled = await (await post({ inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } })).text();
    expect(prefilled).toMatch(/input_required/);
    const forged = await (
      await post({ inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }, requestState: 'v1.e30.AAAA' })
    ).text();
    expect(forged).toMatch(/Invalid or expired requestState/);
    expect(seen).toHaveLength(0);
  });
});

describe('scopes', () => {
  it('tools needing scopes the grant lacks are hidden and refused like unknown tools', async () => {
    const c = await connect({ scopesOf: () => ['items:read'] });
    const { tools } = await c.client.listTools();
    expect(tools.some((t) => t.name === 'delete_item')).toBe(false);
    const r = await c.call('delete_item', { id: 'x' });
    expect(r.text).toBe("Unknown tool 'delete_item'.");
    expect(c.asked()).toBe(0);
    await c.close();
  });
});

describe('egress guard', () => {
  it('the public policy refuses loopback, private and metadata addresses, literal or resolved', async () => {
    const c = await connect({ egress: 'public' });
    const r = await c.call('get_item', { id: '1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a public address/);
    expect(c.records[0]?.status).toBe('egress');

    const viaDns = await sendUpstream(
      { url: new URL('http://localhost:1/'), method: 'GET', headers: {} },
      { allowedOrigin: 'http://localhost:1', policy: 'public', timeoutMs: 2_000, maxResponseBytes: 1_000 },
    ).catch((e: Error) => e);
    expect((viaDns as Error).message).toMatch(/resolves to .* not a public address/);
    await c.close();
  });

  it('arguments cannot leave the upstream origin', () => {
    const t = manifest().tools[0]!;
    const req = buildRequest(t, { id: '//evil.test/x' }, origin);
    expect(req.url.origin).toBe(origin);
    expect(req.url.pathname).toBe('/items/%2F%2Fevil.test%2Fx');
    expect(() =>
      buildRequest(
        { ...t, http: { ...t.http, params: [{ arg: 'id', in: 'path' }, { arg: 'h', in: 'header', name: 'Authorization' }] } },
        { id: '1', h: 'Bearer stolen' },
        origin,
      ),
    ).toThrow(/cannot be set by a tool argument/);
  });

  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('pick', () => {
  it('keys, indexes, wildcards and field lists', () => {
    const v = { data: [{ id: 1, a: 'x', b: 'y' }, { id: 2, a: 'z' }], meta: { next: 'c' } };
    expect(pick(v, '$.data[*].{id,a}')).toEqual([{ id: 1, a: 'x' }, { id: 2, a: 'z' }]);
    expect(pick(v, '$.data[1].a')).toBe('z');
    expect(pick(v, '$.{data,meta}.meta.next')).toBe('c');
    expect(pick(v, '$.nope')).toBeUndefined();
    expect(() => pick(v, 'data')).toThrow(/must start with \$/);
  });
});
