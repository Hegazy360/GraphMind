/**
 * The session shape (protocol traffic folded under `mcp:protocol`) and the
 * two failures that used to be silent: a server that logs to stdout, and a
 * server that never gets going (cannot be spawned, or dies before its first
 * response). Plus the units behind them: the ring buffer, the exit-code
 * words, the clock.
 *
 * Same rig as the other proxy suites: a real `@graphmind-ai/client` session,
 * a real WebSocket viewer double, a real child process.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { durationBetween, roundDurationMs } from '../src/mcp-proxy/clock.js';
import { describeExit, ntstatusName } from '../src/mcp-proxy/exit-status.js';
import { isWorkMethod, mapMethod } from '../src/mcp-proxy/mapping.js';
import { spawnFailureMessage } from '../src/mcp-proxy/proxy.js';
import { STDOUT_NOISE_MAX_RECORDED } from '../src/mcp-proxy/reporter.js';
import { StderrRing } from '../src/mcp-proxy/stderr-ring.js';
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

async function attach(
  options: { breakpoints?: Parameters<FakeViewer['setBreakpoint']>[0][] } & RigInit = {},
): Promise<{ viewer: FakeViewer; rig: ProxyRig }> {
  const { breakpoints, ...rest } = options;
  viewer = await FakeViewer.start({ breakpoints: breakpoints ?? [] });
  rig = new ProxyRig({
    server: 'raw-server.mjs',
    viewerUrl: viewer.url,
    waitForAttach: true,
    ...rest,
  });
  await waitUntil(() => rig?.handle.session.attached === true, 'the proxy to attach');
  return { viewer, rig };
}

const startOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.started').find((f) => f.payload['nodeId'] === nodeId);
const finishOf = (v: FakeViewer, nodeId: string): ReceivedFrame | undefined =>
  v.ofType('node.finished').find((f) => f.payload['nodeId'] === nodeId);

/** Run a session to completion and hand back everything the viewer saw. */
async function closeRun(v: FakeViewer, r: ProxyRig): Promise<void> {
  r.endClient();
  await r.handle.done;
  await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
  rig = undefined;
}

// ── the rule ─────────────────────────────────────────────────────────────────

describe('mcp-proxy: the work / protocol rule', () => {
  it('names exactly the six work families; everything else (including unknown) is protocol', () => {
    for (const m of [
      'tools/call',
      'resources/read',
      'prompts/get',
      'sampling/createMessage',
      'elicitation/create',
      'elicitation/whatever-comes-next',
      'completion/complete',
    ]) {
      expect(isWorkMethod(m), m).toBe(true);
    }
    for (const m of [
      'initialize',
      'ping',
      'tools/list',
      'resources/list',
      'resources/templates/list',
      'prompts/list',
      'roots/list',
      'resources/subscribe',
      'logging/setLevel',
      'notifications/initialized',
      'notifications/progress',
      'tasks/get',
      'something/nobody/has/heard/of',
      '',
    ]) {
      expect(isWorkMethod(m), m).toBe(false);
    }
  });

  it('parents work under the session and protocol under mcp:protocol', () => {
    expect(mapMethod('tools/call', { name: 'x' }).parentId).toBe('mcp:session');
    expect(mapMethod('resources/read', { uri: 'a://b' }).parentId).toBe('mcp:session');
    expect(mapMethod('prompts/get', { name: 'p' }).parentId).toBe('mcp:session');
    expect(mapMethod('sampling/createMessage', {}).parentId).toBe('mcp:session');
    expect(mapMethod('completion/complete', {}).parentId).toBe('mcp:session');
    expect(mapMethod('elicitation/create', {})).toEqual({
      nodeId: 'mcp:elicitation/create',
      kind: 'custom',
      name: 'elicitation/create',
      parentId: 'mcp:session',
    });
    expect(mapMethod('initialize', {}).parentId).toBe('mcp:protocol');
    expect(mapMethod('notifications/initialized', undefined).parentId).toBe('mcp:protocol');
    expect(mapMethod('made/up', null).parentId).toBe('mcp:protocol');
  });
});

