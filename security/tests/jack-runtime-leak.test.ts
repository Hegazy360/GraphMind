/**
 * GraphMind Jack, runtime (M2): the upstream credential Jack attaches to
 * every call must never reach the MCP client or the call log — not in a
 * result, not in an error, not on any failure path.
 *
 *   forbidden  the upstream API key (what apikey mode sends as Authorization)
 *   by-design  tool arguments and the API's own response data — the model
 *              asked for them, so they MUST come back (non-vacuity)
 *
 * The upstream is hostile-ish on purpose: it errors, stalls, redirects and
 * oversizes. It never echoes the Authorization header itself — an API that
 * returns its callers' credentials is leaking them on its own; the question
 * here is whether JACK adds a leak.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseManifest } from '@graphmind-ai/jack-schema';
import { createToolHttpHandler, headerCredentials, type CallRecord } from '@graphmind-ai/jack-runtime';

const nonce = randomBytes(8).toString('hex');
const FORBIDDEN_KEY = `upk_CANARY_${nonce}_${randomBytes(16).toString('hex')}`;
const BY_DESIGN_ARG = `arg-${nonce}`;
const BY_DESIGN_DATA = `data-${nonce}`;

let upstream: HttpServer;
let origin = '';
const keysSeenUpstream: string[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    keysSeenUpstream.push(String(req.headers.authorization ?? ''));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/ok/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: decodeURIComponent(path.slice(4)), data: BY_DESIGN_DATA }));
    }
    if (path === '/401') {
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"', 'content-type': 'application/problem+json' });
      return res.end(JSON.stringify({ title: 'Unauthorized', detail: 'token rejected' }));
    }
    if (path === '/500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('internal error');
    }
    if (path === '/redirect') {
      res.writeHead(307, { location: `http://169.254.169.254/?k=x` });
      return res.end();
    }
    if (path === '/slow') return void setTimeout(() => res.end('{}'), 3_000);
    if (path === '/huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ x: 'y'.repeat(300_000) }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

const t = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `Canary tool ${name} used by the secret-leak audit.`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
  http: { method: 'GET', path, params: path.includes('{id}') ? [{ arg: 'id', in: 'path' }] : [], timeoutMs: 1_000 },
  ...extra,
});

describe('jack runtime never returns or logs the upstream credential', () => {
  it('every result, error and call record across success and failure paths', async () => {
    const manifest = parseManifest({
      version: 1,
      name: 'Canary API',
      upstream: origin,
      tools: [
        t('ok', '/ok/{id}'),
        t('unauthorized', '/401'),
        t('server_error', '/500'),
        t('redirect', '/redirect'),
        t('slow', '/slow'),
        t('huge', '/huge'),
        t('confirmed', '/ok/{id}', { confirm: true, annotations: { destructiveHint: true } }),
      ],
    });
    const records: CallRecord[] = [];
    const errors: string[] = [];
    const surfaces: string[] = [];
    const make = (egress: 'any' | 'public') =>
      createToolHttpHandler({
        manifest,
        egress,
        credentials: headerCredentials({ authorization: `Bearer ${FORBIDDEN_KEY}` }),
        onCall: (r) => records.push(r),
        onerror: (e) => errors.push(`${e.message}\n${e.stack ?? ''}`),
        maxResponseBytes: 100_000,
      });

    for (const egress of ['any', 'public'] as const) {
      const handler = make(egress);
      const client = new Client(
        { name: 'audit', version: '1' },
        { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      client.setRequestHandler('elicitation/create', async (req) => {
        surfaces.push(JSON.stringify(req)); // the confirmation prompt is a surface too
        return { action: 'accept', content: { confirm: true } };
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://jack.test/mcp'), {
          fetch: async (url, init) => {
            const res = await handler.fetch(new Request(url, init));
            surfaces.push([...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));
            return res;
          },
        }),
      );
      surfaces.push(JSON.stringify(await client.listTools()));
      const calls: Array<[string, Record<string, unknown>]> = [
        ['ok', { id: BY_DESIGN_ARG }],
        ['unauthorized', {}],
        ['server_error', {}],
        ['redirect', {}],
        ['slow', {}],
        ['huge', {}],
        ['confirmed', { id: BY_DESIGN_ARG }],
        ['ok', { id: 'x', unexpected: FORBIDDEN_KEY.slice(0, 4) }], // invalid arguments
        ['no_such_tool', {}],
      ];
      for (const [name, args] of calls) surfaces.push(JSON.stringify(await client.callTool({ name, arguments: args })));
      await client.close();
      await handler.close();
    }

    const all = [...surfaces, ...records.map((r) => JSON.stringify(r)), ...errors].join('\n---\n');
    expect(all).not.toContain(FORBIDDEN_KEY);
    // Non-vacuity: the key really was sent upstream, and the by-design data really came back.
    expect(keysSeenUpstream).toContain(`Bearer ${FORBIDDEN_KEY}`);
    expect(all).toContain(BY_DESIGN_ARG);
    expect(all).toContain(BY_DESIGN_DATA);
    // And the failure paths really ran (otherwise a silent no-op would pass).
    expect(new Set(records.map((r) => r.status))).toEqual(
      new Set(['ok', 'upstream_error', 'timeout', 'too_large', 'invalid_arguments', 'forbidden', 'egress']),
    );
  });
});
