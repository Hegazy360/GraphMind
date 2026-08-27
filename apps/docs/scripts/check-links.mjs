/**
 * Post-build link check for the docs site. No dependencies.
 *
 *   node scripts/check-links.mjs [dist] [base]
 *
 * Fails the process when a page links to something that is not in `dist`, to
 * an anchor that no element on the target page has, or to a root-absolute path
 * that never got Astro's `base` prefix (the failure mode the rehype plugin and
 * `withBase()` exist to prevent — see README "Base path"). Also reports pages
 * nothing links to, which is usually a page missing from the sidebar.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'dist');
const BASE = (process.argv[3] ?? '/docs').replace(/\/+$/, '');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const distFiles = new Set(files.map((f) => f.slice(DIST.length)));
const idsByFile = new Map();
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  idsByFile.set(
    f.slice(DIST.length),
    new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])),
  );
}

// map a public URL path (with base) to a dist file path
function toDistPath(urlPath) {
  let p = urlPath;
  if (BASE !== '') {
    if (p === BASE) p = '/';
    else if (p.startsWith(`${BASE}/`)) p = p.slice(BASE.length);
    else return null; // outside the base: unbased link
  }
  if (p === '' || p === '/') return '/index.html';
  if (p.endsWith('/')) return `${p}index.html`;
  if (distFiles.has(p)) return p;
  if (distFiles.has(`${p}/index.html`)) return `${p}/index.html`;
  return p;
}

let broken = 0;
let unbased = 0;
let checkedLinks = 0;
let checkedAnchors = 0;
const linkedTargets = new Set();

for (const file of htmlFiles) {
  const rel = file.slice(DIST.length);
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|data:|#|javascript:|\/\/)/.test(raw)) continue;
    if (!raw.startsWith('/')) continue;
    const hashAt = raw.indexOf('#');
    const path = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const anchor = hashAt === -1 ? null : decodeURIComponent(raw.slice(hashAt + 1));
    const target = toDistPath(path.split('?')[0]);
    checkedLinks++;
    if (target === null) {
      console.log(`UNBASED  ${rel}  ->  ${raw}`);
      unbased++;
      continue;
    }
    if (!distFiles.has(target)) {
      console.log(`BROKEN   ${rel}  ->  ${raw}   (looked for ${target})`);
      broken++;
      continue;
    }
    linkedTargets.add(target);
    if (anchor !== null && idsByFile.has(target)) {
      checkedAnchors++;
      if (!idsByFile.get(target).has(anchor)) {
        console.log(`ANCHOR   ${rel}  ->  ${raw}`);
        broken++;
      }
    }
  }
}

for (const f of htmlFiles) {
  const rel = f.slice(DIST.length);
  if (rel === '/404.html' || rel === '/index.html') continue;
  if (rel.includes('/schema/')) continue; // redirect stub
  if (!linkedTargets.has(rel)) console.log(`ORPHAN   ${rel} is not linked from any page`);
}

console.log(
  `\n${htmlFiles.length} pages · ${checkedLinks} internal links · ${checkedAnchors} anchors checked`,
);
console.log(
  broken === 0 && unbased === 0
    ? 'OK — no broken links, no broken anchors, no unbased links'
    : `FAIL — ${broken} broken, ${unbased} unbased`,
);
process.exit(broken === 0 && unbased === 0 ? 0 : 1);