// ── the shape on the wire ────────────────────────────────────────────────────

describe('mcp-proxy: session shape', () => {
  it('folds handshake, discovery and keepalive under an mcp:protocol node that opens collapsed', async () => {
    const { viewer: v, rig: r } = await attach();
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    r.notify('notifications/initialized');
    r.request(2, 'tools/list');
    r.request(3, 'ping');
    r.callTool(4, 'echo', { text: 'work' });
    r.request(5, 'resources/read', { uri: 'test://greeting' });
    r.request(6, 'prompts/get', { name: 'summarize' });
    await r.response(6);
    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'prompt:summarize');

    const protocol = startOf(v, 'mcp:protocol');
    expect(protocol?.payload).toMatchObject({
      kind: 'custom',
      name: 'protocol',
      parentId: 'mcp:session',
      instanceId: 'mcp:protocol',
      collapsed: true,
    });
    // Ordering: session, then the group, then its first child — a viewer
    // that honours `collapsed` on first sight never sees a child arrive
    // before the parent it should be hidden under.
    const session = startOf(v, 'mcp:session');
    const init = startOf(v, 'mcp:initialize');
    expect(session?.seq).toBeLessThan(protocol?.seq ?? -1);
    expect(protocol?.seq).toBeLessThan(init?.seq ?? -1);

    for (const id of ['mcp:initialize', 'mcp:notifications/initialized', 'mcp:tools/list', 'mcp:ping']) {
      expect(startOf(v, id)?.payload['parentId'], id).toBe('mcp:protocol');
    }
    for (const id of ['tool:echo', 'resource:test://greeting', 'prompt:summarize']) {
      expect(startOf(v, id)?.payload['parentId'], id).toBe('mcp:session');
    }
    // Exactly one group per session, however many protocol frames.
    expect(v.ofType('node.started').filter((f) => f.payload['nodeId'] === 'mcp:protocol')).toHaveLength(1);

    await closeRun(v, r);
    const finished = v.ofType('node.finished');
    const protocolEnd = finished.find((f) => f.payload['nodeId'] === 'mcp:protocol');
    const sessionEnd = finished.find((f) => f.payload['nodeId'] === 'mcp:session');
    expect(protocolEnd?.payload).toMatchObject({
      instanceId: 'mcp:protocol',
      status: 'ok',
      output: { calls: 4, errors: 0, stdoutNoise: 0 },
    });
    // The group closes before the session that contains it.
    expect(protocolEnd?.seq).toBeLessThan(sessionEnd?.seq ?? -1);
    expect(sessionEnd?.payload['status']).toBe('ok');
  });

  it('creates mcp:protocol lazily: a session with only real work has no empty group', async () => {
    const { viewer: v, rig: r } = await attach();
    r.callTool(1, 'echo', { text: 'only work' });
    await r.response(1);
    await closeRun(v, r);
    expect(startOf(v, 'mcp:protocol')).toBeUndefined();
    expect(finishOf(v, 'mcp:protocol')).toBeUndefined();
    expect(startOf(v, 'tool:echo')?.payload['parentId']).toBe('mcp:session');
  });

  it('a session with zero real calls is still a complete, closed graph', async () => {
    const { viewer: v, rig: r } = await attach();
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    r.notify('notifications/initialized');
    r.request(2, 'ping');
    await r.response(2);
    await closeRun(v, r);
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toEqual({
      calls: 3,
      errors: 0,
      stdoutNoise: 0,
    });
    expect(finishOf(v, 'mcp:session')?.payload['status']).toBe('ok');
    // Nothing but the session and the group hangs off the session.
    const underSession = v
      .ofType('node.started')
      .filter((f) => f.payload['parentId'] === 'mcp:session')
      .map((f) => f.payload['nodeId']);
    expect(new Set(underSession)).toEqual(new Set(['mcp:protocol']));
  });

  it('an unknown method lands under mcp:protocol, is gated, and never crashes the relay', async () => {
    const { viewer: v, rig: r } = await attach({
      breakpoints: [{ kind: 'custom', name: 'made/up', point: 'before' }],
    });
    r.request(1, 'made/up', { anything: true });
    const paused = await v.waitForPause('mcp:made/up', 'before');
    expect(startOf(v, 'mcp:made/up')?.payload['parentId']).toBe('mcp:protocol');
    v.resume(paused.payload['pauseId'] as string, 'continue');
    // raw-server answers unknown methods with -32601; the relay carried it.
    const response = (await r.response(1)) as { error: { code: number } };
    expect(response.error.code).toBe(-32601);
    r.request(2, 'ping');
    await r.response(2);
  });

  it('a protocol call that FAILS still holds the error gate, and the group counts it', async () => {
    // graphmind serve arms {point:'error'} by default; the fake viewer does
    // the same here. raw-server does not implement resources/list, so the
    // handshake-era listing fails the way a broken initialize would.
    const { viewer: v, rig: r } = await attach({ breakpoints: [{ point: 'error' }] });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    await r.response(1);
    r.request(2, 'resources/list');
    const paused = await v.waitForPause('mcp:resources/list', 'error');
    const errored = v
      .ofType('node.error')
      .find((f) => f.payload['nodeId'] === 'mcp:resources/list');
    expect((errored?.payload['error'] as { name: string }).name).toBe('JsonRpcError(-32601)');
    expect(startOf(v, 'mcp:resources/list')?.payload['parentId']).toBe('mcp:protocol');

    v.resume(paused.payload['pauseId'] as string, 'continue');
    const response = (await r.response(2)) as { error: { code: number } };
    expect(response.error.code).toBe(-32601);

    await closeRun(v, r);
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toMatchObject({ calls: 2, errors: 1 });
    expect(finishOf(v, 'mcp:resources/list')?.payload['status']).toBe('error');
  });

  it('gates still hold protocol nodes (a breakpoint on ping) under the folded group', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'noisy-server.mjs',
      breakpoints: [{ kind: 'custom', name: 'ping', point: 'before' }],
    });
    r.request(1, 'ping');
    const paused = await v.waitForPause('mcp:ping', 'before');
    await tick(60);
    expect(r.err.toString()).not.toContain('handling ping');
    v.resume(paused.payload['pauseId'] as string, 'continue');
    await r.response(1);
    expect(r.err.toString()).toContain('handling ping');
  });

  it('batch frames follow the same rule (observed, parented, not gated)', async () => {
    const { viewer: v, rig: r } = await attach();
    r.send([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'b' } } },
    ]);
    await r.response(2);
    await v.waitFor((f) => f.type === 'node.finished' && f.payload['nodeId'] === 'tool:echo');
    expect(startOf(v, 'mcp:initialize')?.payload).toMatchObject({ parentId: 'mcp:protocol', batched: true });
    expect(startOf(v, 'mcp:notifications/initialized')?.payload['parentId']).toBe('mcp:protocol');
    expect(startOf(v, 'tool:echo')?.payload).toMatchObject({ parentId: 'mcp:session', batched: true });
    expect(startOf(v, 'mcp:protocol')?.seq).toBeLessThan(startOf(v, 'mcp:initialize')?.seq ?? -1);
  });

  it('reports sub-millisecond durations (0.01 ms resolution) and keeps ts an integer', async () => {
    const { viewer: v, rig: r } = await attach();
    for (let i = 1; i <= 5; i += 1) {
      r.request(i, 'ping');
      await r.response(i);
    }
    await closeRun(v, r);
    const finishes = v.ofType('node.finished');
    expect(finishes.length).toBeGreaterThan(5);
    for (const f of finishes) {
      const ms = f.payload['durationMs'] as number;
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThanOrEqual(0);
      // Rounded to 0.01 ms: no more than two decimals survive.
      expect(Math.round(ms * 100) / 100).toBe(ms);
      expect(Number.isInteger(f.ts)).toBe(true);
    }
  });
});

