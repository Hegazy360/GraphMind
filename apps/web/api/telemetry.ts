import { randomBytes } from 'node:crypto';
import { put } from '@vercel/blob';

/**
 * POST /api/telemetry  { event, installId, version, ts? }
 *
 * Receiver for the CLI's anonymous usage telemetry (see
 * packages/cli/TELEMETRY.md). Stores one small blob per event under
 * `telemetry/<event>/<yyyy-mm-dd>/<installId>-<8 hex>.json` with the
 * server's timestamp. Strictly validated, size-capped, and never echoes
 * anything back to the caller.
 *
 * Responses:
 *   204                                      stored
 *   400 { ok: false, error }                 invalid payload
 *   405 { ok: false, error }                 non-POST (including OPTIONS)
 *   500 { ok: false, error }                 blob write failed
 *   503 { ok: false, error: 'not configured' }  BLOB_READ_WRITE_TOKEN missing
 */

const EVENT_RE = /^[a-z][a-z-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9a-zA-Z.-]{1,32})?$/;
const MAX_BODY_BYTES = 1024;

interface TelemetryRequest {
  method?: string;
  body?: unknown;
}

interface TelemetryResponse {
  setHeader(name: string, value: string): void;
  status(code: number): TelemetryResponse;
  json(payload: unknown): void;
  end(): void;
}

interface TelemetryEvent {
  event: string;
  installId: string;
  version: string;
}

function parseEvent(body: unknown): TelemetryEvent | null {
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
  const record = data as Record<string, unknown>;

  const event = record.event;
  if (typeof event !== 'string' || !EVENT_RE.test(event)) return null;

  const rawInstallId = record.installId;
  if (typeof rawInstallId !== 'string') return null;
  const installId = rawInstallId.trim().toLowerCase();
  if (!UUID_RE.test(installId)) return null;

  const version = record.version;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;

  return { event, installId, version };
}

export default async function handler(req: TelemetryRequest, res: TelemetryResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const parsed = parseEvent(req.body);
  if (!parsed) {
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ ok: false, error: 'not configured' });
    return;
  }

  // Server-side timestamp: the client's `ts` is never trusted or stored.
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const suffix = randomBytes(4).toString('hex');
  const key = `telemetry/${parsed.event}/${day}/${parsed.installId}-${suffix}.json`;
  try {
    await put(
      key,
      JSON.stringify({ event: parsed.event, installId: parsed.installId, version: parsed.version, ts: now }),
      {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      },
    );
  } catch {
    res.status(500).json({ ok: false, error: 'storage error' });
    return;
  }

  res.status(204).end();
}
