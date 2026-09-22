/**
 * Kill switches and environment-derived defaults.
 *
 * Precedence for "is GraphMind enabled":
 *   1. GRAPHMIND_DISABLED=1        -> disabled, always (ops-level kill switch,
 *                                     beats even an explicit opts.enabled). Any
 *                                     value but ''/0/false/off/no counts — see
 *                                     killSwitchOn.
 *   2. opts.enabled (if provided)  -> as given.
 *   3. NODE_ENV === 'production'   -> disabled unless GRAPHMIND=1.
 *   4. otherwise                   -> enabled.
 *
 * Loop hold (parsed in loop-guard.ts, option > env > default per field):
 *   GRAPHMIND_LOOP_THRESHOLD  non-negative integer, default 3; 0 disables.
 *   GRAPHMIND_ON_LOOP         pause (default) | warn | off.
 *   GRAPHMIND_LOOP_ALLOW      comma-separated node ids/names never held (tools that poll).
 *
 * Edited input (0.6.0, see edit-input.ts):
 *   GRAPHMIND_DISABLE_EDIT_INPUT  kill switch (killSwitchOn spelling): `edit-input`
 *                                 is not announced and every edit is refused.
 */

export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_URL = 'ws://127.0.0.1:4747/ingest';

/** The spellings that mean "off" for a kill switch. Everything else is on. */
const KILL_SWITCH_OFF = new Set(['', '0', 'false', 'off', 'no']);

/**
 * A kill switch or privacy switch read from the environment: ON for any value
 * except unset, empty, `0`, `false`, `off` and `no` (case-insensitive,
 * surrounding whitespace ignored). These switches exist to keep data out of a
 * recording or to turn instrumentation off, so an unexpected spelling —
 * `yes`, `on`, `TRUE ` — must err towards the switch being on. (Until 0.6
 * only `1`/`true` counted, so `GRAPHMIND_HIDE_INPUTS=yes` silently recorded
 * everything.) Python and Ruby implement the same rule.
 */
export function killSwitchOn(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return !KILL_SWITCH_OFF.has(value.trim().toLowerCase());
}

export function resolveEnabled(explicit: boolean | undefined, env: EnvLike): boolean {
  if (killSwitchOn(env['GRAPHMIND_DISABLED'])) return false;
  if (explicit !== undefined) return explicit;
  if (env['NODE_ENV'] === 'production' && env['GRAPHMIND'] !== '1') return false;
  return true;
}

export function resolveUrl(explicit: string | undefined, env: EnvLike): string {
  return explicit ?? env['GRAPHMIND_URL'] ?? DEFAULT_URL;
}