// ── silent failure 1: the server logs to stdout ──────────────────────────────

describe('mcp-proxy: a server that logs to stdout', () => {
  it('says so once on stderr, quotes the line, and records an error-badged node under mcp:protocol', async () => {
    const { viewer: v, rig: r } = await attach({ server: 'chatty-server.mjs' });
    r.request(1, 'ping');
    await r.response(1);

    // Printed once, default-on, with the offending text and the fix.
    await waitUntil(() => r.logs.some((l) => l.includes('wrote a line to stdout that is not JSON-RPC')), 'the stdout warning');
    const warnings = r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"debug: loading config from ./config.json"');
    expect(warnings[0]).toContain('stdout is the MCP wire; log to stderr');

    // The bytes still reached the client untouched — the proxy does not edit
    // the wire on its own initiative (that is what the viewer is for).
    expect(r.out.toString()).toContain('debug: loading config from ./config.json\n');

    const noise = await v.waitFor(
      (f) => f.type === 'node.started' && f.payload['nodeId'] === 'mcp:stdout-noise',
    );
    expect(noise.payload).toMatchObject({
      kind: 'custom',
      name: 'stdout noise',
      parentId: 'mcp:protocol',
      input: { text: 'debug: loading config from ./config.json', bytes: 40, count: 1 },
    });
    const error = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:stdout-noise');
    expect((error?.payload['error'] as { name: string; message: string }).name).toBe('StdoutNoise');
    expect((error?.payload['error'] as { message: string }).message).toContain('log to stderr');
    // The group exists even though no protocol METHOD has been seen yet.
    expect(startOf(v, 'mcp:protocol')?.seq).toBeLessThan(noise.seq);

    await closeRun(v, r);
    // Two noise lines: the boot line and "handling ping".
    const summary = r.logs.filter((l) => l.includes('were not JSON-RPC and were relayed verbatim'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('2 line(s) the server wrote to stdout');
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toMatchObject({ stdoutNoise: 2 });
    // Still only ONE warning after the second line.
    expect(r.logs.filter((l) => l.includes('wrote a line to stdout that is not JSON-RPC'))).toHaveLength(1);
  });

  it('quotes at most 200 bytes of a long line', async () => {
    const { rig: r } = await attach({
      server: 'chatty-server.mjs',
      env: { ...process.env, CHATTY_LONG: '1' },
    });
    r.request(1, 'ping');
    await r.response(1);
    await waitUntil(() => r.logs.some((l) => l.includes('wrote a line to stdout that is not JSON-RPC')), 'the stdout warning');
    const line = r.logs.find((l) => l.includes('wrote a line to stdout that is not JSON-RPC')) as string;
    expect(line).toContain('(first 200 bytes)');
    const quoted = /: "([^"]*)"/.exec(line)?.[1] ?? '';
    expect(quoted.length).toBe(200);
    expect(quoted.startsWith('debug: xxxx')).toBe(true);
  });

  it(`records at most ${STDOUT_NOISE_MAX_RECORDED} executions but counts every line`, async () => {
    const { viewer: v, rig: r } = await attach({ server: 'chatty-server.mjs' });
    const total = STDOUT_NOISE_MAX_RECORDED + 10;
    // boot line + one per request = total + 1 - 1 … make it exact: send
    // (total - 1) requests so boot + requests == total.
    for (let i = 1; i < total; i += 1) {
      r.request(i, 'ping');
      await r.response(i);
    }
    await closeRun(v, r);
    const recorded = v.ofType('node.started').filter((f) => f.payload['nodeId'] === 'mcp:stdout-noise');
    expect(recorded).toHaveLength(STDOUT_NOISE_MAX_RECORDED);
    expect(r.logs.find((l) => l.includes('were not JSON-RPC and were relayed verbatim'))).toContain(
      `${total} line(s) the server wrote to stdout`,
    );
    expect(finishOf(v, 'mcp:protocol')?.payload['output']).toMatchObject({ stdoutNoise: total });
  });

  it('prints nothing new for a healthy server', async () => {
    const { rig: r } = await attach({ server: 'noisy-server.mjs' });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    await r.response(1);
    r.callTool(2, 'echo', { text: 'fine' });
    await r.response(2);
    r.endClient();
    await r.handle.done;
    rig = undefined;
    const logs = r.logs.join('\n');
    expect(logs).not.toContain('not JSON-RPC');
    expect(logs).not.toContain('before answering anything');
    expect(logs).not.toContain('cannot run');
    expect(logs).not.toContain('were not JSON-RPC');
  });
});

