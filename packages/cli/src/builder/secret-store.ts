/**
 * Keys that never touch the disk.
 *
 * The Build page offers two places to put an API key: the project's `.env`
 * (env-file.ts — owner-only, git-ignored, survives a restart) or here. Here
 * means: held in this server process's memory, handed to the child process
 * when a run starts, scrubbed out of the job log, forgotten when the server
 * exits, when the TTL passes, or the moment the engineer clicks Forget.
 *
 * The guarantees this file is responsible for:
 *
 *  - a value is never written anywhere: no `.env`, no spec file, no log, no
 *    HTTP response. `names()` is the only read path that leaves this module
 *    apart from `values()`, which exists for the runner's child environment
 *    and its scrubber;
 *  - `toJSON` is overridden, so a store that ends up inside something that
 *    gets serialized (a debug dump, an error payload) cannot leak a value;
 *  - entries expire, so a key typed in the morning is not still in memory
 *    at the end of the day;
 *  - the empty string removes a name, the same convention env-file.ts uses.
 */
import { ENV_KEY_RE, EnvFileError, MAX_ENV_VALUE_LENGTH, MAX_ENV_ENTRIES } from './env-file.js';

/** How long a session key stays usable without being re-entered. */
export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

interface Entry {
  value: string;
  expiresAt: number;
}

export interface SessionSecretsOptions {
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class SessionSecrets {
  private readonly byDir = new Map<string, Map<string, Entry>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SessionSecretsOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Hold `updates` for `dir` until the TTL passes. The same validation as a
   * write to `.env`, so the two paths accept exactly the same values and a
   * key typed into one is accepted by the other.
   *
   * Returns the names now held, never a value.
   */
  set(dir: string, updates: Record<string, unknown>): string[] {
    const keys = Object.keys(updates);
    if (keys.length > MAX_ENV_ENTRIES) throw new EnvFileError('too-many', `at most ${MAX_ENV_ENTRIES} variables per write`);
    const entries = this.entriesFor(dir);
    for (const key of keys) {
      if (!ENV_KEY_RE.test(key)) {
        throw new EnvFileError('bad-key', `"${key}" is not an environment variable name (UPPER_CASE letters, digits, underscores)`);
      }
      const value = updates[key];
      if (typeof value !== 'string') throw new EnvFileError('bad-value', `the value of ${key} must be a string`);
      if (value.length > MAX_ENV_VALUE_LENGTH) throw new EnvFileError('bad-value', `the value of ${key} is too long`);
      // A line break would be a second variable to any loader that saw it;
      // refusing it here keeps the two stores interchangeable.
      if (/[\r\n\0]/.test(value)) throw new EnvFileError('bad-value', `the value of ${key} must be a single line`);
      if (value === '') entries.delete(key);
      else entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    }
    if (entries.size === 0) this.byDir.delete(dir);
    return this.names(dir);
  }

  /** Which names are held for `dir`. Names only, by design. */
  names(dir: string): string[] {
    return [...this.live(dir).keys()].sort();
  }

  /** The values, for the runner's child environment and its log scrubber only. */
  values(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of this.live(dir)) out[key] = entry.value;
    return out;
  }

  /** Forget everything held for `dir` (or just `names`). Returns what went. */
  clear(dir: string, names?: readonly string[]): string[] {
    const entries = this.byDir.get(dir);
    if (entries === undefined) return [];
    const gone: string[] = [];
    for (const key of names ?? [...entries.keys()]) {
      if (entries.delete(key)) gone.push(key);
    }
    if (entries.size === 0) this.byDir.delete(dir);
    return gone.sort();
  }

  /** Every directory holding at least one live key. */
  dirs(): string[] {
    const out: string[] = [];
    for (const dir of this.byDir.keys()) if (this.live(dir).size > 0) out.push(dir);
    return out.sort();
  }

  /** The server is closing. */
  dispose(): void {
    for (const entries of this.byDir.values()) entries.clear();
    this.byDir.clear();
  }

  /** Never serialize a value, whatever ends up holding a reference to this. */
  toJSON(): string {
    return '[session secrets: values are not serializable]';
  }

  private entriesFor(dir: string): Map<string, Entry> {
    const existing = this.live(dir);
    if (this.byDir.has(dir)) return existing;
    const created = new Map<string, Entry>();
    this.byDir.set(dir, created);
    return created;
  }

  /** The entries for `dir` with the expired ones dropped. */
  private live(dir: string): Map<string, Entry> {
    const entries = this.byDir.get(dir);
    if (entries === undefined) return new Map();
    const now = this.now();
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
    if (entries.size === 0) this.byDir.delete(dir);
    return entries;
  }
}
