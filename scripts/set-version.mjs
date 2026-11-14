#!/usr/bin/env node
/**
 * Set the version of every publishable package (and the Python package) in
 * lockstep, so a release is one command and never a half-bumped monorepo.
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * Workspace dependencies stay `workspace:*` — pnpm rewrites them to the real
 * version at publish time.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { listPublishablePackages } from './release/lib.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>   e.g. 0.2.0');
  process.exit(1);
}

// Every workspace package that is published to npm — discovered exactly the
// way check-versions, publish-npm and verify-published discover them (every
// non-private package under packages/). A hand-kept list here drifted from
// those once already, and a new package then blocked every release.
let changed = 0;
for (const { dir } of listPublishablePackages(root)) {
  const path = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const before = pkg.version;
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name.padEnd(26)} ${before} -> ${version}`);
  changed += 1;
}

// The Python distribution ships from the same repo and shares the version.
const pyproject = join(root, 'python', 'pyproject.toml');
if (existsSync(pyproject)) {
  const text = readFileSync(pyproject, 'utf8');
  const next = text.replace(/^(version\s*=\s*)["'][^"']+["']/m, `$1"${version}"`);
  if (next !== text) {
    writeFileSync(pyproject, next);
    console.log(`${'graphmind-ai (python)'.padEnd(26)} -> ${version}`);
    changed += 1;
  } else {
    console.warn('python/pyproject.toml: no top-level version field updated');
  }
  // graphmind/_version.py derives from installed metadata, so there is no
  // second constant to keep in step here — that is deliberate.
}

// The TypeScript client reports its version in `hello` from a constant (a
// runtime read of package.json breaks inside bundled host apps), so it is
// rewritten here with the package; packages/client/test/version.test.ts
// fails if the two ever disagree.
const clientVersion = join(root, 'packages', 'client', 'src', 'version.ts');
if (existsSync(clientVersion)) {
  const text = readFileSync(clientVersion, 'utf8');
  const next = text.replace(/^(export const CLIENT_VERSION = )'[^']+'/m, `$1'${version}'`);
  if (next !== text) {
    writeFileSync(clientVersion, next);
    console.log(`${'client CLIENT_VERSION'.padEnd(26)} -> ${version}`);
  } else if (!text.includes(`CLIENT_VERSION = '${version}'`)) {
    console.warn('packages/client/src/version.ts: no CLIENT_VERSION constant updated');
  }
}

// The Ruby gem ships from the same repo and shares the version. Its constant
// is the source of truth (the gemspec reads it), so this is the only place.
const rubyVersion = join(root, 'ruby', 'lib', 'graphmind', 'version.rb');
if (existsSync(rubyVersion)) {
  const text = readFileSync(rubyVersion, 'utf8');
  const next = text.replace(/^(\s*VERSION\s*=\s*)["'][^"']+["']/m, `$1"${version}"`);
  if (next !== text) {
    writeFileSync(rubyVersion, next);
    console.log(`${'graphmind (ruby gem)'.padEnd(26)} -> ${version}`);
    changed += 1;
  } else {
    console.warn('ruby/lib/graphmind/version.rb: no VERSION constant updated');
  }
}

console.log(`\n${changed} package(s) set to ${version}.`);
console.log('Next: pnpm release   (verifies, tags, publishes everywhere, and confirms each step)');
