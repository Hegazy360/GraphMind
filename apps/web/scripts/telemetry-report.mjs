/**
 * Aggregate the anonymous telemetry blobs into the behavioral Gate 0 numbers:
 * per-day per-event counts, unique installs, and installs active on >= 2
 * distinct days (the W1-return proxy from internal/decisions.md).
 *
 * Usage (from apps/web): pnpm telemetry
 * Token: BLOB_READ_WRITE_TOKEN from the environment or .env.local.
 *
 * Reads only blob pathnames (telemetry/<event>/<yyyy-mm-dd>/<installId>-<hex>.json)
 * — no blob bodies are fetched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { list } from '@vercel/blob';

function resolveToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const envFile = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'), 'utf8');
    const match = envFile.match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/m);
    if (match) return match[1];
  } catch {
    // fall through
  }
  console.error('No BLOB_READ_WRITE_TOKEN found (env or apps/web/.env.local — run `vercel env pull .env.local`).');
  process.exit(1);
}

const PATH_RE = /^telemetry\/([a-z][a-z-]{0,31})\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})-[0-9a-f]{8}\.json$/;

const token = resolveToken();

/** date -> event -> count */
const perDay = new Map();
/** date -> Set<installId> */
const installsPerDay = new Map();
/** installId -> Set<date> */
const daysPerInstall = new Map();
let totalEvents = 0;
let unparseable = 0;

let cursor;
do {
  const page = await list({ prefix: 'telemetry/', token, cursor });
  for (const blob of page.blobs) {
    const match = blob.pathname.match(PATH_RE);
    if (!match) {
      unparseable += 1;
      continue;
    }
    const [, event, date, installId] = match;
    totalEvents += 1;

    if (!perDay.has(date)) perDay.set(date, new Map());
    const events = perDay.get(date);
    events.set(event, (events.get(event) ?? 0) + 1);

    if (!installsPerDay.has(date)) installsPerDay.set(date, new Set());
    installsPerDay.get(date).add(installId);

    if (!daysPerInstall.has(installId)) daysPerInstall.set(installId, new Set());
    daysPerInstall.get(installId).add(date);
  }
  cursor = page.cursor;
} while (cursor);

const dates = [...perDay.keys()].sort();
if (dates.length === 0) {
  console.log('No telemetry events recorded yet.');
  process.exit(0);
}

console.log('Per-day event counts:');
for (const date of dates) {
  const events = [...perDay.get(date).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([event, count]) => `${event}=${count}`)
    .join('  ');
  const installs = installsPerDay.get(date).size;
  console.log(`  ${date}  ${events}  (${installs} install${installs === 1 ? '' : 's'})`);
}

const uniqueInstalls = daysPerInstall.size;
const returning = [...daysPerInstall.values()].filter((days) => days.size >= 2).length;

console.log('');
console.log(`Events total:      ${totalEvents}`);
console.log(`Unique installs:   ${uniqueInstalls}`);
console.log(`Active >=2 days:   ${returning}  (W1-return proxy)`);
if (unparseable > 0) console.log(`Skipped ${unparseable} blob(s) with unexpected pathnames.`);
