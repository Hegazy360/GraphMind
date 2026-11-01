/**
 * "Test connection" for an MCP node: the probe connects the way the generated
 * project will, lists tools, and closes — and reports failure as a message,
 * never as a hang or a thrown error. Over HTTP, the bearer token it was given
 * is scrubbed from whatever comes back and never logged.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeMcpServer } from '../src/builder/mcp-probe.js';
import type { McpServerSpec } from '../src/builder/spec.js';
import { startTestServer, type TestServer } from './helpers.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'mcp-probe-server.mjs');

function stdio(extra: Partial<McpServerSpec> = {}): McpServerSpec {
  return { name: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE], url: '', tools: [], ...extra };
}

describe('probeMcpServer', () => {
  it('connects to a stdio server, names it, and lists its tools', async () => {
    const result = await probeMcpServer(stdio());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server).toEqual({ name: 'probe-fixture', version: '9.9.9' });
    expect(result.tools.map((t) => t.name).sort()).toEqual(['echo', 'now']);
    expect(result.tools.find((t) => t.name === 'echo')?.description).toBe('Echoes its input back.');
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a command that dies before the handshake, with its stderr', async () => {
    const result = await probeMcpServer(stdio({ args: [FIXTURE, '--crash'] }), { timeoutMs: 8_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toBe('');
    expect(result.stderr).toContain('CONFIG_MISSING');
  });

  it('reports a command that does not exist, rather than throwing', async () => {
    const result = await probeMcpServer(stdio({ command: '/nonexistent/definitely-not-a-program' }), { timeoutMs: 8_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/ENOENT|spawn|not found|did not connect/i);
  });

  it('reports an HTTP endpoint that refuses, and scrubs the bearer token from the message', async () => {
    const BEARER = 'tok-SECRETBEARERVALUE-0123456789';
    const result = await probeMcpServer(
      { name: 'remote', transport: 'http', command: '', args: [], url: 'http://127.0.0.1:9/mcp', headerEnv: 'TOK', tools: [] },
      { bearer: BEARER, timeoutMs: 8_000 },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(BEARER);
  });
});

describe('POST /api/builder/mcp/probe', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  async function boot(): Promise<TestServer & { logs: string[] }> {
    const logs: string[] = [];
    const ts = await startTestServer({ log: (line) => logs.push(line) });
    cleanups.push(() => ts.cleanup());
    return { ...ts, logs };
  }

  async function post(port: number, body: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}/api/builder/mcp/probe`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any, text: JSON.stringify(await Promise.resolve()) };
  }

  it('needs no token, validates the node, and answers with the tools', async () => {
    const { port, server, logs } = await boot();
    const open = await post(port, { server: stdio() });
    expect(open.status).toBe(200);
    expect(open.body.ok).toBe(true);

    const bad = await post(port, { server: { name: 'x', transport: 'stdio' } }, server.tokens.viewer);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid-server');

    const ok = await post(port, { server: stdio() }, server.tokens.viewer);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['echo', 'now']);
    // The log names the node and the outcome, nothing else.
    expect(logs.some((line) => line.includes('probed MCP server "fixture"') && line.includes('2 tools'))).toBe(true);
  });

  it('uses a bearer token once and never logs or echoes it', async () => {
    const { port, server, logs } = await boot();
    const BEARER = 'tok-ROUTESECRET-abcdefghijklmnop';
    const result = await post(
      port,
      { server: { name: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp', headerEnv: 'TOK' }, bearer: BEARER },
      server.tokens.viewer,
    );
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain(BEARER);
    expect(logs.join('\n')).not.toContain(BEARER);
    const multiline = await post(port, { server: stdio(), bearer: 'a\nb' }, server.tokens.viewer);
    expect(multiline.status).toBe(400);
  });
});
