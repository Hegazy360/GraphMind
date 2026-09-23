/**
 * `graphmind pauses | wait | resume | skill` and `serve --json`, end to end:
 * a real server (with its credential files), a real @graphmind-ai/client
 * session holding a real gate, and — for the binary itself — the CLI built
 * into a private directory and run as a child process.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, mergeToolInput, type GateDecision } from '@graphmind-ai/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultFlags, parseCliArgs, type ParsedCli } from '../src/args.js';
import { EXIT, INLINE_LIMIT, runPauses, runResume, runWait, type ControlIo } from '../src/commands/control.js';
import { SKILL_INSTALL_PATH, SKILL_SOURCE, runSkill } from '../src/commands/skill.js';
import { packageRoot } from '../src/paths.js';
import type { ServerOptions } from '../src/server.js';
import { heldApp, sleep } from './control-helpers.js';
import { startTestServer, waitUntil, type TestServer } from './helpers.js';

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
    expect(text).toContain(`graphmind resume ${agent.pauseId} --run ${agent.runId} --action continue`);
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
    expect(text).toContain(`graphmind resume ${agent.pauseId} --run ${agent.runId} --action continue --input @edited-input.json`);
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
