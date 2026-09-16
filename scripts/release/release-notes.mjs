#!/usr/bin/env node
/**
 * The CHANGELOG section for one version, for the GitHub Release body.
 *
 *   node scripts/release/release-notes.mjs --version 0.5.0 [--out notes.md]
 *
 * A version with no section is an error: a release whose notes say nothing is
 * a release nobody can assess, and the CHANGELOG is where the integrator
 * writes them (see internal/decisions.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, isMain, listPublishablePackages, parseArgs } from './lib.mjs';

/**
 * Pure: the body under `## <version>` up to the next `## ` heading, trimmed.
 * Matches `## 0.5.0`, `## v0.5.0`, `## [0.5.0]` and `## 0.5.0 — 2026-09-14`.
 * Returns undefined when the version has no section.
 */
export function extractChangelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (heading.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n').trim();
  return body === '' ? undefined : body;
}

/** The release body: the CHANGELOG section plus a fixed verification footer. */
export function releaseBody({ version, section, repoSlug = 'Hegazy360/GraphMind' }) {
  const packages = ['graphmind-ai', '@graphmind-ai/sdk', '@graphmind-ai/client', '@graphmind-ai/schema', '@graphmind-ai/anthropic', '@graphmind-ai/openai', '@graphmind-ai/langgraph', '@graphmind-ai/mcp'];
  return [
    section,
    '',
    '---',
    '',
    '### Verify this release',
    '',
    'Every npm tarball attached here was published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) from this repository\'s `publish-npm.yml` workflow. To check on your machine:',
    '',
    '```sh',
    `npm view graphmind-ai@${version} dist.attestations   # non-empty = attested`,
    `npm install graphmind-ai@${version} && npm audit signatures`,
    '```',
    '',
    `A CycloneDX SBOM (\`graphmind-${version}.cdx.json\`) covering the eight npm packages and their complete dependency closure, as installed from these exact tarballs, is attached. Checksums: \`SHA256SUMS\`.`,
    '',
    `Packages: ${packages.map((p) => `\`${p}@${version}\``).join(', ')}. PyPI: \`graphmind-ai==${version}\` (attestations at https://pypi.org/project/graphmind-ai/${version}/#files). Full policy: [SECURITY.md](https://github.com/${repoSlug}/blob/master/SECURITY.md).`,
    '',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const version = typeof args.version === 'string' ? args.version : listPublishablePackages()[0]?.version;
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const section = extractChangelogSection(changelog, version);
  if (section === undefined) {
    console.error(`CHANGELOG.md has no "## ${version}" section — write the release notes before tagging.`);
    process.exit(1);
  }
  const body = releaseBody({ version, section, repoSlug: process.env.GITHUB_REPOSITORY ?? 'Hegazy360/GraphMind' });
  if (typeof args.out === 'string') {
    writeFileSync(args.out, body);
    console.log(`release notes for ${version} written to ${args.out} (${body.length} chars)`);
  } else {
    process.stdout.write(body);
  }
}