// ── silent failure 2: the server never got going ─────────────────────────────

describe('mcp-proxy: a server that exits before its first response', () => {
  it('prints the exit with the stderr tail and puts both on the session node', async () => {
    const { viewer: v, rig: r } = await attach({ server: 'crash-server.mjs' });
    r.request(1, 'initialize', { protocolVersion: '2025-11-25' });
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(2);

    const line = r.logs.find((l) => l.includes('before answering anything')) as string;
    expect(line).toContain('the MCP server exited with code 2 before answering anything');
    expect(line).toContain('FATAL: DATABASE_URL is not set');
    expect(line).toContain('at boot (crash-server.mjs:9:11)');

    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const sessionError = v
      .ofType('node.error')
      .find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((sessionError?.payload['error'] as { name: string }).name).toBe('McpServerExitedEarly');
    expect((sessionError?.payload['error'] as { message: string }).message).toContain(
      'DATABASE_URL is not set',
    );
    expect(finishOf(v, 'mcp:session')?.payload['status']).toBe('error');
    // The unanswered initialize is an error too, under the folded group.
    const initError = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:initialize');
    expect((initError?.payload['error'] as { message: string }).message).toContain(
      'before answering initialize',
    );
    expect(startOf(v, 'mcp:initialize')?.payload['parentId']).toBe('mcp:protocol');
  });

  it('keeps only the last 200 lines / 32 KB of stderr, and says how many it dropped', async () => {
    const { viewer: v, rig: r } = await attach({
      server: 'crash-server.mjs',
      env: { ...process.env, CRASH_LINES: '500' },
    });
    r.request(1, 'ping');
    await r.finish();
    rig = undefined;
    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const line = r.logs.find((l) => l.includes('before answering anything')) as string;
    expect(line).toContain('earlier line(s) omitted here');
    expect(line).toContain('crash-server: line 500 of 500');
    expect(line).not.toContain('crash-server: line 1 of 500\n');
    const message = (
      v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session')?.payload['error'] as {
        message: string;
      }
    ).message;
    // 500 lines + 2 trace lines went in; at most 200 came out.
    expect(message.split('\n').filter((l) => l.startsWith('crash-server:')).length).toBeLessThanOrEqual(200);
    expect(message).toContain('line 500 of 500');
    expect(message).not.toContain('line 1 of 500');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(40 * 1024);
  });

  // The case the early-death report exists for, under --wait-for-attach with
  // nothing listening: the server crashes on boot while the proxy is still
  // waiting. The proxy used to read neither of its pipes until the run
  // opened — Node's child_process discards unread stdio when the child exits,
  // so the stack trace went nowhere, and the stdout relay, attached after the
  // stream had ended, waited for an end that had already happened: the
  // proxy never exited (with stdin closed it exited 0).
  it('a server that dies while the proxy waits to attach: stderr still reaches the client and the report, and the proxy exits with its code', async () => {
    const r = new ProxyRig({ server: 'crash-server.mjs', waitForAttach: true });
    rig = r;
    r.request(1, 'ping');
    const code = await r.handle.done;
    rig = undefined;
    expect(code).toBe(2);
    const err = r.err.toString('utf8');
    for (let i = 1; i <= 3; i += 1) expect(err).toContain(`crash-server: line ${i} of 3\n`);
    expect(err).toContain('Error: FATAL: DATABASE_URL is not set');
    const line = r.logs.find((l) => l.includes('before answering anything')) as string;
    expect(line).toContain('exited with code 2');
    expect(line).toContain('DATABASE_URL is not set');
  }, 20_000);

  // Volume while waiting: the server's stderr is drained from spawn (a paused
  // pipe was backpressure on the server — a Python server's blocking writes
  // hang it), mirrored to the client at once, and buffered for the graph until
  // the run opens.
  it('reads stderr while waiting to attach: 3,000 lines all reach the client and the report keeps the tail', async () => {
    const r = new ProxyRig({
      server: 'crash-server.mjs',
      env: { ...process.env, CRASH_LINES: '3000' },
      waitForAttach: true,
    });
    rig = r;
    r.request(1, 'ping');
    const code = await r.handle.done;
    rig = undefined;
    expect(code).toBe(2);
    const err = r.err.toString('utf8');
    const mirrored = err.split('\n').filter((l) => l.startsWith('crash-server: line '));
    expect(mirrored.length).toBe(3000);
    expect(mirrored.at(-1)).toBe('crash-server: line 3000 of 3000');
    const line = r.logs.find((l) => l.includes('before answering anything')) as string;
    expect(line).toContain('crash-server: line 3000 of 3000');
    expect(line).toContain('DATABASE_URL is not set');
    // 3,000 lines + 2 trace lines were seen; the terminal quotes the tail.
    const omitted = Number(/\((\d+) earlier line\(s\) omitted here/.exec(line)?.[1]);
    const quoted = line.split('\n').filter((l) => l.startsWith('    ')).length;
    expect(omitted + quoted).toBe(3002);
  }, 20_000);

  it('says where to look instead of quoting when stderr is inherited', async () => {
    const { rig: r } = await attach({ server: 'crash-server.mjs', captureStderr: false });
    r.request(1, 'ping');
    await r.finish();
    rig = undefined;
    const line = r.logs.find((l) => l.includes('before answering anything')) as string;
    expect(line).toContain('--inherit-stderr');
    expect(line).not.toContain('DATABASE_URL');
  });

  it('is silent when the client simply hangs up before asking anything (exit 0, nothing pending)', async () => {
    const { rig: r } = await attach({ server: 'noisy-server.mjs' });
    r.endClient();
    const code = await r.handle.done;
    rig = undefined;
    expect(code).toBe(0);
    expect(r.logs.join('\n')).not.toContain('before answering anything');
  });
});

