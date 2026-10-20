/**
 * Runs a generated project as a child process and keeps its output for the
 * Build page: install once (skipped when node_modules / .venv exists), then
 * start. The project streams to this server's own /ingest, so the run shows
 * up in the viewer next to the log.
 *
 * What never reaches the log, by construction:
 *
 *  - every value in the project's `.env` (the key the engineer just typed);
 *  - the value of every process environment variable whose NAME looks like a
 *    secret (`isSecretKey`: ANTHROPIC_API_KEY, GITHUB_TOKEN, ...), since the
 *    child inherits this server's environment and a provider SDK that prints
 *    its config on error would otherwise land the operator's key in a log
 *    the viewer displays.
 *
 * Replacement is on the raw text, before a line is stored, so the scrubbed
 * copy is the only copy. Short values (< 6 chars) are not scrubbed: they
 * would blank ordinary words, and a six-character "secret" is not one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { commandsFor, installMarker, platformOf, type Command, type Platform } from './codegen/index.js';
import { readEnvValues } from './env-file.js';
import { requireProject, type StoredProject } from './projects.js';
import type { LogFn } from '../hub.js';
import { REDACTED, isSecretKey } from '../redact-secrets.js';
import { TARGETS, type WorkflowSpec } from './spec.js';
import { NO_PYTHON_MESSAGE, resolvePython, type PythonToolchain } from './toolchain.js';

export type JobPhase = 'installing' | 'running' | 'exited' | 'failed' | 'stopped';

export interface JobLine {
  /** Absolute index since the job started; the client pages with it. */
  i: number;
  stream: 'out' | 'err' | 'sys';
  text: string;
  ts: number;
}

export interface JobInfo {
  id: string;
  dir: string;
  name: string;
  phase: JobPhase;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | undefined;
  /** How many lines have been produced (some may have been dropped from the buffer). */
  total: number;
  pid: number | undefined;
}

export interface RunnerOptions {
  /** This server's ingest URL, read when a job starts (the port is known by then). */
  ingestUrl: () => string;
  log?: LogFn | undefined;
  platform?: Platform | undefined;
  /** Lines kept per job. Default 2000. */
  maxLines?: number | undefined;
  /** Finished jobs remembered. Default 20. */
  maxFinished?: number | undefined;
  /** Override the per-target commands (tests run a tiny script instead of npm). */
  commandsFor?: ((spec: WorkflowSpec, platform: Platform) => { install: Command[]; start: Command }) | undefined;
  /** The parent environment the child inherits. Default process.env. */
  parentEnv?: NodeJS.ProcessEnv | undefined;
  /** Grace between SIGTERM and SIGKILL on stop. Default 3000. */
  killGraceMs?: number | undefined;
  /** Override Python discovery (tests). `null` = behave as if none qualifies. */
  python?: PythonToolchain | null | undefined;
}

