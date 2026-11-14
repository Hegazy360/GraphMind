// GraphMind Jack dashboard. Dependency-free; talks only to its own server's
// /v1 and /auth, by URLs relative to the page, so the same files work at the
// origin root (`jack serve`) and under a prefix (the platform's /jack/).
// Everything that came from a customer (spec text, descriptions, tool
// results, user names) is rendered with textContent, never innerHTML.
//
// The top bar, sign-in and the account page (with API tokens) are the shared
// GraphMind shell (./gm/shell.js); inside the platform they live on the hub.
import { startShell, toast as gmToast } from './gm/shell.js';

const shell = await startShell({ product: 'jack' });
const state = {
  apiKey: sessionStorage.getItem('jack.apiKey') ?? '',
  server: null, // GET /health: { protocol, origin, accounts, ... }
  projects: [],
  project: null, // GET /v1/projects/:id
  draft: null, // DraftView
  editing: null, // tool key being edited
  toolFilter: '',
  timer: null,
};

// ---------------------------------------------------------------- DOM --
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    // CSSOM, not the attribute: the CSP (style-src 'self') blocks style="" attributes.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
function mount(...nodes) {
  main().replaceChildren(...nodes);
}

const toast = gmToast;

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}
const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function copyBox(text, testid) {
  return h(
    'div',
    { class: 'copy' },
    h('code', { 'data-testid': testid }, text),
    h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, 'Copy'),
  );
}

// ---------------------------------------------------------------- API --
class ApiError extends Error {}
/** Thrown when the server has accounts and nobody is signed in: the sign-in page is already on screen. */
class SignInRequired extends Error {}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(state.apiKey ? { authorization: `Bearer ${state.apiKey}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { res, data: {} };
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { res, data };
}

async function api(method, path, body, retried = false) {
  const { res, data } = await request(method, `v1${path}`, body);
  if (res.status === 401) {
    if (shell.server.accounts) {
      if (retried) throw new SignInRequired('sign in to continue');
      shell.user = null; // the session ended: sign in (on the hub inside the platform), then try again
      await shell.requireSession();
      shell.renderBar();
      return api(method, path, body, true);
    }
    const key = prompt('This Jack server needs an API key (jack serve --api-key …):');
    if (key) {
      state.apiKey = key.trim();
      sessionStorage.setItem('jack.apiKey', state.apiKey);
      return api(method, path, body);
    }
  }
  if (!res.ok) throw new ApiError(data?.detail ?? data?.title ?? `HTTP ${res.status}`);
  return data;
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof SignInRequired)) toast(err.message, true);
    return undefined;
  }
}

// ------------------------------------------------------------- shell --
async function loadProjects() {
  const { projects } = await api('GET', '/projects');
  state.projects = projects;
  renderSidebar();
}

function renderSidebar() {
  renderServerInfo();
  const current = state.project?.project.id;
  $('#project-list').replaceChildren(
    ...state.projects.map((p) =>
      h(
        'a',
        { href: `#/p/${p.id}/tools`, class: p.id === current ? 'on' : '' },
        p.name,
        h('span', { class: 'sub' }, p.activeVersion ? `live v${p.activeVersion} · ${p.mode}` : 'not deployed'),
      ),
    ),
  );
}

// ------------------------------------------------------ server info --
function renderServerInfo() {
  $('#server-info').replaceChildren(state.server ? `MCP ${state.server.protocol} · ${state.server.origin}` : '');
}

// ------------------------------------------------------------ router --
const TABS = [
  ['tools', 'Tools'],
  ['signin', 'Sign-in'],
  ['try', 'Try it'],
  ['deploy', 'Deploy'],
  ['users', 'Users'],
  ['activity', 'Activity'],
  ['settings', 'Settings'],
];

async function route() {
  clearInterval(state.timer);
  state.timer = null;
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  if (parts[0] === 'account') return; // the shell's account page (on the hub inside the platform)
  if (parts[0] === 'signin' || parts[0] === 'signup') {
    history.replaceState(null, '', '#/'); // signed in already (requireSession ran at boot)
    return route();
  }
  await guarded(loadProjects);
  if (params.get('signin_error') && parts[0] !== 'p') toast(params.get('signin_error'), true);
  if (parts[0] === 'new') return renderNew();
  if (parts[0] === 'p' && parts[1]) {
    const ok = await guarded(() => loadProject(parts[1]));
    if (ok === undefined) return renderHome();
    return renderProject(parts[2] ?? 'tools', params);
  }
  state.project = null;
  renderSidebar();
  return renderHome();
}

async function loadProject(id) {
  state.project = await api('GET', `/projects/${id}`);
  const { draft } = await api('GET', `/projects/${id}/draft`).catch(() => ({ draft: null }));
  state.draft = draft;
  renderSidebar();
  return true;
}

