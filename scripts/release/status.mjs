#!/usr/bin/env node
/**
 * Where does every artifact stand, and what stops the next release?
 *
 *   node scripts/release/status.mjs            # table + blockers; exit 1 if anything is behind
 *   node scripts/release/status.mjs --json
 *
 * Read-only: asks npm, PyPI and RubyGems what they serve and compares it with
 * what the repo says, then lists everything that would make the release
 * workflows go red before they get to publish. scripts/release.mjs drives the
 * fixes; this module only knows facts. Everything that touches the network is
 * injectable (see ./test).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  REPO_ROOT,
  SEMVER_RE,
  compareSemver,
  isMain,
  listPublishablePackages,
  parseArgs,
  publishedVersions,
  pypiVersions,
  pythonVersion,
  rubyVersion,
  rubygemsVersions,
} from './lib.mjs';
import { checkVersions } from './check-versions.mjs';
import { findProvenanceBlockers } from './pack.mjs';
import { extractChangelogSection } from './release-notes.mjs';

export const REPO_SLUG = 'Hegazy360/GraphMind';
export const REPO_URL = `git+https://github.com/${REPO_SLUG}.git`;
export const PYPI_NAME = 'graphmind-ai';
export const GEM_NAME = 'graphmind';

/**
 * Every artifact this repo ships, with the version the repo declares:
 * `{ registry, name, local, dir? }`.
 */
export function listArtifacts(root = REPO_ROOT) {
  const out = listPublishablePackages(root).map((p) => ({ registry: 'npm', name: p.name, local: p.version, dir: p.dir }));
  const py = pythonVersion(root);
  if (py !== undefined) out.push({ registry: 'pypi', name: PYPI_NAME, local: py });
  const rb = rubyVersion(root);
  if (rb !== undefined) out.push({ registry: 'rubygems', name: GEM_NAME, local: rb });
  return out;
}

export const defaultLookups = {
  npm: (name) => publishedVersions(name),
  pypi: (name) => pypiVersions(name),
  rubygems: (name) => rubygemsVersions(name),
};

