/**
 * The only screens an end user ever sees from Jack: sign in with an API key,
 * approve an app, and errors. Server-rendered, no JavaScript, strict CSP,
 * cannot be framed (clickjacking a consent page is the classic attack).
 *
 * Form ids and field names are a stable contract (`jack-apikey`,
 * `jack-consent`, `api_key`, `decision`) — tests and the docs rely on them.
 */
import type { ToolDefinition } from '@graphmind-ai/jack-schema';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  // same-origin, NOT no-referrer: under no-referrer browsers send `Origin: null` on form posts
  // (Fetch spec), which the CSRF check must reject, so Jack's own forms would be blocked.
  'referrer-policy': 'same-origin',
};

const STYLE = `
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#111827;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;max-width:460px;width:100%;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h1{font-size:19px;margin:0 0 6px}p{margin:8px 0}.muted{color:#6b7280;font-size:13px}.warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 10px;font-size:13px}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:8px 10px;font-size:13px}
ul{padding-left:18px;margin:6px 0}li{margin:2px 0}.tag{font-size:11px;border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:1px}
.read{background:#ecfdf5;color:#065f46}.write{background:#eff6ff;color:#1e40af}.destructive{background:#fef2f2;color:#991b1b}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}input[type=password]{width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;font-weight:600;padding:10px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer}
button.primary{background:#111827;color:#fff;border-color:#111827}.who{font-weight:600}.brand{font-size:12px;color:#9ca3af;margin-top:18px;text-align:center}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="card">${body}<div class="brand">Secured by GraphMind Jack</div></main></body></html>`;
}

export function errorPage(title: string, detail: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p class="err">${esc(detail)}</p><p class="muted">You can close this window and try connecting again from your app.</p>`);
}

/** `base` is the issuer path ('' for an origin issuer, '/p/acme' on a shared host). */
export function apiKeyPage(opts: { project: string; requestId: string; base?: string; error?: string }): string {
  return layout(
    `Sign in to ${opts.project}`,
    `<h1>Sign in to ${esc(opts.project)}</h1>
<p>Paste your ${esc(opts.project)} API key. It is stored encrypted by Jack and used only for the requests your AI app makes on your behalf. The app itself never sees it.</p>
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
<form id="jack-apikey" method="post" action="${esc(opts.base ?? '')}/oauth/apikey" autocomplete="off">
<input type="hidden" name="request" value="${esc(opts.requestId)}">
<label for="api_key">API key</label>
<input id="api_key" type="password" name="api_key" required autofocus spellcheck="false">
<div class="row"><button class="primary" type="submit">Continue</button></div>
</form>`,
  );
}

export interface ConsentView {
  project: string;
  requestId: string;
  base?: string;
  user: string;
  client: { name: string; verifiedHost: string | null; redirectHost: string };
  tools: Pick<ToolDefinition, 'name' | 'annotations' | 'description'>[];
  scopes: string[];
}

function kind(t: ConsentView['tools'][number]): 'read' | 'write' | 'destructive' {
  if (t.annotations.destructiveHint) return 'destructive';
  if (t.annotations.readOnlyHint) return 'read';
  return 'write';
}

export function consentPage(v: ConsentView): string {
  const who = v.client.verifiedHost
    ? `<p class="muted">Verified app from <strong>${esc(v.client.verifiedHost)}</strong></p>`
    : `<p class="warn">This app registered itself and is <strong>not verified</strong>. It will return to <strong>${esc(v.client.redirectHost)}</strong>. Only continue if you started this from an app you trust.</p>`;
  const groups = (['read', 'write', 'destructive'] as const)
    .map((k) => [k, v.tools.filter((t) => kind(t) === k)] as const)
    .filter(([, ts]) => ts.length > 0);
  const label = { read: 'Read', write: 'Change data', destructive: 'Delete data' };
  const list = groups
    .map(
      ([k, ts]) =>
        `<p><span class="tag ${k}">${label[k]}</span></p><ul>${ts
          .map((t) => `<li>${esc(t.annotations.title ?? t.name)}</li>`)
          .join('')}</ul>`,
    )
    .join('');
  return layout(
    `Allow ${v.client.name}?`,
    `<h1>Allow <span class="who">${esc(v.client.name)}</span> to use ${esc(v.project)}?</h1>
${who}
<p>Signed in as <span class="who">${esc(v.user)}</span>. The app will be able to:</p>
${list || '<p class="muted">No tools are available with these permissions.</p>'}
${v.scopes.length ? `<p class="muted">Permissions: ${v.scopes.map(esc).join(', ')}</p>` : ''}
<p class="muted">Actions marked as deleting data ask for your approval each time. You can disconnect the app at any time.</p>
<form id="jack-consent" method="post" action="${esc(v.base ?? '')}/oauth/consent">
<input type="hidden" name="request" value="${esc(v.requestId)}">
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="approve">Allow</button></div>
</form>`,
  );
}
