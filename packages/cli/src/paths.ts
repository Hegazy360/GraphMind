/** Filesystem defaults: database location and the built viewer directory. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_PORT = 4747;

/** This file lives in `<packageRoot>/src` or `<packageRoot>/dist`. */
export const packageRoot: string = fileURLToPath(new URL('..', import.meta.url));

/**
 * `$GRAPHMIND_HOME`, defaulting to `~/.graphmind`. Holds the telemetry id and
 * the `run/` directory (a running server's control-credential files). The
 * database keeps its own resolution (`resolveDbPath`) so an existing
 * `GRAPHMIND_HOME` never moves anyone's recorded runs.
 */
export function resolveHome(env: EnvLike = process.env): string {
  const home = env['GRAPHMIND_HOME'];
  return home !== undefined && home !== '' ? resolve(home) : join(homedir(), '.graphmind');
}

/** `$GRAPHMIND_HOME/run`: one credential file per running `serve` (dir 0700, files 0600). */
export function resolveRunDir(env: EnvLike = process.env): string {
  return join(resolveHome(env), 'run');
}

/** `--db` beats `GRAPHMIND_DB` beats `~/.graphmind/graphmind.db`. */
export function resolveDbPath(explicit: string | undefined, env: EnvLike = process.env): string {
  const fromEnv = env['GRAPHMIND_DB'];
  const path = explicit ?? fromEnv;
  if (path !== undefined && path !== '') return resolve(path);
  return join(homedir(), '.graphmind', 'graphmind.db');
}

/**
 * Where the built viewer lives: `<packageRoot>/viewer-dist` (i.e.
 * `../viewer-dist` relative to the compiled `dist/` directory). The viewer is
 * built separately and copied in at publish time — it may be absent, in which
 * case the server serves a placeholder page instead.
 */
export function resolveViewerDist(explicit: string | undefined, env: EnvLike = process.env): string {
  const fromEnv = env['GRAPHMIND_VIEWER_DIST'];
  const path = explicit ?? fromEnv;
  if (path !== undefined && path !== '') return resolve(path);
  return join(packageRoot, 'viewer-dist');
}
