/**
 * Spec -> project. Pure: the same spec always gives the same files, which is
 * what lets the Build page preview exactly what Create will write.
 */
import { PROVIDER_ENV_KEY, TARGETS, type TargetId, type WorkflowSpec } from '../spec.js';
import { GITIGNORE } from './shared.js';
import { readme } from './ts-common.js';
import { generatePython } from './python.js';
import { generateTsAiSdk } from './ts-ai-sdk.js';
import { generateTsAnthropic } from './ts-anthropic.js';
import { generateTsOpenai } from './ts-openai.js';
import type { Command, EnvKey, GeneratedFile, GeneratedProject } from './types.js';
import type { LocalPackages } from '../local-packages.js';
import { pythonCommands, venvPython, type PythonToolchain } from '../toolchain.js';

export type { AdapterSource, Command, EnvKey, GeneratedFile, GeneratedProject } from './types.js';

export type Platform = 'posix' | 'win32';

export function platformOf(nodePlatform: string = process.platform): Platform {
  return nodePlatform === 'win32' ? 'win32' : 'posix';
}

/**
 * How to install and start a project of this target. Argv arrays, no shell:
 * the runner spawns them as given, and the README prints them joined.
 *
 * Python commands depend on which interpreter the machine has (toolchain.ts):
 * the runner passes the one it resolved; the README, written before anyone
 * knows, gets the generic `python3 -m venv` route plus the uv alternative.
 */
export function commandsFor(
  target: TargetId,
  platform: Platform = platformOf(),
  python?: PythonToolchain,
): { install: Command[]; start: Command } {
  if (TARGETS[target].language === 'typescript') {
    return {
      install: [{ argv: ['npm', 'install', '--no-fund', '--no-audit'], label: 'npm install' }],
      start: { argv: ['npm', 'start'], label: 'npm start' },
    };
  }
  if (python !== undefined) return pythonCommands(python, platform);
  const venv = venvPython(platform);
  const systemPython = platform === 'win32' ? 'python' : 'python3';
  return {
    install: [
      { argv: [systemPython, '-m', 'venv', '.venv'], label: `${systemPython} -m venv .venv` },
      { argv: [venv, '-m', 'pip', 'install', '-r', 'requirements.txt'], label: `${venv} -m pip install -r requirements.txt` },
    ],
    start: { argv: [venv, 'main.py'], label: `${venv} main.py` },
  };
}

export interface GenerateOptions {
  /** Adapters from a checkout instead of the registry (local-packages.ts). */
  local?: LocalPackages | undefined;
}

/** Where to look for "already installed" before running the install step. */
export function installMarker(target: TargetId): string {
  return TARGETS[target].language === 'typescript' ? 'node_modules' : '.venv';
}

export function envKeysFor(spec: WorkflowSpec): EnvKey[] {
  const key = PROVIDER_ENV_KEY[spec.provider];
  return [
    {
      name: key,
      required: true,
      hint: `Your ${spec.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key. Written to .env (owner-only, git-ignored); never shown again.`,
    },
    {
      name: 'GRAPHMIND_URL',
      required: false,
      hint: 'Only if the debugger is not on ws://127.0.0.1:4747/ingest.',
    },
  ];
}

export function generateProject(spec: WorkflowSpec, platform: Platform = platformOf(), options: GenerateOptions = {}): GeneratedProject {
  const target = TARGETS[spec.target];
  const local = options.local;
  let files: GeneratedFile[];
  switch (spec.target) {
    case 'ts-ai-sdk':
      files = generateTsAiSdk(spec, local);
      break;
    case 'ts-anthropic':
      files = generateTsAnthropic(spec, local);
      break;
    case 'ts-openai':
      files = generateTsOpenai(spec, local);
      break;
    case 'py-openai':
    case 'py-anthropic':
      files = generatePython(spec, local);
      break;
  }
  const commands = commandsFor(spec.target, platform);
  const uv = target.language === 'python' ? pythonCommands({ kind: 'uv', bin: 'uv', version: undefined, describe: 'uv' }, platform) : undefined;
  files.push({ path: '.gitignore', content: GITIGNORE });
  files.push({
    path: 'README.md',
    content: readme(spec, {
      install: commands.install.map((c) => c.label),
      start: commands.start.label,
      alternative:
        uv === undefined
          ? undefined
          : {
              title: 'Or, with [uv](https://docs.astral.sh/uv/) (it finds or fetches a 3.10+ interpreter without touching the system Python):',
              lines: [...uv.install.map((c) => c.label), uv.start.label],
            },
      source: local === undefined ? 'registry' : 'checkout',
    }),
  });
  return {
    target,
    source: local === undefined ? 'registry' : 'checkout',
    files,
    install: commands.install,
    start: commands.start,
    envKeys: envKeysFor(spec),
  };
}
