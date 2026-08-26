/**
 * Kill switches and environment-derived defaults.
 *
 * Precedence for "is GraphMind enabled":
 *   1. GRAPHMIND_DISABLED=1        -> disabled, always (ops-level kill switch,
 *                                     beats even an explicit opts.enabled).
 *   2. opts.enabled (if provided)  -> as given.
 *   3. NODE_ENV === 'production'   -> disabled unless GRAPHMIND=1.
 *   4. otherwise                   -> enabled.
 */

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_URL = 'ws://127.0.0.1:4747/ingest';

export function resolveEnabled(explicit: boolean | undefined, env: EnvLike): boolean {
  if (env['GRAPHMIND_DISABLED'] === '1') return false;
  if (explicit !== undefined) return explicit;
  if (env['NODE_ENV'] === 'production' && env['GRAPHMIND'] !== '1') return false;
  return true;
}

export function resolveUrl(explicit: string | undefined, env: EnvLike): string {
  return explicit ?? env['GRAPHMIND_URL'] ?? DEFAULT_URL;
}
