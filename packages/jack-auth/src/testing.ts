/**
 * A scripted browser for testing OAuth flows end to end: follows redirects,
 * keeps cookies per origin, and fills the forms it meets. Used by Jack's
 * own tests and the example's — and handy for testing your own setup.
 *
 *   const final = await browse(authorizationUrl, fetchImpl, {
 *     forms: { 'jack-apikey': () => ({ api_key: 'tk_demo_alice' }), 'jack-consent': () => ({ decision: 'approve' }) },
 *     stopAt: (url) => url.startsWith('http://127.0.0.1:'),   // the client's redirect_uri
 *   });
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BrowseOptions {
  /** Form id → the fields to submit (merged over the form's own hidden inputs). Return null to stop. */
  forms: Record<string, (page: { url: string; html: string }) => Record<string, string> | null>;
  /** True for the URL the flow should end at (the client's redirect URI); it is returned, not fetched. */
  stopAt: (url: string) => boolean;
  maxSteps?: number;
}

export interface BrowseResult {
  /** The redirect URI the flow ended at, with its query (code/state/iss or error). */
  url?: string;
  /** If the flow stopped on a page instead (an error page, or a form with no handler). */
  stuck?: { url: string; status: number; html: string };
  /** Every URL visited, for assertions. */
  visited: string[];
}

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function findForm(html: string): { id: string; action: string; method: string; fields: Record<string, string> } | null {
  const m = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const input of (m[2] as string).match(/<input\b[^>]*>/gi) ?? []) {
    const name = attr(input, 'name');
    if (name && attr(input, 'type') === 'hidden') fields[name] = unescape(attr(input, 'value') ?? '');
  }
  return { id: attr(m[1] as string, 'id') ?? '', action: unescape(attr(m[1] as string, 'action') ?? ''), method: (attr(m[1] as string, 'method') ?? 'get').toLowerCase(), fields };
}

export async function browse(start: string, fetchImpl: FetchLike, opts: BrowseOptions): Promise<BrowseResult> {
  const jar = new Map<string, Map<string, string>>();
  const visited: string[] = [];
  let url = start;
  let init: RequestInit = { method: 'GET' };
  for (let step = 0; step < (opts.maxSteps ?? 20); step++) {
    if (opts.stopAt(url)) return { url, visited };
    visited.push(url);
    const origin = new URL(url).origin;
    const cookies = jar.get(origin);
    const headers = new Headers(init.headers);
    if (cookies?.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetchImpl(url, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const [k, ...v] = (pair ?? '').split('=');
      if (k) (jar.get(origin) ?? jar.set(origin, new Map()).get(origin)!).set(k.trim(), v.join('='));
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href;
      init = { method: 'GET' };
      continue;
    }
    const html = await res.text();
    // Forms on error pages count too: "wrong key, try again" is a 400 with the form still on it.
    const form = findForm(html);
    const fill = form ? opts.forms[form.id] : undefined;
    const values = form && fill ? fill({ url, html }) : null;
    if (!form || !values) return { stuck: { url, status: res.status, html }, visited };
    const body = new URLSearchParams({ ...form.fields, ...values }).toString();
    const target = new URL(form.action || url, url).href;
    init = form.method === 'post'
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body }
      : { method: 'GET' };
    url = form.method === 'post' ? target : `${target.split('?')[0]}?${body}`;
  }
  throw new Error(`browse: more than ${opts.maxSteps ?? 20} steps from ${start}`);
}
