/**
 * Shared pieces of the release scripts. Everything that talks to the outside
 * world (the registry, the shell) is injectable so the scripts can be unit
 * tested without a network or an npm account — see ./test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY = 'https://registry.npmjs.org';

/** Strict semver (with an optional pre-release), the only shape we publish. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Every workspace package under packages/ that is not `private: true`, in
 * directory order. Returns `{ name, version, dir, manifest }` records.
 */
export function listPublishablePackages(root = REPO_ROOT) {
  const out = [];
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return out;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private === true) continue;
    out.push({ name: manifest.name, version: manifest.version, dir: join(packagesDir, entry.name), manifest });
  }
  return out;
}

/** `v1.2.3` or `refs/tags/v1.2.3` -> `1.2.3`; anything else -> undefined. */
export function versionFromTag(tag) {
  if (typeof tag !== 'string') return undefined;
  const bare = tag.replace(/^refs\/tags\//, '');
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(bare);
  return match ? match[1] : undefined;
}

/** Version declared by python/pyproject.toml, or undefined when absent. */
export function pythonVersion(root = REPO_ROOT) {
  const path = join(root, 'python', 'pyproject.toml');
  if (!existsSync(path)) return undefined;
  const match = /^version\s*=\s*["']([^"']+)["']/m.exec(readFileSync(path, 'utf8'));
  return match ? match[1] : undefined;
}

/** Version declared by ruby/lib/graphmind/version.rb, or undefined when absent. */
export function rubyVersion(root = REPO_ROOT) {
  const path = join(root, 'ruby', 'lib', 'graphmind', 'version.rb');
  if (!existsSync(path)) return undefined;
  const match = /^\s*VERSION\s*=\s*["']([^"']+)["']/m.exec(readFileSync(path, 'utf8'));
  return match ? match[1] : undefined;
}

/** Compare two `x.y.z[-pre]` strings numerically. Pre-release < release. */
export function compareSemver(a, b) {
  const pa = String(a).split('-');
  const pb = String(b).split('-');
  const na = pa[0].split('.').map(Number);
  const nb = pb[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) < (nb[i] ?? 0) ? -1 : 1;
  }
  if (pa[1] === undefined && pb[1] === undefined) return 0;
  if (pa[1] === undefined) return 1;
  if (pb[1] === undefined) return -1;
  return pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0;
}

/** True when `version` is at least `min` (both `x.y.z`). */
export function satisfiesMin(version, min) {
  const clean = String(version).trim();
  if (!/^\d+\.\d+\.\d+/.test(clean)) return false;
  return compareSemver(clean, min) >= 0;
}

/**
 * The registry document for one package, or undefined when it does not exist
 * (404) — a first publish of a brand-new package must not be an error.
 * Network failures propagate so a caller can retry.
 */
export async function fetchPackument(name, { fetch: fetchImpl = globalThis.fetch, registry = REGISTRY } = {}) {
  const res = await fetchImpl(`${registry}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${name}`);
  return res.json();
}

/** Which of `versions` the registry already has for `name`. */
export async function publishedVersions(name, options) {
  let doc;
  try {
    doc = await fetchPackument(name, options);
  } catch {
    return undefined; // unknown: the caller decides whether to retry
  }
  return new Set(Object.keys(doc?.versions ?? {}));
}

/**
 * Run a command, streaming its output, and return the exit code. `spawn` is
 * injectable for tests. Never throws on a non-zero exit; throws if the
 * binary cannot be started at all.
 */
export function run(command, args, { cwd = REPO_ROOT, env = process.env, spawn = spawnSync, stdio = 'inherit' } = {}) {
  const result = spawn(command, args, { cwd, env, stdio, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Parse `--flag value` / `--flag=value` / `--bool` argv into an object. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = true;
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the module at `moduleUrl` is the script node was started with. */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === moduleUrl;
  } catch {
    return false;
  }
}
