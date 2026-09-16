/**
 * Adversarial coverage for the session shape and the two "silent failure"
 * diagnostics — the edge cases a user hits that the happy-path suite
 * (mcp-proxy-shape.test.ts) does not: a structured logger (pino/bunyan)
 * writing VALID JSON to stdout, a debugger dying while it holds a protocol
 * node, `initialize` itself failing under the default error gate, a burst
 * of concurrent protocol frames, binary and megabyte-sized noise, and a
 * spawn that throws with nobody listening.
 *
 * Same rig as the other proxy suites: a real `@graphmind-ai/client` session,
 * a real WebSocket viewer double, a real child process.
 */
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { ATTACH_WAIT_MS, SPAWN_FAILURE_ATTACH_MS } from '../src/mcp-proxy/proxy.js';
import { STDOUT_NOISE_MAX_RECORDED } from '../src/mcp-proxy/reporter.js';
import { FakeViewer, ProxyRig, tick, waitUntil, type ReceivedFrame } from './mcp-proxy-harness.js';

let viewer: FakeViewer | undefined;
let rig: ProxyRig | undefined;

afterEach(async () => {
  if (rig !== undefined) {
    rig.endClient();
    await Promise.race([rig.handle.done, tick(3000)]);
    rig.handle.stop('SIGKILL');
    rig = undefined;
  }
  if (viewer !== undefined) {
    await viewer.close();
    viewer = undefined;
  }
});

type RigInit = ConstructorParameters<typeof ProxyRig>[0];

/**
 * A minimal stdio server as a `node -e` script: runs `prelude` on boot (that
 * is where each test plants its misbehaviour), then answers every request
 * with `{ok:true}` — or, with INIT_FAILS=1, answers `initialize` with a
 * JSON-RPC error the way a server rejecting the protocol version does; with
 * MUTE=1 it answers nothing at all.
 */
function inlineServer(prelude: string): string[] {
  return [
    '-e',
    `
    const { stdin, stdout } = require('node:process');
    ${prelude}
    let buffer = '';
    stdin.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === undefined || process.env.MUTE === '1') continue;
        if (message.method === 'initialize' && process.env.INIT_FAILS === '1') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unsupported protocol version' } }) + '\\n');
        } else {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) + '\\n');
        }
      }
    });
    `,
  ];
}

const PINO_LINE = JSON.stringify({ level: 30, time: 1726284000000, pid: 4242, msg: 'server started' });

async function attach(
  options: { breakpoints?: Parameters<FakeViewer['setBreakpoint']>[0][] } & RigInit = {},
): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  const { breakpoints, ...rest } = options;
  viewer = await FakeViewer.start({ breakpoints: breakpoints ?? [] });
  rig = new ProxyRig({ viewerUrl: viewer.url, waitForAttach: true, ...rest });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

const startOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.started').find((f) => f.payload['nodeId'] === nodeId);
const finishOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.finished').find((f) => f.payload['nodeId'] === nodeId);
const noiseStarts = (v: FakeViewer): ReceivedFrame[] =>
  v.ofType('node.started').filter((f) => f.payload['nodeId'] === 'mcp:stdout-noise');

async function closeRun(v: FakeViewer, r: ProxyRig): Promise<void> {
  r.endClient();
  await r.handle.done;
  await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
  rig = undefined;
}

// ── stdout noise that IS valid JSON ─────────────────────────────────────────

