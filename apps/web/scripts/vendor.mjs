// Copy the homepage's third-party files out of node_modules into vendor/,
// which is committed: the site is static (no build on deploy) and loads
// nothing from a CDN. Re-run after bumping a version: `pnpm --filter web vendor`.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'vendor');
mkdirSync(out, { recursive: true });

const FILES = [
  // GSAP 3 + ScrollTrigger — "no charge" standard licence (gsap.com/standard-license)
  ['gsap/dist/gsap.min.js', 'gsap.min.js'],
  ['gsap/dist/ScrollTrigger.min.js', 'ScrollTrigger.min.js'],
  // Fonts, latin subsets, variable weight — SIL OFL 1.1 (@fontsource-variable)
  ['@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2', 'bricolage-grotesque-latin-wght.woff2'],
  ['@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2', 'instrument-sans-latin-wght.woff2'],
  ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2', 'geist-mono-latin-wght.woff2'],
];
const notices = [];
for (const [from, to] of FILES) {
  copyFileSync(join(root, 'node_modules', from), join(out, to));
  const pkgDir = join(root, 'node_modules', from.split('/').slice(0, from.startsWith('@') ? 2 : 1).join('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  notices.push(`${to}  ←  ${pkg.name}@${pkg.version}  (${pkg.license ?? 'see package'})`);
}
writeFileSync(join(out, 'NOTICES.txt'), `Third-party files served by graphmind.ai, copied by scripts/vendor.mjs:\n\n${notices.join('\n')}\n`);
console.log(notices.join('\n'));
