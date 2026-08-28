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
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>   e.g. 0.2.0');
  process.exit(1);
}

// Every workspace package that is published to npm.
const PACKAGES = [
  'schema',
  'client',
  'ai-sdk',
  'anthropic',
  'openai',
  'langgraph',
  'mcp',
  'cli',
];

let changed = 0;
for (const name of PACKAGES) {
  const path = join(root, 'packages', name, 'package.json');
  if (!existsSync(path)) {
    console.warn(`skip packages/${name} (not present)`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.private === true) {
    console.warn(`skip ${pkg.name} (private)`);
    continue;
  }
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

// A publishable package this script does not know about is the failure mode it
// exists to prevent, so say so rather than leaving it silently behind.
const known = new Set(PACKAGES);
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || known.has(entry.name)) continue;
  const path = join(root, 'packages', entry.name, 'package.json');
  if (!existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.private === true) continue;
  console.error(
    `\nERROR: packages/${entry.name} (${pkg.name}) is publishable but is not in PACKAGES — ` +
      'it would ship at the wrong version. Add it to scripts/set-version.mjs.',
  );
  process.exit(1);
}

console.log(`\n${changed} package(s) set to ${version}.`);
console.log('Next: pnpm install && pnpm -r build && pnpm test && pnpm -r publish --access public');
