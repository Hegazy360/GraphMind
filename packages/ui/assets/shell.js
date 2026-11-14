// GraphMind shell — shared by the hub, Circuit and Jack (served as ./gm/shell.js).
//
//   startShell({ product })  draws the top bar and returns the shell:
//     shell.server      { accounts, signup, users } of the server this page talks to
//     shell.platform    true when the page runs inside the platform (a hub is one level up)
//     shell.hubUrl      the hub's URL inside the platform (or for the hub itself), else null
//     shell.user        the signed-in account, or null
//     shell.requireSession()  resolves with the user; signs in first if needed
//     shell.signOut()
//
// There is ONE account space. Inside the platform every sign-in and every
// "Account" link goes to the hub (sign-in comes back via ?next=). A dashboard
// running on its own (`jack serve --accounts`, `circuit dev --accounts`)
// renders the very same sign-in and account page in place, at #/account.
//
// Every URL is relative to the page, nothing is rendered with innerHTML, and
// styles go through the CSSOM, so this runs under default-src 'self'.

const DOCS = 'https://graphmind.ai/docs';
const PRODUCTS = [
  ['hub', 'Home', ''],
  ['circuit', 'Circuit', 'circuit/'],
  ['jack', 'Jack', 'jack/'],
];
const NAMES = { hub: 'Home', circuit: 'Circuit', jack: 'Jack' };