describe('mcp-proxy: a command that cannot be started', () => {
  const einval = (): never => {
    throw Object.assign(new Error('spawn npx.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn' });
  };

  it('a spawn that THROWS (Windows .cmd / EINVAL) ends like ENOENT: one line, code 127, failed node', async () => {
    // Built directly rather than via attach(): a run that fails to spawn is
    // over in a few ms, so polling for `attached` would miss the window.
    const v = await FakeViewer.start({ breakpoints: [] });
    viewer = v;
    const r = new ProxyRig({
      command: 'npx.cmd',
      args: ['-y', 'some-server'],
      spawnFn: einval as unknown as typeof spawn,
      viewerUrl: v.url,
      waitForAttach: true,
    });
    rig = r;
    const code = await r.finish();
    rig = undefined;
    expect(code).toBe(127);
    const line = r.logs.find((l) => l.includes('cannot run')) as string;
    expect(line).toContain('cannot run "npx.cmd": spawn npx.cmd EINVAL');
    expect(line).toContain('.cmd/.bat');
    // No stack trace leaked; no "unexpected internal failure".
    expect(r.logs.join('\n')).not.toContain('unexpected internal failure');
    expect(r.logs.join('\n')).not.toContain('    at ');

    await waitUntil(() => v.ofType('run.finished').length === 1, 'run.finished');
    const started = startOf(v, 'mcp:session');
    const error = v.ofType('node.error').find((f) => f.payload['nodeId'] === 'mcp:session');
    expect((error?.payload['error'] as { name: string }).name).toBe('SpawnError');
    expect((error?.payload['error'] as { message: string }).message).toContain('cannot run "npx.cmd"');
    // Even under --wait-for-attach (the failure fires before the run opens),
    // the node exists before its error.
    expect(started?.seq).toBeLessThan(error?.seq ?? -1);
    expect(finishOf(v, 'mcp:session')?.payload).toMatchObject({ status: 'error', output: { exitCode: 127 } });
    // Nothing was ever answered, but this is a spawn failure, not an early
    // death — one explanation, not two.
    expect(r.logs.join('\n')).not.toContain('before answering anything');
  });

  it('ENOENT gets the same treatment plus a PATH hint (detached, no viewer)', async () => {
    rig = new ProxyRig({ command: 'definitely-not-a-real-binary-xyz', args: [] });
    const code = await rig.finish();
    expect(code).toBe(127);
    const line = rig.logs.find((l) => l.includes('cannot run')) as string;
    expect(line).toContain('cannot run "definitely-not-a-real-binary-xyz"');
    expect(line).toContain('not found on PATH');
    rig = undefined;
  });

  it.runIf(process.platform === 'win32')(
    'on Windows, a real .cmd target is reported, not thrown (runs on CI only)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gm-cmd-'));
      const script = join(dir, 'server.cmd');
      writeFileSync(script, '@echo off\r\necho {"jsonrpc":"2.0","id":1,"result":{}}\r\n');
      const r = new ProxyRig({ command: script, args: [] });
      rig = r;
      const code = await r.finish();
      rig = undefined;
      expect(code).toBe(127);
      const line = r.logs.find((l) => l.includes('cannot run')) as string;
      expect(line).toContain('EINVAL');
      expect(line).toContain('.cmd/.bat');
    },
  );

  it('words the failure the same whether spawn threw or emitted', () => {
    const enoent = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    expect(spawnFailureMessage('nope', enoent)).toBe(
      'cannot run "nope": spawn nope ENOENT — the command was not found on PATH; check the "command" in your MCP client config',
    );
    const cmd = Object.assign(new Error('spawn x.CMD EINVAL'), { code: 'EINVAL' });
    expect(spawnFailureMessage('x.CMD', cmd)).toContain('Windows cannot start a .cmd/.bat directly');
    const eacces = Object.assign(new Error('spawn ./s EACCES'), { code: 'EACCES' });
    expect(spawnFailureMessage('./s', eacces)).toContain('not executable');
    // Anything else: the message, no invented hint, no crash on odd values.
    expect(spawnFailureMessage('x', new Error('weird'))).toBe('cannot run "x": weird');
    expect(spawnFailureMessage('x', 'a string')).toBe('cannot run "x": a string');
    expect(spawnFailureMessage('x', null)).toBe('cannot run "x": null');
  });
});

