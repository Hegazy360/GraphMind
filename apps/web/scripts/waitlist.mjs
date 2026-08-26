/**
 * Print every waitlist signup, newest first.
 *
 * Usage (from apps/web): pnpm waitlist
 * Token: BLOB_READ_WRITE_TOKEN from the environment or .env.local.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, list } from '@vercel/blob';

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

const token = resolveToken();
const entries = [];
let cursor;
do {
  const page = await list({ prefix: 'waitlist/', token, cursor });
  for (const blob of page.blobs) {
    const result = await get(blob.pathname, { access: 'private', token, useCache: false });
    if (!result) continue;
    const text = await new Response(result.stream).text();
    try {
      entries.push(JSON.parse(text));
    } catch {
      entries.push({ email: `<unparseable: ${blob.pathname}>`, ts: null });
    }
  }
  cursor = page.cursor;
} while (cursor);

entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
for (const entry of entries) {
  const when = entry.ts ? new Date(entry.ts).toISOString().replace('T', ' ').slice(0, 16) : 'unknown time';
  console.log(`${when}  ${entry.email}`);
}
console.log(`\n${entries.length} signup${entries.length === 1 ? '' : 's'} on the waitlist.`);
