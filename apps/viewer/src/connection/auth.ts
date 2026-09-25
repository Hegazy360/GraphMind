/**
 * The viewer's control credential (0.6, contract C3).
 *
 * `graphmind serve` opens the viewer as `http://127.0.0.1:<port>/#token=<t>`
 * (through a private redirect file, never a command line). The token arrives
 * only in the URL fragment — which browsers never send to a server or in a
 * Referer — and is then:
 *
 *  1. taken out of the address bar at once (`history.replaceState`), so it is
 *     not in the history entry, a bookmark, or a screenshot of the URL bar;
 *  2. kept in `localStorage` (which is per origin: this server's port only),
 *     so reopening the plain URL in another tab still has control;
 *  3. presented on the viewer socket as the subprotocol `gm.auth.<token>` next
 *     to `graphmind.v1` (a browser WebSocket cannot set headers), and on HTTP
 *     as `Authorization: Bearer`. Never as `?token=` and never as a cookie —
 *     the server reads neither.
 *
 * Without a token the viewer still connects: it can watch, continue, retry
 * and abort, but cannot inject, edit a held call's input, or change
 * breakpoints or step mode. The token changes every time the server starts; a
 * stale one is dropped the first time the server refuses it, and a tab adopts
 * the newer token another tab of this origin stored.
 */

const STORAGE_KEY = 'graphmind.viewerToken';
const FRAGMENT_KEY = 'token';
export const UI_SUBPROTOCOL = 'graphmind.v1';
export const AUTH_SUBPROTOCOL_PREFIX = 'gm.auth.';

/** A token as the server mints them: printable, no separators a subprotocol would reject. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

let memoryToken: string | undefined;
const listeners = new Set<(token: string | undefined) => void>();

function readStorage(): string | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value !== null && TOKEN_RE.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(token: string | undefined): void {
  try {
    if (token === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // storage blocked: the in-memory copy still serves this page
  }
}

/**
 * Take `#token=…` out of the URL (keeping any other hash, e.g. a deep link)
 * and remember it. Call once, before anything reads `location.hash` (and on
 * `hashchange`). Returns the token that was found, if any.
 *
 * Any page can navigate the user to `#token=<anything>`, so a fragment token
 * never displaces a token this tab already has on its word alone: it replaces
 * it only once this page's own server confirms it is a viewer token (a
 * refused or unconfirmed one is discarded and the old token kept). With no
 * token yet it is taken at once — a bad one is dropped at the first refusal.
 */
export function captureTokenFromLocation(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  const hash = location.hash;
  const prefix = `#${FRAGMENT_KEY}=`;
  if (!hash.startsWith(prefix)) return undefined;
  // `#token=<t>` or `#token=<t>&/run/<id>`: a deep link after the token survives.
  const body = hash.slice(prefix.length);
  const amp = body.indexOf('&');
  const token = amp === -1 ? body : body.slice(0, amp);
  const route = amp === -1 ? '' : body.slice(amp + 1);
  const rest = route.startsWith('/') ? `#${route}` : '';
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${rest}`);
  } catch {
    // replaceState can throw on exotic origins; the token is still taken
  }
  if (!TOKEN_RE.test(token)) return undefined;
  const current = viewerToken();
  if (current === undefined) setViewerToken(token);
  else if (current !== token) void adoptIfConfirmed(token);
  return token;
}

/** Replace the current token with `candidate` once this page's server says it is a viewer token. */
async function adoptIfConfirmed(candidate: string): Promise<void> {
  if ((await sessionPrincipal(candidate)) === 'viewer') setViewerToken(candidate);
}

/**
 * Who this page's own server says `token` is: `'refused'` on 401, undefined
 * when the server cannot be asked. Always the page's origin — the token
 * belongs to the server that served the page, never to a `?server=` target.
 */
async function sessionPrincipal(token: string): Promise<string | 'refused' | undefined> {
  try {
    const url = new URL('/api/session', location.href).href;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 401) return 'refused';
    if (!response.ok) return undefined;
    const body = (await response.json()) as { principal?: unknown };
    return typeof body.principal === 'string' ? body.principal : undefined;
  } catch {
    return undefined;
  }
}

export function viewerToken(): string | undefined {
  return memoryToken ?? readStorage();
}

function notify(token: string | undefined): void {
  for (const listener of [...listeners]) listener(token);
}

export function setViewerToken(token: string | undefined): void {
  memoryToken = token;
  writeStorage(token);
  notify(token);
}

/**
 * Another tab of this origin stored a token (a restarted `graphmind serve`
 * opened one with its new token): adopt it, so this tab stops presenting a
 * token the new server refuses. Only a confirmed token ever reaches storage
 * from a fragment (see captureTokenFromLocation).
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  const stored = readStorage();
  if (stored === undefined || stored === memoryToken) return;
  memoryToken = stored;
  notify(stored);
}

let watchingStorage = false;

export function onViewerTokenChange(listener: (token: string | undefined) => void): () => void {
  if (!watchingStorage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    watchingStorage = true;
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The token belongs to the server that served this page. A viewer pointed at
 * another server (`?server=` / `?ws=`, or the Vite dev server) never sends it
 * there.
 */
export function tokenFor(url: string): string | undefined {
  const token = viewerToken();
  if (token === undefined || typeof location === 'undefined') return undefined;
  try {
    const target = new URL(url, location.href);
    return target.host === location.host ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Subprotocols for the viewer socket: none without a token (0.5-compatible). */
export function socketProtocols(url: string): string[] | undefined {
  const token = tokenFor(url);
  return token === undefined ? undefined : [UI_SUBPROTOCOL, `${AUTH_SUBPROTOCOL_PREFIX}${token}`];
}

/** `Authorization` header for a same-origin API call, when there is a token. */
export function authHeaders(url: string): Record<string, string> {
  const token = tokenFor(url);
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/**
 * The socket closed before it ever opened while presenting `presented`.
 * Either the server is down, or the token is from an earlier `graphmind
 * serve` (the server answers 401, which a browser WebSocket cannot see). Ask
 * this page's own server about THAT token — never another host, whatever
 * `?server=` says — and on a 401 forget it where it is still held: this
 * tab's copy, and the per-origin slot only if it still holds that same token
 * (another tab may have stored a newer, valid one there, which this tab then
 * adopts).
 */
export async function checkTokenAfterFailedConnect(presented: string | undefined): Promise<void> {
  if (presented === undefined) return;
  if ((await sessionPrincipal(presented)) !== 'refused') return; // valid, or the server is unreachable
  if (memoryToken === presented) memoryToken = undefined;
  if (readStorage() === presented) writeStorage(undefined);
  notify(viewerToken());
}
