/**
 * The recorded database holds every prompt, tool input, tool output and error
 * the user ever streamed. On a shared machine that is not a 0644 file.
 *
 * POSIX modes are largely inert on Windows (Node reports a synthesized mode
 * and chmod only toggles the read-only bit), so the assertions run on POSIX
 * only — the code path itself is a no-op there by design.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/sqlite-storage.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-perms-'));
  dirs.push(dir);
  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

posixOnly('on-disk permissions', () => {
  it('creates ~/.graphmind 0700 and graphmind.db 0600', () => {
    const base = scratch();
    // Let GraphMind create the directory itself, the way it creates
    // ~/.graphmind on first run.
    const home = join(base, 'dot-graphmind');
    const dbPath = join(home, 'graphmind.db');
    const storage = new SqliteStorage(dbPath);
    try {
      expect(mode(home)).toBe(0o700);
      expect(mode(dbPath)).toBe(0o600);
    } finally {
      storage.close();
    }
    expect(mode(dbPath) & 0o077).toBe(0);
  });

  it('keeps the -wal and -shm siblings owner-only too', () => {
    const base = scratch();
    const dbPath = join(base, 'sub', 'graphmind.db');
    const storage = new SqliteStorage(dbPath);
    try {
      storage.ensureRun({ id: 'r', app: 'a', startedAt: Date.now(), schemaVersion: 1, source: 'live' });
      storage.insertEvent({ runId: 'r', seq: 0, ts: Date.now(), type: 'node.started', nodeId: 'n', payload: {} });
      // The WAL pair exists while the database is open and carries the same
      // data as the database itself.
      for (const sibling of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(existsSync(sibling), sibling).toBe(true);
        expect(mode(sibling) & 0o077, sibling).toBe(0);
      }
    } finally {
      storage.close();
    }
  });

  it('tightens a database file that an older version left world-readable', () => {
    const base = scratch();
    const dbPath = join(base, 'legacy', 'graphmind.db');
    new SqliteStorage(dbPath).close();
    // Simulate the pre-fix state and reopen.
    chmodSync(dbPath, 0o644);
    expect(mode(dbPath)).toBe(0o644);
    const storage = new SqliteStorage(dbPath);
    try {
      expect(mode(dbPath)).toBe(0o600);
    } finally {
      storage.close();
    }
  });

  it('never re-modes a directory it did not create', () => {
    // `graphmind --db /tmp/x.db` must not turn the parent into 0700.
    const base = scratch();
    chmodSync(base, 0o755);
    const storage = new SqliteStorage(join(base, 'graphmind.db'));
    try {
      expect(mode(base)).toBe(0o755);
    } finally {
      storage.close();
    }
  });
});