// -------------------------------------------------------------- home --
function renderHome() {
  if (state.projects.length === 0) {
    return mount(
      h(
        'div',
        { class: 'empty' },
        h('h1', {}, 'Turn your API into an MCP server'),
        h('p', {}, 'Import an OpenAPI spec, choose what AI clients may do, set up sign-in, and deploy. Your users connect from Claude, ChatGPT, Cursor or VS Code.'),
        h('a', { class: 'btn primary', href: '#/new', 'data-testid': 'start' }, 'Import your API'),
        h(
          'div',
          { class: 'steps' },
          h('div', {}, h('b', {}, '1 · Import'), 'A spec URL or file. Reads start enabled, writes start off.'),
          h('div', {}, h('b', {}, '2 · Curate'), 'Pick tools, rewrite descriptions for models, require approval.'),
          h('div', {}, h('b', {}, '3 · Sign-in'), 'Your login (OIDC) or per-user API keys. Jack handles OAuth.'),
          h('div', {}, h('b', {}, '4 · Deploy'), 'Get an MCP URL. Try it here first, as yourself.'),
        ),
      ),
    );
  }
  mount(
    h('div', { class: 'head' }, h('h1', {}, 'Projects'), h('a', { class: 'btn primary', href: '#/new' }, '+ New project')),
    h(
      'div',
      { class: 'cards' },
      state.projects.map((p) =>
        h(
          'a',
          { class: 'card', href: `#/p/${p.id}/tools` },
          h('div', { class: 't' }, p.name),
          h('div', { class: 'muted small mono' }, p.slug),
          h(
            'div',
            { class: 'row', style: 'margin-top:10px' },
            p.activeVersion ? h('span', { class: 'pill live' }, `live v${p.activeVersion}`) : h('span', { class: 'pill draft' }, 'not deployed'),
            h('span', { class: `pill ${p.mode === 'open' ? '' : 'signin'}` }, p.mode === 'open' ? 'no sign-in' : 'sign-in'),
            h('span', { class: 'muted small' }, `${p.tools} tools live`),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------- new project --
function renderNew() {
  state.project = null;
  renderSidebar();
  const url = h('input', { type: 'url', id: 'spec-url', placeholder: 'https://api.example.com/openapi.json' });
  const text = h('textarea', { class: 'code', id: 'spec-text', placeholder: 'or paste the OpenAPI document (JSON or YAML)' });
  const upstream = h('input', { type: 'url', id: 'spec-upstream', placeholder: 'only if the spec has a relative server URL' });
  const out = h('div');
  const source = () => (text.value.trim() ? { text: text.value } : url.value.trim() ? { url: url.value.trim() } : null);

  async function analyze() {
    const src = source();
    if (!src) return toast('Give a spec URL or paste one', true);
    const r = await guarded(() => api('POST', '/import/preview', { source: src, ...(upstream.value ? { upstream: upstream.value } : {}) }));
    if (!r) return;
    const p = r.preview;
    const name = h('input', { type: 'text', id: 'project-name', value: p.title });
    const slug = h('input', { type: 'text', id: 'project-slug', value: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) });
    out.replaceChildren(
      h(
        'div',
        { class: 'panel', 'data-testid': 'import-preview' },
        h('h2', { style: 'margin-top:0' }, p.title),
        h('p', { class: 'muted' }, `${p.dialect} · calls go to `, h('code', {}, p.baseUrl)),
        h(
          'p',
          {},
          h('b', {}, `${p.operations} operations. `),
          `${p.enabled} read tools will start enabled; ${p.writes} operations that change data start disabled until you enable them.`,
        ),
        p.diagnostics.filter((d) => d.severity === 'warning').map(diag),
        h(
          'table',
          {},
          h('tr', {}, h('th', {}, ''), h('th', {}, 'Operation'), h('th', {}, 'Tool')),
          p.tools.map((t) =>
            h(
              'tr',
              { class: t.enabled ? '' : 'off' },
              h('td', {}, h('span', { class: `pill ${t.kind}` }, t.kind)),
              h('td', { class: 'path' }, `${t.method} ${t.path}`),
              h('td', {}, h('span', { class: 'toolname' }, t.key), t.enabled ? '' : h('span', { class: 'muted small' }, ' · off')),
            ),
          ),
        ),
        h('div', { class: 'row', style: 'margin-top:14px' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Project name'), name), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Slug ', h('span', { class: 'hint' }, 'part of the MCP URL')), slug)),
        h(
          'div',
          { class: 'row', style: 'margin-top:16px' },
          h(
            'button',
            {
              class: 'btn primary',
              id: 'create-project',
              onclick: async () => {
                const created = await guarded(() =>
                  api('POST', '/projects', { source: src, name: name.value, slug: slug.value, ...(upstream.value ? { upstream: upstream.value } : {}) }),
                );
                if (created) location.hash = `#/p/${created.project.id}/tools`;
              },
            },
            'Create project',
          ),
        ),
      ),
    );
  }

  mount(
    h('div', { class: 'head' }, h('h1', {}, 'New project')),
    h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Start from your OpenAPI (Swagger 2.0, OpenAPI 3.0 or 3.1) document. Nothing is published until you deploy.'),
      h('label', { class: 'field' }, 'Spec URL'),
      url,
      h('label', { class: 'field' }, 'Or paste it'),
      text,
      h('label', { class: 'field' }, 'API base URL ', h('span', { class: 'hint' }, 'optional')),
      upstream,
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', id: 'analyze', onclick: analyze }, 'Analyze')),
    ),
    out,
  );
}

// ----------------------------------------------------------- project --
const draftChanges = () => (state.draft ? state.draft.live.changes + (state.draft.live.configChanged ? 1 : 0) : 0);

function projectHeader(tab) {
  const { project } = state.project;
  const changes = draftChanges();
  const warnings = state.draft ? [...state.draft.diagnostics, ...state.draft.tools.flatMap((t) => t.diagnostics)].filter((d) => d.severity === 'warning').length : 0;
  return [
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        {},
        h('h1', { 'data-testid': 'project-name' }, project.name),
        h(
          'div',
          { class: 'meta' },
          project.activeVersion ? h('span', { class: 'pill live', 'data-testid': 'live-version' }, `live v${project.activeVersion}`) : h('span', { class: 'pill draft' }, 'not deployed'),
          h('span', { class: `pill ${project.mode === 'open' ? '' : 'signin'}` }, project.mode === 'open' ? 'no sign-in' : `sign-in: ${project.auth.mode}`),
          h('span', { class: 'muted small mono' }, project.mcpUrl),
        ),
      ),
    ),
    changes > 0 || !project.activeVersion
      ? h(
          'div',
          { class: 'banner draft', 'data-testid': 'draft-banner' },
          h('span', {}, project.activeVersion ? `${changes} undeployed change${changes === 1 ? '' : 's'}.` : 'Draft not deployed yet. AI clients cannot connect until you deploy.'),
          tab === 'deploy' ? '' : h('a', { class: 'btn primary small', href: `#/p/${project.id}/deploy` }, 'Review & deploy'),
        )
      : '',
    h(
      'nav',
      { class: 'tabs' },
      TABS.map(([id, label]) =>
        h(
          'a',
          { href: `#/p/${project.id}/${id}`, class: id === tab ? 'on' : '', 'data-tab': id },
          label,
          id === 'tools' && warnings ? h('span', { class: 'count' }, String(warnings)) : '',
          id === 'deploy' && changes ? h('span', { class: 'count' }, String(changes)) : '',
        ),
      ),
    ),
  ];
}

function renderProject(tab, params) {
  const views = { tools: viewTools, signin: viewSignin, try: viewTry, deploy: viewDeploy, users: viewUsers, activity: viewActivity, settings: viewSettings };
  const view = views[tab] ?? viewTools;
  const body = h('div', { id: 'tab' });
  mount(...projectHeader(tab), body);
  view(body, params);
}

/** Re-render the current tab after a draft change, keeping the page where it is. */
function refresh(draft) {
  if (draft) state.draft = draft;
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  renderProject(path.split('/')[3] ?? 'tools', new URLSearchParams(query));
}

function diag(d) {
  return h('div', { class: `diag ${d.severity}` }, h('code', {}, d.code), d.tool ? h('b', {}, `${d.tool}: `) : '', d.message);
}

// -------------------------------------------------------------- tools --
async function patchTool(key, patch) {
  const r = await guarded(() => api('PATCH', `/projects/${state.project.project.id}/draft/tools/${encodeURIComponent(key)}`, patch));
  if (r) refresh(r.draft);
  return r;
}

function viewTools(el) {
  const d = state.draft;
  if (!d) return el.append(h('div', { class: 'panel' }, 'This project has no spec yet. Import one under Settings.'));
  const filter = h('input', {
    type: 'text',
    placeholder: 'Filter tools…',
    value: state.toolFilter,
    oninput: (e) => {
      state.toolFilter = e.target.value;
      renderRows();
    },
  });
  const tbody = h('tbody');
  function renderRows() {
    const q = state.toolFilter.toLowerCase();
    const rows = d.tools.filter((t) => !q || `${t.name} ${t.key} ${t.path} ${t.description}`.toLowerCase().includes(q));
    tbody.replaceChildren(...rows.flatMap((t) => toolRows(t)));
  }
  renderRows();
  el.append(
    h(
      'div',
      { class: 'row', style: 'margin-bottom:12px' },
      h('div', { class: 'grow' }, h('b', { 'data-testid': 'tool-count' }, `${d.enabled} of ${d.tools.length} tools enabled`), h('span', { class: 'muted' }, ` · calls go to ${d.baseUrl}`)),
      h('div', { style: 'width:260px' }, filter),
    ),
    d.diagnostics.map(diag),
    h('div', { class: 'panel', style: 'padding:6px 8px' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'On'), h('th', {}, 'Tool'), h('th', {}, 'Operation'), h('th', {}, ''), h('th', {}, ''))), tbody)),
  );
}

