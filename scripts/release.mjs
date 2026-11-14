#!/usr/bin/env node
/**
 * `pnpm release` — get every artifact (npm, PyPI, RubyGems) published at one
 * version, from your own terminal, confirming each step before it runs.
 *
 *   pnpm release              # interactive: check, fix, verify, publish, confirm
 *   pnpm release --dry-run    # walk the whole flow; print commands, run none
 *   pnpm release:status       # read-only report (scripts/release/status.mjs)
 *
 * STATE-BASED, SO ALWAYS SAFE TO RE-RUN. Nothing is remembered between runs:
 * every run asks git and the three registries where things stand and picks up
 * from there. Quit at any prompt (q or Ctrl+C) and run it again later.
 *
 * TWO WAYS TO PUBLISH, chosen per run:
 *   GitHub Actions (default)  tag + push; publish-{npm,python,ruby}.yml do the
 *                             upload with Trusted Publishing and npm provenance.
 *                             This script watches the registries until all
 *                             artifacts land, and offers the local path for
 *                             anything that does not.
 *   This machine              pnpm/uv/gem with your own logins. No npm
 *                             provenance (that needs CI's OIDC identity).
 *
 * The two things CI cannot do on its own are handled up front: a brand-new
 * npm package (Trusted Publishing can only publish to a package that already
 * exists) and a never-published gem (needs a *pending* trusted publisher).
 *
 * Dependency-free like every script here; all registry/repo logic lives in
 * scripts/release/status.mjs and is unit-tested.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { REPO_ROOT, SEMVER_RE, compareSemver, listPublishablePackages, parseArgs } from './release/lib.mjs';
import { checkVersions } from './release/check-versions.mjs';
import {
  REPO_SLUG,
  collectStatus,
  findBlockers,
  formatStatus,
  nextVersions,
  promoteUnreleased,
  registryUrl,
} from './release/status.mjs';
import { extractChangelogSection } from './release/release-notes.mjs';

const args = parseArgs(process.argv.slice(2));
const DRY_RUN = args['dry-run'] === true;
const WATCH_MINUTES = Number(args['watch-minutes'] ?? 45);
const ACTIONS_URL = `https://github.com/${REPO_SLUG}/actions`;

// ---------------------------------------------------------------- output --

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => paint(1, t);
const dim = (t) => paint(2, t);
const warn = (t) => console.log(paint(33, `! ${t}`));
const good = (t) => console.log(paint(32, `✓ ${t}`));
const bad = (t) => console.log(paint(31, `✗ ${t}`));
const section = (n, title) => console.log(`\n${bold(`━━ ${n}  ${title}`)}`);
const indent = (text, by = '    ') => text.split('\n').map((l) => by + l).join('\n');
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const show = (cmd) => cmd.map(quote).join(' ');

const RESUME = 'Stopped. Nothing is half-done that a re-run cannot see: run `pnpm release` again to pick up from here.';

function quit(code = 0) {
  console.log(`\n${dim(RESUME)}`);
  process.exit(code);
}

// --------------------------------------------------------------- prompts --

/**
 * One question, one short-lived readline: a long-lived one would keep the
 * terminal in raw mode and garble the prompts of `npm login` / `gem push`
 * running in between.
 */
async function ask(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    quit(130);
  });
  try {
    const answer = (await rl.question(`${paint(36, '?')} ${question} `)).trim();
    return answer === '' ? fallback : answer;
  } finally {
    rl.close();
  }
}

async function yes(question, defaultYes = true) {
  const answer = (await ask(`${question} ${dim(defaultYes ? '[Y/n/q]' : '[y/N/q]')}`, defaultYes ? 'y' : 'n')).toLowerCase();
  if (answer === 'q') quit();
  return answer === 'y' || answer === 'yes';
}

/** `choices`: [{ key, label }]. Returns the chosen key; `q` always quits. */
async function choose(question, choices, fallback) {
  for (const c of choices) console.log(`    ${bold(c.key)}  ${c.label}${c.key === fallback ? dim('  (default)') : ''}`);
  for (;;) {
    const answer = (await ask(`${question} ${dim(`[${choices.map((c) => c.key).join('/')}/q]`)}`, fallback ?? '')).toLowerCase();
    if (answer === 'q') quit();
    if (choices.some((c) => c.key === answer)) return answer;
  }
}

// -------------------------------------------------------------- commands --