// ------------------------------------------------------------- helpers --
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // the CSP blocks style="" attributes
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
export function toast(message, isError = false) {
  let t = document.getElementById('gm-toast');
  if (!t) {
    t = h('div', { id: 'gm-toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = message;
  t.className = `gm-show${isError ? ' gm-err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isError ? 6500 : 3000);
}

export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

const initial = (user) => (user.name || user.email || '?').trim().charAt(0) || '?';

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The account endpoints of this page's server (shared by every product inside the platform). */
export async function auth(method, path, body) {
  const res = await fetch(`auth${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail ?? data?.title ?? `HTTP ${res.status}`);
  return data;
}

function logo() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 17 L12 6 M12 6 L19 14 M6 17 L19 14');
  path.setAttribute('class', 'gm-edge');
  svg.append(path);
  for (const [cx, cy, accent] of [[6, 17, false], [12, 6, true], [19, 14, false]]) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', '2.6');
    c.setAttribute('class', accent ? 'gm-node gm-node-accent' : 'gm-node');
    svg.append(c);
  }
  return svg;
}

// --------------------------------------------------------------- shell --
export async function startShell({ product }) {
  const isHub = product === 'hub';
  const [own, parent] = await Promise.all([getJson('health'), isHub ? null : getJson('../health')]);
  const platform = isHub || parent?.service === 'platform';
  const server = { accounts: own?.accounts === true, signup: own?.signup === true, users: own?.users };
  if (server.accounts && server.users === undefined) {
    const st = await getJson('auth/status');
    if (st) Object.assign(server, { signup: st.signup, users: st.users });
  }
  const shell = {
    product,
    server,
    platform,
    hubUrl: platform ? new URL(isHub ? './' : '../', location.href).href : null,
    user: server.accounts ? (await getJson('auth/me'))?.user ?? null : null,
  };

  /** Where "Account" lives: the hub inside the platform, this page otherwise. */
  shell.accountHref = () => (shell.platform ? `${shell.hubUrl}#/account` : '#/account');
  /** The hub's sign-in, coming back here afterwards. */
  shell.signInHref = (mode = 'signin') => `${shell.hubUrl}#/${mode}?next=${encodeURIComponent(location.href)}`;

  // The page area the shell owns on a standalone dashboard (sign-in, account).
  let page = document.getElementById('gm-page');
  if (!page && !isHub) {
    page = h('div', { id: 'gm-page', hidden: true });
    document.getElementById('gm-bar')?.after(page);
  }
  let pending = null; // resolve() of a requireSession() waiting on the sign-in page
  let waiting = null; // ...and its promise, so concurrent callers (polling) share one sign-in

  const openPage = (render) => {
    page.hidden = false;
    document.body.classList.add('gm-page-open');
    render(page);
  };
  const closePage = () => {
    if (!page) return;
    page.hidden = true;
    page.replaceChildren();
    document.body.classList.remove('gm-page-open');
  };

  shell.requireSession = () => {
    if (!server.accounts) return Promise.resolve(null);
    if (shell.user) return Promise.resolve(shell.user);
    if (shell.platform && !isHub) {
      location.href = shell.signInHref(server.signup && server.users === 0 ? 'signup' : 'signin');
      return new Promise(() => {}); // navigating away
    }
    if (waiting) return waiting;
    waiting = new Promise((resolve) => {
      pending = resolve;
      showSignIn();
    }).finally(() => (waiting = null));
    return waiting;
  };

  function showSignIn(mode) {
    const firstVisitor = server.signup && server.users === 0;
    openPage((el) =>
      renderAuth(el, shell, {
        mode: mode ?? (firstVisitor ? 'signup' : 'signin'),
        onSignedIn: (user) => {
          shell.user = user;
          renderBar();
          closePage();
          if (location.hash.startsWith('#/account')) location.hash = '#/';
          if (pending) {
            const done = pending;
            pending = null;
            done(user);
          } else {
            location.reload(); // signed out and back in: start the app afresh
          }
        },
        onSwitch: (m) => showSignIn(m),
      }),
    );
  }

  shell.signOut = async () => {
    try {
      await auth('POST', '/logout', {});
    } catch {
      /* the session is gone either way */
    }
    shell.user = null;
    if (shell.platform) {
      location.href = `${shell.hubUrl}#/signin`; // on the hub this is a hash change: its router takes over
      return;
    }
    renderBar();
    showSignIn('signin');
  };

  // Standalone dashboards: #/account is the shell's page. Inside the platform it lives on the hub.
  const onHash = () => {
    if (isHub || !server.accounts) return;
    if (location.hash.startsWith('#/account')) {
      if (shell.platform) return location.replace(shell.accountHref());
      if (!shell.user) return;
      openPage((el) => renderAccount(el, shell));
    } else if (!pending) {
      closePage();
    }
  };
  window.addEventListener('hashchange', onHash);

  // ---- the bar
  const bar = document.getElementById('gm-bar');
  function renderBar() {
    if (!bar) return;
    bar.className = 'gm-bar';
    const brandHref = shell.platform ? shell.hubUrl : './';
    const products = shell.platform
      ? PRODUCTS.map(([id, label, path]) =>
          h('a', { href: new URL(path, shell.hubUrl).href, class: id === product ? 'on' : '', 'data-testid': `nav-${id}`, 'aria-current': id === product ? 'page' : null }, label),
        )
      : [h('span', { class: 'on' }, NAMES[product] ?? product)];

    let right;
    if (!server.accounts) {
      right = [h('span', { class: 'gm-pill', title: 'This server has no accounts: it is open to anyone who can reach it (local use).' }, 'local · open')];
    } else if (!shell.user) {
      right = shell.platform
        ? [
            h('a', { class: 'gm-bar-link', href: isHub ? '#/signin' : shell.signInHref('signin'), 'data-testid': 'nav-signin' }, 'Sign in'),
            server.signup ? h('a', { class: 'gm-btn gm-btn-primary gm-btn-sm', href: isHub ? '#/signup' : shell.signInHref('signup'), 'data-testid': 'nav-signup' }, 'Create account') : '',
          ]
        : [];
    } else {
      const menu = h(
        'div',
        { class: 'gm-menu', role: 'menu', hidden: true },
        h('div', { class: 'gm-menu-head' }, h('b', {}, shell.user.name || shell.user.email), h('span', {}, shell.user.email)),
        h('a', { href: shell.accountHref(), role: 'menuitem', 'data-testid': 'menu-account', onclick: () => (menu.hidden = true) }, 'Account & API tokens'),
        h('a', { href: DOCS, role: 'menuitem' }, 'Documentation'),
        h('button', { type: 'button', role: 'menuitem', class: 'gm-danger-text', 'data-testid': 'menu-sign-out', onclick: () => shell.signOut() }, 'Sign out'),
      );
      const button = h(
        'button',
        {
          type: 'button',
          class: 'gm-user-btn',
          'aria-haspopup': 'menu',
          'data-testid': 'who',
          onclick: (e) => {
            e.stopPropagation();
            menu.hidden = !menu.hidden;
          },
        },
        h('span', { class: 'gm-avatar', 'aria-hidden': 'true' }, initial(shell.user)),
        h('span', { class: 'gm-user-name' }, shell.user.name || shell.user.email),
      );
      right = [h('div', { class: 'gm-user' }, button, menu)];
    }

    bar.replaceChildren(
      h(
        'div',
        { class: 'gm-bar-inner' },
        h('a', { class: 'gm-brand', href: brandHref, 'data-testid': 'brand' }, logo(), 'GraphMind'),
        h('nav', { class: 'gm-products', 'aria-label': 'Products' }, products),
        h('div', { class: 'gm-bar-right' }, h('a', { class: 'gm-bar-link', href: DOCS }, 'Docs'), right),
      ),
    );
  }
  document.addEventListener('click', () => bar?.querySelector('.gm-menu')?.setAttribute('hidden', ''));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') bar?.querySelector('.gm-menu')?.setAttribute('hidden', '');
  });
  shell.renderBar = renderBar;
  renderBar();
  onHash();
  return shell;
}

