import { randomBytes } from 'node:crypto';
import { put } from '@vercel/blob';

/**
 * POST /api/events  { event, sid, where?, which? }
 *
 * The homepage's own funnel, first-party and anonymous: eight named events
 * (page view → demo → CTA → sign-up → first product use), one random session
 * id the page makes and forgets on close, no cookies, no IP, no user agent,
 * no referrer. Stored one blob per event under
 * `events/<event>/<yyyy-mm-dd>/<sid>-<8 hex>.json` with the server's time,
 * so the week's funnel is a listing. Size-capped, strictly validated, and it
 * never echoes anything back.
 *
 * Responses: 204 stored · 400 invalid · 405 non-POST · 500 storage error ·
 * 503 BLOB_READ_WRITE_TOKEN missing.
 */

export const EVENTS = new Set([
  'home-view',
  'demo-start',
  'demo-inject', // the aha: the visitor unblocked the held call themselves
  'demo-done',
  'cta-click',
  'signup-view',
  'signup-done',
  'product-open',
  'activated',
]);
const SID_RE = /^[a-z0-9]{8,32}$/;
const WORD_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_BODY_BYTES = 512;

interface Req {
  method?: string;
  body?: unknown;
}
interface Res {
  setHeader(name: string, value: string): void;
  status(code: number): Res;
  json(payload: unknown): void;
  end(): void;
}

export interface WebEvent {
  event: string;
  sid: string;
  where?: string;
  which?: string;
}

export function parseWebEvent(body: unknown): WebEvent | null {
  let data: unknown = body;
  if (typeof data === 'string') {
    if (Buffer.byteLength(data) > MAX_BODY_BYTES) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.event !== 'string' || !EVENTS.has(r.event)) return null;
  if (typeof r.sid !== 'string' || !SID_RE.test(r.sid)) return null;
  const out: WebEvent = { event: r.event, sid: r.sid };
  for (const k of ['where', 'which'] as const) {
    const v = r[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !WORD_RE.test(v)) return null;
    out[k] = v;
  }
  return out;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const parsed = parseWebEvent(req.body);
  if (!parsed) {
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ ok: false, error: 'not configured' });
    return;
  }
  const now = new Date().toISOString();
  const key = `events/${parsed.event}/${now.slice(0, 10)}/${parsed.sid}-${randomBytes(4).toString('hex')}.json`;
  try {
    await put(key, JSON.stringify({ ...parsed, ts: now }), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } catch {
    res.status(500).json({ ok: false, error: 'storage error' });
    return;
  }
  res.status(204).end();
}