function toolRows(t) {
  const on = h('label', { class: 'switch', title: t.enabled ? 'Enabled' : 'Disabled' }, h('input', {
    type: 'checkbox',
    checked: t.enabled,
    'data-testid': `toggle-${t.key}`,
    onchange: (e) => patchTool(t.key, { enabled: e.target.checked }),
  }), h('span'));
  const row = h(
    'tr',
    { class: `${t.enabled ? '' : 'off'} ${state.editing === t.key ? 'editing' : ''}`, 'data-tool': t.key },
    h('td', {}, on),
    h(
      'td',
      {},
      h('div', { class: 'toolname' }, t.name, t.name !== t.key ? h('span', { class: 'muted small' }, ` (from ${t.key})`) : ''),
      h('div', { class: 'desc' }, t.description.split('\n')[0]),
      t.diagnostics.filter((x) => x.severity === 'warning').map(diag),
    ),
    h('td', { class: 'path' }, `${t.method} ${t.path}`),
    h(
      'td',
      {},
      h('span', { class: `pill ${t.kind}` }, t.kind === 'read' ? 'read' : t.kind === 'write' ? 'writes' : 'deletes'),
      ' ',
      t.confirm ? h('span', { class: 'pill warn', title: 'Users approve every call' }, 'approval') : '',
      t.deprecated ? h('span', { class: 'pill' }, 'deprecated') : '',
    ),
    h('td', {}, h('button', { class: 'btn small', 'data-testid': `edit-${t.key}`, onclick: () => { state.editing = state.editing === t.key ? null : t.key; refresh(); } }, state.editing === t.key ? 'Close' : 'Edit')),
  );
  if (state.editing !== t.key) return [row];
  return [row, h('tr', { class: 'editing' }, h('td', {}), h('td', { colspan: 4 }, toolEditor(t)))];
}

