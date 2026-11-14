/**
 * Several Jack servers at once (one per worktree): stable per-worktree
 * ports, fallback when taken, and worktree-local discovery.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { choosePort, parsePortFlag, PORT_BASE, portIsFree, readRunInfo, runFile, stablePort, worktreeRoot, writeRunInfo } from '../src/ports.js';

const dir = mkdtempSync(join(tmpdir(), 'jack-ports-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function worktree(name: string) {
  const root = join(dir, name);
  mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n'); // a worktree's .git is a file
  return root;
}

const listen = (port: number) =>
  new Promise<Server>((resolve) => {
    const s = createServer();
    s.listen(port, '127.0.0.1', () => resolve(s));
  });

describe('ports', () => {
  it('stable per worktree, different between worktrees, inside each service window', () => {
    const a = worktree('a');
    const b = worktree('b');
    expect(worktreeRoot(join(a, 'nested', 'deeper'))).toBe(a);
    expect(stablePort('preview', a)).toBe(stablePort('preview', a));
    expect(stablePort('preview', a)).not.toBe(stablePort('preview', b));
    for (const service of ['serve', 'preview', 'acme-tasks'] as const) {
      const p = stablePort(service, a);
      expect(p).toBeGreaterThanOrEqual(PORT_BASE[service]);
      expect(p).toBeLessThan(PORT_BASE[service] + 1_000);
    }
  });

  it('auto moves to the next free port when the preferred one is taken', async () => {
    const root = worktree('busy');
    const preferred = stablePort('preview', root);
    const squatter = await listen(preferred);
    try {
      const chosen = await choosePort('auto', 'preview', root);
      expect(chosen.port).not.toBe(preferred);
      expect(chosen.note).toMatch(new RegExp(`preferred port ${preferred} is busy`));
      expect(await portIsFree(chosen.port)).toBe(true);
    } finally {
      squatter.close();
    }
  });

  it('an explicit port is exact: busy is an error, not a silent move', async () => {
    const squatter = await listen(0);
    const port = (squatter.address() as { port: number }).port;
    try {
      await expect(choosePort(port, 'preview')).rejects.toThrow(/in use/);
    } finally {
      squatter.close();
    }
    expect(await choosePort(0, 'preview')).toEqual({ port: 0 });
    expect(parsePortFlag(undefined)).toBe('auto');
    expect(parsePortFlag('4823')).toBe(4823);
    expect(() => parsePortFlag('70000')).toThrow();
  });
});

describe('discovery', () => {
  it('each worktree finds its own server; stale records (dead pid) are ignored and removed', () => {
    const a = worktree('disc-a');
    const b = worktree('disc-b');
    const unregister = writeRunInfo({ service: 'preview', url: 'http://127.0.0.1:21001/mcp' }, a);
    expect(readRunInfo('preview', a)?.url).toBe('http://127.0.0.1:21001/mcp');
    expect(readRunInfo('preview', b)).toBeNull();
    unregister();
    expect(readRunInfo('preview', a)).toBeNull();

    // A crashed server leaves its file behind: pid 2^22 + 1 is beyond any real pid.
    mkdirSync(join(a, '.jack', 'run'), { recursive: true });
    writeFileSync(runFile('preview', a), JSON.stringify({ service: 'preview', url: 'http://127.0.0.1:1/mcp', pid: 4_194_305, startedAt: '' }));
    expect(readRunInfo('preview', a)).toBeNull();
    expect(readRunInfo('preview', a)).toBeNull(); // and the file is gone
  });
});
