/**
 * The one place Jack talks to a customer's API. Built on node:http(s)
 * rather than fetch so the egress guard can sit inside DNS resolution
 * (see egress.ts). It never follows redirects, enforces a timeout over the
 * whole exchange, and stops reading at a byte cap.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkTarget, EgressDeniedError, guardedLookup, type EgressPolicy } from './egress.js';

export interface UpstreamRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface UpstreamResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface SendOptions {
  allowedOrigin: string;
  policy: EgressPolicy;
  timeoutMs: number;
  /** Hard cap on the response body; larger responses fail rather than buffer. */
  maxResponseBytes: number;
}

export type UpstreamErrorKind = 'egress' | 'timeout' | 'too_large' | 'network';

export class UpstreamError extends Error {
  override name = 'UpstreamError';
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Sends one request. Rejects only with UpstreamError; HTTP error statuses resolve normally. */
export function sendUpstream(req: UpstreamRequest, opts: SendOptions): Promise<UpstreamResponse> {
  try {
    checkTarget(req.url, opts.allowedOrigin, opts.policy);
  } catch (err) {
    return Promise.reject(new UpstreamError('egress', (err as Error).message));
  }
  const send = req.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = { ...req.headers };
  if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const r = send(
      req.url,
      { method: req.method, headers, lookup: guardedLookup(opts.policy) as never, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxResponseBytes) {
            finish(() => reject(new UpstreamError('too_large', `the API's response is larger than ${opts.maxResponseBytes} bytes`)));
            res.destroy();
            r.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        );
        res.on('error', (err) => finish(() => reject(new UpstreamError('network', err.message))));
      },
    );

    const timer = setTimeout(() => {
      finish(() => reject(new UpstreamError('timeout', `the API did not answer within ${Math.round(opts.timeoutMs / 1000)}s`)));
      r.destroy();
    }, opts.timeoutMs);

    r.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof EgressDeniedError || err.code === 'EJACKEGRESS') {
        finish(() => reject(new UpstreamError('egress', err.message)));
      } else {
        // Connection-level message only (ECONNREFUSED, ENOTFOUND…): never the request itself.
        finish(() => reject(new UpstreamError('network', `could not reach the API (${err.code ?? err.message})`)));
      }
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

export interface GuardedFetchOptions {
  policy: EgressPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * A minimal fetch for Jack's own outbound calls (CIMD documents, identity
 * provider discovery, token and JWKS endpoints): same egress guard, no
 * redirects, timeout and size cap. Returns a standard Response.
 */
export async function guardedFetch(
  url: string | URL,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  opts: GuardedFetchOptions,
): Promise<Response> {
  const target = new URL(url);
  const res = await sendUpstream(
    {
      url: target,
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    },
    {
      allowedOrigin: target.origin,
      policy: opts.policy,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxResponseBytes: opts.maxResponseBytes ?? 256 * 1024,
    },
  );
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
  }
  const status = res.status === 0 ? 502 : res.status;
  return new Response(status === 204 || status === 304 ? null : new Uint8Array(res.body), { status, statusText: res.statusText, headers });
}
