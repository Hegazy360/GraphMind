/**
 * Read the version of an installed peer SDK.
 *
 * `require('<pkg>/package.json')` is the obvious way and it is NOT reliable:
 * a package with an `exports` map only exposes the subpaths it lists, and
 * several SDKs (`openai` since v5, `@anthropic-ai/sdk`) deliberately do not
 * list `./package.json`. Asking for it throws ERR_PACKAGE_PATH_NOT_EXPORTED,
 * which is how every OpenAI-adapter run came to report `openai@unknown`.
 *
 * So try, in order:
 *   1. the `./package.json` subpath — free when the package exposes it
 *      (`ai`, `@langchain/core`, `@langchain/langgraph` all do);
 *   2. the manifest beside the package's resolved entry point;
 *   3. the `node_modules/<name>/package.json` chain above the caller, which
 *      is how Node finds the package DIRECTORY in the first place and so
 *      cannot be hidden by any `exports` map.
 *
 * Never throws and never imports the SDK's runtime code: resolution and a
 * manifest read only, so a missing or exotic peer just yields `undefined`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How far up a directory chain to look before giving up. */
const MAX_WALK_UP = 12;

/**
 * The installed version of `name`, or `undefined` when it cannot be read.
 * `from` is the module URL (or path) resolution starts at — pass the caller's
 * own `import.meta.url` so the peer resolves the way its imports would.
 */
export function peerVersion(name: string, from: string): string | undefined {
  return (
    fromExportedManifest(name, from) ??
    fromResolvedEntry(name, from) ??
    fromNodeModulesChain(name, from)
  );
}

/** The `./package.json` subpath, when the package's `exports` allows it. */
function fromExportedManifest(name: string, from: string): string | undefined {
  try {
    const require = createRequire(from);
    return readVersion(require(`${name}/package.json`), name);
  } catch {
    return undefined;
  }
}

/** The manifest sitting above the resolved entry point, whatever `exports` says. */
function fromResolvedEntry(name: string, from: string): string | undefined {
  let entry: string;
  try {
    entry = createRequire(from).resolve(name);
  } catch {
    return undefined; // no `require` condition, or not installed
  }
  return walkUp(dirname(entry), (dir) => readManifest(join(dir, 'package.json'), name));
}

/**
 * `<ancestor>/node_modules/<name>/package.json`, the directory lookup Node's
 * own resolver performs before it ever consults `exports`. This is the branch
 * that keeps working for a package with no `require` condition at all.
 */
function fromNodeModulesChain(name: string, from: string): string | undefined {
  let start: string;
  try {
    start = dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  } catch {
    return undefined;
  }
  return walkUp(start, (dir) => {
    // Node never appends `node_modules` to a `node_modules` directory.
    if (dir.endsWith(`${sep}node_modules`)) return undefined;
    return readManifest(join(dir, 'node_modules', ...name.split('/'), 'package.json'), name);
  });
}

/** Run `probe` on `dir` and each ancestor until it answers or the root is hit. */
function walkUp(dir: string, probe: (dir: string) => string | undefined): string | undefined {
  const { root } = parse(dir);
  let current = dir;
  for (let step = 0; step < MAX_WALK_UP; step += 1) {
    const found = probe(current);
    if (found !== undefined) return found;
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function readManifest(path: string, name: string): string | undefined {
  try {
    return readVersion(JSON.parse(readFileSync(path, 'utf8')), name);
  } catch {
    return undefined;
  }
}

/** A manifest's `version`, but only if it is the manifest of `name`. */
function readVersion(manifest: unknown, name: string): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const { name: found, version } = manifest as { name?: unknown; version?: unknown };
  if (found !== name) return undefined;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}
