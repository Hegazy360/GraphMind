/**
 * Anonymous usage telemetry: event name + random install id + version, nothing
 * else — no payloads, no PII, no run data. Full disclosure in ../TELEMETRY.md.
 *
 * Switches, in precedence order (see telemetryMode):
 *   DO_NOT_TRACK=1|true      -> off, always (the cross-tool convention wins
 *                               over every GraphMind-specific setting)
 *   GRAPHMIND_TELEMETRY=0    -> off ("false" too)
 *   GRAPHMIND_TELEMETRY=log  -> print the exact payload to stderr, send nothing
 *                               (also in CI — it is how you audit what would go)
 *   CI set                   -> off (never collect from build machines)
 *   otherwise                -> send
 * When off, nothing is written to disk and nothing is sent.
 *
 * Delivery is fire-and-forget over node:http(s) with the socket unref()ed so
 * an in-flight request can never hold the process open (an undici fetch would
 * keep the event loop alive for up to its abort timeout). Requests time out
 * after 3s, and every failure — offline, DNS, non-2xx, unwritable home dir —
 * is silent: telemetry must never break or slow the CLI.
 *
 * This module is deliberately self-contained (no relative imports; version is
 * read from package.json directly) so tests can import the .ts file into a
 * bare child process under Node's type stripping.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_ENDPOINT = 'https://graphmind.ai/api/telemetry';
const TIMEOUT_MS = 3000;

/** Events are short command names only ('serve', 'demo', 'run-ingested', ...). */
const EVENT_RE = /^[a-z][a-z-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

type EnvLike = Record<string, string | undefined>;

export type TelemetryMode = 'send' | 'log' | 'off';

/** Prefix of every line `GRAPHMIND_TELEMETRY=log` writes to stderr. */
export const LOG_PREFIX = '[graphmind telemetry] ';

/** `1` / `true`, case-insensitive, surrounding whitespace ignored. */
function isOn(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Pure precedence, exported for tests. `DO_NOT_TRACK` (consoledonottrack.com)
 * is checked first and wins over everything, including `GRAPHMIND_TELEMETRY=1`
 * and `=log`: a user who set the cross-tool switch must never have to learn
 * ours. `log` beats the CI rule on purpose — it sends nothing, and printing
 * the payload on a build machine is exactly how someone audits it.
 */
export function telemetryMode(env: EnvLike): TelemetryMode {
  if (isOn(env['DO_NOT_TRACK'])) return 'off';
  const flag = (env['GRAPHMIND_TELEMETRY'] ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false') return 'off';
  if (flag === 'log') return 'log';
  if (env['CI'] !== undefined) return 'off'; // never collect from CI machines
  return 'send';
}

/** `$GRAPHMIND_HOME/telemetry-id`, defaulting to `~/.graphmind/telemetry-id`. */
function installIdPath(env: EnvLike): string {
  const home = env['GRAPHMIND_HOME'];
  const dir = home !== undefined && home !== '' ? resolve(home) : join(homedir(), '.graphmind');
  return join(dir, 'telemetry-id');
}

let cachedId: { path: string; id: string } | undefined;

/**
 * A random UUID persisted on first use. If the file is unreadable or
 * unwritable, falls back to an ephemeral per-process id rather than failing.
 */
function loadInstallId(env: EnvLike): string {
  const path = installIdPath(env);
  if (cachedId !== undefined && cachedId.path === path) return cachedId.id;

  let id: string | undefined;
  try {
    const raw = readFileSync(path, 'utf8').trim().toLowerCase();
    if (UUID_RE.test(raw)) id = raw;
  } catch {
    // first use (or unreadable) — generate below
  }
  if (id === undefined) {
    id = randomUUID();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // unwritable: keep the ephemeral id for this process
    }
  }
  cachedId = { path, id };
  return id;
}

/**
 * Record one usage event: fire-and-forget POST of
 * `{ event, installId, version, ts }` to the telemetry endpoint
 * (GRAPHMIND_TELEMETRY_URL overrides the default, for tests).
 * Synchronous, non-blocking, and silent on every failure.
 */
export function recordTelemetry(event: string): void {
  try {
    const env: EnvLike = process.env;
    const mode = telemetryMode(env);
    if (mode === 'off') return;
    if (!EVENT_RE.test(event)) return; // command names only, never data

    const body = JSON.stringify({
      event,
      installId: loadInstallId(env),
      version: VERSION,
      ts: new Date().toISOString(),
    });

    if (mode === 'log') {
      // The exact bytes a send would carry, and nothing is sent. stderr, not
      // stdout: `graphmind runs --json` and friends own stdout.
      process.stderr.write(`${LOG_PREFIX}${body}\n`);
      return;
    }

    const endpoint = env['GRAPHMIND_TELEMETRY_URL'];
    const url = new URL(endpoint !== undefined && endpoint !== '' ? endpoint : DEFAULT_ENDPOINT);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, {
      method: 'POST',
      agent: false, // one-shot socket, no keep-alive pool
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      timeout: TIMEOUT_MS,
    });
    req.on('error', () => {}); // silent: never crash, never log
    req.on('timeout', () => req.destroy());
    req.on('socket', (socket) => socket.unref()); // never hold the process open
    req.on('response', (res) => res.resume()); // drain and discard
    req.end(body);
  } catch {
    // telemetry must never break the CLI
  }
}