function toolEditor(t) {
  const name = h('input', { type: 'text', value: t.name, 'data-testid': 'edit-name' });
  const title = h('input', { type: 'text', value: t.annotations.title ?? '', 'data-testid': 'edit-title' });
  const desc = h('textarea', { 'data-testid': 'edit-description' }, t.description);
  desc.value = t.description;
  const confirm = h('input', { type: 'checkbox', checked: t.confirm, 'data-testid': 'edit-confirm' });
  const scopes = h('input', { type: 'text', value: t.requiredScopes.join(' '), 'data-testid': 'edit-scopes' });
  return h(
    'div',
    { class: 'stack', style: 'max-width:760px' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Tool name ', h('span', { class: 'hint' }, 'what the model calls')), name), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Title ', h('span', { class: 'hint' }, 'shown to users')), title)),
    h('label', { class: 'field' }, 'Description for the model ', h('span', { class: 'hint' }, t.descriptionIsCustom ? 'custom' : 'from the spec — models pick tools by this text; say what ids look like and what to call first')),
    desc,
    h('label', { class: 'check' }, confirm, h('span', {}, h('b', {}, 'Ask the user to approve every call'), h('div', { class: 'muted small' }, 'Recommended for anything that deletes data or spends money.'))),
    h('label', { class: 'field' }, 'Required permissions ', h('span', { class: 'hint' }, 'OAuth scopes, space separated')),
    scopes,
    t.diagnostics.map(diag),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn primary',
          'data-testid': 'save-tool',
          onclick: async () => {
            const patch = {
              name: name.value.trim() === t.key ? null : name.value.trim(),
              description: desc.value.trim() === '' ? null : desc.value.trim() === t.description && !t.descriptionIsCustom ? null : desc.value.trim(),
              confirm: confirm.checked,
              annotations: title.value.trim() ? { ...t.annotations, title: title.value.trim() } : null,
              requiredScopes: scopes.value.trim() ? scopes.value.trim().split(/\s+/) : null,
            };
            const r = await patchTool(t.key, patch);
            if (r) {
              state.editing = null;
              refresh();
              toast('Saved to the draft');
            }
          },
        },
        'Save',
      ),
      t.descriptionIsCustom ? h('button', { class: 'btn', onclick: () => patchTool(t.key, { description: null }) }, 'Reset description to the spec') : '',
    ),
  );
}

