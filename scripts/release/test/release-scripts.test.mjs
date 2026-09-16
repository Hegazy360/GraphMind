/**
 * Unit tests for scripts/release/*.mjs — no network, no npm account, no
 * Actions runner. Run with:
 *
 *   node --test scripts/release/test/
 *
 * Anything that would touch the registry or the shell is injected.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compareSemver, fetchPackument, listPublishablePackages, parseArgs, satisfiesMin, versionFromTag } from '../lib.mjs';
import { checkVersions } from '../check-versions.mjs';
import { findProvenanceBlockers, findUnpublishableSpecifiers, packAll } from '../pack.mjs';
import { planPublish, publishNpm, waitUntilPublished } from '../publish-npm.mjs';
import { provenanceOf, verifyProvenance } from '../verify-provenance.mjs';
import { extractChangelogSection, releaseBody } from '../release-notes.mjs';
import { validateSbom } from '../sbom.mjs';
import { summarizeAuditJson } from '../audit-signatures.mjs';
import { countDependencies } from '../dep-count.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A miniature monorepo: two public packages, one private, python + ruby. */
function fakeRepo({ version = '1.2.3', python = version, ruby = version, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gm-release-'));
  dirs.push(root);
  const pkg = (dir, manifest) => {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(manifest, null, 2));
  };
  pkg('cli', { name: 'graphmind-ai', version, repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' }, dependencies: { '@graphmind-ai/client': 'workspace:*' }, ...extra.cli });
  pkg('client', { name: '@graphmind-ai/client', version, repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' }, ...extra.client });
  pkg('internal', { name: 'internal-thing', version: '0.0.0', private: true });
  mkdirSync(join(root, 'packages', 'no-manifest'));
  if (python !== null) {
    mkdirSync(join(root, 'python'));
    writeFileSync(join(root, 'python', 'pyproject.toml'), `[project]\nname = "graphmind-ai"\nversion = "${python}"\n`);
  }
  if (ruby !== null) {
    mkdirSync(join(root, 'ruby', 'lib', 'graphmind'), { recursive: true });
    writeFileSync(join(root, 'ruby', 'lib', 'graphmind', 'version.rb'), `module Graphmind\n  VERSION = "${ruby}"\nend\n`);
  }
  return root;
}

const lookupFrom = (table) => async (name) => (table[name] === null ? undefined : new Set(table[name] ?? []));

describe('lib', () => {
  it('versionFromTag accepts v-prefixed semver and refs/tags/, nothing else', () => {
    assert.equal(versionFromTag('v0.5.0'), '0.5.0');
    assert.equal(versionFromTag('refs/tags/v0.5.0-rc.1'), '0.5.0-rc.1');
    for (const bad of ['0.5.0', 'v0.5', 'v0.5.0.1', 'release-0.5.0', '', undefined, 'vlatest']) {
      assert.equal(versionFromTag(bad), undefined, String(bad));
    }
  });

  it('compareSemver / satisfiesMin: the npm >= 11.5.1 trusted-publishing floor', () => {
    assert.equal(compareSemver('11.4.2', '11.5.1'), -1);
    assert.equal(compareSemver('11.5.1', '11.5.1'), 0);
    assert.equal(compareSemver('11.10.0', '11.5.1'), 1); // numeric, not lexical
    assert.equal(compareSemver('11.5.1-pre.1', '11.5.1'), -1);
    assert.equal(satisfiesMin('11.5.1\n', '11.5.1'), true); // `npm --version` has a newline
    assert.equal(satisfiesMin('10.9.8', '11.5.1'), false);
    assert.equal(satisfiesMin('12.0.2', '11.5.1'), true);
    assert.equal(satisfiesMin('garbage', '11.5.1'), false);
  });

  it('parseArgs handles --k v, --k=v and bare flags', () => {
    assert.deepEqual(parseArgs(['--tag', 'v1.0.0', '--dry-run', '--out=x.json', 'pos']), { _: ['pos'], tag: 'v1.0.0', 'dry-run': true, out: 'x.json' });
  });

  it('listPublishablePackages skips private packages and directories without a manifest', () => {
    const root = fakeRepo();
    assert.deepEqual(listPublishablePackages(root).map((p) => p.name).sort(), ['@graphmind-ai/client', 'graphmind-ai']);
  });

  it('fetchPackument: 404 is "not published yet", other errors throw', async () => {
    const fetch404 = async () => ({ status: 404, ok: false });
    assert.equal(await fetchPackument('@graphmind-ai/new', { fetch: fetch404 }), undefined);
    const fetch500 = async () => ({ status: 503, ok: false });
    await assert.rejects(fetchPackument('graphmind-ai', { fetch: fetch500 }), /503/);
    let url;
    const fetchOk = async (u) => {
      url = u;
      return { status: 200, ok: true, json: async () => ({ versions: { '1.0.0': {} } }) };
    };
    const doc = await fetchPackument('@graphmind-ai/client', { fetch: fetchOk });
    assert.deepEqual(Object.keys(doc.versions), ['1.0.0']);
    assert.equal(url, 'https://registry.npmjs.org/@graphmind-ai%2Fclient');
  });
});

describe('check-versions', () => {
  it('passes when npm, PyPI and gem versions all equal the tag', () => {
    const result = checkVersions({ root: fakeRepo(), tag: 'v1.2.3' });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.version, '1.2.3');
    assert.equal(result.entries.length, 4); // 2 npm + python + ruby
  });

  it('fails loudly, naming every package, when the tag does not match', () => {
    const result = checkVersions({ root: fakeRepo(), tag: 'v1.2.4' });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 4);
    assert.match(result.problems.join('\n'), /graphmind-ai is 1\.2\.3, expected 1\.2\.4/);
    assert.match(result.problems.join('\n'), /graphmind \(RubyGems\) is 1\.2\.3, expected 1\.2\.4/);
  });

  it('catches a half-bumped repo without a tag (dry run)', () => {
    const drift = checkVersions({ root: fakeRepo({ python: '1.2.2' }) });
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.problems, ['graphmind-ai (PyPI) is 1.2.2, expected 1.2.3']);
    const rubyDrift = checkVersions({ root: fakeRepo({ ruby: '9.9.9' }) });
    assert.deepEqual(rubyDrift.problems, ['graphmind (RubyGems) is 9.9.9, expected 1.2.3']);
    const npmDrift = checkVersions({ root: fakeRepo({ extra: { client: { version: '1.2.2' } } }) });
    assert.deepEqual(npmDrift.problems, ['@graphmind-ai/client is 1.2.2, expected 1.2.3']);
  });

  it('rejects a malformed tag and an empty repo', () => {
    assert.match(checkVersions({ root: fakeRepo(), tag: 'release-1' }).problems[0], /not of the form/);
    const empty = mkdtempSync(join(tmpdir(), 'gm-empty-'));
    dirs.push(empty);
    assert.match(checkVersions({ root: empty }).problems[0], /no publishable packages/);
  });
});

describe('pack', () => {
  it('flags workspace:, link: and file: specifiers — the npm-publish-instead-of-pnpm mistake', () => {
    const bad = findUnpublishableSpecifiers({ dependencies: { a: 'workspace:*', b: '^1.0.0' }, peerDependencies: { c: 'link:../c' }, optionalDependencies: { d: 'file:../d' } });
    assert.deepEqual(bad, ['dependencies.a: workspace:*', 'peerDependencies.c: link:../c', 'optionalDependencies.d: file:../d']);
    assert.deepEqual(findUnpublishableSpecifiers({ dependencies: { a: '0.5.0' } }), []);
    assert.deepEqual(findUnpublishableSpecifiers({}), []);
  });

  it('flags what npm --provenance would refuse', () => {
    assert.deepEqual(findProvenanceBlockers({ repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' } }, 'Hegazy360/GraphMind'), []);
    assert.deepEqual(findProvenanceBlockers({}, 'Hegazy360/GraphMind'), ['repository.url is missing']);
    assert.match(findProvenanceBlockers({ repository: { url: 'https://github.com/other/repo' } }, 'Hegazy360/GraphMind')[0], /does not name/);
    assert.deepEqual(findProvenanceBlockers({ repository: { url: 'x' }, private: true }, undefined), ['package is private']);
  });

  it('packAll: runs pnpm pack per package and verifies each tarball manifest', () => {
    const root = fakeRepo();
    const out = join(root, 'tarballs');
    const calls = [];
    // Fake pnpm: drop a tarball named like pnpm would. Fake tar: return the
    // manifest with workspace:* rewritten, as pnpm pack does.
    const spawn = (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      const name = basename(opts.cwd);
      writeFileSync(join(args[2], `${name}-1.2.3.tgz`), 'not really a tarball');
      return { status: 0 };
    };
    const exec = (_tar, args) => {
      const file = basename(args[1]);
      return file.startsWith('cli-')
        ? JSON.stringify({ name: 'graphmind-ai', version: '1.2.3', repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' }, dependencies: { '@graphmind-ai/client': '1.2.3' } })
        : JSON.stringify({ name: '@graphmind-ai/client', version: '1.2.3', repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' } });
    };
    const result = packAll({ root, outDir: out, repoSlug: 'Hegazy360/GraphMind', spawn, exec });
    assert.deepEqual(result.problems, []);
    assert.equal(result.tarballs.length, 2);
    assert.deepEqual(calls[0].slice(0, 2), ['pnpm', 'pack']);
  });

  it('packAll: a tarball that still says workspace:* fails the check', () => {
    const root = fakeRepo();
    const spawn = (_cmd, args, opts) => {
      writeFileSync(join(args[2], `${basename(opts.cwd)}-1.2.3.tgz`), '');
      return { status: 0 };
    };
    const exec = (_tar, args) => (basename(args[1]).startsWith('cli-')
      ? JSON.stringify({ name: 'graphmind-ai', version: '1.2.3', repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' }, dependencies: { '@graphmind-ai/client': 'workspace:*' } })
      : JSON.stringify({ name: '@graphmind-ai/client', version: '1.2.3', repository: { url: 'git+https://github.com/Hegazy360/GraphMind.git' } }));
    const result = packAll({ root, outDir: join(root, 'out'), repoSlug: 'Hegazy360/GraphMind', spawn, exec });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /workspace:\* — pack with pnpm, not npm/);
  });

  it('packAll: a failing pnpm pack is reported, not swallowed', () => {
    const root = fakeRepo();
    const result = packAll({ root, outDir: join(root, 'out'), spawn: () => ({ status: 1 }), exec: () => '{}' });
    assert.equal(result.tarballs.length, 0);
    assert.match(result.problems.join('\n'), /pnpm pack exited 1/);
  });
});

describe('publish-npm', () => {
  const packages = [
    { name: 'graphmind-ai', version: '0.5.0' },
    { name: '@graphmind-ai/client', version: '0.5.0' },
    { name: '@graphmind-ai/schema', version: '0.5.0' },
  ];

  it('planPublish separates already-published, to-publish and unknown', async () => {
    const plan = await planPublish(packages, lookupFrom({ 'graphmind-ai': ['0.4.4'], '@graphmind-ai/client': ['0.4.4', '0.5.0'], '@graphmind-ai/schema': null }));
    assert.deepEqual(plan, { version: '0.5.0', already: ['@graphmind-ai/client'], toPublish: ['graphmind-ai'], unknown: ['@graphmind-ai/schema'] });
  });

  it('planPublish refuses packages that disagree on their version', async () => {
    await assert.rejects(planPublish([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.1' }], lookupFrom({})), /disagree/);
  });

  it('waitUntilPublished polls until the registry catches up, then stops', async () => {
    let polls = 0;
    const lookup = async (name) => {
      polls += 1;
      return new Set(polls >= 3 || name === 'a' ? ['1.0.0'] : []);
    };
    const waits = [];
    const missing = await waitUntilPublished(['a', 'b'], '1.0.0', lookup, { deadlineMs: 60_000, intervalMs: 10, now: () => 0, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(missing, []);
    assert.ok(waits.length >= 1, 'slept between polls');
  });

  it('waitUntilPublished names what never appeared once the deadline passes', async () => {
    let t = 0;
    const missing = await waitUntilPublished(['a', 'b'], '1.0.0', lookupFrom({ a: ['1.0.0'], b: [] }), { deadlineMs: 100, intervalMs: 50, now: () => t, wait: async (ms) => { t += ms; } });
    assert.deepEqual(missing, ['b']);
  });

  it('a re-run for an already-published version is a no-op success that never invokes pnpm', async () => {
    const root = fakeRepo({ version: '0.5.0' });
    let spawned = false;
    const result = await publishNpm({ root, lookup: lookupFrom({ 'graphmind-ai': ['0.5.0'], '@graphmind-ai/client': ['0.5.0'] }), spawn: () => { spawned = true; return { status: 0 }; }, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.equal(spawned, false);
    assert.deepEqual(result.already.sort(), ['@graphmind-ai/client', 'graphmind-ai']);
  });

  it('dry run passes --dry-run to pnpm and never waits on the registry', async () => {
    const root = fakeRepo({ version: '0.5.0' });
    const calls = [];
    const result = await publishNpm({ root, dryRun: true, lookup: lookupFrom({}), spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; }, wait: async () => { throw new Error('must not poll in a dry run'); }, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(calls, [['pnpm', '-r', 'publish', '--access', 'public', '--provenance', '--no-git-checks', '--dry-run']]);
  });

  it('the real command is pnpm -r publish with provenance and no git checks', async () => {
    const root = fakeRepo({ version: '0.5.0' });
    const calls = [];
    const registry = { 'graphmind-ai': [], '@graphmind-ai/client': [] };
    const result = await publishNpm({
      root,
      lookup: lookupFrom(registry),
      spawn: (cmd, args) => {
        calls.push([cmd, ...args]);
        registry['graphmind-ai'].push('0.5.0'); // "publishing" lands both
        registry['@graphmind-ai/client'].push('0.5.0');
        return { status: 0 };
      },
      wait: async () => {},
      deadlineMs: 1000,
      log: () => {},
    });
    assert.deepEqual(calls, [['pnpm', '-r', 'publish', '--access', 'public', '--provenance', '--no-git-checks']]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.published.sort(), ['@graphmind-ai/client', 'graphmind-ai']);
    assert.deepEqual(result.missing, []);
  });

  it('a partial publish fails and names the missing packages', async () => {
    const root = fakeRepo({ version: '0.5.0' });
    const registry = { 'graphmind-ai': [], '@graphmind-ai/client': [] };
    let t = 0;
    const logs = [];
    const result = await publishNpm({
      root,
      lookup: lookupFrom(registry),
      spawn: () => { registry['@graphmind-ai/client'].push('0.5.0'); return { status: 0 }; }, // only one lands
      wait: async (ms) => { t += ms; },
      deadlineMs: 100,
      intervalMs: 50,
      log: (line) => logs.push(line),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['graphmind-ai']);
    assert.deepEqual(result.published, ['@graphmind-ai/client']);
    assert.match(logs.join('\n'), /PARTIAL PUBLISH: 1 of 2/);
    assert.match(logs.join('\n'), /MISSING {2}graphmind-ai@0\.5\.0/);
  });

  it('pnpm exiting non-zero fails the run even if the registry looks complete', async () => {
    const root = fakeRepo({ version: '0.5.0' });
    const result = await publishNpm({ root, lookup: lookupFrom({ 'graphmind-ai': ['0.5.0'], '@graphmind-ai/client': [] }), spawn: () => ({ status: 1 }), wait: async () => {}, deadlineMs: 0, log: () => {} });
    assert.equal(result.ok, false);
  });

  it('a pre-release version goes out under the `next` dist-tag, never `latest`', async () => {
    // versionFromTag accepts v0.5.0-rc.1, so the workflow WILL publish an RC;
    // npm tags whatever it publishes `latest` unless told otherwise, and
    // `npm install graphmind-ai` would then hand every user the RC.
    const root = fakeRepo({ version: '0.5.0-rc.1' });
    const registry = { 'graphmind-ai': [], '@graphmind-ai/client': [] };
    const calls = [];
    const result = await publishNpm({
      root,
      lookup: lookupFrom(registry),
      spawn: (cmd, args) => {
        calls.push([cmd, ...args]);
        registry['graphmind-ai'].push('0.5.0-rc.1');
        registry['@graphmind-ai/client'].push('0.5.0-rc.1');
        return { status: 0 };
      },
      wait: async () => {},
      deadlineMs: 1000,
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['pnpm', '-r', 'publish', '--access', 'public', '--provenance', '--no-git-checks', '--tag', 'next']]);
    // The dry run rehearses the same command line, so verify sees it too.
    const dry = [];
    await publishNpm({ root, dryRun: true, lookup: lookupFrom({}), spawn: (_cmd, args) => { dry.push(args); return { status: 0 }; }, log: () => {} });
    assert.deepEqual(dry, [['-r', 'publish', '--access', 'public', '--provenance', '--no-git-checks', '--tag', 'next', '--dry-run']]);
    // A plain release keeps `latest` (no --tag at all).
    const rel = [];
    await publishNpm({ root: fakeRepo({ version: '0.5.0' }), dryRun: true, lookup: lookupFrom({}), spawn: (_cmd, args) => { rel.push(args); return { status: 0 }; }, log: () => {} });
    assert.equal(rel[0].includes('--tag'), false);
  });
});

describe('verify-provenance', () => {
  const attested = { versions: { '0.5.0': { dist: { attestations: [{ url: 'https://registry.npmjs.org/-/npm/v1/attestations/graphmind-ai@0.5.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } }] } } } };
  const plain = { versions: { '0.4.4': { dist: { tarball: 'x' } } } };

  it('provenanceOf reads dist.attestations like `npm view --json` does', () => {
    assert.deepEqual(provenanceOf(attested, '0.5.0'), { exists: true, attested: true, url: 'https://registry.npmjs.org/-/npm/v1/attestations/graphmind-ai@0.5.0', predicateType: 'https://slsa.dev/provenance/v1' });
    assert.equal(provenanceOf(plain, '0.4.4').attested, false);
    assert.equal(provenanceOf(plain, '0.5.0').exists, false);
    assert.equal(provenanceOf(undefined, '0.5.0').exists, false);
  });

  it('fails for a required package without attestations, warns for an unrequired one', async () => {
    const fetchImpl = async (url) => ({ status: 200, ok: true, json: async () => (url.includes('graphmind-ai') && !url.includes('%2F') ? attested : plain) });
    const strict = await verifyProvenance({ names: ['graphmind-ai', '@graphmind-ai/client'], version: '0.5.0', fetch: fetchImpl, log: () => {} });
    assert.equal(strict.ok, false);
    assert.deepEqual(strict.failures, ['@graphmind-ai/client@0.5.0 is not on the registry']);
    const narrowed = await verifyProvenance({ names: ['graphmind-ai', '@graphmind-ai/client'], version: '0.5.0', required: ['graphmind-ai'], fetch: fetchImpl, log: () => {} });
    assert.equal(narrowed.ok, true);
    assert.equal(narrowed.warnings.length, 1);
    const unattested = await verifyProvenance({ names: ['graphmind-ai'], version: '0.4.4', fetch: async () => ({ status: 200, ok: true, json: async () => plain }), log: () => {} });
    assert.deepEqual(unattested.failures, ['graphmind-ai@0.4.4 has NO provenance attestation']);
  });
});

describe('release-notes', () => {
  const changelog = '# Changelog\n\nintro\n\n## 0.5.0\n\nNew things.\n\n### Fixed\n\n- a bug\n\n## 0.4.4\n\nOld things.\n';
  it('extracts exactly one section', () => {
    assert.equal(extractChangelogSection(changelog, '0.5.0'), 'New things.\n\n### Fixed\n\n- a bug');
    assert.equal(extractChangelogSection(changelog, '0.4.4'), 'Old things.');
    assert.equal(extractChangelogSection(changelog, '0.4.0'), undefined);
    assert.equal(extractChangelogSection('## 0.5.0\n\n## 0.4.4\nx', '0.5.0'), undefined, 'an empty section is no section');
  });
  it('tolerates common heading styles and does not confuse 0.5.0 with 0.5.0-rc.1 or 10.5.0', () => {
    assert.equal(extractChangelogSection('## [0.5.0] - 2026-09-14\nbody\n', '0.5.0'), 'body');
    assert.equal(extractChangelogSection('## v0.5.0\nbody\n', '0.5.0'), 'body');
    assert.equal(extractChangelogSection('## 0.5.0-rc.1\nrc\n## 0.5.0\nfinal\n', '0.5.0'), 'final');
    assert.equal(extractChangelogSection('## 10.5.0\nten\n', '0.5.0'), undefined);
  });
  it('releaseBody carries the section, the verification commands and the version', () => {
    const body = releaseBody({ version: '0.5.0', section: 'New things.' });
    assert.match(body, /^New things\./);
    assert.match(body, /npm view graphmind-ai@0\.5\.0 dist\.attestations/);
    assert.match(body, /npm audit signatures/);
    assert.match(body, /graphmind-0\.5\.0\.cdx\.json/);
  });
});

describe('sbom', () => {
  const expected = [{ name: 'graphmind-ai', version: '0.5.0' }, { name: '@graphmind-ai/client', version: '0.5.0' }];
  it('accepts a CycloneDX document that lists every package', () => {
    const sbom = { bomFormat: 'CycloneDX', components: [{ purl: 'pkg:npm/graphmind-ai@0.5.0' }, { purl: 'pkg:npm/%40graphmind-ai/client@0.5.0' }, { purl: 'pkg:npm/ws@8.21.3' }] };
    assert.deepEqual(validateSbom(sbom, expected), { ok: true, problems: [], componentCount: 3 });
  });
  it('rejects a missing package, an empty SBOM and the wrong format', () => {
    assert.match(validateSbom({ bomFormat: 'CycloneDX', components: [{ purl: 'pkg:npm/graphmind-ai@0.5.0' }] }, expected).problems[0], /@graphmind-ai\/client@0\.5\.0 is missing/);
    assert.match(validateSbom({ bomFormat: 'CycloneDX', components: [] }, []).problems[0], /no components/);
    assert.match(validateSbom({ bomFormat: 'SPDX' }, []).problems[0], /bomFormat/);
  });
});

describe('audit-signatures', () => {
  it('reads npm\'s --json --include-attestations shape', () => {
    const report = { invalid: [], missing: [{ name: 'local-thing', version: '1.0.0' }], verified: [{ name: 'graphmind-ai', version: '0.5.0', attestations: { url: 'x' } }, { name: '@graphmind-ai/client', version: '0.5.0', attestations: { url: 'y' } }] };
    const s = summarizeAuditJson(report);
    assert.deepEqual([...s.attested].sort(), ['@graphmind-ai/client', 'graphmind-ai']);
    assert.deepEqual(s.missingSignatures, ['local-thing@1.0.0']);
    assert.deepEqual(s.invalid, []);
    assert.deepEqual(summarizeAuditJson(undefined).attested.size, 0);
    assert.deepEqual(summarizeAuditJson({ invalid: [{ name: 'evil', version: '1' }] }).invalid, ['evil@1']);
  });
});

describe('dep-count', () => {
  it('follows node resolution through nested node_modules and skips our own packages', () => {
    const lock = {
      '': {},
      'node_modules/graphmind-ai': { dependencies: { '@graphmind-ai/client': '1', ws: '8' } },
      'node_modules/@graphmind-ai/client': { dependencies: { '@graphmind-ai/schema': '1' } },
      'node_modules/@graphmind-ai/schema': { dependencies: { zod: '4' } },
      'node_modules/zod': {},
      'node_modules/ws': { dependencies: { debug: '4' } },
      'node_modules/debug': { dependencies: { ms: '2' } },
      'node_modules/ms': {},
      'node_modules/ws/node_modules/debug': { dependencies: { ms: '3' } }, // nested override wins for ws
    };
    const counts = countDependencies(lock, ['graphmind-ai', '@graphmind-ai/schema', 'missing']);
    assert.deepEqual(counts['graphmind-ai'].direct, ['ws']);
    // ws -> ws/node_modules/debug -> ms (top-level), plus zod via schema: ws, debug, ms, zod
    assert.equal(counts['graphmind-ai'].transitiveCount, 4);
    assert.deepEqual(counts['@graphmind-ai/schema'], { direct: ['zod'], directCount: 1, transitiveCount: 1 });
    assert.equal(counts.missing, undefined);
  });
});
