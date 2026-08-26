import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';

/**
 * POST /api/waitlist  { email: string }
 *
 * Stores one blob per subscriber, keyed by sha256 of the normalized email,
 * so repeat signups are idempotent overwrites (never duplicates).
 *
 * Responses:
 *   200 { ok: true }                        stored (or already subscribed)
 *   400 { ok: false, error }                invalid email
 *   405 { ok: false, error }                non-POST (including OPTIONS)
 *   500 { ok: false, error }                blob write failed
 *   503 { ok: false, error: 'not configured' }  BLOB_READ_WRITE_TOKEN missing
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

interface WaitlistRequest {
  method?: string;
  body?: unknown;
}

interface WaitlistResponse {
  setHeader(name: string, value: string): void;
  status(code: number): WaitlistResponse;
  json(payload: unknown): void;
}

function parseEmail(body: unknown): string | null {
  let data: unknown = body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null) return null;
  const email = (data as Record<string, unknown>).email;
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(normalized)) return null;
  return normalized;
}

export default async function handler(req: WaitlistRequest, res: WaitlistResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const email = parseEmail(req.body);
  if (!email) {
    res.status(400).json({ ok: false, error: 'invalid email' });
    return;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ ok: false, error: 'not configured' });
    return;
  }

  const key = 'waitlist/' + createHash('sha256').update(email).digest('hex') + '.json';
  try {
    await put(key, JSON.stringify({ email, ts: new Date().toISOString() }), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch {
    res.status(500).json({ ok: false, error: 'storage error' });
    return;
  }

  res.status(200).json({ ok: true });
}