// ------------------------------------------------------------ sign-in --
function viewSignin(el) {
  const d = state.draft;
  const { project, oidcRedirectUri, secrets, issuer } = state.project;
  const auth = d?.config.auth ?? { mode: 'none', requireSignIn: false };
  let mode = auth.mode;
  const fields = h('div');
  const readTools = (d?.tools ?? []).filter((t) => t.enabled && t.kind === 'read');
  const secretSet = secrets.some((s) => s.name === 'oidc_client_secret');
  const linkSecretSet = secrets.some((s) => s.name === 'link_secret');
  const upstreamOrigin = (() => { try { return new URL(d?.baseUrl ?? project.upstream).origin; } catch { return project.upstream; } })();

  const inputs = {
    requireSignIn: h('input', { type: 'checkbox', checked: auth.mode === 'none' && auth.requireSignIn }),
    header: h('input', { type: 'text', value: auth.mode === 'apikey' ? auth.header : 'Authorization' }),
    prefix: h('input', { type: 'text', value: auth.mode === 'apikey' ? auth.prefix : 'Bearer ' }),
    whoami: h('select', {}, h('option', { value: '' }, '— none (accept any key) —'), readTools.map((t) => h('option', { value: t.name, selected: auth.mode === 'apikey' && auth.whoamiTool === t.name }, t.name))),
    issuer: h('input', { type: 'url', value: auth.mode === 'oidc' ? auth.issuer : '', placeholder: 'https://login.example.com', 'data-testid': 'oidc-issuer' }),
    clientId: h('input', { type: 'text', value: auth.mode === 'oidc' ? auth.clientId : '', 'data-testid': 'oidc-client-id' }),
    secret: h('input', { type: 'password', placeholder: secretSet ? '•••••••• (stored encrypted — type to replace)' : 'client secret', 'data-testid': 'oidc-secret', autocomplete: 'off' }),
    scopes: h('input', { type: 'text', value: auth.mode === 'oidc' ? auth.scopes.join(' ') : 'openid profile email' }),
    linkUrl: h('input', { type: 'url', value: auth.mode === 'link' ? auth.linkUrl : `${upstreamOrigin}/jack/link`, 'data-testid': 'link-url' }),
    linkSecret: h('input', { type: 'password', placeholder: linkSecretSet ? '•••••••• (stored encrypted — type to replace)' : 'at least 32 characters; the same value as JACK_LINK_SECRET in your app', 'data-testid': 'link-secret', autocomplete: 'off' }),
  };

  function renderFields() {
    if (mode === 'none') {
      fields.replaceChildren(h('label', { class: 'check' }, inputs.requireSignIn, h('span', {}, 'Still require AI clients to sign in (for rate limiting and an audit trail). No credentials are sent to your API.')));
    } else if (mode === 'apikey') {
      fields.replaceChildren(
        h('p', { class: 'muted' }, 'Each user pastes their own API key on Jack\'s sign-in page. The AI app never sees it; Jack sends it to your API.'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Header'), inputs.header), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Value prefix'), inputs.prefix)),
        h('label', { class: 'field' }, 'Check keys with ', h('span', { class: 'hint' }, 'a read tool that returns the current user, e.g. get_me')),
        inputs.whoami,
      );
    } else if (mode === 'oidc') {
      fields.replaceChildren(
        h('p', { class: 'muted' }, 'Users log in with your existing login (Auth0, Okta, Cognito, Keycloak, Entra, your own). Register Jack there as a confidential client:'),
        h('label', { class: 'field' }, 'Redirect URI to register'),
        copyBox(oidcRedirectUri, 'oidc-redirect'),
        h('label', { class: 'field' }, 'Issuer URL ', h('span', { class: 'hint' }, '/.well-known/openid-configuration must work there')),
        inputs.issuer,
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Client ID'), inputs.clientId), h('div', { class: 'grow' }, h('label', { class: 'field' }, 'Client secret ', secretSet ? h('span', { class: 'pill ok' }, 'set') : ''), inputs.secret)),
        h('label', { class: 'field' }, 'Scopes ', h('span', { class: 'hint' }, 'tool permissions from your spec are added automatically')),
        inputs.scopes,
      );
    } else if (mode === 'link') {
      fields.replaceChildren(
        h('p', { class: 'muted' }, 'For apps with a session login and no OAuth server. You add one route and one middleware with ', h('code', {}, '@graphmind-ai/jack-verify'), ' (Python and Ruby too). Jack sends signed-in users to your link route; after that, every call carries a short-lived signed ', h('code', {}, 'Jack-Assertion'), ' header naming the user.'),
        h('label', { class: 'field' }, 'Link route in your app ', h('span', { class: 'hint' }, 'must be on the API origin')),
        inputs.linkUrl,
        h('label', { class: 'field' }, 'Shared secret ', linkSecretSet ? h('span', { class: 'pill ok' }, 'set') : '', h('button', { class: 'btn small', type: 'button', onclick: () => { const b = new Uint8Array(32); crypto.getRandomValues(b); inputs.linkSecret.value = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); inputs.linkSecret.type = 'text'; } }, 'Generate')),
        inputs.linkSecret,
        h('label', { class: 'field' }, 'Values your app needs'),
        h('div', { class: 'stack' }, copyBox(`JACK_LINK_ISSUER=${issuer}`, 'link-issuer'), copyBox(`JACK_LINK_AUDIENCE=${upstreamOrigin}`, 'link-audience')),
      );
    } else fields.replaceChildren();
  }

  const choice = (id, title, text, disabled = false) =>
    h(
      'label',
      { class: `choice${disabled ? ' disabled' : ''}` },
      h('div', { class: 't' }, h('input', { type: 'radio', name: 'mode', value: id, checked: mode === id, disabled, 'data-testid': `mode-${id}`, onchange: () => { mode = id; renderFields(); } }), title),
      h('div', { class: 'muted small' }, text),
    );

  async function save() {
    const pid = project.id;
    let next;
    if (mode === 'none') next = { mode: 'none', requireSignIn: inputs.requireSignIn.checked };
    else if (mode === 'apikey') next = { mode: 'apikey', header: inputs.header.value || 'Authorization', prefix: inputs.prefix.value, ...(inputs.whoami.value ? { whoamiTool: inputs.whoami.value } : {}) };
    else if (mode === 'link') {
      if (inputs.linkSecret.value) {
        if (inputs.linkSecret.value.length < 32) return toast('The shared secret must be at least 32 characters', true);
        const ok = await guarded(() => api('PUT', `/projects/${pid}/secrets/link_secret`, { value: inputs.linkSecret.value }));
        if (ok === undefined) return;
      }
      next = { mode: 'link', linkUrl: inputs.linkUrl.value, secretRef: 'secret:link_secret' };
    } else {
      if (inputs.secret.value) {
        const ok = await guarded(() => api('PUT', `/projects/${pid}/secrets/oidc_client_secret`, { value: inputs.secret.value }));
        if (ok === undefined) return;
      }
      next = { mode: 'oidc', issuer: inputs.issuer.value, clientId: inputs.clientId.value, clientSecretRef: 'secret:oidc_client_secret', scopes: inputs.scopes.value.split(/\s+/).filter(Boolean) };
    }
    const r = await guarded(() => api('PATCH', `/projects/${pid}/draft`, { auth: next }));
    if (r) {
      state.project = await api('GET', `/projects/${pid}`);
      refresh(r.draft);
      toast('Saved to the draft — deploy to make it live');
    }
  }

  renderFields();
  el.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'How do your users sign in?'),
      h('p', { class: 'muted' }, 'Whatever you choose, AI clients get standard MCP OAuth from Jack and only ever hold a Jack token. Live now: ', h('b', {}, project.mode === 'open' ? 'no sign-in' : project.auth.mode), '.'),
      h(
        'div',
        { class: 'choices' },
        choice('oidc', 'Your login (OIDC)', 'Users log in with the account they already have.'),
        choice('apikey', 'Personal API keys', 'Users paste their own key, once, on Jack\'s page.'),
        choice('none', 'No sign-in', 'Public APIs. Calls carry no user credential.'),
        choice('link', 'Account linking', 'Session-only apps, no OAuth server: one route and one middleware in your app.'),
      ),
      fields,
      h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn primary', 'data-testid': 'save-signin', onclick: save }, 'Save')),
    ),
  );
}

