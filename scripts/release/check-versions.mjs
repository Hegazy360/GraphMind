#!/usr/bin/env node
/**
 * The tag must equal every version in the repo, or nothing ships.
 *
 *   node scripts/release/check-versions.mjs --tag v0.5.0     # release
 *   node scripts/release/check-versions.mjs                  # dry run: all equal?
 *
 * Checks the eight npm packages, python/pyproject.toml and the Ruby VERSION
 * constant. A half-bumped monorepo is the failure this exists to prevent:
 * `graphmind-ai@0.5.0` depending on `@graphmind-ai/client@0.5.0` that was
 * never published resolves to ETARGET for every user.
 */
import {
  REPO_ROOT,
  isMain,
  listPublishablePackages,
  parseArgs,
  pythonVersion,
  rubyVersion,
  versionFromTag,
  SEMVER_RE,
} from './lib.mjs';

/**
 * Pure: returns `{ ok, version, entries, problems }`. `tag` is optional; when
 * given, the version it names is the expected one. Otherwise the expectation
 * is that everything agrees with the CLI package.
 */
export function checkVersions({ root = REPO_ROOT, tag } = {}) {
  const problems = [];
  const entries = [];

  const packages = listPublishablePackages(root);
  if (packages.length === 0) problems.push('no publishable packages found under packages/');
  for (const pkg of packages) entries.push({ what: pkg.name, version: pkg.version });

  const py = pythonVersion(root);
  if (py !== undefined) entries.push({ what: 'graphmind-ai (PyPI)', version: py });
  const rb = rubyVersion(root);
  if (rb !== undefined) entries.push({ what: 'graphmind (RubyGems)', version: rb });

  let expected;
  if (tag !== undefined) {
    expected = versionFromTag(tag);
    if (expected === undefined) {
      problems.push(`tag "${tag}" is not of the form v<major>.<minor>.<patch>[-pre]`);
    }
  } else {
    expected = packages.find((p) => p.name === 'graphmind-ai')?.version ?? packages[0]?.version;
  }

  if (expected !== undefined) {
    if (!SEMVER_RE.test(expected)) problems.push(`"${expected}" is not a valid version`);
    for (const entry of entries) {
      if (entry.version !== expected) {
        problems.push(`${entry.what} is ${entry.version}, expected ${expected}`);
      }
    }
  }

  return { ok: problems.length === 0, version: expected, entries, problems };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const tag = typeof args.tag === 'string' ? args.tag : undefined;
  const result = checkVersions({ tag });
  for (const entry of result.entries) console.log(`  ${entry.what.padEnd(26)} ${entry.version}`);
  if (!result.ok) {
    console.error('\nVERSION CHECK FAILED:');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    console.error('\nBump everything in lockstep with: node scripts/set-version.mjs <version>');
    process.exit(1);
  }
  console.log(`\nAll ${result.entries.length} versions agree: ${result.version}${tag ? ` (tag ${tag})` : ''}`);
  if (typeof args.output === 'string') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.output, `${result.version}\n`);
  }
}
