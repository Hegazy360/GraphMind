/**
 * The invariant everything else depends on: with no debugger armed, the proxy
 * is invisible. Every test here runs a REAL child process on the server side.
 *
 * No GraphMind server is running in this file (the rig points the session at a
 * dead port), which is also the single most important deployment case: the
 * proxy must relay perfectly when the debugger is not there at all.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FIXTURES, ProxyRig, tick, waitUntil } from './mcp-proxy-harness.js';

/**
 * Run a fixture server directly — no proxy in the pipeline — and collect its
 * stdout. The byte-faithfulness test compares this against what the client
 * sees through the proxy: same bytes in, same bytes out.
 */
function runDirect(script: string, input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${FIXTURES}${script}`], { stdio: 'pipe' });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.write(input);
    child.stdin.end();
  });
}

const CONVERSATION = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"héllo \\u00e9"}}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"boom"}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"softfail"}}',
  '{"jsonrpc":"2.0","id":"str-5","method":"resources/read","params":{"uri":"test://greeting"}}',
  '{"jsonrpc":"2.0","id":6,"method":"prompts/get","params":{"name":"summarize"}}',
].join('\n') + '\n';

describe('mcp-proxy: byte-faithful relaying', () => {
  it('delivers exactly the bytes the server wrote, with no gate armed', async () => {
    const direct = await runDirect('raw-server.mjs', CONVERSATION);
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.sendRaw(CONVERSATION);
    await rig.response(6);
    await rig.close();

    expect(rig.out.equals(direct)).toBe(true);
    // ...and the bytes are genuinely non-canonical, so this is a real test:
    // JSON.parse+stringify would collapse `1.50` and the spaced comma.
    expect(rig.out.toString()).toContain('"jsonrpc":"2.0" , "id":2');
    expect(rig.out.toString()).toContain('"ratio":1.50');
    expect(rig.out.toString()).toContain('caf\\u00e9');
    expect(rig.out.toString()).toContain('"zzz":"ordered-last-on-purpose"');
  });

  it('reassembles frames written one byte at a time', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    const line = '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"echo","arguments":{"text":"drip"}}}\n';
    for (const char of line) rig.sendRaw(char);
    const response = await rig.response(9);
    expect(JSON.stringify(response)).toContain('drip');
    await rig.close();
  });

  it('relays two frames arriving in one chunk, and a frame split across two', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.sendRaw(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"me',
    );
    rig.sendRaw('thod":"ping"}\n');
    await rig.response(1);
    await rig.response(2);
    await rig.response(3);
    await rig.close();
  });

  it('relays a 2 MB payload intact', async () => {
    const size = 2 * 1024 * 1024;
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.callTool(1, 'big', { size });
    const response = (await rig.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text.length).toBe(size);
    await rig.close();
  });

  it('degrades to a raw pipe (instead of breaking) when a frame passes the ceiling', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs', maxFrameBytes: 4096 });
    rig.callTool(1, 'big', { size: 64 * 1024 });
    const response = (await rig.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text.length).toBe(64 * 1024);
    await rig.close();
    expect(rig.logs.join('\n')).toContain('exceeded 4096 bytes');
  });

  it('relays non-JSON garbage verbatim rather than dropping it', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.sendRaw('this is not json\n');
    rig.request(1, 'ping');
    await rig.response(1);
    await rig.close();
    // The server saw the garbage (it logs unparseable lines to stderr).
    expect(rig.err.toString()).toContain('unparseable line: this is not json');
  });

  it('relays a JSON-RPC batch untouched', async () => {
    const batch =
      '[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"ping"}]\n';
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.sendRaw(batch);
    await rig.response(1);
    await rig.response(2);
    await rig.close();
  });
});

describe('mcp-proxy: both directions and concurrency', () => {
  it('keeps interleaved concurrent requests correlated and out-of-order safe', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.callTool('a', 'slow', { ms: 120 });
    rig.callTool('b', 'slow', { ms: 10 });
    rig.callTool('c', 'echo', { text: 'immediate' });

    const first = await rig.nextLine();
    const second = await rig.nextLine();
    const third = await rig.nextLine();
    const order = [first, second, third].map((l) => (JSON.parse(l) as { id: string }).id);
    // The server answers c and b before a: the proxy must not serialize them.
    expect(order).toEqual(['c', 'b', 'a']);
    await rig.close();
  });

  it('relays server-initiated notifications and requests (sampling)', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.callTool(1, 'notify');
    const notification = await rig.nextLine((l) => l.includes('notifications/message'));
    expect(JSON.parse(notification)).toMatchObject({ method: 'notifications/message' });
    await rig.response(1);

    // Server -> client request, answered by the client.
    rig.callTool(2, 'sample');
    const sampling = await rig.nextLine((l) => l.includes('sampling/createMessage'));
    const samplingId = (JSON.parse(sampling) as { id: string }).id;
    rig.send({ jsonrpc: '2.0', id: samplingId, result: { model: 'fake', content: 'sampled' } });
    const answer = (await rig.response(2)) as { result: { content: { text: string }[] } };
    expect(answer.result.content[0]?.text).toContain('sampled');
    await rig.close();
  });

  it('passes the server’s stderr through untouched', async () => {
    const rig = new ProxyRig({ server: 'noisy-server.mjs' });
    rig.request(1, 'ping');
    await rig.response(1);
    await rig.close();
    const err = rig.err.toString();
    expect(err).toContain('noisy-server: booting');
    expect(err).toContain('✓ unicode and \x1b[32mcolour\x1b[0m survive');
    expect(err).toContain('noisy-server: handling ping');
    // Our own diagnostics go to `log`, never into the client's stderr stream.
    expect(err).not.toContain('graphmind mcp-proxy');
  });
});

describe('mcp-proxy: failure modes', () => {
  it('keeps serving after a request the server never answers', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.callTool('lost', 'never');
    await waitUntil(() => rig.err.toString().includes('swallowing'), 'server to swallow the call');
    rig.request('alive', 'ping');
    const pong = await rig.response('alive');
    expect(pong).toMatchObject({ id: 'alive' });
    // The swallowed call is still open — the graph shows it as running.
    expect(rig.handle.reporter.outstanding).toBe(1);
    await rig.close();
    expect(rig.logs.join('\n')).toContain('still unanswered when the server exited');
  });

  it('propagates the exit code when the server dies mid-request', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.callTool(1, 'die');
    const code = await rig.finish();
    expect(code).toBe(3);
  });

  it('shuts down cleanly (code 0) when the client hangs up', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    rig.request(1, 'ping');
    await rig.response(1);
    expect(await rig.close()).toBe(0);
  });

  it('reports a command that does not exist instead of crashing', async () => {
    const rig = new ProxyRig({ command: 'definitely-not-a-real-binary-xyz', args: [] });
    const code = await rig.finish();
    expect(code).toBe(127);
    expect(rig.logs.join('\n')).toContain('cannot run "definitely-not-a-real-binary-xyz"');
  });

  it('works with no TTY and no GraphMind server listening', async () => {
    // The rig always points at a dead port, so every test above already
    // covers this; assert it explicitly because it is the deployment default.
    const rig = new ProxyRig({ server: 'raw-server.mjs' });
    expect(rig.handle.session.attached).toBe(false);
    rig.callTool(1, 'echo', { text: 'detached' });
    const response = (await rig.response(1)) as { result: { content: { text: string }[] } };
    expect(response.result.content[0]?.text).toBe('detached');
    await tick(10);
    expect(rig.handle.session.attached).toBe(false);
    await rig.close();
  });

  it('does not become a zombie when the server ignores the client hanging up', async () => {
    const rig = new ProxyRig({
      server: 'deaf-server.mjs',
      shutdownGraceMs: 150,
      killGraceMs: 150,
    });
    rig.request(1, 'ping');
    await rig.response(1);
    const code = await rig.close();
    // SIGTERM (15) -> 128 + 15. The point is that `close()` returned at all.
    expect(code).toBe(143);
    expect(rig.logs.join('\n')).toContain('client disconnected; asking the server to stop');
  });

  it('hands the server the real stderr fd with --inherit-stderr', async () => {
    const rig = new ProxyRig({ server: 'noisy-server.mjs', captureStderr: false });
    rig.request(1, 'ping');
    await rig.response(1);
    await rig.close();
    // Inherited, so the bytes went straight to this process's stderr and
    // never through the stream we hold.
    expect(rig.err.length).toBe(0);
  });

  it('emits one stderr trace line per frame with --trace', async () => {
    const rig = new ProxyRig({ server: 'raw-server.mjs', trace: true });
    rig.callTool(1, 'echo', { text: 'traced' });
    await rig.response(1);
    await rig.close();
    const logs = rig.logs.join('\n');
    expect(logs).toContain('[client->server] -> tools/call #1');
    expect(logs).toContain('[server->client] <- tools/call #1 ok');
  });
});
