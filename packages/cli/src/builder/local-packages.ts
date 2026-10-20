/**
 * Where a generated project gets its GraphMind adapter from.
 *
 * A published CLI generates `"@graphmind-ai/sdk": "^<its own version>"` and
 * `graphmind-ai>=<version>`: the registry has them, and a project speaks the
 * same wire protocol as the server that made it. A CLI running FROM A
 * CHECKOUT of this repository is a different case: its version may not be
 * published yet (every release goes through exactly that window), so the
 * registry pin would fail at `npm install`. Here the adapters come from the
 * checkout instead:
 *
 *  - npm: `pnpm pack` of the built packages into
 *    `$GRAPHMIND_HOME/workflows/.packages/`, referenced as `file:` tarballs,
 *    with `overrides` so the adapter's own `@graphmind-ai/client` and
 *    `@graphmind-ai/schema` resolve to the local tarballs too (pnpm rewrites
 *    `workspace:*` to the version on pack, and that version is unpublished);
 *  - pip: `graphmind-ai @ file://<checkout>/python`.
 *
 * Detection is a filesystem fact, not a network check: `pnpm-workspace.yaml`
 * two levels above this package. Packing happens once per server process
 * and only when a project is previewed or created.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot, type EnvLike } from '../paths.js';
import { resolveWorkflowsDir } from './projects.js';

/** The npm packages a generated TypeScript project may depend on. */
export const LOCAL_NPM_PACKAGES = ['schema', 'client', 'ai-sdk', 'anthropic', 'openai'] as const;

export interface LocalPackages {
  /** The checkout root. */
  root: string;
  /** npm package name -> absolute tarball path. */
  npm: Record<string, string>;
  /** PEP 508 direct reference for the Python package. */
  pythonRequirement: string;
}

/** The repository root when this CLI runs from a checkout; undefined when installed from npm. */
export function detectCheckout(root: string = resolve(packageRoot, '..', '..')): string | undefined {
  return existsSync(join(root, 'pnpm-workspace.yaml')) && existsSync(join(root, 'packages', 'ai-sdk', 'package.json')) ? root : undefined;
}

export class LocalPackagesError extends Error {
  override name = 'LocalPackagesError';
}

/** Pack the local packages. Throws with the fix when the checkout is not built. */
export function packLocalPackages(root: string, destination: string, platform: NodeJS.Platform = process.platform): LocalPackages {
  const missing = LOCAL_NPM_PACKAGES.filter((name) => !existsSync(join(root, 'packages', name, 'dist', 'index.js')));
  if (missing.length > 0) {
    throw new LocalPackagesError(
      `this graphmind runs from a checkout whose packages are not built (${missing.join(', ')}); run \`pnpm -r --filter './packages/**' build\` first`,
    );
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const npm: Record<string, string> = {};
  for (const name of LOCAL_NPM_PACKAGES) {
    const dir = join(root, 'packages', name);
    const result = spawnSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      shell: platform === 'win32',
    });
    if (result.status !== 0) {
      throw new LocalPackagesError(`pnpm pack failed for packages/${name}: ${(result.stderr || result.stdout || '').trim().slice(-400)}`);
    }
    // pnpm prints the tarball path (or name) last; find the file by package name to be safe.
    const pkgName = name === 'schema' || name === 'client' || name === 'anthropic' || name === 'openai' ? `@graphmind-ai/${name}` : '@graphmind-ai/sdk';
    const prefix = `graphmind-ai-${name === 'ai-sdk' ? 'sdk' : name}-`;
    const file = readdirSync(destination)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.tgz'))
      .sort()
      .at(-1);
    if (file === undefined) throw new LocalPackagesError(`pnpm pack produced no tarball for packages/${name}`);
    npm[pkgName] = join(destination, file);
  }
  return { root, npm, pythonRequirement: `graphmind-ai @ ${pathToFileURL(join(root, 'python')).href}` };
}

let cached: { key: string; value: LocalPackages } | undefined;

/**
 * Local packages for this process, or undefined when the CLI was installed
 * from the registry. Packed once per process per workflows directory.
 */
export function resolveLocalPackages(env: EnvLike = process.env): LocalPackages | undefined {
  if ((env['GRAPHMIND_BUILDER_REGISTRY'] ?? '') === '1') return undefined; // force the published pins
  const root = detectCheckout();
  if (root === undefined) return undefined;
  const destination = join(resolveWorkflowsDir(env), '.packages');
  if (cached !== undefined && cached.key === destination) return cached.value;
  const value = packLocalPackages(root, destination);
  cached = { key: destination, value };
  return value;
}

/** Tests: forget the packed set. */
export function resetLocalPackagesCache(): void {
  cached = undefined;
}