describe('mcp-proxy: a structured logger (valid JSON, not JSON-RPC) on stdout', () => {
  it('a pino-style log line is stdout noise: warned once, recorded under mcp:protocol, counted', async () => {
    // The production-grade version of console.log: pino/bunyan/winston-json
    // write one JSON object per line to stdout by default. The MCP client
    // rejects it exactly like plain text (its schema parse fails), so the
    // proxy must not treat it as a frame just because JSON.parse succeeded.
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(`stdout.write(${JSON.stringify(PINO_LINE)} + '\\n');`),
    });
    // Only WORK in this session: the group must exist because of the noise
    // alone, with calls: 0.
    r.callTool(1, 'echo', { text: 'work' });
    await r.response(1);

    await waitUntil(() => r.logs.some((l) => l.includes('wrote a line to stdout that is not JSON-RPC')), 'the stdout warning');
    const warnings = r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('server started');
    expect(warnings[0]).toContain('stdout is the MCP wire; log to stderr');
    // Relayed byte-for-byte all the same.
    expect(r.out.toString()).toContain(`${PINO_LINE}\n`);

    const noise = await v.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'mcp:stdout-noise',
    );
    expect(noise.payload).toMatchObject({
      parentId: 'mcp:protocol',
      input: { text: PINO_LINE, bytes: Buffer.byteLength(PINO_LINE), truncated: false, count: 1 },
    });
    expect(startOf(v, 'mcp:protocol')?.payload['collapsed']).toBe(true);
    expect(startOf(v, 'tool:echo')?.payload['parentId']).toBe('mcp:session');

    await closeRun(v, r);
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toEqual({
      calls: 0,
      errors: 0,
      stdoutNoise: 1,
    });
    expect(r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'))).toHaveLength(1);
    expect(r.logs.find((l) => l.includes('1 line(s) the server wrote to stdout'))).toContain(
      'were not JSON-RPC and were relayed verbatim',
    );
  });

  it('a JSON log line does not count as "the server answered": an early crash is still explained', async () => {
    // Boots, logs one JSON line to stdout, complains on stderr, never answers
    // the pending initialize, exits 1. Before the fix the JSON log line set
    // "first response seen" and the exit went unexplained.
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(
        `stdout.write(${JSON.stringify(PINO_LINE)} + '\\n');` +
          `process.stderr.write('pino-server: cannot connect to redis\\n');` +
          `setTimeout(() => process.exit(1), 60);`,
      ),
      env: { ...process.env, MUTE: '1' },
    });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(1);
    const early = r.logs.find((l) => l.includes('before answering anything'));
    expect(early).toContain('the MCP server exited with code 1 before answering anything');
    expect(early).toContain('cannot connect to redis');
    expect(r.logs.join('\n')).toContain('1 request(s) were still unanswered');
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const sessionError = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((sessionError?.payload['error'] as { name: string }).name).toBe('McpServerExitedEarly');
    expect(r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'))).toHaveLength(1);
  });
});

// ── fail open, on a protocol node ───────────────────────────────────────────

describe('mcp-proxy: fail-open on protocol nodes', () => {
  it('a debugger that dies while holding `ping` releases the gate; the relay keeps working detached', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'raw-server.mjs',
      breakpoints: [{ kind: 'custom', name: 'ping', point: 'before' }],
    });
    r.request(1, 'ping');
    await v.waitForPause('mcp:ping', 'before');
    await tick(50);
    expect(r.out.toString()).not.toContain('"id":1');

    v.killAbruptly();
    viewer = undefined;
    const response = await r.response(1);
    expect(response['id']).toBe(1);

    // Detached now: protocol and work frames both flow, nothing is held.
    r.request(2, 'tools/list');
    await r.response(2);
    r.callTool(3, 'echo', { text: 'still here' });
    const echoed = await r.response(3);
    expect(JSON.stringify(echoed)).toContain('still here');

    const code = await r.close();
    rig = undefined;
    expect(code).toBe(0);
    expect(r.logs.join('\n')).not.toContain('unexpected internal failure');
  });

  it('a spawn that throws with no debugger listening exits 127 in bounded time, nothing thrown', async () => {
    const einval = (): never => {
      throw Object.assign(new Error('spawn npx.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
    };
    const startedAt = Date.now();
    const r = new ProxyRig({
      command: 'npx.cmd',
      args: ['-y', 'some-server'],
      spawnFn: einval as unknown as typeof spawn,
      waitForAttach: true,
    });
    rig = r;
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(127);
    expect(Date.now() - startedAt).toBeLessThan(ATTACH_WAIT_MS + 3_000);
    expect(r.logs.filter((l) => l.includes('cannot run "npx.cmd"'))).toHaveLength(1);
    expect(r.logs.join('\n')).not.toContain('unexpected internal failure');
    // stdout carried nothing: it is the MCP wire even when we fail.
    expect(r.out.length).toBe(0);
  });

  it('a spawnFn that throws a non-Error value is still one plain line, not a crash', async () => {
    const throwsString = (): never => {
      throw 'the spawner said no';
    };
    const r = new ProxyRig({ command: 'weird', args: [], spawnFn: throwsString as unknown as typeof spawn });
    rig = r;
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(127);
    expect(r.logs.find((l) => l.includes('cannot run'))).toBe(
      'graphmind mcp-proxy: cannot run "weird": the spawner said no',
    );
  });
});

// ── a failure that is over before the debugger attaches ─────────────────────

