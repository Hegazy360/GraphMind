/**
 * Who is allowed to talk to the local server.
 *
 * `graphmind serve` binds 127.0.0.1 and has no auth, which is the right
 * default for a local-first tool — but only if a web page the user happens to
 * be visiting cannot reach it. Two browser mechanisms defeat a loopback bind
 * on their own, and both are closed here:
 *
 *  1. **The WebSocket handshake is not covered by the same-origin policy.**
 *     Any page can `new WebSocket('ws://127.0.0.1:4747/ws/ui')` and, once
 *     upgraded, read every recorded run and send control frames — including
 *     `exec.resume` with an injected tool result, i.e. steer the user's agent.
 *     The browser does send an `Origin` header on the upgrade, and it cannot
 *     be forged from a page, so checking it is the fix.
 *
 *  2. **DNS rebinding.** An attacker domain that re-resolves to 127.0.0.1
 *     becomes same-origin for the browser, so a plain `fetch` reaches the
 *     HTTP API with the response readable. The one header the attacker cannot
 *     change is `Host`: it still names their domain. Requiring a loopback
 *     `Host` closes it.
 *
 * The rules, in both cases:
 *
 *  - **No `Origin` header at all is allowed.** That is how non-browser clients
 *    connect — the SDK, `curl`, the CLI's own demo replayer, the tests. A web
 *    page can never omit it, so this is not a hole a page can walk through.
 *  - A loopback origin **on this server's own port** is allowed: that is the
 *    viewer the CLI itself serves.
 *  - Everything else is refused, unless the user opted in via
 *    `GRAPHMIND_ALLOWED_ORIGINS`.
 *
 * `GRAPHMIND_ALLOWED_ORIGINS` is a comma-separated list of extra origins:
 *
 *     # viewer dev server (apps/viewer runs Vite on port 5199)
 *     GRAPHMIND_ALLOWED_ORIGINS=http://localhost:5199,http://127.0.0.1:5199 graphmind serve
 *
 *     # disable the check entirely — only for a setup you fully control
 *     GRAPHMIND_ALLOWED_ORIGINS='*' graphmind serve
 */
import type { EnvLike } from './paths.js';

/** Env var holding extra allowed origins (comma-separated, or `*`). */
export const ALLOWED_ORIGINS_ENV = 'GRAPHMIND_ALLOWED_ORIGINS';

export interface OriginPolicy {
  /** Extra origins the user allow-listed, normalized (`scheme://host[:port]`). */
  readonly extra: ReadonlySet<string>;
  /** `GRAPHMIND_ALLOWED_ORIGINS=*`: allow everything. Opt-in, unsafe. */
  readonly allowAny: boolean;
}

/**
 * `scheme://host[:port]`, lower-cased, default port dropped. Both sides of
 * every comparison go through this, so `http://LocalHost:80/` and
 * `http://localhost` compare equal. Returns undefined for anything that is not
 * a URL — which includes the literal `"null"` a sandboxed iframe or a
 * `file://` page sends, and which must therefore never be allowed.
 */
export function normalizeOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.host === '') return undefined; // e.g. `file:///x`
  return `${url.protocol}//${url.host}`.toLowerCase();
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * True for names and addresses that can only ever mean "this machine":
 * 127.0.0.0/8, ::1 (in any spelling), and `localhost` — which RFC 6761
 * reserves, and which browsers resolve to loopback without consulting DNS,
 * subdomains included.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) return isIpv4Loopback(host.slice('::ffff:'.length));
  return isIpv4Loopback(host);
}

/** The port an origin implies, filling in the scheme default. */
function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

/** Hostname of a `Host` header value (`example.com:4747`, `[::1]:4747`). */
export function hostnameOfHostHeader(value: string): string | undefined {
  const host = value.trim().toLowerCase();
  if (host === '') return undefined;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? undefined : host.slice(1, end);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

export function parseOriginPolicy(env: EnvLike): OriginPolicy {
  const raw = env[ALLOWED_ORIGINS_ENV] ?? '';
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.includes('*')) return { extra: new Set(), allowAny: true };
  const extra = new Set<string>();
  for (const part of parts) {
    const normalized = normalizeOrigin(part);
    if (normalized !== undefined) extra.add(normalized);
  }
  return { extra, allowAny: false };
}

/**
 * `port` is the port this server actually bound, so a viewer served by the
 * CLI itself is same-origin and passes without configuration.
 */
export function isOriginAllowed(
  origin: string | undefined,
  port: number,
  policy: OriginPolicy,
): boolean {
  // Absent header: a non-browser client. A page cannot suppress `Origin`.
  if (origin === undefined || origin === '') return true;
  if (policy.allowAny) return true;
  const normalized = normalizeOrigin(origin);
  if (normalized === undefined) return false; // "null", garbage, file://
  if (policy.extra.has(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(url.hostname)) return false;
  return portOf(url) === port;
}

/**
 * The `Host` check. Only the *name* matters: a rebinding attacker controls the
 * DNS name, never the loopback address it resolves to. The port is left alone
 * on purpose so an SSH tunnel (`-L 8888:127.0.0.1:4747`) keeps working.
 */
export function isHostAllowed(host: string | undefined, policy: OriginPolicy): boolean {
  if (host === undefined || host === '') return true; // HTTP/1.0 has no Host
  if (policy.allowAny) return true;
  const hostname = hostnameOfHostHeader(host);
  if (hostname === undefined) return false;
  if (isLoopbackHostname(hostname)) return true;
  // Allow-listing an origin allow-lists reaching the server under its name.
  for (const origin of policy.extra) {
    try {
      if (new URL(origin).hostname.toLowerCase() === hostname) return true;
    } catch {
      // not a URL: cannot match a hostname
    }
  }
  return false;
}

export type RejectionKind = 'origin' | 'host';

export interface Rejection {
  kind: RejectionKind;
  /** The offending header value, for logs and the 403 body. */
  value: string;
  message: string;
}

function hint(): string {
  return (
    `Set ${ALLOWED_ORIGINS_ENV} to a comma-separated list of origins to allow it ` +
    `(for example ${ALLOWED_ORIGINS_ENV}=http://localhost:5199), or '*' to disable the check.`
  );
}

/**
 * Check both headers of one request. Returns undefined when it may proceed.
 * Used by the HTTP middleware and by the WebSocket upgrade handler, so the
 * two endpoints can never drift apart.
 */
export function checkRequestHeaders(
  headers: { origin?: string | undefined; host?: string | undefined },
  port: number,
  policy: OriginPolicy,
): Rejection | undefined {
  if (!isHostAllowed(headers.host, policy)) {
    const value = headers.host ?? '';
    return {
      kind: 'host',
      value,
      message:
        `Refused: Host "${value}" is not a loopback name. The GraphMind server is bound to ` +
        '127.0.0.1 and only answers to 127.0.0.1, localhost or [::1] — a request arriving under ' +
        'another name is DNS rebinding, not you. ' +
        hint(),
    };
  }
  if (!isOriginAllowed(headers.origin, port, policy)) {
    const value = headers.origin ?? '';
    return {
      kind: 'origin',
      value,
      message:
        `Refused: Origin "${value}" may not talk to this GraphMind server. It records your ` +
        'prompts and tool payloads and can drive a paused agent, so only the viewer it serves ' +
        `itself (http://127.0.0.1:${port}, http://localhost:${port}) is allowed by default. ` +
        hint(),
    };
  }
  return undefined;
}
