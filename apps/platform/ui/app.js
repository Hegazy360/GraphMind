// The GraphMind hub: sign in once, then open Circuit and Jack. The bar, the
// sign-in and the account page are the shared shell (./gm/shell.js), the same
// component every dashboard uses; this file only routes and draws the
// products page.
import { h, renderAccount, renderAuth, renderReset, startShell, toast } from './gm/shell.js';

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

/** `#/signin?notice=confirmed`: why an email link brought the visitor back (a key into fixed messages). */
function noticeParam() {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get('notice') ?? undefined : undefined;
}

const SKILLS_COMMAND = 'npx graphmind-ai skill all --install';

/** "Using Claude Code?": the Agent Skills, and the token that lets Claude Code drive Circuit and Jack. */
function claudeCodeCard() {
  return h('section', { class: 'hub-card quiet hub-skills', 'data-testid': 'claude-code-card' },
    h('div', {}, h('span', { class: 'gm-pill' }, 'Claude Code'), h('span', { class: 'hub-kind' }, 'Agent Skills')),
    h('h2', {}, 'Using Claude Code?'),
    h('p', {}, 'Install the GraphMind skills and Claude Code knows how to debug your agent runs, build and fix Circuit workflows, and set up Jack, and acts on the Insights recommendations.'),
    h('div', { class: 'gm-copy' },
      h('code', { 'data-testid': 'skills-command' }, SKILLS_COMMAND),
      h('button', { class: 'gm-btn gm-btn-sm', type: 'button', 'data-testid': 'copy-skills', onclick: () => navigator.clipboard?.writeText(SKILLS_COMMAND).then(() => toast('Copied'), () => {}) }, 'Copy'),
    ),
    h('p', {}, 'It writes the skills into ', h('code', { class: 'gm-code' }, '.claude/skills/'), '. With a personal token from your ',
      h('a', { href: '#/account' }, 'Account page'), ' in ', h('code', { class: 'gm-code' }, 'GRAPHMIND_TOKEN'), ', Claude Code can drive Circuit and Jack for you.'),
    h('div', { class: 'hub-links' },
      h('a', { class: 'hub-go', href: 'circuit/#/insights', 'data-testid': 'circuit-insights' }, 'Circuit insights →'),
      h('a', { class: 'hub-go', href: 'jack/', 'data-testid': 'jack-insights' }, 'Jack insights (per project) →'),
    ),
  );
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
          h('p', { class: 'hub-note' }, 'Insights: what to change in each workflow, from its recent runs.'),
          h('span', { class: 'hub-go' }, 'Open Circuit →'),
        ),
        h('a', { class: 'hub-card', href: 'jack/', 'data-testid': 'open-jack' },
          h('div', {}, h('span', { class: 'gm-pill gm-pill-accent' }, 'Jack'), h('span', { class: 'hub-kind' }, 'Your API as an MCP server')),
          h('h2', {}, 'Point it at the API you already have.'),
          h('p', {}, 'Import an OpenAPI document, choose and describe the tools, pick how your users sign in, deploy, and hand Claude or Cursor the URL.'),
          h('p', { class: 'hub-note' }, "Insights, per project: which tools keep failing, and what to change."),
          h('span', { class: 'hub-go' }, 'Open Jack →'),
        ),
        h('div', { class: 'hub-card quiet' },
          h('div', {}, h('span', { class: 'gm-pill' }, 'Debugger'), h('span', { class: 'hub-kind' }, 'Local, no account')),
          h('h2', {}, 'The live debugger for AI agents.'),
          h('p', {}, 'Runs on your machine: ', h('code', { class: 'gm-code' }, 'npx graphmind-ai demo'), '. Pause on error, inspect, edit and inject, replay as a test, build a workflow on the canvas.'),
          h('a', { class: 'hub-go', href: 'https://graphmind.ai/docs/start/install/' }, 'Install guide →'),
        ),
      ),
      claudeCodeCard(),
    ),
  );
}

function route() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  shell.renderBar();
  if (!shell.user) {
    const firstVisitor = shell.server.signup && shell.server.users === 0;
    const mode = path === '/recover' ? 'recover' : path === '/signup' || (path === '/' && firstVisitor) ? 'signup' : 'signin';
    return renderAuth(main, shell, {
      mode,
      notice: noticeParam(),
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
  if (path === '/reset') {
    // A reset link signed the visitor in (the server exchanged its code); now the new password.
    return renderReset(main, shell, { onDone: () => { location.hash = '#/'; } });
  }
  if (path === '/recover') history.replaceState(null, '', '#/');
  if (path === '/account') return renderAccount(main, shell);
  return renderHome();
}

window.addEventListener('hashchange', route);
route();