describe('mcp-proxy: failures faster than an attach (no --wait-for-attach)', () => {
  // The default invocation: `graphmind mcp-proxy -- <cmd>` with GraphMind
  // running. A spawn failure or a boot crash ends the run in a few
  // milliseconds — before the WebSocket handshake — and the run used to be
  // disposed unseen, while the terminal said "GraphMind is not running".

  it('ENOENT with a debugger listening still puts the SpawnError run on the graph', async () => {
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const startedAt = Date.now();
    const r = new ProxyRig({ command: 'definitely-not-a-real-binary-xyz', args: [], viewerUrl: v.url });
    rig = r;
    // What every MCP host does the instant it spawns the proxy: write the
    // first request. It must not turn into a ghost node after run.finished.
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(127);
    expect(Date.now() - startedAt).toBeLessThan(SPAWN_FAILURE_ATTACH_MS + 2_000);
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const error = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((error?.payload['error'] as { name: string }).name).toBe('SpawnError');
    expect((error?.payload['error'] as { message: string }).message).toContain('not found on PATH');
    expect(finishOf(v, 'mcp:session')?.payload).toMatchObject({ status: 'error', output: { exitCode: 127 } });
    expect(startOf(v, 'mcp:session')?.seq).toBeLessThan(error?.seq ?? -1);
    expect(error?.seq).toBeLessThan(finishOf(v, 'mcp:session')?.seq ?? -1);
    // ONE run. The 'error' event fires outside the run's async context; an
    // emit from there used to open an anonymous implicit run and the
    // SpawnError landed in it, alone, beside a session node with no error.
    expect(v.ofType('run.started')).toHaveLength(1);
    expect(new Set(v.received.filter((f) => f.type !== 'hello').map((f) => f.runId)).size).toBe(1);
    // Nothing is observed after the session closed: no node.* after
    // run.finished (the already-written initialize is either an errored
    // node closed inside the run, or — when it arrives after the close, as
    // over a real pipe — not observed at all; never a ghost).
    await tick(150);
    const runFinishedSeq = v.ofType('run.finished')[0]?.seq ?? -1;
    expect(v.received.filter((f) => f.seq > runFinishedSeq && f.type.startsWith('node.'))).toEqual([]);
    const key = (f: ReceivedFrame): string => `${String(f.payload['nodeId'])}#${String(f.payload['instanceId'])}`;
    const closed = new Set(v.ofType('node.finished').map(key));
    for (const started of v.ofType('node.started')) expect(closed.has(key(started)), key(started)).toBe(true);
  });

  it('a spawn that THROWS with a debugger listening still puts the SpawnError run on the graph', async () => {
    const einval = (): never => {
      throw Object.assign(new Error('spawn npx.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
    };
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({
      command: 'npx.cmd',
      args: ['-y', 'some-server'],
      spawnFn: einval as unknown as typeof spawn,
      viewerUrl: v.url,
    });
    rig = r;
    expect(await r.finish()).toBe(127);
    rig = undefined;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const error = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((error?.payload['error'] as { message: string }).message).toContain('cannot run "npx.cmd"');
    expect(v.ofType('run.started')).toHaveLength(1);
  });

  it('a server that dies on boot before the handshake completes is still recorded, with its stderr tail', async () => {
    // Deterministic version of the race: the viewer accepts the socket but
    // withholds hello.ack until the session is already over.
    const v = await FakeViewer.start({ breakpoints: [], autoAck: false });
    viewer = v;
    const r = new ProxyRig({ server: 'crash-server.mjs', viewerUrl: v.url });
    rig = r;
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    await waitUntil(() => r.logs.some((l) => l.includes('before answering anything')), 'the early-death line');
    expect(r.handle.session.attached).toBe(false);
    await v.waitForType('hello');
    v.sendControl('hello.ack', {
      versions: { protocol: PROTOCOL_VERSION, viewer: 'fake-viewer/0.0.0' },
      capabilities: ['pause', 'step', 'inject', 'retry', 'abort'],
      breakpoints: [],
      mode: 'run',
    });
    expect(await r.finish()).toBe(2);
    rig = undefined;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const error = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((error?.payload['error'] as { name: string }).name).toBe('McpServerExitedEarly');
    expect((error?.payload['error'] as { message: string }).message).toContain('DATABASE_URL is not set');
    expect(startOf(v, 'mcp:initialize')?.payload['parentId']).toBe('mcp:protocol');
  });

  it('a frame the client writes after the session ended is relayed, not observed (no ghost after run.finished)', async () => {
    // Over a real pipe the host's first request lands AFTER a spawn failure
    // has already closed the run (I/O is a macrotask; the whole failed run
    // is microtasks). Reproduced deterministically: a synchronous spawn
    // failure closes the run at construction, the viewer withholds its ack
    // so the proxy is sitting in the attach grace, and the frame is written
    // then. Before the guard, node.started for mcp:protocol and the request
    // were emitted after run.finished — ghosts in a finished run.
    const einval = (): never => {
      throw Object.assign(new Error('spawn npx.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
    };
    const v = await FakeViewer.start({ breakpoints: [], autoAck: false });
    viewer = v;
    const r = new ProxyRig({
      command: 'npx.cmd',
      args: [],
      spawnFn: einval as unknown as typeof spawn,
      viewerUrl: v.url,
    });
    rig = r;
    await tick(20); // the failed run is over; the proxy is waiting for an attach
    expect(r.handle.session.attached).toBe(false);
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    await tick(50);
    await v.waitForType('hello');
    v.sendControl('hello.ack', {
      versions: { protocol: PROTOCOL_VERSION, viewer: 'fake-viewer/0.0.0' },
      capabilities: ['pause', 'step', 'inject', 'retry', 'abort'],
      breakpoints: [],
      mode: 'run',
    });
    expect(await r.finish()).toBe(127);
    rig = undefined;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    await tick(100);
    const runFinishedSeq = v.ofType('run.finished')[0]?.seq ?? -1;
    expect(v.received.filter((f) => f.seq > runFinishedSeq && f.type.startsWith('node.'))).toEqual([]);
    expect(startOf(v, 'mcp:initialize')).toBeUndefined();
    expect(startOf(v, 'mcp:protocol')).toBeUndefined();
    expect(v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session')).toBeDefined();
  });

  it('with nothing listening the grace is bounded: ENOENT still exits 127 promptly', async () => {
    const startedAt = Date.now();
    const r = new ProxyRig({ command: 'definitely-not-a-real-binary-xyz', args: [] });
    rig = r;
    const ready = vi.spyOn(r.handle.session, 'ready');
    expect(await r.finish()).toBe(127);
    rig = undefined;
    expect(Date.now() - startedAt).toBeLessThan(SPAWN_FAILURE_ATTACH_MS + 2_000);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith({ timeoutMs: SPAWN_FAILURE_ATTACH_MS });
  });

  it('a healthy session that ends before attach is not delayed', async () => {
    // No failure → no grace: the proxy must stay invisible when nothing is
    // wrong, whether or not a debugger is up. Asserted on the call, not on
    // the clock, so a loaded CI runner cannot turn it into a flake.
    const v = await FakeViewer.start({ breakpoints: [], autoAck: false });
    viewer = v;
    const r = new ProxyRig({ server: 'raw-server.mjs', viewerUrl: v.url });
    rig = r;
    const ready = vi.spyOn(r.handle.session, 'ready');
    r.request(1, 'ping');
    await r.response(1);
    expect(await r.close()).toBe(0);
    rig = undefined;
    expect(ready).not.toHaveBeenCalled();
    expect(r.logs.join('\n')).not.toContain('before answering anything');
  });
});

// ── initialize itself fails ─────────────────────────────────────────────────

describe('mcp-proxy: the handshake fails', () => {
  it('an `initialize` error holds the default error gate under the folded group; continue passes it on', async () => {
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(''),
      env: { ...process.env, INIT_FAILS: '1' },
      breakpoints: [{ point: 'error' }],
    });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    const paused = await v.waitForPause('mcp:initialize', 'error');
    expect(startOf(v, 'mcp:initialize')?.payload['parentId']).toBe('mcp:protocol');
    const errored = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:initialize');
    expect((errored?.payload['error'] as { name: string }).name).toBe('JsonRpcError(-32602)');
    // Held: the client has not seen the failure yet.
    await tick(60);
    expect(r.out.toString()).not.toContain('unsupported protocol version');

    v.resume(paused.payload['pauseId'] as string, 'continue');
    const response = (await r.response(1)) as { error: { code: number } };
    expect(response.error.code).toBe(-32602);

    await closeRun(v, r);
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toEqual({ calls: 1, errors: 1, stdoutNoise: 0 });
    expect(finishOf(v, 'mcp:initialize')?.payload['status']).toBe('error');
  });

  it('an `initialize` error can be repaired at the gate: inject a result and the client never sees the failure', async () => {
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(''),
      env: { ...process.env, INIT_FAILS: '1' },
      breakpoints: [{ point: 'error' }],
    });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    const paused = await v.waitForPause('mcp:initialize', 'error');
    v.resume(paused.payload['pauseId'] as string, 'inject', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      serverInfo: { name: 'repaired', version: '0' },
    });
    const response = (await r.response(1)) as { result?: { serverInfo?: { name: string } }; error?: unknown };
    expect(response.error).toBeUndefined();
    expect(response.result?.serverInfo?.name).toBe('repaired');
    expect(r.out.toString()).not.toContain('unsupported protocol version');
  });
});

