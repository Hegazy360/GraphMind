/**
 * @graphmind-ai/jack-auth — the per-project OAuth 2.1 authorization server
 * MCP clients talk to (MCP 2026-07-28 authorization): PKCE S256, CIMD with
 * a DCR fallback, consent, rotating refresh tokens, audience-bound JWT
 * access tokens, step-up, and federation to the project's own sign-in
 * (`oidc`, `apikey`; `link` arrives in M5).
 */
export const CIMD_SUPPORTED = true as const;
export const PKCE_METHODS = ['S256'] as const;

export { createAuthServer, type AuthEvent, type AuthServer, type AuthServerOptions } from './server.js';
export { SqliteAuthStore, type AuthStore, type GrantRecord } from './store.js';
export { ClientError, ClientRegistry, redirectMatches, validRedirectUri, type ClientFetch, type ResolvedClient } from './clients.js';
export { randomToken, SecretBox, sha256, verifyPkce } from './crypto.js';
export {
  apiKeyHeaders,
  identifyApiKey,
  LINK_TYP,
  LinkProvider,
  OidcProvider,
  resolveAuth,
  UpstreamAuthError,
  type ApiKeySettings,
  type Fetcher,
  type Identity,
  type LinkSettings,
  type OidcSettings,
  type ResolvedAuth,
  type UpstreamCredential,
} from './upstream.js';
export { esc } from './pages.js';
