// The GraphMind hub: sign in once, then open Circuit and Jack. The bar, the
// sign-in and the account page are the shared shell (./gm/shell.js), the same
// component every dashboard uses; this file only routes and draws the
// products page.
import { h, renderAccount, renderAuth, startShell } from './gm/shell.js';

const main = document.getElementById('main');
const shell = await startShell({ product: 'hub' });

/** `#/signin?next=<url>`: a dashboard sent the visitor here to sign in; go back afterwards (same origin only). */
function nextUrl() {
  const q = location.hash.split('?')[1];
  const next = q ? new URLSearchParams(q).get('next') : null;
  if (!next) return null;
  try {
    const u = new URL(next, location.href);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}

function renderHome() {
  const user = shell.user;
  main.replaceChildren(
    h('section', { class: 'hub' },
      h('p', { class: 'gm-eyebrow' }, 'Your GraphMind'),
      h('h1', { class: 'gm-h1' }, `Hello, ${user.name || user.email}.`),
      h('p', { class: 'hub-lede' }, 'Everything below is yours to use under this one account. The debugger stays on your machine and needs no account at all.'),
      h('div', { class: 'hub-grid' },
        h('a', { class: 'hub-card', href: 'circuit/', 'data-testid': 'open-circuit' },
          h('div', {}, h('span', { class: 'gm-pill gm-pill-accent' }, 'Circuit'), h('span', { class: 'hub-kind' }, 'Durable workflows')),
          h('h2', {}, 'Workflows as code, with a flight recorder.'),
          h('p', {}, 'Start a run, watch it pause on a failing step, fix it and resume. Fork a what-if, check a deploy against in-flight runs, call MCP servers from steps.'),
          h('span', { class: 'hub-go' }, 'Open Circuit →'),
        ),
        h('a', { class: 'hub-card', href: 'jack/', 'data-testid': 'open-jack' },
          h('div', {}, h('span', { class: 'gm-pill gm-pill-accent' }, 'Jack'), h('span', { class: 'hub-kind' }, 'Your API as an MCP server')),
          h('h2', {}, 'Point it at the API you already have.'),
          h('p', {}, 'Import an OpenAPI document, choose and describe the tools, pick how your users sign in, deploy, and hand Claude or Cursor the URL.'),
          h('span', { class: 'hub-go' }, 'Open Jack →'),
        ),
        h('div', { class: 'hub-card quiet' },
          h('div', {}, h('span', { class: 'gm-pill' }, 'Debugger'), h('span', { class: 'hub-kind' }, 'Local, no account')),
          h('h2', {}, 'The live debugger for AI agents.'),
          h('p', {}, 'Runs on your machine: ', h('code', { class: 'gm-code' }, 'npx graphmind-ai demo'), '. Pause on error, inspect, edit and inject, replay as a test, build a workflow on the canvas.'),
          h('a', { class: 'hub-go', href: 'https://graphmind.ai/docs/start/install/' }, 'Install guide →'),
        ),
      ),
    ),
  );
}

function route() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  shell.renderBar();
  if (!shell.user) {
    const firstVisitor = shell.server.signup && shell.server.users === 0;
    const mode = path === '/signup' || (path === '/' && firstVisitor) ? 'signup' : 'signin';
    return renderAuth(main, shell, {
      mode,
      onSignedIn: (user) => {
        shell.user = user;
        const next = nextUrl();
        if (next) return location.assign(next);
        location.hash = '#/';
        route();
      },
    });
  }
  if (path === '/signin' || path === '/signup') {
    const next = nextUrl();
    if (next) return location.assign(next); // already signed in: straight back
    history.replaceState(null, '', '#/');
  }
  if (path === '/account') return renderAccount(main, shell);
  return renderHome();
}

window.addEventListener('hashchange', route);
route();
