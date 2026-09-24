/**
 * Edit tool arguments END TO END through the CLI (0.6.0, contracts C2 + C3) —
 * the coding-agent path, with no fixtures and nothing in-process:
 *
 *   1. `graphmind serve --no-open --port <free> --db <tmp> --allow-control=edit`
 *      (this package's CLI, built privately — see below) with its own
 *      GRAPHMIND_HOME, where it writes the agent token file;
 *   2. a real agent, examples/e2e/src/edit-agent.mjs: @graphmind-ai/sdk around a
 *      MockLanguageModelV4 from `ai/test`, whose tool call has a bad argument
 *      (`to: "XYZ"`) the real tool throws on; the server's default
 *      `{point:'error'}` breakpoint holds it at an editable error gate;
 *   3. `graphmind wait` sees the pause; `graphmind resume --input` (presenting
 *      the agent token from the file) is refused by the tool's own schema for
 *      a bad edit — the gate stays held — and resumes for a good one; the tool
 *      runs with the edited argument, the agent finishes, and the stored
 *      `exec.resumed` carries `edited` and `principal: 'agent'`.
 *
 * The viewer's half of the same loop is apps/viewer/e2e/edit-e2e.spec.ts.
 *
 * The server binary is compiled into a private directory (never dist/, which
 * mcp.test.ts rebuilds while suites run in parallel — the control-cli.test.ts
 * pattern). The agent imports @graphmind-ai/sdk's dist, so the workspace
 * packages must be built (`pnpm -r --filter './packages/**' run build`, which
 * CI runs before the tests); locally the suite is skipped without them.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { packageRoot } from '../src/paths.js';
import { waitUntil } from './helpers.js';

const REPO = join(packageRoot, '..', '..');
const AGENT = join(REPO, 'examples', 'e2e', 'src', 'edit-agent.mjs');
const SDK_DIST = join(REPO, 'packages', 'ai-sdk', 'dist', 'index.js');
const BUILD_DIR = join(packageRoot, '.edit-e2e-dist');
const CLI = join(BUILD_DIR, 'cli.js');

const sdkBuilt = existsSync(SDK_DIST);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GRAPHMIND')) env[key] = value;
  }
  return { ...env, GRAPHMIND_TELEMETRY: '0', DO_NOT_TRACK: '1', GRAPHMIND_RETENTION: 'off', ...extra };
}

interface Spawned {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function run(args: string[], env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** One CLI command to completion: exit code and output. */
async function graphmind(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const cmd = run([CLI, ...args], env);
  const code = await cmd.exited;
  return { code, out: cmd.stdout(), err: cmd.stderr() };
}

