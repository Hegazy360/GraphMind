/**
 * The command surface: argument parsing (especially `--`, which has to hand
 * the child's own flags through untouched), the zero-config guide, and the
 * hard rule that `graphmind mcp-proxy` writes NOTHING to stdout but protocol.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultFlags, parseCliArgs } from '../src/args.js';
import { runMcpProxy } from '../src/commands/mcp-proxy.js';
import { mcpProxyHelp } from '../src/mcp-proxy/help.js';
import { FIXTURES } from './mcp-proxy-harness.js';

const savedTelemetry = process.env['GRAPHMIND_TELEMETRY'];

beforeEach(() => {
  // Never let a test touch the network or write ~/.graphmind/telemetry-id.
  process.env['GRAPHMIND_TELEMETRY'] = '0';
});

afterEach(() => {
  if (savedTelemetry === undefined) delete process.env['GRAPHMIND_TELEMETRY'];
  else process.env['GRAPHMIND_TELEMETRY'] = savedTelemetry;
});

describe('parseCliArgs: the `--` boundary', () => {
  it('hands everything after `--` to the child, unparsed', () => {
    const parsed = parseCliArgs(['mcp-proxy', '--', 'python', '-m', 'my_server', '--port', '9']);
    expect(parsed.command).toBe('mcp-proxy');
    expect(parsed.rest).toEqual(['python', '-m', 'my_server', '--port', '9']);
    // Crucially the child's `--port 9` did NOT become ours.
    expect(parsed.flags.port).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('still parses our own flags before the separator', () => {
    const parsed = parseCliArgs(['mcp-proxy', '--trace', '--port', '4848', '--', 'node', 'x.js']);
    expect(parsed.flags.trace).toBe(true);
    expect(parsed.flags.port).toBe(4848);
    expect(parsed.rest).toEqual(['node', 'x.js']);
  });

  it('keeps a `--help` that belongs to the child away from our help', () => {
    const parsed = parseCliArgs(['mcp-proxy', '--', 'node', 'x.js', '--help']);
    expect(parsed.flags.help).toBe(false);
    expect(parsed.rest).toEqual(['node', 'x.js', '--help']);
  });

  it('leaves `rest` absent when there is no separator', () => {
    expect(parseCliArgs(['mcp-proxy', 'node', 'x.js']).rest).toBeUndefined();
    expect(parseCliArgs(['mcp-proxy', 'node', 'x.js']).positionals).toEqual(['node', 'x.js']);
  });

  it('validates --max-frame-bytes and defaults the new flags off', () => {
    expect(parseCliArgs(['--max-frame-bytes', '10']).errors[0]).toContain('--max-frame-bytes');
    expect(parseCliArgs(['--max-frame-bytes', '65536']).flags.maxFrameBytes).toBe(65536);
    const flags = defaultFlags();
    expect(flags.trace).toBe(false);
    expect(flags.waitForAttach).toBe(false);
    expect(flags.inheritStderr).toBe(false);
    expect(flags.maxFrameBytes).toBeUndefined();
  });
});

describe('graphmind mcp-proxy: zero-config discovery', () => {
  it('explains itself (with a working `claude mcp add`) when given no command', async () => {
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    io.stdout.on('data', (c: Buffer) => out.push(c));
    io.stderr.on('data', (c: Buffer) => err.push(c));

    const code = await runMcpProxy(parseCliArgs(['mcp-proxy']), io);
    expect(code).toBe(1);
    // stdout is the protocol channel even here: not one byte of guidance.
    expect(Buffer.concat(out).length).toBe(0);

    const guide = Buffer.concat(err).toString();
    expect(guide).toContain('graphmind mcp-proxy -- node my-server.js');
    expect(guide).toContain('claude mcp add my-server-debug -- npx -y graphmind-ai mcp-proxy --');
    expect(guide).toContain('python -m my_server');
  });

  it('reflects --port in the guide so the recipe matches the running server', () => {
    expect(mcpProxyHelp(5151).join('\n')).toContain('http://127.0.0.1:5151');
  });
});

describe('graphmind mcp-proxy: end to end through the command', () => {
  it('relays, keeps stdout protocol-only, and returns the child’s exit code', async () => {
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    const out: Buffer[] = [];
    io.stdout.on('data', (c: Buffer) => out.push(c));
    io.stderr.resume();

    const parsed = parseCliArgs([
      'mcp-proxy',
      // A port nothing is listening on: the fail-open path, which is also the
      // normal case for someone who has not started GraphMind yet.
      '--port',
      '1',
      '--',
      process.execPath,
      `${FIXTURES}raw-server.mjs`,
    ]);
    const done = runMcpProxy(parsed, io);
    io.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'via the cli' } },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    io.stdin.end();
    expect(await done).toBe(0);

    const text = Buffer.concat(out).toString();
    expect(text).toContain('via the cli');
    // Every line on stdout parses as JSON-RPC — no banner, no log line.
    for (const line of text.split('\n').filter((l) => l !== '')) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });
});
