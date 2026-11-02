/**
 * Which Python runs a generated Python project.
 *
 * The SDK needs Python >= 3.10 and macOS ships 3.9 as `python3`, so "just
 * run python3" fails on a stock Mac. The runner therefore picks, in order:
 *
 *  1. `GRAPHMIND_PYTHON`: an interpreter the user named (any version check
 *     is theirs);
 *  2. `uv`, when installed: `uv venv --python '>=3.10'` uses an interpreter
 *     uv already manages or downloads one into uv's own directory. Nothing
 *     touches the system interpreter, and `pip` is never needed;
 *  3. the newest `python3.X` on PATH that reports >= 3.10, then `python3`
 *     and `python` if they qualify.
 *
 * Nothing here installs or modifies anything: when no interpreter
 * qualifies, the install step fails with a message naming the fix.
 */
import { spawnSync } from 'node:child_process';
import type { Platform } from './codegen/types.js';
import { pythonCommands, venvPython, type PythonToolchain } from './toolchain-commands.js';

export { pythonCommands, venvPython, type PythonToolchain };

export const MIN_PYTHON: readonly [number, number] = [3, 10];

const CANDIDATES = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];

/** Version of `bin`, as [major, minor], or undefined when it does not run. */
export function pythonVersion(bin: string, platform: Platform = process.platform === 'win32' ? 'win32' : 'posix'): [number, number] | undefined {
  try {
    const result = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: platform === 'win32',
    });
    if (result.status !== 0) return undefined;
    const [major, minor] = result.stdout.trim().split(/\s+/).map(Number);
    return major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor) ? undefined : [major, minor];
  } catch {
    return undefined;
  }
}

function hasUv(platform: Platform): boolean {
  try {
    const result = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 5_000, shell: platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function resolvePython(env: Record<string, string | undefined> = process.env, platform: Platform = process.platform === 'win32' ? 'win32' : 'posix'): PythonToolchain | undefined {
  const explicit = env['GRAPHMIND_PYTHON'];
  if (explicit !== undefined && explicit.trim() !== '') {
    const version = pythonVersion(explicit.trim(), platform);
    return { kind: 'interpreter', bin: explicit.trim(), version: version === undefined ? undefined : version.join('.'), describe: `GRAPHMIND_PYTHON=${explicit.trim()}` };
  }
  if (hasUv(platform)) return { kind: 'uv', bin: 'uv', version: undefined, describe: 'uv (manages its own interpreters; the system Python is not touched)' };
  for (const candidate of CANDIDATES) {
    const version = pythonVersion(candidate, platform);
    if (version !== undefined && (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1]))) {
      return { kind: 'interpreter', bin: candidate, version: version.join('.'), describe: `${candidate} (${version.join('.')})` };
    }
  }
  return undefined;
}

export const NO_PYTHON_MESSAGE =
  `no Python >= ${MIN_PYTHON.join('.')} found. Install uv (https://docs.astral.sh/uv/getting-started/installation/), ` +
  'which keeps its interpreters out of the system, or set GRAPHMIND_PYTHON to a 3.10+ interpreter.';

/** The venv's interpreter, relative to the project. */
