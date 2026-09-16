#!/usr/bin/env node
/**
 * Measured dependency counts per published package — the numbers quoted in
 * docs/reference/security. Counted from npm's own lockfile after a clean
 * `npm install` of the packed tarballs, i.e. what a consumer gets, not what
 * the pnpm workspace holds.
 *
 *   node scripts/release/dep-count.mjs --tarballs <dir>
 *   node scripts/release/dep-count.mjs --lock <node_modules/.package-lock.json>
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isMain, listPublishablePackages, parseArgs } from './lib.mjs';
import { cleanInstall } from './sbom.mjs';

/**
 * Pure: from a lockfile-v3 `packages` map, the direct and transitive
 * third-party dependency counts of each named package. Workspace siblings
 * (`@graphmind-ai/*`, `graphmind-ai`) are followed but not counted.
 */
export function countDependencies(lockPackages, names, { isOwn = (n) => n === 'graphmind-ai' || n.startsWith('@graphmind-ai/') } = {}) {
  const resolveDep = (fromPath, dep) => {
    let base = fromPath;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${dep}`;
      if (lockPackages[candidate]) return candidate;
      if (!base) return undefined;
      const i = base.lastIndexOf('/node_modules/');
      base = i === -1 ? '' : base.slice(0, i);
    }
  };
  const nameOf = (path) => path.replace(/^.*node_modules\//, '');
  const out = {};
  for (const name of names) {
    const rootPath = `node_modules/${name}`;
    const info = lockPackages[rootPath];
    if (info === undefined) {
      out[name] = undefined;
      continue;
    }
    const seen = new Set();
    const stack = [rootPath];
    while (stack.length > 0) {
      const path = stack.pop();
      const deps = { ...(lockPackages[path].dependencies ?? {}), ...(lockPackages[path].optionalDependencies ?? {}) };
      for (const dep of Object.keys(deps)) {
        const resolved = resolveDep(path, dep);
        if (resolved !== undefined && !seen.has(resolved)) {
          seen.add(resolved);
          stack.push(resolved);
        }
      }
    }
    const direct = Object.keys(info.dependencies ?? {}).filter((d) => !isOwn(d));
    const transitive = [...seen].map(nameOf).filter((n) => !isOwn(n));
    out[name] = { direct, directCount: direct.length, transitiveCount: new Set(transitive).size };
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  let lockPath;
  let cleanup;
  if (typeof args.lock === 'string') lockPath = args.lock;
  else if (typeof args.tarballs === 'string') {
    const dir = cleanInstall(args.tarballs, { log: () => {} });
    lockPath = join(dir, 'node_modules', '.package-lock.json');
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  } else {
    console.error('usage: node scripts/release/dep-count.mjs --tarballs <dir> | --lock <.package-lock.json>');
    process.exit(2);
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')).packages;
  const names = listPublishablePackages().map((p) => p.name);
  const counts = countDependencies(lock, names);
  console.log('package'.padEnd(26), 'direct', 'transitive (third-party, incl. direct)');
  for (const name of names) {
    const c = counts[name];
    console.log(name.padEnd(26), String(c?.directCount ?? '?').padEnd(6), String(c?.transitiveCount ?? '?').padEnd(4), c ? c.direct.join(', ') : 'not installed');
  }
  cleanup?.();
}
