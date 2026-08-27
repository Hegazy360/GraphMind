import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `ready()` must be able to RESOLVE, which means the process has to stay
 * alive long enough to resolve it.
 *
 * This only reproduces in a real child process: the failure mode is Node's
 * event loop draining while the ready() timeout is the sole pending work, so
 * the process dies with code 13 and no output. In-process tests always have
 * vitest's own handles keeping the loop alive, which hides it — which is
 * exactly how this shipped in 0.3.1 and was found by someone running an agent
 * before starting the debugger.
 */
// The BUILT entry, not src: this is what a user imports, and Node's
// type-stripping cannot resolve the source's .js-extension imports anyway.
const clientEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const built = existsSync(clientEntry);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-ready-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runScript(body: string): { stdout: string; status: number } {
  const file = join(dir, 'script.mjs');
  writeFileSync(file, body.replace('__CLIENT__', clientEntry.replace(/\\/g, '\\\\')));
  try {
    const stdout = execFileSync(process.execPath, [file], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GRAPHMIND_TELEMETRY: '0' },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

// Needs `pnpm --filter @graphmind-ai/client build` first; CI builds packages
// before running tests, so this is only skipped in a bare source checkout.
describe.skipIf(!built)('ready() with no debugger listening', () => {
  it('resolves false instead of letting the process die silently', () => {
    const { stdout, status } = runScript(`
      import { createSession } from '__CLIENT__';
      const s = createSession({ app: 'repro', url: 'ws://127.0.0.1:4899/ingest' });
      const attached = await s.ready({ timeoutMs: 300 });
      console.log('RESOLVED:' + attached);
      await s.dispose();
      console.log('DONE');
    `);
    expect(stdout).toContain('RESOLVED:false');
    expect(stdout).toContain('DONE');
    expect(status).toBe(0);
  });

  it('still lets the process exit promptly once settled', () => {
    const started = Date.now();
    const { stdout, status } = runScript(`
      import { createSession } from '__CLIENT__';
      const s = createSession({ app: 'repro', url: 'ws://127.0.0.1:4899/ingest' });
      await s.ready({ timeoutMs: 300 });
      await s.dispose();
      console.log('DONE');
    `);
    expect(stdout).toContain('DONE');
    expect(status).toBe(0);
    // A ref'd timer must not outlive its own timeout: no lingering handle.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