/** Highest non-pre-release version in a Set, or undefined. */
export function latestRelease(versions) {
  let best;
  for (const v of versions ?? []) {
    if (!SEMVER_RE.test(v) || v.includes('-')) continue;
    if (best === undefined || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Attach registry facts to each artifact. `state` is one of
 *   current  the registry serves the repo's version
 *   behind   the package exists on the registry, but not at the repo's version
 *   new      never published at all
 *   unknown  the lookup failed (network) — treat as "not proven"
 */
export async function collectStatus({ root = REPO_ROOT, lookups = defaultLookups, version } = {}) {
  const artifacts = listArtifacts(root);
  return Promise.all(
    artifacts.map(async (a) => {
      const want = version ?? a.local;
      const have = await lookups[a.registry](a.name);
      let state;
      if (have === undefined) state = 'unknown';
      else if (have.has(want)) state = 'current';
      else if (have.size === 0) state = 'new';
      else state = 'behind';
      return { ...a, want, latest: latestRelease(have), state };
    }),
  );
}

/** `{ patch, minor, major }` successors of a released `x.y.z`. */
export function nextVersions(version) {
  const [core] = String(version).split('-');
  const [maj, min, pat] = core.split('.').map(Number);
  if (version.includes('-')) {
    // 0.7.0-rc.2 -> its own release is the natural "next".
    return { patch: core, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` };
  }
  return { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` };
}

/**
 * Everything in the repo itself that would stop the release workflows before
 * they publish, for a release of `version`. Each blocker is
 * `{ id, title, detail, fix?: { kind, ... } }`; scripts/release.mjs knows how
 * to perform each `fix.kind`, and prints `detail` for anything it cannot.
 */
export function findBlockers({ root = REPO_ROOT, version }) {
  const blockers = [];

  const versions = checkVersions({ root });
  const mismatched = versions.entries.filter((e) => e.version !== version);
  if (mismatched.length > 0) {
    blockers.push({
      id: 'version-mismatch',
      title: `Not everything is at ${version}`,
      detail:
        mismatched.map((e) => `${e.what} is ${e.version}`).join('\n') +
        '\nEvery publish workflow starts with check-versions and stops here, so none of them would ship.',
      fix: { kind: 'set-version', version, outliers: mismatched.map((e) => e.what) },
    });
  }

  for (const pkg of listPublishablePackages(root)) {
    const problems = findProvenanceBlockers(pkg.manifest, REPO_SLUG);
    if (problems.length === 0) continue;
    blockers.push({
      id: `provenance:${pkg.name}`,
      title: `${pkg.name}: npm would refuse to publish it with --provenance`,
      detail: problems.join('\n'),
      fix: {
        kind: 'add-repository',
        file: join(pkg.dir, 'package.json'),
        repository: { type: 'git', url: REPO_URL, directory: relative(root, pkg.dir).split('\\').join('/') },
      },
    });
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const text = readFileSync(changelogPath, 'utf8');
    if (extractChangelogSection(text, version) === undefined) {
      const unreleased = extractChangelogSection(text, 'Unreleased');
      blockers.push({
        id: 'changelog',
        title: `CHANGELOG.md has no "## ${version}" section`,
        detail:
          'publish-npm.yml builds the GitHub Release notes from it in the verify job, so npm would not publish.' +
          (unreleased ? '\nThere is an "## Unreleased" section that can become it.' : `\nWrite a "## ${version}" section.`),
        ...(unreleased ? { fix: { kind: 'promote-unreleased', file: changelogPath, version } } : {}),
      });
    }
  }

  return blockers;
}

/** Pure: rename `## Unreleased` to `## <version>` and open a fresh, empty one above it. */
export function promoteUnreleased(text, version) {
  const re = /^##[ \t]+\[?Unreleased\]?[ \t]*$/im;
  if (!re.test(text)) return undefined;
  return text.replace(re, `## Unreleased\n\n## ${version}`);
}

/** The registry page a human would open for an artifact. */
export function registryUrl(a) {
  if (a.registry === 'npm') return `https://www.npmjs.com/package/${a.name}`;
  if (a.registry === 'pypi') return `https://pypi.org/project/${a.name}/`;
  return `https://rubygems.org/gems/${a.name}`;
}

const LABEL = { npm: 'npm', pypi: 'PyPI', rubygems: 'RubyGems' };
const MARK = { current: 'ok     ', behind: 'BEHIND ', new: 'NEW    ', unknown: '?      ' };

/** Plain-text table of `collectStatus` output. */
export function formatStatus(status, { color = (_c, s) => s } = {}) {
  const tint = { current: 32, behind: 33, new: 33, unknown: 31 };
  const nameWidth = Math.max(...status.map((a) => a.name.length)) + 2;
  return status
    .map((a) => {
      const published = a.latest ?? (a.state === 'unknown' ? 'lookup failed' : 'never published');
      return `  ${color(tint[a.state], MARK[a.state])} ${LABEL[a.registry].padEnd(9)} ${a.name.padEnd(nameWidth)} repo ${a.want.padEnd(9)} registry ${published}`;
    })
    .join('\n');
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const status = await collectStatus();
  const version = typeof args.version === 'string' ? args.version : checkVersions().version;
  const blockers = findBlockers({ version });
  if (args.json === true) {
    console.log(JSON.stringify({ version, status, blockers }, null, 2));
  } else {
    console.log(formatStatus(status));
    if (blockers.length > 0) {
      console.log(`\nBlockers for releasing ${version}:`);
      for (const b of blockers) console.log(`  - ${b.title}\n      ${b.detail.split('\n').join('\n      ')}`);
    }
    const behind = status.filter((a) => a.state !== 'current');
    console.log(behind.length === 0 ? '\nEverything is published at the repo\'s version.' : `\n${behind.length} artifact(s) not published at the repo's version. Run: pnpm release`);
  }
  process.exit(status.every((a) => a.state === 'current') && blockers.length === 0 ? 0 : 1);
}