/** Run quietly and return trimmed stdout ('' on failure) — for read-only git queries. */
function capture(cmd, cmdArgs, { cwd = REPO_ROOT } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const has = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * The one way this script changes anything: say what and why, show the exact
 * commands, ask, run them in order. A failure offers retry / skip / quit.
 * Returns true when every command ran and succeeded.
 */
async function step(why, commands, { cwd = REPO_ROOT, defaultYes = true, env } = {}) {
  console.log(`\n${why}`);
  for (const c of commands) console.log(dim(`    $ ${cwd === REPO_ROOT ? '' : `(cd ${cwd.replace(`${REPO_ROOT}/`, '')}) `}${show(c)}`));
  if (DRY_RUN) {
    console.log(dim('    (dry run — not running)'));
    return true;
  }
  if (!(await yes('Run this?', defaultYes))) {
    console.log(dim('    skipped'));
    return false;
  }
  for (let i = 0; i < commands.length; ) {
    const [cmd, ...rest] = commands[i];
    console.log(dim(`\n$ ${show(commands[i])}`));
    const r = spawnSync(cmd, rest, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
    if (r.status === 0) {
      i += 1;
      continue;
    }
    bad(`${show(commands[i])} ${r.error ? `could not start (${r.error.code})` : `exited ${r.status}`}`);
    const next = await choose('What now?', [
      { key: 'r', label: 'retry this command' },
      { key: 's', label: 'skip the rest of this step and carry on' },
    ], 'r');
    if (next === 's') return false;
  }
  return true;
}

/** A change this script makes by editing a file itself (shown as a diff-ish preview). */
async function edit(why, file, preview, apply) {
  console.log(`\n${why}`);
  console.log(dim(indent(preview)));
  if (DRY_RUN) {
    console.log(dim('    (dry run — not writing)'));
    return false;
  }
  if (!(await yes(`Write ${file.replace(`${REPO_ROOT}/`, '')}?`))) return false;
  apply();
  touched.add(file);
  return true;
}

/** Files this run changed — and the only files its release commit includes. */
const touched = new Set();
let built = false;

// --------------------------------------------------------------- the flow --

async function gitPreflight() {
  section('1/6', 'Git');
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  console.log(`  branch ${bold(branch)}`);

  const dirty = capture('git', ['status', '--porcelain']).out;
  if (dirty) {
    warn('Uncommitted changes (they stay out of the release commit, but tests below run against them):');
    console.log(dim(indent(dirty)));
    if (!(await yes('Continue anyway?', false))) quit();
  }

  const fetched = capture('git', ['fetch', '--quiet', '--tags', 'origin']);
  if (!fetched.ok) warn(`git fetch origin failed (${fetched.err.split('\n')[0]}). Working from what this checkout knows.`);

  if (branch !== 'master') {
    warn(`Releases are normally tagged on master; you are on ${branch}.`);
    if (!(await yes(`Release from ${branch} anyway?`, false))) quit();
  }
  const upstream = capture('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}`]).ok ? `origin/${branch}` : undefined;
  if (upstream) {
    const behind = Number(capture('git', ['rev-list', '--count', `HEAD..${upstream}`]).out || 0);
    if (behind > 0) {
      warn(`${branch} is ${behind} commit(s) behind ${upstream}.`);
      await step('Bring it up to date first (fast-forward only — never merges or rewrites):', [['git', 'pull', '--ff-only']]);
    }
  }
  return { branch };
}

async function chooseVersion(status) {
  section('3/6', 'Version');
  const repo = checkVersions();
  const current = repo.version; // graphmind-ai's version
  const everywhere = status.every((a) => a.state === 'current');

  if (everywhere && repo.ok) {
    good(`Everything is published at ${current}. Nothing is behind.`);
    if (!(await yes('Start a new release?', false))) {
      console.log('Nothing to do.');
      process.exit(0);
    }
  } else {
    const unpublished = status.filter((a) => a.state !== 'current').length;
    console.log(`  The repo says ${bold(current)}; ${unpublished} of ${status.length} artifact(s) are not published at their repo version.`);
  }

  const n = nextVersions(current);
  const choices = [];
  if (!everywhere) choices.push({ key: '1', label: `${current} — finish publishing the repo's version`, v: current });
  choices.push(
    { key: '2', label: `${n.patch} — patch`, v: n.patch },
    { key: '3', label: `${n.minor} — minor`, v: n.minor },
    { key: '4', label: `${n.major} — major`, v: n.major },
    { key: '5', label: 'something else (e.g. a 0.7.0-rc.1 pre-release)' },
  );
  const key = await choose('Release which version?', choices, choices[0].key);
  let version = choices.find((c) => c.key === key).v;
  while (version === undefined || !SEMVER_RE.test(version)) {
    version = await ask('Version (x.y.z or x.y.z-pre):');
    if (version === 'q') quit();
  }

  const npmLatest = status.find((a) => a.name === 'graphmind-ai')?.latest;
  if (npmLatest && compareSemver(version, npmLatest) < 0) {
    warn(`${version} is lower than graphmind-ai@${npmLatest}, already on npm.`);
    if (!(await yes('Use it anyway?', false))) return chooseVersion(status);
  }

  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  if (extractChangelogSection(changelog, version) !== undefined && extractChangelogSection(changelog, 'Unreleased') !== undefined) {
    warn(`CHANGELOG.md has both "## ${version}" and a non-empty "## Unreleased". Only the ${version} section becomes the release notes; Unreleased waits for the next release.`);
  }
  return version;
}

async function fixBlockers(version) {
  section('4/6', `What would stop ${version} from shipping`);
  const skipped = new Set();
  for (;;) {
    const blockers = findBlockers({ version }).filter((b) => !skipped.has(b.id));
    if (blockers.length === 0) {
      if (skipped.size === 0) good('Nothing. The repo is releasable.');
      else if (DRY_RUN) console.log(dim('  (dry run: the fixes above were shown, not applied)'));
      else warn('Some blockers were skipped — CI will go red on those.');
      return;
    }
    const b = blockers[0];
    console.log(`\n${paint(33, '■')} ${bold(b.title)}`);
    console.log(indent(b.detail));
    const applied = await applyFix(b, version);
    if (!applied && !DRY_RUN) {
      const next = await choose('Not fixed. Now what?', [
        { key: 'c', label: 'I fixed it myself — check again' },
        { key: 's', label: 'skip it (the release will likely fail on it)' },
      ], 'c');
      if (next === 's') skipped.add(b.id);
    } else if (DRY_RUN) {
      skipped.add(b.id); // nothing was written, so it would come back forever
    }
  }
}

async function applyFix(blocker, version) {
  const fix = blocker.fix;
  if (fix === undefined) return false;

  if (fix.kind === 'set-version') {
    const npmOutliers = fix.outliers.filter((what) => !what.includes('('));
    const total = checkVersions().entries.length;
    const choices = [{ key: 'a', label: `set every package to ${version} (node scripts/set-version.mjs ${version})` }];
    if (npmOutliers.length > 0 && npmOutliers.length === fix.outliers.length && npmOutliers.length < total / 2) {
      choices.push({ key: 'p', label: `mark ${npmOutliers.join(', ')} "private": true — keep it out of releases for now` });
    }
    const how = choices.length === 1 ? 'a' : await choose('How should it be fixed?', choices, 'a');
    if (how === 'a') {
      const before = new Set(changedFiles());
      const ok = await step(`Bump everything to ${version} in lockstep:`, [[process.execPath, 'scripts/set-version.mjs', version]]);
      // Attribute exactly what set-version wrote, never your unrelated edits.
      if (ok && !DRY_RUN) for (const f of changedFiles()) if (!before.has(f)) touched.add(f);
      return ok;
    }
    let all = true;
    for (const name of npmOutliers) {
      const file = join(listPublishablePackages().find((p) => p.name === name).dir, 'package.json');
      all = (await edit(`Mark ${name} private:`, file, `"private": true   (in ${file.replace(`${REPO_ROOT}/`, '')})`, () => {
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        pkg.private = true;
        writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
      })) && all;
    }
    return all;
  }

  if (fix.kind === 'add-repository') {
    return edit('Add the repository field the other packages have:', fix.file, `"repository": ${JSON.stringify(fix.repository)}`, () => {
      const pkg = JSON.parse(readFileSync(fix.file, 'utf8'));
      // Keep key order readable: put it right after "license" when there is one.
      const out = {};
      for (const [k, v] of Object.entries(pkg)) {
        out[k] = v;
        if (k === 'license') out.repository = fix.repository;
      }
      if (out.repository === undefined) out.repository = fix.repository;
      writeFileSync(fix.file, `${JSON.stringify(out, null, 2)}\n`);
    });
  }

  if (fix.kind === 'promote-unreleased') {
    return edit(`Turn "## Unreleased" into "## ${version}" (and open a fresh, empty Unreleased above it):`, fix.file, `## Unreleased\n\n## ${version}\n<the current Unreleased notes>`, () => {
      writeFileSync(fix.file, promoteUnreleased(readFileSync(fix.file, 'utf8'), version));
    });
  }
  return false;
}

/** Tracked files git sees as modified right now (to attribute set-version's writes). */
function changedFiles() {
  return capture('git', ['diff', '--name-only']).out.split('\n').filter(Boolean).map((f) => join(REPO_ROOT, f));
}

async function verifyLocally() {
  section('5/6', 'Verify locally (the same gates the publish workflows run)');
  console.log(dim('  Catching a red test here costs minutes; catching it in CI after the tag is pushed costs a re-tag.'));
  const pack = mkdtempSync(join(tmpdir(), 'graphmind-pack-'));
  built = await step('JavaScript: install, build, typecheck, test, security suite, pack proof', [
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'build:packages'],
    ['pnpm', 'build:viewer'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'test:all'],
    ['pnpm', 'test:security'],
    [process.execPath, '--test', 'scripts/release/test/*.test.mjs'],
    [process.execPath, 'scripts/release/pack.mjs', '--out', pack],
  ]);
  if (has('make')) await step('Python: tests (python/.venv; the host interpreter is untouched)', [['make', '-C', 'python', 'test']]);
  if (has('bundle')) await step('Ruby: build the gem and run its tests', [['gem', 'build', 'graphmind.gemspec', '--output', join(mkdtempSync(join(tmpdir(), 'graphmind-gem-')), 'check.gem')], ['bundle', 'install'], ['bundle', 'exec', 'rake', 'test']], { cwd: join(REPO_ROOT, 'ruby') });
}

async function commitRelease(version) {
  if (touched.size === 0) return;
  const files = [...touched].map((f) => f.replace(`${REPO_ROOT}/`, ''));
  if (await step(`Commit the release changes (only the ${files.length} file(s) this run changed):`, [['git', 'commit', '-m', `Release ${version}`, '--', ...files]])) {
    touched.clear();
  }
}

/** Tag HEAD (unless the tag exists) and push branch + tag. True when pushed. */
async function tagAndPush(version, branch, why) {
  const tag = `v${version}`;
  const local = capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok;
  if (!local) {
    await step(`Create the tag ${tag} on this commit:`, [['git', 'tag', '-a', tag, '-m', tag]]);
  } else {
    const at = capture('git', ['rev-list', '-n', '1', tag]).out;
    const head = capture('git', ['rev-parse', 'HEAD']).out;
    if (at !== head) warn(`${tag} already exists locally and points at ${at.slice(0, 7)}, not HEAD (${head.slice(0, 7)}). Publishing what the tag points at.`);
  }
  return step(`Push ${branch} and ${tag} — ${why}:`, [
    ['git', 'push', 'origin', branch],
    ['git', 'push', 'origin', tag],
  ]);
}

/** Poll the registries until `version` is everywhere, the deadline passes, or Ctrl+C. */
async function watch(version) {
  console.log(`\nWatching the registries for ${version} (every 30s, up to ${WATCH_MINUTES} min). ${dim('Ctrl+C stops watching, not the release.')}`);
  console.log(dim(`  Workflow runs: ${ACTIONS_URL}`));
  let stop = false;
  const onInt = () => {
    stop = true;
  };
  process.on('SIGINT', onInt);
  const started = Date.now();
  const seen = new Set();
  let status;
  try {
    for (;;) {
      status = await collectStatus({ version });
      for (const a of status) {
        if (a.state === 'current' && !seen.has(a.name + a.registry)) {
          seen.add(a.name + a.registry);
          good(`${a.name} (${a.registry}) ${version}`);
        }
      }
      const left = status.filter((a) => a.state !== 'current');
      if (left.length === 0 || stop || Date.now() - started > WATCH_MINUTES * 60_000) break;
      process.stdout.write(dim(`  … ${Math.round((Date.now() - started) / 60_000)} min, waiting on ${left.length}\r`));
      for (let i = 0; i < 60 && !stop; i += 1) await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    process.off('SIGINT', onInt);
  }
  return status;
}

// ------------------------------------------------------ local publishing --

async function publishNpmLocally(version, names, { all }) {
  if (!has('npm')) return bad('npm is not on PATH.');
  if (!capture('npm', ['whoami']).ok) {
    await step('You are not logged in to npm on this machine:', [['npm', 'login']]);
  }
  if (!built) built = await step('Build the packages and the viewer the CLI ships:', [['pnpm', 'build:packages'], ['pnpm', 'build:viewer']]);
  const only = all ? [] : ['--only', names.join(',')];
  const ok = await step(
    `Publish ${all ? 'every npm package' : names.join(', ')} at ${version} from this machine (no provenance; already-published ones are skipped):`,
    [[process.execPath, 'scripts/release/publish-npm.mjs', '--no-provenance', ...only]],
  );
  if (ok) {
    console.log('\nSo CI can publish the next version itself, give each package a Trusted Publisher');
    console.log(dim('(repo Hegazy360/GraphMind · workflow publish-npm.yml · environment npm):'));
    for (const name of names) console.log(dim(`    https://www.npmjs.com/package/${name}/access`));
  }
}

async function publishPypiLocally(version) {
  if (!has('uv')) return bad('uv is not on PATH (https://docs.astral.sh/uv/) — it builds and uploads the Python package.');
  const out = mkdtempSync(join(tmpdir(), 'graphmind-pypi-'));
  if (!(await step(`Build graphmind-ai ${version} (wheel + sdist) into a fresh directory:`, [['uv', 'build', '--out-dir', out]], { cwd: join(REPO_ROOT, 'python') }))) return;
  const files = DRY_RUN ? [`${out}/*`] : readdirSync(out).filter((f) => f.includes(version)).map((f) => join(out, f));
  if (!DRY_RUN && files.length === 0) return bad(`uv build produced nothing named ${version} in ${out}.`);
  if (!process.env.UV_PUBLISH_TOKEN) console.log(dim('\n  No UV_PUBLISH_TOKEN set: when asked, enter __token__ as the username and a PyPI API token as the password.'));
  await step('Upload to PyPI:', [['uv', 'publish', ...files]]);
}

async function publishGemLocally(version, isNew) {
  if (!has('gem')) return bad('gem is not on PATH.');
  const file = join(mkdtempSync(join(tmpdir(), 'graphmind-gem-')), `graphmind-${version}.gem`);
  if (!(await step(`Build graphmind ${version}.gem:`, [['gem', 'build', 'graphmind.gemspec', '--output', file]], { cwd: join(REPO_ROOT, 'ruby') }))) return;
  const ok = await step('Push it to RubyGems (gem asks for your login / OTP if it needs to):', [['gem', 'push', file]]);
  if (ok && isNew) {
    console.log('\nThe gem exists now, so CI can push the next one: add a Trusted Publisher at rubygems.org → graphmind → Trusted publishers');
    console.log(dim('    (owner Hegazy360 · repo GraphMind · workflow publish-ruby.yml · environment rubygems)'));
  }
}

async function publishLocally(version, status) {
  const left = status.filter((a) => a.state !== 'current');
  const npmLeft = left.filter((a) => a.registry === 'npm');
  if (npmLeft.length > 0) {
    const allNpm = npmLeft.length === status.filter((a) => a.registry === 'npm').length;
    await publishNpmLocally(version, npmLeft.map((a) => a.name), { all: allNpm });
  }
  if (left.some((a) => a.registry === 'pypi')) await publishPypiLocally(version);
  const gem = left.find((a) => a.registry === 'rubygems');
  if (gem) await publishGemLocally(version, gem.state === 'new');
}

async function publish(version, branch) {
  section('6/6', `Publish ${version}`);
  let status = await collectStatus({ version });
  if (status.every((a) => a.state === 'current')) {
    good(`All ${status.length} artifacts are already at ${version}.`);
    return status;
  }
  const tag = `v${version}`;
  const tagOnGithub = capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out !== '';

  if (tagOnGithub) {
    warn(`${tag} is already on GitHub, so the publish workflows already ran (or are running) for it — and these are not at ${version}:`);
    for (const a of status.filter((x) => x.state !== 'current')) console.log(`    ${a.name} (${a.registry})`);
    console.log(dim(`  See why: ${ACTIONS_URL}`));
    const how = await choose('Now what?', [
      { key: 'w', label: 'they may still be running — watch the registries' },
      { key: 'l', label: 'publish the missing ones from this machine' },
    ], 'w');
    if (how === 'w' && !DRY_RUN) status = await watch(version);
    if (status.some((a) => a.state !== 'current') && (how === 'l' || (await yes('Publish what is still missing from this machine?')))) {
      await publishLocally(version, status);
    }
    return collectStatus({ version });
  }

  const route = await choose('How should it be published?', [
    { key: 'c', label: 'GitHub Actions: push the tag, CI publishes with provenance + Trusted Publishing, this script watches' },
    { key: 'l', label: 'This machine: publish with your own npm / PyPI / RubyGems logins (no npm provenance)' },
  ], 'c');

  await commitRelease(version);

  if (route === 'l') {
    await publishLocally(version, status);
    // Pushed after the uploads, so the workflows find everything already
    // published (a no-op each) and publish-npm.yml just cuts the GitHub Release.
    await tagAndPush(version, branch, 'CI then finds everything published and only creates the GitHub Release');
    return collectStatus({ version });
  }

  // What CI cannot do on its own — settle it before the tag goes out.
  const newNpm = status.filter((a) => a.registry === 'npm' && a.state === 'new').map((a) => a.name);
  if (newNpm.length > 0) {
    console.log(`\n${paint(33, '■')} ${bold(`Never published on npm: ${newNpm.join(', ')}`)}`);
    console.log(indent('Trusted Publishing can only publish to a package that already exists, so CI needs an\nNPM_TOKEN repository secret to create these — without one, the npm job fails part-way.'));
    if (!(await yes('Does the repo have an NPM_TOKEN secret?', false))) {
      console.log('Publishing just these from here first is the clean fix: CI then skips them and publishes the rest with provenance.');
      await publishNpmLocally(version, newNpm, { all: false });
    }
  }
  let gemLocally = false;
  const gem = status.find((a) => a.registry === 'rubygems');
  if (gem?.state === 'new') {
    console.log(`\n${paint(33, '■')} ${bold('The graphmind gem has never been published')}`);
    console.log(indent('CI can push it only through a *pending* trusted publisher, which expires ~12 hours after you create it:\nrubygems.org → Settings → Trusted publishers → "Create a pending trusted publisher"\n  gem graphmind · owner Hegazy360 · repo GraphMind · workflow publish-ruby.yml · environment rubygems'));
    gemLocally = !(await yes('Have you created it (in the last ~12 hours)?', false));
    if (gemLocally) console.log('Then the gem gets pushed from this machine right after the tag.');
  }

  if (!(await tagAndPush(version, branch, 'this is what starts publish-npm, publish-python and publish-ruby'))) {
    warn('The tag was not pushed, so CI is not publishing anything.');
    if (await yes('Publish from this machine instead?', false)) await publishLocally(version, await collectStatus({ version }));
    return collectStatus({ version });
  }
  if (gemLocally) await publishGemLocally(version, true);
  if (DRY_RUN) return status;

  status = await watch(version);
  const left = status.filter((a) => a.state !== 'current');
  if (left.length > 0) {
    warn(`Still not at ${version}: ${left.map((a) => `${a.name} (${a.registry})`).join(', ')}.`);
    console.log(dim(`  A red run at ${ACTIONS_URL} says why; a run still going means just wait (re-run pnpm release later).`));
    if (await yes('Publish those from this machine now?', false)) await publishLocally(version, status);
    status = await collectStatus({ version });
  }
  return status;
}

// ------------------------------------------------------------------ main --

async function main() {
  if (!process.stdin.isTTY) {
    console.error('pnpm release is interactive. For a report a script can read, run: pnpm release:status');
    process.exit(1);
  }
  console.log(bold(`GraphMind release${DRY_RUN ? '  (dry run — nothing will be run or written)' : ''}`));
  console.log(dim('Every change is shown and confirmed before it runs. q or Ctrl+C at any prompt stops; re-running resumes.'));

  const { branch } = await gitPreflight();

  section('2/6', 'What the registries serve vs. what the repo says');
  const status = await collectStatus();
  console.log(formatStatus(status, { color: paint }));

  const version = await chooseVersion(status);
  await fixBlockers(version);
  await verifyLocally();
  const final = await publish(version, branch);

  console.log(`\n${bold(`Result for ${version}`)}`);
  console.log(formatStatus(final, { color: paint }));
  const left = final.filter((a) => a.state !== 'current');
  if (left.length === 0) {
    good(`Every artifact is published at ${version}.`);
    for (const a of final) console.log(dim(`    ${registryUrl(a)}`));
  } else {
    bad(`${left.length} artifact(s) are not at ${version} yet.`);
    quit(1);
  }
}

await main();
