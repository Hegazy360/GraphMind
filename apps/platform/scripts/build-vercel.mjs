#!/usr/bin/env node
/**
 * Assemble graphmind.ai as ONE Vercel deployment, in the Build Output API v3
 * layout (https://vercel.com/docs/build-output-api/v3), at <repo>/.vercel/output:
 *
 *   static/              the homepage (apps/web), /docs (Astro), /try (the viewer)
 *   functions/
 *     _platform.func/    the platform: hub, sign-in, Circuit, Jack, hosted MCP, engine tick
 *     api/waitlist.func  the homepage's three Blob functions, unchanged
 *     api/events.func
 *     api/telemetry.func
 *   config.json          routes: redirects, then static files, then the platform
 *
 * Writing the output ourselves (instead of letting Vercel guess from a
 * framework preset) makes the deployment exactly what this script says: the
 * same routes locally and on Vercel, and functions bundled to single files
 * so pnpm's symlinked workspace never meets Vercel's file tracer.
 *
 * Prerequisite: the workspace builds, which `pnpm build:site` runs first.
 * When POSTGRES_URL_NON_POOLING is set (production builds on Vercel), the
 * database migrations are applied before anything is written, so a
 * deployment never goes live against a schema it does not understand.
 *
 * Usage: node apps/platform/scripts/build-vercel.mjs [--skip-migrate]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const out = join(root, '.vercel', 'output');
const fail = (msg) => {
  console.error(`build-vercel: ${msg}`);
  process.exit(1);
};
const need = (path, hint) => {
  if (!existsSync(path)) fail(`missing ${relative(root, path)} — ${hint}`);
  return path;
};

const platformDist = need(join(root, 'apps/platform/dist/vercel.js'), 'run `pnpm build:site` (it builds the workspace first)');
const docsDist = need(join(root, 'apps/docs/dist/docs'), 'run `pnpm --filter docs build`');
const tryDist = need(join(root, 'apps/viewer/dist-try/try'), 'run `pnpm --filter viewer build:try`');

// ------------------------------------------------------------ migrations --
if (process.env.POSTGRES_URL_NON_POOLING && !process.argv.includes('--skip-migrate')) {
  const { migrateAll } = await import(join(root, 'apps/platform/dist/hosted.js'));
  const applied = await migrateAll(process.env.POSTGRES_URL_NON_POOLING);
  console.log(`build-vercel: migrations ${applied.length ? `applied: ${applied.join(', ')}` : 'up to date'}`);
} else {
  console.log('build-vercel: no POSTGRES_URL_NON_POOLING (preview or local build): migrations skipped');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'static'), { recursive: true });

// ---------------------------------------------------------------- static --
const web = join(root, 'apps/web');
const WEB_SKIP = new Set(['api', 'test', 'scripts', 'node_modules', 'package.json', 'tsconfig.json', 'vercel.json', '.gitignore', '.vercel', 'og-source.html']);
cpSync(web, join(out, 'static'), {
  recursive: true,
  filter: (src) => {
    const rel = relative(web, src);
    return rel === '' || !WEB_SKIP.has(rel.split('/')[0]);
  },
});
cpSync(docsDist, join(out, 'static', 'docs'), { recursive: true });
cpSync(tryDist, join(out, 'static', 'try'), { recursive: true });

// ------------------------------------------------------------- functions --
// ESM bundles of CommonJS dependencies need a real `require` for their node: imports.
const banner = { js: "import { createRequire as __gmCreateRequire } from 'node:module'; const require = __gmCreateRequire(import.meta.url);" };

/**
 * Each dashboard serves its files from `new URL('../<dir>/', import.meta.url)`
 * next to its own dist/. In one bundle they would all point at the same
 * place, so each lookup is rewritten to its own folder beside the bundle,
 * and the build fails if a rewrite does not match (a moved file, a renamed dir).
 */