// --------------------------------------------------- sign-in / sign-up --
/** The one sign-in / sign-up form. `onSignedIn(user)` runs after success. */
export function renderAuth(container, shell, { mode = 'signin', onSignedIn, onSwitch } = {}) {
  const server = shell.server;
  const signup = mode === 'signup' && server.signup;
  const email = h('input', { class: 'gm-input', type: 'email', id: 'auth-email', autocomplete: 'email', placeholder: 'you@company.com', required: true });
  const name = h('input', { class: 'gm-input', type: 'text', id: 'auth-name', autocomplete: 'name', placeholder: 'How should we address you?' });
  const password = h('input', {
    class: 'gm-input',
    type: 'password',
    id: 'auth-password',
    autocomplete: signup ? 'new-password' : 'current-password',
    placeholder: signup ? 'At least 10 characters' : 'Your password',
    required: true,
    minlength: signup ? 10 : 1,
  });
  const status = h('p', { class: 'gm-auth-status', role: 'alert', 'data-testid': 'auth-status' });
  const submit = h('button', { class: 'gm-btn gm-btn-primary gm-btn-block', type: 'submit', 'data-testid': 'auth-submit', style: 'margin-top:18px' }, signup ? 'Create account' : 'Sign in');
  const switchLink = (target, label) =>
    h('a', {
      href: `#/${target}`,
      'data-testid': `to-${target}`,
      onclick: (e) => {
        if (!onSwitch) return; // the hub routes on the hash itself
        e.preventDefault();
        onSwitch(target);
      },
    }, label);

  const form = h(
    'form',
    {
      'data-testid': signup ? 'signup-form' : 'signin-form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        status.textContent = '';
        try {
          const body = { email: email.value.trim(), password: password.value };
          if (signup && name.value.trim()) body.name = name.value.trim();
          const r = await auth('POST', signup ? '/signup' : '/login', body);
          if (signup) server.users = (server.users ?? 0) + 1;
          toast(signup ? 'Welcome — your account is ready.' : `Signed in as ${r.user.email}`);
          onSignedIn?.(r.user);
        } catch (err) {
          status.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'gm-label', for: 'auth-email' }, 'Email'),
    email,
    signup ? h('label', { class: 'gm-label', for: 'auth-name' }, 'Name', h('span', { class: 'gm-hint' }, 'optional')) : '',
    signup ? name : '',
    h('label', { class: 'gm-label', for: 'auth-password' }, 'Password'),
    password,
    status,
    submit,
  );

  container.replaceChildren(
    h(
      'div',
      { class: 'gm-auth' },
      h(
        'div',
        { class: 'gm-panel' },
        h('p', { class: 'gm-eyebrow' }, signup ? 'Create account' : 'Sign in'),
        h('h1', { class: 'gm-h1', style: 'font-size:24px' }, signup ? 'Your GraphMind account' : 'Welcome back'),
        h('p', { class: 'gm-muted gm-small', style: 'margin:8px 0 0' }, signup
          ? 'Free while GraphMind is in early access: no plans, no card, every feature. One account for Circuit, Jack and what comes next.'
          : 'One account for Circuit, Jack and what comes next.'),
        form,
        h('p', { class: 'gm-auth-switch' },
          signup
            ? ['Already have an account? ', switchLink('signin', 'Sign in')]
            : server.signup
              ? ['New here? ', switchLink('signup', 'Create a free account')]
              : 'This server does not accept new accounts. Ask whoever runs it for one.'),
      ),
    ),
  );
  email.focus();
}

