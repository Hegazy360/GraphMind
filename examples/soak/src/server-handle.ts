/**
 * Parent-side handle for the out-of-process soak server: spawn, IPC
 * request/response, an RSS trace sampled the whole time it is up, and timed
 * REST helpers.
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MemSample {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface DbSizes {
  db: number;
  wal: number;
  shm: number;
  total: number;
}

export interface ServerHandleOptions {
  pingIntervalMs?: number;
  memIntervalMs?: number;
  retention?: 'off' | 'on';
  verbose?: boolean;
}

const CHILD = fileURLToPath(new URL('./server-child.ts', import.meta.url));

export class SoakServer {
  private nextId = 1;
  private readonly pending = new Map<number, (body: Record<string, unknown>) => void>();
  readonly mem: MemSample[] = [];
  /**
   * RSS read from outside the child with `ps`. The in-child sampler is a
   * setInterval, and a server saturated with synchronous SQLite writes starves
   * its own timers — so under exactly the load worth measuring, the in-process
   * trace goes sparse. This one cannot be starved.
   */
  readonly psRss: { at: number; rss: number }[] = [];
  private psTimer: NodeJS.Timeout | undefined;
  readonly logs: string[] = [];
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    readonly port: number,
    readonly dbPath: string,
    private readonly tmpDir: string,
    private readonly verbose: boolean,
  ) {}

  get ingestUrl(): string {
    return `ws://127.0.0.1:${this.port}/ingest`;
  }

  get uiUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws/ui`;
  }

  static async start(options: ServerHandleOptions = {}): Promise<SoakServer> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'graphmind-soak-'));
    const dbPath = join(tmpDir, 'soak.db');
    const childOptions = {
      dbPath,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
      memIntervalMs: options.memIntervalMs ?? 1000,
      retention: options.retention ?? 'off',
    };
    const child = fork(CHILD, [JSON.stringify(childOptions)], {
      execArgv: ['--expose-gc', '--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, GRAPHMIND_TELEMETRY: '0' },
    });

    return await new Promise<SoakServer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('soak server did not start within 30s')), 30_000);
      let handle: SoakServer | undefined;
      child.on('message', (raw: unknown) => {
        const message = raw as { t: string; [key: string]: unknown };
        if (message.t === 'ready' && handle === undefined) {
          clearTimeout(timer);
          handle = new SoakServer(
            child,
            message['url'] as string,
            message['port'] as number,
            message['dbPath'] as string,
            tmpDir,
            options.verbose === true,
          );
          handle.wire();
          resolve(handle);
          return;
        }
        if (message.t === 'fatal') {
          clearTimeout(timer);
          reject(new Error(`soak server failed to start: ${String(message['error'])}`));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (handle === undefined) reject(new Error(`soak server exited early (code ${String(code)})`));
      });
    });
  }

  /** Start sampling the child's RSS from outside every `intervalMs`. */
  startPsSampler(intervalMs = 250): void {
    if (this.psTimer !== undefined) return;
    const pid = this.child.pid;
    if (pid === undefined) return;
    this.psTimer = setInterval(() => {
      try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
        const kb = Number(out.trim());
        if (Number.isFinite(kb)) this.psRss.push({ at: Date.now(), rss: kb * 1024 });
      } catch {
        /* process gone */
      }
    }, intervalMs);
    this.psTimer.unref();
  }

  stopPsSampler(): void {
    if (this.psTimer !== undefined) clearInterval(this.psTimer);
    this.psTimer = undefined;
  }

  psSince(mark: number): { at: number; rss: number }[] {
    return this.psRss.filter((sample) => sample.at >= mark);
  }

  private wire(): void {
    this.child.on('message', (raw: unknown) => {
      const message = raw as { t: string; id?: number; [key: string]: unknown };
      if (message.t === 'mem') {
        this.mem.push(message as unknown as MemSample);
        return;
      }
      if (message.t === 'log') {
        const line = String(message['line']);
        this.logs.push(line);
        if (this.verbose) console.log(`  [server] ${line}`);
        return;
      }
      if (message.t === 'reply' && typeof message.id === 'number') {
        const settle = this.pending.get(message.id);
        this.pending.delete(message.id);
        settle?.(message);
      }
    });
    this.child.once('exit', () => {
      this.exited = true;
    });
  }

  private call(t: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.resolve({ ok: false, error: 'server process has exited' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.send({ t, id, ...extra });
    });
  }

  /** Force a full GC in the server process and report what stayed resident. */
  async gc(): Promise<{ rss: number; heapUsed: number; external: number }> {
    const reply = await this.call('gc');
    return {
      rss: Number(reply['rss'] ?? 0),
      heapUsed: Number(reply['heapUsed'] ?? 0),
      external: Number(reply['external'] ?? 0),
    };
  }

  async dbSizes(): Promise<DbSizes> {
    const reply = await this.call('db');
    return {
      db: Number(reply['db'] ?? 0),
      wal: Number(reply['wal'] ?? 0),
      shm: Number(reply['shm'] ?? 0),
      total: Number(reply['total'] ?? 0),
    };
  }

  async prune(policy: { keepRuns?: number; keepDays?: number }): Promise<Record<string, unknown>> {
    return await this.call('prune', policy);
  }

  async vacuum(): Promise<Record<string, unknown>> {
    return await this.call('vacuum');
  }

  async close(): Promise<DbSizes> {
    this.stopPsSampler();
    const reply = await this.call('close');
    await new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      this.child.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    const sizes: DbSizes = {
      db: Number(reply['db'] ?? 0),
      wal: Number(reply['wal'] ?? 0),
      shm: Number(reply['shm'] ?? 0),
      total: Number(reply['total'] ?? 0),
    };
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    return sizes;
  }

  cleanup(): void {
    try {
      rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Timed REST call. Returns the parsed body plus wall-clock duration. */
  async api<T>(path: string): Promise<{ ms: number; bytes: number; body: T; status: number }> {
    const started = performance.now();
    const response = await fetch(`${this.url}${path}`);
    const text = await response.text();
    const ms = performance.now() - started;
    return {
      ms,
      bytes: Buffer.byteLength(text),
      status: response.status,
      body: JSON.parse(text) as T,
    };
  }

  /** RSS growth across the sampled window (peak and final vs. the first sample). */
  memReport(): { first: number; peak: number; last: number; samples: number } {
    if (this.mem.length === 0) return { first: 0, peak: 0, last: 0, samples: 0 };
    let peak = 0;
    for (const sample of this.mem) peak = Math.max(peak, sample.rss);
    return {
      first: (this.mem[0] as MemSample).rss,
      peak,
      last: (this.mem[this.mem.length - 1] as MemSample).rss,
      samples: this.mem.length,
    };
  }

  memSince(mark: number): MemSample[] {
    return this.mem.filter((sample) => sample.at >= mark);
  }
}