// ── units ────────────────────────────────────────────────────────────────────

describe('exit-status: NTSTATUS codes get a name', () => {
  it('names the Windows crash codes, signed or unsigned', () => {
    expect(ntstatusName(3221225477)).toBe('STATUS_ACCESS_VIOLATION');
    expect(ntstatusName(-1073741819)).toBe('STATUS_ACCESS_VIOLATION');
    expect(ntstatusName(0xc0000409)).toBe('STATUS_STACK_BUFFER_OVERRUN');
    expect(ntstatusName(0xc000013a)).toBe('STATUS_CONTROL_C_EXIT');
    expect(ntstatusName(1)).toBeUndefined();
    expect(ntstatusName(0)).toBeUndefined();
    expect(ntstatusName(null)).toBeUndefined();
    expect(ntstatusName(0xc0000000 + 999_999)).toBeUndefined();
    expect(ntstatusName(0x1_0000_0000)).toBeUndefined();
    expect(ntstatusName(1.5)).toBeUndefined();
  });

  it('describes an exit in plain words', () => {
    expect(describeExit({ code: 0, signal: null })).toBe('the MCP server exited with code 0');
    expect(describeExit({ code: null, signal: null })).toBe('the MCP server exited with code 0');
    expect(describeExit({ code: 1, signal: null })).toBe('the MCP server exited with code 1');
    expect(describeExit({ code: null, signal: 'SIGKILL' })).toBe('the MCP server was killed by SIGKILL');
    expect(describeExit({ code: 3221225477, signal: null })).toBe(
      'the MCP server exited with code 3221225477 (STATUS_ACCESS_VIOLATION — it crashed)',
    );
  });
});