// --------------------------------------------------------- the account --
/** The one account page: profile, plan, personal API tokens, sign out. */
export async function renderAccount(container, shell) {
  const user = shell.user;
  const base = shell.platform ? shell.hubUrl : new URL('./', location.href).href;
  // What the CLIs should be pointed at: inside the platform each product has its own path.
  const jackUrl = (shell.platform ? new URL('jack', base) : new URL('.', base)).href.replace(/\/$/, '');
  const circuitUrl = (shell.platform ? new URL('circuit', base) : new URL('.', base)).href.replace(/\/$/, '');
  const showJack = shell.platform || shell.product === 'jack';
  const showCircuit = shell.platform || shell.product === 'circuit';

  let tokens = [];
  const list = h('div', { 'data-testid': 'tokens' }, h('p', { class: 'gm-quiet gm-small' }, 'Loading…'));
  const minted = h('div');
  const draw = () =>
    list.replaceChildren(
      tokens.length === 0
        ? h('div', { class: 'gm-empty' }, 'No API tokens yet. Create one to let a CLI act as you.')
        : h('table', { class: 'gm-table' },
            h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Token'), h('th', {}, 'Created'), h('th', {}, 'Last used'), h('th', {}, '')),
            tokens.map((t) =>
              h('tr', {},
                h('td', {}, t.name),
                h('td', { class: 'gm-mono' }, `${t.prefix}…`),
                h('td', { class: 'gm-quiet gm-small' }, ago(t.createdAt)),
                h('td', { class: 'gm-quiet gm-small' }, t.lastUsedAt ? ago(t.lastUsedAt) : 'never'),
                h('td', { style: 'text-align:right' }, h('button', {
                  class: 'gm-btn gm-btn-sm gm-btn-danger',
                  type: 'button',
                  'data-testid': 'revoke-token',
                  onclick: async () => {
                    try {
                      await auth('DELETE', `/tokens/${t.id}`);
                      tokens = tokens.filter((x) => x.id !== t.id);
                      draw();
                      toast('Token revoked');
                    } catch (err) {
                      toast(err.message, true);
                    }
                  },
                }, 'Revoke')),
              ),
            ),
          ),
    );

  const tokenName = h('input', { class: 'gm-input', type: 'text', id: 'token-name', value: 'cli', placeholder: 'laptop, CI, …' });
  const mint = h('button', {
    class: 'gm-btn gm-btn-primary',
    type: 'button',
    'data-testid': 'mint-token',
    onclick: async () => {
      try {
        const r = await auth('POST', '/tokens', { name: tokenName.value.trim() || 'cli' });
        tokens.unshift({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.createdAt, lastUsedAt: null });
        draw();
        minted.replaceChildren(
          h('div', { class: 'gm-banner', 'data-testid': 'minted' },
            h('b', {}, 'Copy it now. '), 'This token will not be shown again.',
            h('div', { class: 'gm-copy' },
              h('code', { 'data-testid': 'minted-token' }, r.token),
              h('button', { class: 'gm-btn gm-btn-sm', type: 'button', onclick: () => navigator.clipboard?.writeText(r.token).then(() => toast('Copied')) }, 'Copy'),
            ),
          ),
        );
      } catch (err) {
        toast(err.message, true);
      }
    },
  }, 'Create token');

  container.replaceChildren(
    h('div', { class: 'gm-page', 'data-testid': 'account-page' },
      h('p', { class: 'gm-eyebrow' }, 'Account'),
      h('h1', { class: 'gm-h1' }, 'Account & API tokens'),
      h('p', { class: 'gm-muted', style: 'margin:8px 0 24px' }, shell.platform
        ? 'One account for every GraphMind product. Settings here apply to Circuit and Jack alike.'
        : 'Your account on this server.'),

      h('section', { class: 'gm-panel' },
        h('div', { class: 'gm-profile' },
          h('span', { class: 'gm-avatar gm-avatar-lg', 'aria-hidden': 'true' }, initial(user)),
          h('div', {}, h('b', { 'data-testid': 'account-name' }, user.name || user.email), h('span', { class: 'gm-muted gm-small' }, user.email, ' · member since ', new Date(user.createdAt).toLocaleDateString())),
        ),
      ),

      h('section', { class: 'gm-panel' },
        h('div', { class: 'gm-section-head' }, h('h2', { class: 'gm-h2' }, 'Plan'), h('span', { class: 'gm-pill gm-pill-accent' }, 'Early access · free')),
        h('p', { class: 'gm-muted gm-small', style: 'margin:6px 0 0' }, 'Everything is included and there is nothing to choose or pay. When plans arrive they will apply to the hosted services only, and you will hear first.'),
      ),

      h('section', { class: 'gm-panel' },
        h('h2', { class: 'gm-h2' }, 'API tokens'),
        h('p', { class: 'gm-muted gm-small', style: 'margin:0' }, 'A personal token lets a CLI or script act as you. It is shown once, works until you revoke it, and can only be created or revoked here.'),
        h('div', { class: 'gm-stack gm-small', style: 'margin-top:12px' },
          showJack ? h('div', { class: 'gm-copy' }, h('code', {}, `jack deploy --server ${jackUrl} --api-key gmt_…`)) : '',
          showCircuit ? h('div', { class: 'gm-copy' }, h('code', {}, `circuit mcp serve --api ${circuitUrl} --api-key gmt_…`)) : '',
        ),
        h('div', { style: 'margin-top:14px' }, list),
        h('div', { class: 'gm-row', style: 'margin-top:14px; align-items:flex-end' },
          h('div', { class: 'gm-grow' }, h('label', { class: 'gm-label', for: 'token-name', style: 'margin-top:0' }, 'New token name'), tokenName),
          mint,
        ),
        minted,
      ),

      h('section', { class: 'gm-panel' },
        h('div', { class: 'gm-section-head' },
          h('div', {}, h('h2', { class: 'gm-h2' }, 'Sign out'), h('p', { class: 'gm-muted gm-small', style: 'margin:0' }, 'Ends this browser session. API tokens keep working until revoked.')),
          h('button', { class: 'gm-btn gm-btn-danger', type: 'button', 'data-testid': 'sign-out', onclick: () => shell.signOut() }, 'Sign out'),
        ),
      ),
    ),
  );

  try {
    tokens = (await auth('GET', '/tokens')).tokens;
    draw();
  } catch (err) {
    list.replaceChildren(h('p', { class: 'gm-auth-status' }, err.message));
  }
}
