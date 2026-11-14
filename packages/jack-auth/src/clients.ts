/**
 * Who is asking: MCP client identification (plan §3.4 (a)).
 *
 * 1. **CIMD** (primary). The `client_id` is an https URL; we fetch the
 *    JSON document it names, through the egress guard, and its
 *    `client_id` must equal the URL. Its `redirect_uris` are authoritative.
 * 2. **DCR** (fallback, deprecated in 2026-07-28 but still used by Cursor
 *    and older clients). Public clients only, rate limited, and the consent
 *    page says the app is unverified.
 *
 * Redirect URIs (RFC 8252 + OAuth 2.1): exact string match, except
 * loopback (127.0.0.1 / [::1] / localhost over http) where the port may
 * differ, because native apps bind a random port each time.
 */
import { randomToken } from './crypto.js';
import type { AuthStore } from './store.js';

export class ClientError extends Error {
  override name = 'ClientError';
  constructor(
    readonly code: 'invalid_client' | 'invalid_redirect_uri' | 'invalid_client_metadata' | 'temporarily_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedClient {
  clientId: string;
  kind: 'cimd' | 'dcr';
  name: string;
  /** What the consent page shows as "who this really is". */
  verifiedHost: string | null;
  redirectUris: string[];
  logoUri?: string;
}

export type ClientFetch = (url: URL) => Promise<Response>;

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

/**
 * Allowed redirect URIs: https; http only on loopback; or a private-use
 * scheme that looks like a reversed domain (cursor://…, com.example.app:/…),
 * per RFC 8252 §7.1. Never javascript:, data:, file: or a fragment.
 */
export function validRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash !== '') return false;
  if (u.protocol === 'https:') return u.username === '' && u.password === '';
  if (u.protocol === 'http:') return isLoopback(u);
  const scheme = u.protocol.slice(0, -1);
  if (['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ws', 'wss', 'ftp'].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && (scheme.includes('.') || ['cursor', 'vscode', 'vscode-insiders', 'claude'].includes(scheme));
}

export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return isLoopback(reg) && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
    } catch {
      return false;
    }
  });
}

const MAX_CIMD_BYTES = 5 * 1024;

export class ClientRegistry {
  private readonly cimdCache = new Map<string, { client: ResolvedClient; until: number }>();

  constructor(
    private readonly store: AuthStore,
    private readonly fetchCimd: ClientFetch,
    private readonly now: () => number,
    private readonly dcrLimitPerHour = 50,
  ) {}

  static isCimdId(clientId: string): boolean {
    try {
      const u = new URL(clientId);
      return u.protocol === 'https:' && u.pathname !== '/' && u.hash === '';
    } catch {
      return false;
    }
  }

  async resolve(clientId: string): Promise<ResolvedClient> {
    if (ClientRegistry.isCimdId(clientId)) return this.resolveCimd(clientId);
    const rec = this.store.getClient(clientId);
    if (!rec) throw new ClientError('invalid_client', 'unknown client_id');
    this.store.touchClient(clientId, this.now());
    const m = rec.metadata as { client_name?: string; redirect_uris?: string[]; logo_uri?: string };
    return {
      clientId,
      kind: 'dcr',
      name: typeof m.client_name === 'string' && m.client_name.trim() ? m.client_name.trim().slice(0, 80) : 'Unnamed app',
      verifiedHost: null,
      redirectUris: m.redirect_uris ?? [],
    };
  }

  private async resolveCimd(clientId: string): Promise<ResolvedClient> {
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.until > this.now()) return cached.client;
    let res: Response;
    try {
      res = await this.fetchCimd(new URL(clientId));
    } catch (err) {
      throw new ClientError('invalid_client', `could not fetch the client metadata document (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) throw new ClientError('invalid_client', `client metadata document returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_CIMD_BYTES) throw new ClientError('invalid_client_metadata', 'client metadata document is too large');
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ClientError('invalid_client_metadata', 'client metadata document is not JSON');
    }
    if (doc.client_id !== clientId) throw new ClientError('invalid_client_metadata', 'client_id in the metadata document does not match its URL');
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (uris.length === 0 || !uris.every(validRedirectUri)) throw new ClientError('invalid_client_metadata', 'redirect_uris missing or not allowed');
    const auth = doc.token_endpoint_auth_method ?? 'none';
    if (auth !== 'none') throw new ClientError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method none) are supported');
    const client: ResolvedClient = {
      clientId,
      kind: 'cimd',
      name: typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 80) : new URL(clientId).host,
      verifiedHost: new URL(clientId).host,
      redirectUris: uris,
    };
    // Respect a short cache: an attacker controlling the document can't pin a stale one for long.
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 300);
    this.cimdCache.set(clientId, { client, until: this.now() + Math.min(Math.max(maxAge, 60), 3_600) * 1000 });
    return client;
  }

  /** RFC 7591 registration, public clients only. */
  register(metadata: Record<string, unknown>): Record<string, unknown> {
    if (this.store.countClientsSince(this.now() - 3_600_000) >= this.dcrLimitPerHour) {
      throw new ClientError('temporarily_unavailable', 'too many registrations; try again later');
    }
    const uris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirectUri(u))) {
      throw new ClientError('invalid_redirect_uri', 'redirect_uris must be https, loopback http, or a reverse-domain app scheme');
    }
    const method = metadata.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new ClientError('invalid_client_metadata', 'only token_endpoint_auth_method "none" (public clients) is supported');
    const grantTypes = (metadata.grant_types as string[] | undefined) ?? ['authorization_code', 'refresh_token'];
    if (!grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
      throw new ClientError('invalid_client_metadata', 'only authorization_code and refresh_token grants are supported');
    }
    const name = typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 80) : undefined;
    const clientId = `jdc_${randomToken(16)}`;
    const now = this.now();
    const stored = {
      client_name: name,
      redirect_uris: uris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    this.store.putClient({ clientId, kind: 'dcr', metadata: stored, createdAt: now, lastUsedAt: now });
    return { client_id: clientId, client_id_issued_at: Math.floor(now / 1000), ...stored };
  }
}
