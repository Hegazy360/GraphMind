/**
 * How to make and use a virtualenv — argv only, no probing.
 *
 * Split from toolchain.ts (which spawns interpreters to find one) so the
 * code generator stays free of `node:child_process` and can therefore run in
 * the browser: the Build page generates the project it shows without a
 * server (see apps/viewer/src/builder/BuilderPage.tsx).
 */
import type { Platform } from './codegen/types.js';
import type { Command } from './codegen/types.js';

export interface PythonToolchain {
  kind: 'uv' | 'interpreter';
  /** `uv`, or the interpreter path. */
  bin: string;
  /** "3.12", when known. */
  version: string | undefined;
  /** One line for the job log. */
  describe: string;
}

export function venvPython(platform: Platform): string {
  return platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
}

/** Install and start commands for a Python project under this toolchain. */
export function pythonCommands(toolchain: PythonToolchain, platform: Platform): { install: Command[]; start: Command } {
  const python = venvPython(platform);
  if (toolchain.kind === 'uv') {
    return {
      install: [
        { argv: ['uv', 'venv', '--quiet', '--python', '>=3.10', '.venv'], label: "uv venv --python '>=3.10' .venv" },
        { argv: ['uv', 'pip', 'install', '--quiet', '--python', python, '-r', 'requirements.txt'], label: `uv pip install --python ${python} -r requirements.txt` },
      ],
      start: { argv: [python, 'main.py'], label: `${python} main.py` },
    };
  }
  return {
    install: [
      { argv: [toolchain.bin, '-m', 'venv', '.venv'], label: `${toolchain.bin} -m venv .venv` },
      { argv: [python, '-m', 'pip', 'install', '--quiet', '-r', 'requirements.txt'], label: `${python} -m pip install -r requirements.txt` },
    ],
    start: { argv: [python, 'main.py'], label: `${python} main.py` },
  };
}