// ------------------------------------------------------------- try it --
function skeleton(schema) {
  const out = {};
  for (const name of schema?.required ?? []) {
    const p = schema.properties?.[name] ?? {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    out[name] = p.default ?? (p.enum ? p.enum[0] : t === 'integer' || t === 'number' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : '');
  }
  return out;
}

function viewTry(el, params) {
  const { project, active, testSession } = state.project;
  if (params.get('signin') === 'ok') toast('Signed in for testing');
  if (params.get('signin_error')) el.append(h('div', { class: 'banner err' }, `Sign-in failed: ${params.get('signin_error')}`));
  // One-shot: drop ?signin=… so re-renders don't repeat the message (replaceState fires no hashchange).
  if (params.has('signin') || params.has('signin_error')) history.replaceState(null, '', `#/p/${project.id}/try`);
  if (!active) return el.append(h('div', { class: 'panel' }, 'Deploy first: "Try it" calls the live MCP endpoint, exactly as an AI client would.'));
  const tools = active.manifest.tools;
  const needsSignIn = project.mode !== 'open';
  const select = h('select', { 'data-testid': 'try-tool' }, tools.map((t) => h('option', { value: t.name }, t.name)));
  const args = h('textarea', { class: 'code', 'data-testid': 'try-args' });
  const approve = h('input', { type: 'checkbox', 'data-testid': 'try-approve' });
  const approveRow = h('label', { class: 'check' }, approve, h('span', {}, 'Approve when the tool asks (it requires user approval)'));
  const desc = h('p', { class: 'muted small' });
  const out = h('div');
  const pick = () => {
    const t = tools.find((x) => x.name === select.value);
    args.value = JSON.stringify(skeleton(t?.inputSchema), null, 2);
    desc.textContent = t?.description ?? '';
    approveRow.style.display = t?.confirm ? '' : 'none';
  };
  select.addEventListener('change', pick);
  pick();

  async function run() {
    let parsed;
    try {
      parsed = JSON.parse(args.value || '{}');
    } catch {
      return toast('Arguments must be JSON', true);
    }
    out.replaceChildren(h('p', { class: 'muted' }, 'Calling…'));
    const r = await guarded(() => api('POST', `/projects/${project.id}/try`, { tool: select.value, args: parsed, approve: approve.checked }));
    if (!r) return out.replaceChildren();
    const res = r.result;
    const text = res.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    out.replaceChildren(
      h(
        'div',
        { class: 'row', style: 'margin:10px 0 6px' },
        h('span', { class: `pill ${res.isError ? 'err' : 'ok'}`, 'data-testid': 'try-status' }, res.isError ? 'tool error' : 'ok'),
        h('span', { class: 'muted small' }, `${res.ms} ms`),
        res.approval !== 'not-needed' ? h('span', { class: 'pill warn' }, `approval: ${res.approval}`) : '',
        res.as ? h('span', { class: 'muted small' }, `as ${res.as}`) : '',
      ),
      h('pre', { class: `result${res.isError ? ' error' : ''}`, 'data-testid': 'try-result' }, text),
    );
  }

  const signin = needsSignIn
    ? h(
        'div',
        { class: `banner ${testSession.signedIn ? 'ok' : 'draft'}` },
        testSession.signedIn ? h('span', { 'data-testid': 'signed-in-as' }, `Signed in for testing as ${testSession.as}`) : h('span', {}, 'This project requires sign-in. Sign in the way your users will — the real sign-in and consent pages.'),
        testSession.signedIn
          ? h('button', { class: 'btn small', onclick: async () => { await api('DELETE', `/projects/${project.id}/test-signin`); await loadProject(project.id); refresh(); } }, 'Sign out')
          : h('button', { class: 'btn primary small', 'data-testid': 'test-signin', onclick: async () => { const r = await guarded(() => api('POST', `/projects/${project.id}/test-signin`)); if (r) location.href = r.url; } }, 'Test sign-in'),
      )
    : '';

  el.append(
    signin,
    h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted', style: 'margin-top:0' }, `Calls live v${project.activeVersion} through ${project.mcpUrl} with the official MCP client — the same path an AI client takes. Calls appear in Activity.`),
      h('label', { class: 'field' }, 'Tool'),
      select,
      desc,
      h('label', { class: 'field' }, 'Arguments (JSON)'),
      args,
      approveRow,
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', 'data-testid': 'try-run', onclick: run, disabled: needsSignIn && !testSession.signedIn }, 'Run')),
      out,
    ),
  );
}