// ── concurrency and hostile bytes ───────────────────────────────────────────

describe('mcp-proxy: bursts and hostile stdout', () => {
  it('40 concurrent protocol requests plus per-request noise: one group, exact counts, parent first', async () => {
    const { viewer: v, rig: r } = await attach({ server: 'chatty-server.mjs' });
    const total = 40;
    for (let i = 1; i <= total; i += 1) r.request(i, 'ping');
    await Promise.all(Array.from({ length: total }, (_, i) => r.response(i + 1)));
    await closeRun(v, r);

    const groups = v.ofType('node.started').filter((f) => f.payload['nodeId'] === 'mcp:protocol');
    expect(groups).toHaveLength(1);
    const firstChild = v.ofType('node.started').find((f) => f.payload['parentId'] === 'mcp:protocol');
    expect(groups[0]?.seq).toBeLessThan(firstChild?.seq ?? -1);
    expect(v.ofType('node.finished').filter((f) => f.payload['nodeId'] === 'mcp:ping')).toHaveLength(total);
    // boot line + one "handling ping" per request.
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toEqual({
      calls: total,
      errors: 0,
      stdoutNoise: total + 1,
    });
    expect(noiseStarts(v)).toHaveLength(STDOUT_NOISE_MAX_RECORDED);
    expect(r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'))).toHaveLength(1);
    // Every ping got exactly one finish and the session closed clean.
    expect(finishOf(v, 'mcp:session')?.payload['status']).toBe('ok');
  });

  it('binary garbage (invalid UTF-8, NUL, ANSI) is quoted escaped and relayed byte-for-byte', async () => {
    const bytes = [0xff, 0xfe, 0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41];
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(`stdout.write(Buffer.from(${JSON.stringify(bytes)})); stdout.write('\\n');`),
    });
    r.request(1, 'ping');
    await r.response(1);
    await waitUntil(() => r.logs.some((l) => l.includes('wrote a line to stdout that is not JSON-RPC')), 'the stdout warning');
    const line = r.logs.find((l) => l.includes('wrote a line to stdout that is not JSON-RPC')) as string;
    // Nothing that could drive the terminal survives in the quote.
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[ --]/);
    expect(line).toContain('\\u0000');
    expect(line).toContain('\\u001b');
    expect([...r.out.subarray(0, bytes.length + 1)]).toEqual([...bytes, 0x0a]);
    const noise = await v.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'mcp:stdout-noise',
    );
    expect((noise.payload['input'] as { bytes: number }).bytes).toBe(bytes.length);
  });

  it('a 1 MB stdout line is quoted at 200 bytes, relayed whole, and the pipe keeps moving', async () => {
    const size = 1024 * 1024;
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(`stdout.write('noise:' + 'y'.repeat(${size}) + '\\n');`),
    });
    r.request(1, 'ping');
    await r.response(1);
    const noise = await v.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'mcp:stdout-noise',
    );
    const input = noise.payload['input'] as { text: string; bytes: number; truncated: boolean };
    expect(input.bytes).toBe(size + 'noise:'.length);
    expect(input.truncated).toBe(true);
    expect(input.text.length).toBe(200);
    expect(r.out.length).toBeGreaterThan(size);
    const line = r.logs.find((l) => l.includes('wrote a line to stdout that is not JSON-RPC')) as string;
    expect(line.length).toBeLessThan(600);
    expect(line).toContain('(first 200 bytes)');
  });

  it('blank server lines and client-side junk are not stdout noise', async () => {
    const { viewer: v, rig: r } = await attach({
      args: inlineServer(`stdout.write('\\n\\n   \\n');`),
    });
    r.sendRaw('this is not json\n');
    r.request(1, 'ping');
    await r.response(1);
    await closeRun(v, r);
    const logs = r.logs.join('\n');
    expect(logs).not.toContain('wrote a line to stdout');
    expect(logs).not.toContain('were not JSON-RPC and were relayed verbatim');
    expect(logs).toContain('1 frame(s) from the client were not JSON-RPC');
    expect(noiseStarts(v)).toHaveLength(0);
    expect(startOf(v, 'mcp:protocol')).toBeDefined(); // ping is protocol
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toEqual({ calls: 1, errors: 0, stdoutNoise: 0 });
  });
});
