/**
 * Ports and discovery for running several Jack servers at once — typically
 * one per git worktree.
 *
 *   --port auto (default)  a port derived from the worktree path, so it is the
 *                          SAME every time you start in that worktree (you can
 *                          paste the URL into an AI client once), but DIFFERENT
 *                          between worktrees; if it is taken, the next free one
 *   --port 0               any free port (the OS picks)
 *   --port <n>             exactly n, or fail
 *
 * Every running server writes `.jack/run/<service>.json` in its worktree
 * ({url, pid, …}); `jack tools`, `jack call`, `jack deploy` read it, so the
 * CLI talks to the server of the worktree you are in — never a neighbour's.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

/** Each service gets its own 1,000-port window so services never collide with each other. */
export const PORT_BASE = { serve: 20_000, preview: 21_000, 'acme-tasks': 22_000 } as const;
export type Service = keyof typeof PORT_BASE | (string & {});
const SPAN = 1_000;

/** The worktree (or repo) root: the nearest directory with a `.git` file or folder. Falls back to `start`. */
export function worktreeRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

/** The stable, per-worktree preferred port for a service. */
export function stablePort(service: Service, root: string = worktreeRoot()): number {
  const base = (PORT_BASE as Record<string, number>)[service] ?? 23_000;
  const n = createHash('sha256').update(`${service}\u0000${resolve(root)}`).digest().readUInt32BE(0);
  return base + (n % SPAN);
}

/** True if nothing is listening on 127.0.0.1:port (we can bind it). */
export function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  });
}

export type PortRequest = number | 'auto';

export class PortError extends Error {
  override name = 'PortError';
}

/**
 * Resolve a --port value to a concrete port to listen on. `auto` tries the
 * stable port then scans upward within the service's window; 0 is passed
 * through (the OS chooses at listen time).
 */
export async function choosePort(request: PortRequest, service: Service, root?: string): Promise<{ port: number; note?: string }> {
  if (request !== 'auto') {
    if (request !== 0 && !(await portIsFree(request))) throw new PortError(`port ${request} is in use — use --port auto (the default) to pick a free one`);
    return { port: request };
  }
  const preferred = stablePort(service, root);
  const base = (PORT_BASE as Record<string, number>)[service] ?? 23_000;
  for (let i = 0; i < 50; i++) {
    const port = base + ((preferred - base + i) % SPAN);
    if (await portIsFree(port)) return i === 0 ? { port } : { port, note: `preferred port ${preferred} is busy; using ${port}` };
  }
  return { port: 0, note: `no free port near ${preferred}; using any free port` };
}

export function parsePortFlag(raw: string | undefined): PortRequest {
  if (raw === undefined || raw === 'auto') return 'auto';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new PortError(`--port must be auto, 0 or a port number, got ${raw}`);
  return n;
}

// ------------------------------------------------------------ discovery --

export interface RunInfo {
  service: Service;
  url: string;
  pid: number;
  startedAt: string;
  /** Anything service-specific (MCP URL, issuer, config path…). */
  [extra: string]: unknown;
}

export const runFile = (service: Service, root: string = worktreeRoot()) => join(root, '.jack', 'run', `${service}.json`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Record a running server. Returns a function that removes the record (call it on shutdown). */
export function writeRunInfo(info: Omit<RunInfo, 'pid' | 'startedAt'>, root: string = worktreeRoot()): () => void {
  const path = runFile(info.service as Service, root);
  mkdirSync(dirname(path), { recursive: true });
  const record: RunInfo = { ...info, pid: process.pid, startedAt: new Date().toISOString() } as RunInfo;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as RunInfo;
      if (current.pid === process.pid) rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/** The running server of this worktree, or null (missing file, or its process is gone). */
export function readRunInfo(service: Service, root: string = worktreeRoot()): RunInfo | null {
  const path = runFile(service, root);
  try {
    if (!statSync(path).isFile()) return null;
    const info = JSON.parse(readFileSync(path, 'utf8')) as RunInfo;
    if (typeof info.url !== 'string' || typeof info.pid !== 'number') return null;
    if (!alive(info.pid)) {
      rmSync(path, { force: true }); // stale: the server died without cleaning up
      return null;
    }
    return info;
  } catch {
    return null;
  }
}