export class RunnerError extends Error {
  constructor(
    readonly code: 'already-running' | 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

const MAX_LINE_CHARS = 2000;
const MIN_SCRUB_LENGTH = 6;

interface Job {
  info: JobInfo;
  lines: JobLine[];
  child: ChildProcess | undefined;
  stopRequested: boolean;
  scrub: (text: string) => string;
  killTimer: NodeJS.Timeout | undefined;
}

/** Build the scrubber for one job: `.env` values plus secret-named parent variables. */
export function makeScrubber(values: readonly string[]): (text: string) => string {
  const secrets = [...new Set(values.filter((v) => v.length >= MIN_SCRUB_LENGTH))].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

export class ProjectRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly byDir = new Map<string, string>();
  private readonly log: LogFn;
  private readonly platform: Platform;
  private readonly maxLines: number;
  private readonly maxFinished: number;
  private disposed = false;

  constructor(private readonly options: RunnerOptions) {
    this.log = options.log ?? (() => {});
    this.platform = options.platform ?? platformOf();
    this.maxLines = options.maxLines ?? 2000;
    this.maxFinished = options.maxFinished ?? 20;
  }

  /** Start a job for the project at `dir`. One live job per directory. */
  start(dir: string): JobInfo {
    if (this.disposed) throw new RunnerError('not-found', 'the server is shutting down');
    const project = requireProject(dir);
    const existing = this.byDir.get(project.dir);
    if (existing !== undefined) {
      const live = this.jobs.get(existing);
      if (live !== undefined && (live.info.phase === 'installing' || live.info.phase === 'running')) {
        throw new RunnerError('already-running', `${project.spec.name} is already running (job ${existing}); stop it first`);
      }
    }
    const id = `job_${randomBytes(6).toString('hex')}`;
    const dotenv = readEnvValues(join(project.dir, '.env'));
    const parentEnv = this.options.parentEnv ?? process.env;
    const parentSecrets = Object.entries(parentEnv)
      .filter(([key, value]) => value !== undefined && isSecretKey(key))
      .map(([, value]) => value as string);
    const job: Job = {
      info: {
        id,
        dir: project.dir,
        name: project.spec.name,
        phase: 'installing',
        startedAt: Date.now(),
        endedAt: undefined,
        exitCode: undefined,
        total: 0,
        pid: undefined,
      },
      lines: [],
      child: undefined,
      stopRequested: false,
      scrub: makeScrubber([...Object.values(dotenv), ...parentSecrets]),
      killTimer: undefined,
    };
    this.jobs.set(id, job);
    this.byDir.set(project.dir, id);
    this.pruneFinished();

    // A Python project needs an interpreter >= 3.10 (macOS ships 3.9): find
    // one now, so a machine without one fails here with the fix named, not
    // three commands in with a pip error.
    let python: PythonToolchain | undefined;
    if (TARGETS[project.spec.target].language === 'python' && this.options.commandsFor === undefined) {
      const resolved = this.options.python === undefined ? resolvePython(parentEnv, this.platform) : this.options.python;
      if (resolved === null || resolved === undefined) {
        this.sys(job, NO_PYTHON_MESSAGE);
        this.finish(job, 'failed', undefined);
        return { ...job.info };
      }
      python = resolved;
      this.sys(job, `python: ${python.describe}`);
    }
    const commands = (this.options.commandsFor ?? ((spec, platform) => commandsFor(spec.target, platform, python)))(
      project.spec,
      this.platform,
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...parentEnv,
      ...dotenv,
      GRAPHMIND_URL: this.options.ingestUrl(),
      GRAPHMIND: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };
    const installed = existsSync(join(project.dir, installMarker(project.spec.target)));
    const steps: { command: Command; phase: JobPhase }[] = [
      ...(installed ? [] : commands.install.map((command) => ({ command, phase: 'installing' as const }))),
      { command: commands.start, phase: 'running' as const },
    ];
    if (installed) this.sys(job, `already installed (${installMarker(project.spec.target)} present); skipping install`);
    this.log(`builder: starting ${project.spec.name} in ${project.dir} (${id})`);
    void this.runSteps(job, project, steps, childEnv);
    return { ...job.info };
  }

  private async runSteps(
    job: Job,
    project: StoredProject,
    steps: { command: Command; phase: JobPhase }[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    for (const step of steps) {
      if (job.stopRequested) break;
      job.info.phase = step.phase;
      this.sys(job, `$ ${step.command.label}`);
      const code = await this.spawnStep(job, project.dir, step.command, env);
      if (job.stopRequested) break;
      if (code !== 0) {
        this.sys(job, `${step.command.label} exited with code ${code}`);
        this.finish(job, 'failed', code);
        return;
      }
    }
    if (job.stopRequested) {
      this.finish(job, 'stopped', job.info.exitCode);
      return;
    }
    this.finish(job, 'exited', 0);
  }

  private spawnStep(job: Job, cwd: string, command: Command, env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise<number>((resolve) => {
      const [bin, ...args] = command.argv;
      if (bin === undefined) return resolve(1);
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // npm is npm.cmd on Windows and needs the shell to resolve; the argv
          // is fixed by the generator and contains nothing a caller typed.
          shell: this.platform === 'win32',
        });
      } catch (error) {
        this.sys(job, `could not start ${bin}: ${error instanceof Error ? error.message : String(error)}`);
        return resolve(1);
      }
      job.child = child;
      job.info.pid = child.pid;
      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        job.child = undefined;
        if (job.killTimer !== undefined) {
          clearTimeout(job.killTimer);
          job.killTimer = undefined;
        }
        resolve(code);
      };
      child.on('error', (error) => {
        this.sys(job, `could not start ${bin}: ${error.message}`);
        settle(1);
      });
      const feed = (stream: 'out' | 'err') => {
        let rest = '';
        return (chunk: Buffer | string) => {
          rest += chunk.toString();
          let nl = rest.indexOf('\n');
          while (nl !== -1) {
            this.push(job, stream, rest.slice(0, nl));
            rest = rest.slice(nl + 1);
            nl = rest.indexOf('\n');
          }
          if (rest.length > MAX_LINE_CHARS) {
            this.push(job, stream, rest);
            rest = '';
          }
        };
      };
      const outFeed = feed('out');
      const errFeed = feed('err');
      child.stdout?.on('data', outFeed);
      child.stderr?.on('data', errFeed);
      child.on('close', (code, signal) => {
        if (signal !== null) this.sys(job, `terminated by ${signal}`);
        job.info.exitCode = code ?? (signal !== null ? 1 : 0);
        settle(code ?? (signal !== null ? 1 : 0));
      });
    });
  }

  private push(job: Job, stream: JobLine['stream'], text: string): void {
    const clean = job.scrub(text.replace(/\r$/, ''));
    const line: JobLine = {
      i: job.info.total,
      stream,
      text: clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean,
      ts: Date.now(),
    };
    job.info.total += 1;
    job.lines.push(line);
    if (job.lines.length > this.maxLines) job.lines.splice(0, job.lines.length - this.maxLines);
  }

  private sys(job: Job, text: string): void {
    this.push(job, 'sys', text);
  }

  private finish(job: Job, phase: JobPhase, exitCode: number | undefined): void {
    job.info.phase = phase;
    job.info.exitCode = exitCode;
    job.info.endedAt = Date.now();
    job.info.pid = undefined;
    this.sys(job, phase === 'exited' ? 'finished' : phase === 'stopped' ? 'stopped' : 'failed');
    this.log(`builder: ${job.info.name} ${phase}${exitCode === undefined ? '' : ` (exit ${exitCode})`} (${job.info.id})`);
  }

  get(id: string): JobInfo | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : { ...job.info };
  }

  /** Lines with index >= `after`. */
  lines(id: string, after = 0): JobLine[] {
    const job = this.jobs.get(id);
    if (job === undefined) return [];
    return job.lines.filter((line) => line.i >= after);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => ({ ...job.info })).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** SIGTERM, then SIGKILL after the grace period. False when there is no live job. */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    if (job.info.phase !== 'installing' && job.info.phase !== 'running') return false;
    job.stopRequested = true;
    const child = job.child;
    if (child === undefined) return true;
    this.sys(job, 'stop requested');
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    job.killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, this.options.killGraceMs ?? 3000);
    job.killTimer.unref();
    return true;
  }

  private pruneFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.info.phase !== 'installing' && job.info.phase !== 'running')
      .sort((a, b) => (b.info.endedAt ?? 0) - (a.info.endedAt ?? 0));
    for (const job of finished.slice(this.maxFinished)) {
      this.jobs.delete(job.info.id);
      if (this.byDir.get(job.info.dir) === job.info.id) this.byDir.delete(job.info.dir);
    }
  }

  /** Stop everything; the server is closing. */
  dispose(): void {
    this.disposed = true;
    for (const id of this.jobs.keys()) this.stop(id);
  }
}
