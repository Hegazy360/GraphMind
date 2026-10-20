/**
 * Projects on disk. The builder writes a generated project to a directory,
 * marks it with `graphmind.workflow.json` (the spec, never a secret), and
 * can list and reopen every project it made.
 *
 * Default location: `$GRAPHMIND_HOME/workflows/<name>` (`~/.graphmind/...`),
 * created 0700. A caller may name another directory, which must be absolute;
 * the viewer is the only caller, with the viewer token, on the user's own
 * machine, so this is a convenience boundary, not a security one — the
 * refusals below exist so a typo cannot scatter files into `/` or `~`.
 *
 * Create never deletes. A non-empty directory is refused unless `overwrite`
 * is set, and even then only the generated files are rewritten: `.env` and
 * anything the engineer added are left exactly as they were.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';
import { envKeysPresent, validateEnvUpdates, writeEnvFile } from './env-file.js';
import { generateProject, installMarker, platformOf, type GeneratedProject, type Platform } from './codegen/index.js';
import type { LocalPackages } from './local-packages.js';
import { SPEC_FILE, specFileContent } from './codegen/shared.js';
import { PROJECT_NAME_RE, parseSpec, type WorkflowSpec } from './spec.js';
import { resolveHome, type EnvLike } from '../paths.js';
import { VERSION } from '../version.js';

export { SPEC_FILE };

export class ProjectError extends Error {
  constructor(
    readonly code: 'bad-dir' | 'exists' | 'not-a-project' | 'bad-env',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export function resolveWorkflowsDir(env: EnvLike = process.env): string {
  return join(resolveHome(env), 'workflows');
}

/**
 * Where a project goes. An explicit directory must be absolute and must not
 * be a filesystem root or the home directory itself.
 */
export function resolveProjectDir(spec: WorkflowSpec, explicit: string | undefined, env: EnvLike): string {
  if (explicit === undefined || explicit.trim() === '') return join(resolveWorkflowsDir(env), spec.name);
  const trimmed = explicit.trim();
  if (!isAbsolute(trimmed)) throw new ProjectError('bad-dir', 'the project directory must be an absolute path');
  if (/\0/.test(trimmed)) throw new ProjectError('bad-dir', 'the project directory is not a valid path');
  const dir = normalize(resolve(trimmed));
  const root = parse(dir).root;
  if (dir === root || dir === normalize(homedir())) {
    throw new ProjectError('bad-dir', 'pick a directory for the project, not the filesystem root or your home directory');
  }
  return dir;
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

export interface CreateProjectOptions {
  spec: WorkflowSpec;
  dir?: string | undefined;
  /** Environment variables to write to `.env`. Values never leave this call. */
  secrets?: Record<string, unknown> | undefined;
  overwrite?: boolean | undefined;
  env?: EnvLike | undefined;
  platform?: Platform | undefined;
  /** Adapters from a checkout (local-packages.ts) instead of the registry. */
  local?: LocalPackages | undefined;
  now?: (() => Date) | undefined;
}

export interface CreateProjectResult {
  dir: string;
  /** Relative paths written, in order. */
  files: string[];
  /** Names of the variables now set in `.env`. Never values. */
  envWritten: string[];
  project: GeneratedProject;
}

export function createProject(options: CreateProjectOptions): CreateProjectResult {
  const env = options.env ?? (process.env as EnvLike);
  const spec = options.spec;
  const dir = resolveProjectDir(spec, options.dir, env);
  const secrets = options.secrets === undefined ? {} : validateEnvUpdatesOrThrow(options.secrets);

  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ProjectError('bad-dir', `${dir} exists and is not a directory`);
    if (!isEmptyDir(dir) && options.overwrite !== true) {
      throw new ProjectError(
        'exists',
        `${dir} already exists and is not empty; pick another name or directory, or choose to overwrite the generated files`,
      );
    }
  }

  const project = generateProject(spec, options.platform ?? platformOf(), { local: options.local });
  // The default home is private to the user; mkdir's mode is ignored where
  // the directory already exists, which is what we want.
  mkdirSync(resolveWorkflowsDir(env), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const written: string[] = [];
  for (const file of project.files) {
    const target = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
    written.push(file.path);
  }
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  writeFileSync(join(dir, SPEC_FILE), specFileContent(spec, VERSION, createdAt), 'utf8');
  written.push(SPEC_FILE);

  let envWritten: string[] = [];
  if (Object.keys(secrets).length > 0) {
    writeEnvFile(join(dir, '.env'), secrets);
    envWritten = envKeysPresent(join(dir, '.env'));
  } else if (existsSync(join(dir, '.env'))) {
    envWritten = envKeysPresent(join(dir, '.env'));
  }
  return { dir, files: written, envWritten, project };
}

function validateEnvUpdatesOrThrow(secrets: Record<string, unknown>): Record<string, string> {
  try {
    return validateEnvUpdates(secrets);
  } catch (error) {
    throw new ProjectError('bad-env', error instanceof Error ? error.message : String(error));
  }
}

export interface StoredProject {
  dir: string;
  spec: WorkflowSpec;
  createdAt: string | undefined;
  generator: string | undefined;
}

/** Read a project the builder made. Undefined when `dir` has no valid spec file. */
export function readProject(dir: string): StoredProject | undefined {
  const path = join(dir, SPEC_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const parsed = parseSpec(record['spec']);
  if (!parsed.ok) return undefined;
  return {
    dir,
    spec: parsed.spec,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : undefined,
    generator: typeof record['generator'] === 'string' ? record['generator'] : undefined,
  };
}

/** `dir` must be an absolute path to a directory the builder made. */
export function requireProject(dir: unknown): StoredProject {
  if (typeof dir !== 'string' || dir.trim() === '' || !isAbsolute(dir) || /\0/.test(dir)) {
    throw new ProjectError('bad-dir', 'dir must be the absolute path of a project the builder created');
  }
  const project = readProject(normalize(resolve(dir)));
  if (project === undefined) {
    throw new ProjectError('not-a-project', `${dir} has no ${SPEC_FILE}; only projects the builder created can be run from here`);
  }
  return project;
}

export interface ProjectSummary {
  dir: string;
  name: string;
  target: WorkflowSpec['target'];
  provider: WorkflowSpec['provider'];
  model: string;
  toolCount: number;
  createdAt: string | undefined;
  /** The install step has run (node_modules / .venv present). */
  installed: boolean;
  /** Variables set in `.env`. Names only. */
  envKeys: string[];
}

export function summarize(project: StoredProject): ProjectSummary {
  return {
    dir: project.dir,
    name: project.spec.name,
    target: project.spec.target,
    provider: project.spec.provider,
    model: project.spec.model,
    toolCount: project.spec.tools.length,
    createdAt: project.createdAt,
    installed: existsSync(join(project.dir, installMarker(project.spec.target))),
    envKeys: envKeysPresent(join(project.dir, '.env')),
  };
}

/** Every project under the workflows directory, newest first. */
export function listProjects(env: EnvLike = process.env): ProjectSummary[] {
  const root = resolveWorkflowsDir(env);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const name of names) {
    if (!PROJECT_NAME_RE.test(name)) continue;
    const dir = `${root}${sep}${name}`;
    const project = readProject(dir);
    if (project !== undefined) out.push(summarize(project));
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
