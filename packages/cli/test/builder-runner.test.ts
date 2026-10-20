/**
 * The project runner: install once, then start; the log the viewer shows
 * never contains the key from `.env` or a secret-named variable the child
 * inherited; stop works; one live job per project.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '../src/builder/codegen/index.js';
import { writeEnvFile } from '../src/builder/env-file.js';
import { createProject } from '../src/builder/projects.js';
import { ProjectRunner, RunnerError, makeScrubber, type JobPhase } from '../src/builder/runner.js';
import { defaultSpec, parseSpec } from '../src/builder/spec.js';
import { waitUntil } from './helpers.js';

const SECRET = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PARENT_SECRET = 'ghp_parentTokenValue1234567890';

let home: string;
let env: Record<string, string>;
let runner: ProjectRunner | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'graphmind-runner-'));
  env = { GRAPHMIND_HOME: home };
});
afterEach(() => {
  runner?.dispose();
  runner = undefined;
  rmSync(home, { recursive: true, force: true });
});

function node(script: string, label = 'node'): Command {
  return { argv: [process.execPath, '-e', script], label };
}

function project(name = 'runner-test'): string {
  const parsed = parseSpec({ ...defaultSpec(), name });
  if (!parsed.ok) throw new Error('bad spec');
  const created = createProject({ spec: parsed.spec, env });
  writeEnvFile(join(created.dir, '.env'), { ANTHROPIC_API_KEY: SECRET });
  return created.dir;
}

function make(commands: { install: Command[]; start: Command }, extra: Partial<ConstructorParameters<typeof ProjectRunner>[0]> = {}): ProjectRunner {
  runner = new ProjectRunner({
    ingestUrl: () => 'ws://127.0.0.1:4999/ingest',
    commandsFor: () => commands,
    parentEnv: { PATH: process.env['PATH'] ?? '', GITHUB_TOKEN: PARENT_SECRET, HARMLESS: 'visible-value' },
    ...extra,
  });
  return runner;
}

async function finished(r: ProjectRunner, id: string): Promise<JobPhase> {
  await waitUntil(() => {
    const phase = r.get(id)?.phase;
    return phase !== undefined && phase !== 'installing' && phase !== 'running';
  }, `job ${id} to finish`, 10_000);
  return r.get(id)?.phase as JobPhase;
}

describe('ProjectRunner', () => {
  it('installs, then runs, with .env and the ingest URL in the child environment, and scrubs secrets from the log', async () => {
    const dir = project();
    const r = make({
      install: [node("console.log('installing deps')", 'fake install')],
      start: node(
        [
          "console.log('key is ' + process.env.ANTHROPIC_API_KEY)",
          "console.error('parent token ' + process.env.GITHUB_TOKEN)",
          "console.log('harmless ' + process.env.HARMLESS)",
          "console.log('ingest ' + process.env.GRAPHMIND_URL + ' gm=' + process.env.GRAPHMIND)",
        ].join(';'),
        'fake start',
      ),
    });
    const job = r.start(dir);
    expect(job.phase).toBe('installing');
    expect(job.name).toBe('runner-test');
    expect(await finished(r, job.id)).toBe('exited');
    const info = r.get(job.id);
    expect(info?.exitCode).toBe(0);

    const text = r.lines(job.id).map((l) => `${l.stream}:${l.text}`).join('\n');
    expect(text).toContain('sys:$ fake install');
    expect(text).toContain('out:installing deps');
    expect(text).toContain('sys:$ fake start');
    expect(text).toContain('out:key is __REDACTED__');
    expect(text).toContain('err:parent token __REDACTED__');
    expect(text).toContain('out:harmless visible-value');
    expect(text).toContain('out:ingest ws://127.0.0.1:4999/ingest gm=1');
    expect(text).toContain('sys:finished');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PARENT_SECRET);
    expect(JSON.stringify(r.list())).not.toContain(SECRET);
  });

  it('skips the install step when the marker directory exists', async () => {
    const dir = project();
    mkdirSync(join(dir, 'node_modules'));
    const r = make({
      install: [node("console.log('MUST NOT RUN')", 'fake install')],
      start: node("console.log('started')", 'fake start'),
    });
    const job = r.start(dir);
    expect(await finished(r, job.id)).toBe('exited');
    const text = r.lines(job.id).map((l) => l.text).join('\n');
    expect(text).toContain('already installed');
    expect(text).not.toContain('MUST NOT RUN');
    expect(text).toContain('started');
  });

  it('marks the job failed when the install step exits non-zero, and does not start', async () => {
    const dir = project();
    const r = make({
      install: [node("console.error('nope'); process.exit(3)", 'fake install')],
      start: node("console.log('MUST NOT RUN')", 'fake start'),
    });
    const job = r.start(dir);
    expect(await finished(r, job.id)).toBe('failed');
    expect(r.get(job.id)?.exitCode).toBe(3);
    const text = r.lines(job.id).map((l) => l.text).join('\n');
    expect(text).toContain('fake install exited with code 3');
    expect(text).not.toContain('MUST NOT RUN');
  });

  it('stops a running job, refuses a second job for the same project while one is live, and pages lines', async () => {
    const dir = project();
    const r = make(
      {
        install: [],
        start: node("console.log('alive'); setInterval(() => {}, 1000)", 'fake start'),
      },
      { killGraceMs: 500 },
    );
    const job = r.start(dir);
    await waitUntil(() => r.get(job.id)?.phase === 'running' && r.lines(job.id).some((l) => l.text === 'alive'), 'running');
    expect(() => r.start(dir)).toThrow(RunnerError);
    const before = r.lines(job.id).length;
    expect(r.stop(job.id)).toBe(true);
    expect(await finished(r, job.id)).toBe('stopped');
    expect(r.stop(job.id)).toBe(false); // nothing live anymore
    const tail = r.lines(job.id, before);
    expect(tail.every((l) => l.i >= before)).toBe(true);
    expect(tail.map((l) => l.text)).toContain('stopped');
    // the project can run again once stopped
    const again = r.start(dir);
    expect(again.id).not.toBe(job.id);
  });

  it('refuses a directory that is not a builder project, and an unknown job', () => {
    const r = make({ install: [], start: node('', 'x') });
    expect(() => r.start(home)).toThrow(/graphmind\.workflow\.json/);
    expect(r.get('job_nope')).toBeUndefined();
    expect(r.stop('job_nope')).toBe(false);
    expect(r.lines('job_nope')).toEqual([]);
  });

  it('keeps the log bounded and the indices absolute', async () => {
    const dir = project();
    const r = make(
      {
        install: [],
        start: node('for (let i = 0; i < 50; i++) console.log("line " + i)', 'spam'),
      },
      { maxLines: 10 },
    );
    const job = r.start(dir);
    expect(await finished(r, job.id)).toBe('exited');
    const lines = r.lines(job.id);
    expect(lines.length).toBe(10);
    expect(r.get(job.id)?.total).toBeGreaterThan(50);
    expect(lines[lines.length - 1]?.text).toBe('finished');
    expect(lines[0]?.i).toBe((r.get(job.id)?.total ?? 0) - 10);
  });
});

describe('makeScrubber', () => {
  it('replaces every secret, longest first, and leaves short values alone', () => {
    const scrub = makeScrubber(['abcdef', 'abcdefghij', 'short', '']);
    expect(scrub('x abcdefghij y abcdef z short')).toBe('x __REDACTED__ y __REDACTED__ z short');
    expect(makeScrubber([])('untouched')).toBe('untouched');
  });
});