// ------------------------------------------------------------- deploy --
function diffLine(diff) {
  const parts = [];
  if (diff.added.length) parts.push(h('span', { class: 'a' }, `+${diff.added.length} added`));
  if (diff.removed.length) parts.push(h('span', { class: 'r' }, `−${diff.removed.length} removed`));
  if (diff.changed.length) parts.push(h('span', { class: 'c' }, `${diff.changed.length} changed`));
  if (diff.rewired.length) parts.push(h('span', { class: 'w' }, `${diff.rewired.length} settings`));
  return h('span', { class: 'diff' }, parts.length ? parts : h('span', { class: 'muted' }, 'no tool changes'));
}

async function viewDeploy(el) {
  const { project } = state.project;
  const d = state.draft;
  const message = h('input', { type: 'text', placeholder: 'What changed? (optional)', 'data-testid': 'deploy-message' });
  const list = (label, names, cls) => (names.length ? h('p', {}, h('b', { class: cls }, `${label}: `), names.join(', ')) : '');
  el.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'Connect an AI client'),
      h('p', { class: 'muted' }, 'Give your users this URL. They add it as a remote MCP server and sign in.'),
      copyBox(project.mcpUrl, 'mcp-url'),
      h('label', { class: 'field' }, 'Claude Code'),
      copyBox(`claude mcp add --transport http ${project.slug} ${project.mcpUrl}`, 'claude-cmd'),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, project.activeVersion ? 'Changes since the live version' : 'First deploy'),
      d ? h('div', {}, diffLine(d.live.diff), d.live.configChanged ? h('span', { class: 'pill warn', style: 'margin-left:8px' }, 'sign-in settings changed') : '') : '',
      d ? [list('Added', d.live.diff.added, 'a'), list('Removed', d.live.diff.removed, 'r'), list('Changed for the model', d.live.diff.changed, 'c'), list('Settings changed', d.live.diff.rewired, 'w')] : '',
      h('p', { class: 'muted small' }, 'Changed tool definitions are flagged to clients that pin tools (rug-pull protection).'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, message), h('button', {
        class: 'btn primary',
        'data-testid': 'deploy',
        disabled: d && draftChanges() === 0 && project.activeVersion,
        onclick: async () => {
          const r = await guarded(() => api('POST', `/projects/${project.id}/deploy`, { message: message.value || undefined }));
          if (r) {
            toast(`Deployed v${r.deployment.version}`);
            await loadProject(project.id);
            refresh();
          }
        },
      }, 'Deploy')),
    ),
  );
  const hist = await guarded(() => api('GET', `/projects/${project.id}/deployments`));
  if (!hist) return;
  el.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'History'),
      hist.deployments.length === 0
        ? h('p', { class: 'muted' }, 'Nothing deployed yet.')
        : h(
            'table',
            { 'data-testid': 'history' },
            h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'When'), h('th', {}, 'Changes'), h('th', {}, 'Tools'), h('th', {}, 'Sign-in'), h('th', {}, '')),
            hist.deployments.map((v) =>
              h(
                'tr',
                {},
                h('td', {}, h('b', {}, `v${v.version}`), v.version === hist.activeVersion ? h('span', { class: 'pill live', style: 'margin-left:6px' }, 'live') : '', v.message ? h('div', { class: 'muted small' }, v.message) : ''),
                h('td', { class: 'muted small' }, `${ago(v.createdAt)} · ${v.createdBy}`),
                h('td', {}, diffLine(v.diff)),
                h('td', {}, String(v.tools)),
                h('td', {}, v.auth ?? '—'),
                h(
                  'td',
                  {},
                  v.version === hist.activeVersion
                    ? ''
                    : h('button', {
                        class: 'btn small',
                        'data-testid': `rollback-${v.version}`,
                        onclick: async () => {
                          if (!confirm(`Make v${v.version} live? AI clients get its tools on their next request.`)) return;
                          const r = await guarded(() => api('POST', `/projects/${project.id}/promote`, { version: v.version }));
                          if (r) {
                            toast(`v${v.version} is live`);
                            await loadProject(project.id);
                            refresh();
                          }
                        },
                      }, v.version < hist.activeVersion ? 'Roll back' : 'Make live'),
                ),
              ),
            ),
          ),
    ),
  );
}

