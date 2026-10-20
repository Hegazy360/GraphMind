/**
 * The generated project's `.env`: where an engineer's API key lives.
 *
 * Rules, all enforced here so the routes cannot get them wrong:
 *
 *  - the file is created owner-only (0600) and written atomically (a temp
 *    file in the same directory, then rename), so a crash never leaves a
 *    half-written key and another local user never reads it;
 *  - writing MERGES: keys the caller did not send are kept as they were;
 *  - values are never returned, logged or echoed. `envKeysPresent` reports
 *    which names have a non-empty value, and nothing else;
 *  - a value with a line break is refused rather than escaped, because the
 *    generated loaders (Node's `process.loadEnvFile`, the Python six-liner)
 *    are line-based and would read the second line as another variable.
 */
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `ANTHROPIC_API_KEY`, `GRAPHMIND_URL`: upper-case names as the SDKs read them. */
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_ENV_VALUE_LENGTH = 4096;
/** At most this many variables in one write (a key file, not a config store). */
export const MAX_ENV_ENTRIES = 32;

export class EnvFileError extends Error {
  constructor(
    readonly code: 'bad-key' | 'bad-value' | 'too-many',
    message: string,
  ) {
    super(message);
    this.name = 'EnvFileError';
  }
}

/** Parse `KEY=VALUE` lines; comments, blanks and `export ` prefixes are tolerated. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // an unquoted trailing comment
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Quote only when needed, and never with escapes: the three loaders that read
 * this file (Node's `process.loadEnvFile`, the generated Python six-liner, and
 * `parseEnvFile` here) agree on plain and quoted values but not on escape
 * sequences, so `validateEnvUpdates` refuses the values that would need them.
 */
function quoteIfNeeded(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

export function serializeEnv(entries: Record<string, string>): string {
  const keys = Object.keys(entries).sort();
  return keys.map((key) => `${key}=${quoteIfNeeded(entries[key] as string)}`).join('\n') + (keys.length > 0 ? '\n' : '');
}

/** Validate what a caller wants to write. Throws EnvFileError; never logs a value. */
export function validateEnvUpdates(updates: Record<string, unknown>): Record<string, string> {
  const keys = Object.keys(updates);
  if (keys.length > MAX_ENV_ENTRIES) {
    throw new EnvFileError('too-many', `at most ${MAX_ENV_ENTRIES} variables per write`);
  }
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      throw new EnvFileError('bad-key', `"${key}" is not an environment variable name (UPPER_CASE letters, digits, underscores)`);
    }
    const value = updates[key];
    if (typeof value !== 'string') throw new EnvFileError('bad-value', `the value of ${key} must be a string`);
    if (value.length > MAX_ENV_VALUE_LENGTH) throw new EnvFileError('bad-value', `the value of ${key} is too long`);
    if (/[\r\n\0]/.test(value)) throw new EnvFileError('bad-value', `the value of ${key} must be a single line`);
    if (value.includes('\\')) throw new EnvFileError('bad-value', `the value of ${key} must not contain a backslash`);
    if (value.includes('"') && value.includes("'")) {
      throw new EnvFileError('bad-value', `the value of ${key} must not contain both kinds of quote`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merge `updates` into `.env` at `path` (created 0600 if absent). An empty
 * string REMOVES a key, so "clear my key" is expressible. Returns the names
 * written and the names removed; never a value.
 */
export function writeEnvFile(
  path: string,
  updates: Record<string, string>,
): { written: string[]; removed: string[] } {
  const current = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  const written: string[] = [];
  const removed: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === '') {
      if (key in current) {
        delete current[key];
        removed.push(key);
      }
    } else {
      current[key] = value;
      written.push(key);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.env.${process.pid}.${Date.now()}.tmp`);
  // O_EXCL via 'wx': never follow a planted symlink; mode applies at creation.
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, serializeEnv(current));
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: no POSIX mode bits; the file is still private to the user profile
  }
  renameSync(tmp, path);
  return { written: written.sort(), removed: removed.sort() };
}

/** Which variables have a non-empty value. Names only, by design. */
export function envKeysPresent(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const entries = parseEnvFile(readFileSync(path, 'utf8'));
    return Object.keys(entries)
      .filter((key) => (entries[key] ?? '') !== '')
      .sort();
  } catch {
    return [];
  }
}

/** The values, for the runner's environment and its log scrubber only. */
export function readEnvValues(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