const UI = [
  { file: 'apps/platform/dist/index.js', from: "new URL('../ui/', import.meta.url)", dir: 'ui-platform', src: 'apps/platform/ui' },
  { file: 'apps/circuit-api/dist/index.js', from: "new URL('../ui/', import.meta.url)", dir: 'ui-circuit', src: 'apps/circuit-api/ui' },
  { file: 'apps/jack-api/dist/index.js', from: "new URL('../ui/', import.meta.url)", dir: 'ui-jack', src: 'apps/jack-api/ui' },
  { file: 'packages/ui/dist/index.js', from: "new URL('../assets/', import.meta.url)", dir: 'ui-assets', src: 'packages/ui/assets' },
];
const seen = new Set();
const uiByPath = new Map(UI.map((u) => [join(root, u.file), u]));
const uiDirs = {
  name: 'graphmind-ui-dirs',
  setup(b) {
    // esbuild resolves pnpm's symlinks, so workspace files arrive under their real paths.
    b.onLoad({ filter: /[\\/]dist[\\/]index\.js$/ }, (args) => {
      const entry = uiByPath.get(args.path);
      if (!entry) return undefined;
      const code = readFileSync(args.path, 'utf8');
      if (!code.includes(entry.from)) fail(`${entry.file} no longer contains ${entry.from}; update UI in build-vercel.mjs`);
      seen.add(entry.file);
      return { contents: code.replaceAll(entry.from, `new URL('./${entry.dir}/', import.meta.url)`), loader: 'js' };
    });
  },
};

async function bundle(entry, funcDir, { plugins = [] } = {}) {
  mkdirSync(funcDir, { recursive: true });
  const result = await build({
    entryPoints: [entry],
    outfile: join(funcDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner,
    // pg's optional native binding; never installed, never wanted.
    external: ['pg-native'],
    plugins,
    logLevel: 'warning',
    metafile: true,
    legalComments: 'none',
  });
  return result.metafile;
}

// dub1 (Dublin) sits next to the Supabase project (eu-west-1): every query is a short hop.
const vc = (extra) => JSON.stringify({ runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', supportsResponseStreaming: true, regions: ['dub1'], ...extra }, null, 2);

// The platform.
const platformFunc = join(out, 'functions', '_platform.func');
await bundle(platformDist, platformFunc, { plugins: [uiDirs] });
for (const u of UI) {
  if (!seen.has(u.file)) fail(`${u.file} was not bundled; the UI rewrite list is stale`);
  cpSync(join(root, u.src), join(platformFunc, u.dir), { recursive: true });
}
// 60s is the Hobby plan's ceiling for prebuilt functions; hosted.ts sizes its drain budgets below it.
// On Pro this can rise (up to 800s) together with TICK_BUDGET_MS in hosted.ts.
writeFileSync(join(platformFunc, '.vc-config.json'), vc({ shouldAddHelpers: false, maxDuration: 60 }));
writeFileSync(join(platformFunc, 'package.json'), '{ "type": "module" }\n');

// The homepage's Blob functions keep Vercel's Node helpers (res.status().json(), parsed req.body).
for (const name of ['waitlist', 'events', 'telemetry']) {
  const dir = join(out, 'functions', 'api', `${name}.func`);
  await bundle(join(web, 'api', `${name}.ts`), dir);
  writeFileSync(join(dir, '.vc-config.json'), vc({ shouldAddHelpers: true, maxDuration: 15 }));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
}

// ---------------------------------------------------------------- routes --
const PLATFORM_PATHS = '^/(?:app(?:/.*)?|p/.*|\\.well-known/.*|dashboard/callback|api/internal/.*)$';
const config = {
  version: 3,
  routes: [
    // Sign-in lives in the hub, on this origin.
    { src: '^/login/?$', status: 307, headers: { Location: '/app/#/signin' } },
    { src: '^/signup/?$', status: 307, headers: { Location: '/app/#/signup' } },
    { src: '^/subscriptions/?$', status: 307, headers: { Location: '/#account' } },
    { src: '^/graphs(?:/.*)?$', status: 308, headers: { Location: '/' } },
    // Directory-style URLs, as the docs and /try deployments served them.
    { src: '^/(docs|try)$', status: 308, headers: { Location: '/$1/' } },
    { src: '^/docs/((?:[^/]+/)*[^/.]+)$', status: 308, headers: { Location: '/docs/$1/' } },
    // The hub page and the dashboards must never be cached by the CDN; sign-in state is per user.
    { src: PLATFORM_PATHS, headers: { 'cache-control': 'no-store' }, continue: true },
    { handle: 'filesystem' },
    { src: PLATFORM_PATHS, dest: '/_platform' },
    { src: '^/docs/.*$', status: 404, dest: '/docs/404.html' },
  ],
};
writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2));

console.log(`build-vercel: wrote ${relative(root, out)} (static + _platform + 3 Blob functions)`);