// -------------------------------------------------------------- users --
async function viewUsers(el) {
  const { project } = state.project;
  const r = await guarded(() => api('GET', `/projects/${project.id}/grants`));
  if (!r) return;
  if (project.mode === 'open' && r.grants.length === 0) return el.append(h('div', { class: 'panel' }, 'This project has no sign-in, so there are no connected users. Choose a sign-in method under Sign-in.'));
  el.append(
    h(
      'div',
      { class: 'panel' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Everyone who connected an AI app. Disconnecting revokes access immediately: the app must sign in again.'),
      r.grants.length === 0
        ? h('p', { class: 'muted' }, 'Nobody has connected yet.')
        : h(
            'table',
            { 'data-testid': 'grants' },
            h('tr', {}, h('th', {}, 'User'), h('th', {}, 'App'), h('th', {}, 'Permissions'), h('th', {}, 'Connected'), h('th', {}, '')),
            r.grants.map((g) =>
              h(
                'tr',
                { class: g.revokedAt ? 'off' : '' },
                h('td', {}, h('b', {}, g.user), h('div', { class: 'muted small mono' }, g.subject)),
                h('td', {}, g.app),
                h('td', { class: 'small' }, g.scopes.join(' ') || '—'),
                h('td', { class: 'muted small' }, ago(g.createdAt)),
                h(
                  'td',
                  {},
                  g.revokedAt
                    ? h('span', { class: 'pill' }, 'disconnected')
                    : h('button', {
                        class: 'btn small danger',
                        'data-testid': `revoke-${g.id}`,
                        onclick: async () => {
                          if (!confirm(`Disconnect ${g.user} (${g.app})?`)) return;
                          if ((await guarded(() => api('DELETE', `/projects/${project.id}/grants/${g.id}`))) !== undefined) refresh();
                        },
                      }, 'Disconnect'),
                ),
              ),
            ),
          ),
    ),
  );
}

// ----------------------------------------------------------- activity --
async function viewActivity(el) {
  const { project } = state.project;
  const panel = h('div', { class: 'panel', style: 'padding:6px 8px' });
  el.append(h('p', { class: 'muted' }, 'Every tool call: status, time and size. Arguments, results and credentials are never recorded.'), panel);
  async function load() {
    const r = await api('GET', `/projects/${project.id}/calls?limit=100`).catch(() => null);
    if (!r) return;
    panel.replaceChildren(
      r.calls.length === 0
        ? h('p', { class: 'muted', style: 'padding:10px' }, 'No calls yet. Use "Try it", or connect an AI client.')
        : h(
            'table',
            { 'data-testid': 'calls' },
            h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Tool'), h('th', {}, 'Result'), h('th', {}, 'API'), h('th', {}, 'Time'), h('th', {}, 'Size'), h('th', {}, 'Who')),
            r.calls.map((c) =>
              h(
                'tr',
                {},
                h('td', { class: 'muted small' }, ago(c.at)),
                h('td', { class: 'toolname' }, c.tool),
                h('td', {}, h('span', { class: `pill ${c.status === 'ok' ? 'ok' : c.status === 'declined' ? 'warn' : 'err'}` }, c.status.replaceAll('_', ' '))),
                h('td', { class: 'mono small' }, c.upstreamStatus ?? '—'),
                h('td', { class: 'small' }, `${c.ms} ms`),
                h('td', { class: 'small' }, bytes(c.responseBytes)),
                h('td', { class: 'muted small mono' }, c.subject ?? '—'),
              ),
            ),
          ),
    );
  }
  await load();
  state.timer = setInterval(load, 3000);
}

// ----------------------------------------------------------- settings --
function viewSettings(el) {
  const { project, source } = state.project;
  const url = h('input', { type: 'url', value: source?.url ?? '', placeholder: 'https://api.example.com/openapi.json' });
  const text = h('textarea', { class: 'code', placeholder: 'or paste a new version of the spec' });
  const confirmSlug = h('input', { type: 'text', placeholder: project.slug, 'data-testid': 'delete-confirm' });
  el.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'API spec'),
      h('p', { class: 'muted' }, source ? `${source.url ? `From ${source.url}` : 'Uploaded'} · updated ${ago(source.updatedAt)} · ${bytes(source.bytes)}. Re-importing keeps every change you made to tools.` : 'No spec yet.'),
      h('label', { class: 'field' }, 'Spec URL'),
      url,
      h('label', { class: 'field' }, 'Or paste it'),
      text,
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', {
        class: 'btn',
        onclick: async () => {
          const src = text.value.trim() ? { text: text.value } : url.value.trim() ? { url: url.value.trim() } : null;
          if (!src) return toast('Give a URL or paste the spec', true);
          const r = await guarded(() => api('PUT', `/projects/${project.id}/source`, src));
          if (r) {
            await loadProject(project.id);
            refresh(r.draft);
            toast('Spec updated');
          }
        },
      }, 'Re-import')),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'Configuration as code'),
      h('p', { class: 'muted' }, 'Everything on these pages is a jack.yaml. Export it to keep it in git; `jack deploy` uploads it back.'),
      h('button', {
        class: 'btn',
        'data-testid': 'export',
        onclick: async () => {
          const res = await fetch(`v1/projects/${project.id}/jack.yaml`, { headers: state.apiKey ? { authorization: `Bearer ${state.apiKey}` } : {} });
          const blob = new Blob([await res.text()], { type: 'application/yaml' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `jack.${project.slug}.yaml` });
          a.click();
          URL.revokeObjectURL(a.href);
        },
      }, 'Export jack.yaml'),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'Delete project'),
      h('p', { class: 'muted' }, 'The MCP URL stops working and every connected user is disconnected. Type the slug to confirm.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, confirmSlug), h('button', {
        class: 'btn danger',
        'data-testid': 'delete',
        onclick: async () => {
          if (confirmSlug.value !== project.slug) return toast('Type the slug to confirm', true);
          if ((await guarded(() => api('DELETE', `/projects/${project.id}`))) !== undefined) {
            toast('Deleted');
            location.hash = '#/';
          }
        },
      }, 'Delete')),
    ),
  );
}

// -------------------------------------------------------------- boot --
window.addEventListener('hashchange', route);
// /health is public: it says whether this server has accounts before anything needs a session.
// /health is public: protocol and origin for the sidebar footer.
request('GET', 'health')
  .then(({ res, data }) => {
    if (res.ok) state.server = data;
  })
  .catch(() => {})
  .finally(async () => {
    renderServerInfo();
    await shell.requireSession(); // no-op without accounts; inside the platform, the hub's sign-in
    route();
  });