describe('StderrRing', () => {
  it('keeps the last N lines and counts what it dropped', () => {
    const ring = new StderrRing(3, 1024);
    ring.push('a\nb\nc\nd\ne\n');
    expect(ring.tail()).toEqual(['c', 'd', 'e']);
    expect(ring.dropped).toBe(2);
    expect(ring.seen).toBe(5);
    expect(ring.tail(2)).toEqual(['d', 'e']);
  });

  it('bounds bytes, not just lines', () => {
    const ring = new StderrRing(200, 100);
    for (let i = 0; i < 10; i += 1) ring.push(`${'x'.repeat(30)}${i}\n`);
    const kept = ring.tail();
    expect(kept.join('').length).toBeLessThanOrEqual(100);
    expect(kept[kept.length - 1]).toBe(`${'x'.repeat(30)}9`);
    expect(ring.dropped).toBe(10 - kept.length);
  });

  it('reassembles lines split across chunks and keeps an unterminated tail', () => {
    const ring = new StderrRing();
    ring.push('hel');
    ring.push('lo\nwor');
    expect(ring.tail()).toEqual(['hello', 'wor']);
    expect(ring.seen).toBe(2);
    ring.push('ld\n');
    expect(ring.tail()).toEqual(['hello', 'world']);
    expect(ring.isEmpty).toBe(false);
    expect(new StderrRing().isEmpty).toBe(true);
  });

  it('strips a trailing \\r, truncates a single oversized line, and handles multibyte input', () => {
    const ring = new StderrRing(10, 16);
    ring.push('windows\r\n');
    expect(ring.tail()).toEqual(['windows']);
    ring.push(`${'y'.repeat(100)}\n`);
    const [last] = ring.tail().slice(-1);
    expect(last?.length).toBe(17); // 16 + the ellipsis
    expect(last?.endsWith('…')).toBe(true);
    const utf = new StderrRing();
    utf.push(Buffer.from('caf\u00e9 \u2713\n', 'utf8'));
    expect(utf.tail()).toEqual(['café ✓']);
  });

  it('never grows without bound on a line that never ends', () => {
    const ring = new StderrRing(5, 64);
    for (let i = 0; i < 100; i += 1) ring.push('z'.repeat(10));
    expect(ring.tail().length).toBeLessThanOrEqual(5);
    expect(ring.tail().join('').length).toBeLessThanOrEqual(64 * 2 + 5);
  });
});

describe('clock', () => {
  it('rounds durations to 0.01 ms and never goes negative or non-finite', () => {
    expect(roundDurationMs(1.23456)).toBe(1.23);
    expect(roundDurationMs(0.005)).toBe(0.01);
    expect(roundDurationMs(0.004)).toBe(0);
    expect(roundDurationMs(-3)).toBe(0);
    expect(roundDurationMs(Number.NaN)).toBe(0);
    expect(roundDurationMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(durationBetween(10, 12.345)).toBe(2.35);
    expect(durationBetween(12, 10)).toBe(0);
  });
});