async function storedEvents(port: number, runId: string): Promise<{ type: string; payload: Record<string, any> }[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${encodeURIComponent(runId)}/events`);
  return ((await response.json()) as { events: { type: string; payload: Record<string, any> }[] }).events;
}

describe.skipIf(!sdkBuilt && process.env['CI'] === undefined)('edit a real held tool call from the CLI', () => {
  beforeAll(() => {
    try {
      // TypeScript's own launcher, run by this node: the `.bin/tsc` shim is a
      // shell script, which execFile cannot start on Windows.
      execFileSync(
        process.execPath,
        [
          join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
          ...['-p', 'tsconfig.build.json', '--outDir', BUILD_DIR],
          ...['--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'],
        ],
        { cwd: packageRoot, stdio: 'pipe' },
      );
    } catch (error) {
      const detail = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`tsc (private CLI build) failed:\n${detail.stdout?.toString() ?? ''}${detail.stderr?.toString() ?? ''}`);
    }
  }, 120_000);

  afterAll(() => {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  });

  it('graphmind wait, then resume --input: refused by the schema, then resumed; the tool runs the edit; stored as agent', async () => {
    const home = tempDir('gm-edit-e2e-home-');
    const port = await freePort();
    const env = childEnv({ GRAPHMIND_HOME: home });
    const serve = run(
      [CLI, 'serve', '--no-open', '--port', String(port), '--db', join(tempDir('gm-edit-e2e-db-'), 'g.db'), '--allow-control=edit'],
      env,
    );
    cleanups.push(async () => {
      serve.child.kill('SIGTERM');
      await Promise.race([serve.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      serve.child.kill('SIGKILL');
    });
    await waitUntil(() => serve.stdout().includes('Press Ctrl+C'), 'serve banner', 20_000);
    expect(serve.stdout()).toContain('control  agent (graphmind resume): edit');
    // The agent token file `graphmind resume` presents (0600).
    const tokenFile = join(home, 'run', `serve-${port}.json`);
    expect(existsSync(tokenFile)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    const agent = run([AGENT], childEnv({ GRAPHMIND_URL: `ws://127.0.0.1:${port}/ingest` }));
    cleanups.push(() => {
      agent.child.kill('SIGKILL');
    });

    // 1. wait: blocks until the gate holds, and says what to do with it.
    const waited = await graphmind(['wait', '--json', '--port', String(port), '--timeout', '30'], env);
    expect(waited.code, waited.err).toBe(0);
    const found = JSON.parse(waited.out.trim()) as {
      pause: { runId: string; pauseId: string; nodeId: string; point: string; editable: boolean; state: string };
      input: Record<string, unknown>;
      error: { message: string };
      next: string[];
    };
    expect(found.pause).toMatchObject({ nodeId: 'tool:convertCurrency', point: 'error', editable: true, state: 'open' });
    expect(found.input).toEqual({ amount: 100, from: 'EUR', to: 'XYZ' });
    expect(found.error.message).toBe('unknown currency code "XYZ"');
    const { runId, pauseId } = found.pause;
    // Ready to paste: the ids are plain words here, and `--port` is named off the default port.
    expect(found.next).toContain(
      `graphmind resume ${pauseId} --run ${runId} --port ${port} --action retry --input @edited-input.json`,
    );

    // 2. A bad edit: the tool's own schema refuses it in the app; the gate stays held.
    const bad = await graphmind(
      ['resume', pauseId, '--run', runId, '--action', 'retry', '--input', '{"to":"US dollars"}', '--port', String(port)],
      env,
    );
    expect(bad.code).toBe(6); // EXIT.refused
    expect(bad.err).toContain(`refused pause ${pauseId} (run ${runId}) [schema]: field "to" is too long (at most 3 characters)`);
    const stillHeld = await graphmind(['pauses', '--json', '--run', runId, '--port', String(port)], env);
    expect(JSON.parse(stillHeld.out) as unknown).toMatchObject({ pauses: [{ pauseId, state: 'open' }] });

    // 3. A good edit, from a file, as the `wait` output suggests.
    const editFile = join(tempDir('gm-edit-e2e-input-'), 'edited-input.json');
    writeFileSync(editFile, '{"to":"USD"}\n');
    const good = await graphmind(
      ['resume', pauseId, '--run', runId, '--action', 'retry', '--input', `@${editFile}`, '--json', '--port', String(port)],
      env,
    );
    expect(good.code, good.err).toBe(0);
    const answer = JSON.parse(good.out.trim()) as { outcome: string; principal: string; requestId: string };
    expect(answer).toMatchObject({ outcome: 'resumed', runId, pauseId, principal: 'agent' });

    // 4. The REAL tool ran with the edited argument and the agent finished.
    expect(await agent.exited, agent.stderr()).toBe(0);
    const line = agent.stdout().split('\n').find((l) => l.startsWith('EDIT_AGENT_RESULT '));
    expect(line, agent.stdout()).toBeDefined();
    const result = JSON.parse((line as string).slice('EDIT_AGENT_RESULT '.length)) as {
      text: string;
      executedWith: { amount: number; from: string; to: string }[];
    };
    expect(result.executedWith).toEqual([
      { amount: 100, from: 'EUR', to: 'XYZ' },
      { amount: 100, from: 'EUR', to: 'USD' },
    ]);
    expect(result.text).toContain('"converted":109');

    // 5. The record: the refusal, then the resume the hub stamped as the agent's.
    let events: { type: string; payload: Record<string, any> }[] = [];
    await waitUntil(
      async () => {
        events = await storedEvents(port, runId);
        return events.some((e) => e.type === 'run.finished');
      },
      'run.finished stored',
      10_000,
    );
    const refused = events.filter((e) => e.type === 'exec.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({ pauseId, code: 'schema' });
    const resumed = events.filter((e) => e.type === 'exec.resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload).toEqual({
      pauseId,
      action: 'retry',
      edited: { after: { amount: 100, from: 'EUR', to: 'USD' } },
      requestId: answer.requestId,
      principal: 'agent',
    });
    const toolDone = events.filter((e) => e.type === 'node.finished' && e.payload['nodeId'] === 'tool:convertCurrency');
    expect(toolDone.map((e) => e.payload['output'])).toEqual([{ amount: 100, from: 'EUR', to: 'USD', converted: 109 }]);
    expect(events.find((e) => e.type === 'run.finished')?.payload).toMatchObject({ status: 'ok' });

    // 6. The pause is gone: a late resume is answered "not held", exit 4.
    const late = await graphmind(['resume', pauseId, '--run', runId, '--action', 'continue', '--port', String(port)], env);
    expect(late.code).toBe(4);
  }, 60_000);
});
