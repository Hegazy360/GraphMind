// Unit tests for home.js's sign-in awareness: the homepage asks /app/auth/me
// and, only when signed in, swaps the bar's "Sign in" / "Start free" for
// "Open app" and reveals the Claude Code skills. Signed out, or any failure,
// it changes nothing and logs nothing. home.js runs in a vm with a stub DOM.
// Run: node --test test/home-signin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../home.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function element(id) {
  const classes = new Set();
  return {
    id,
    hidden: false,
    textContent: '',
    style: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    classes,
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    appendChild() {},
    querySelector: () => null,
    contains: () => false,
  };
}

/** Run home.js against a page holding the elements the sign-in code touches, hidden as index.html serves them. */
function load(fetchImpl) {
  return loadWith([], fetchImpl);
}

function loadWith(links, fetchImpl) {
  const els = {};
  for (const id of ['nav-signin', 'nav-start', 'nav-app', 'signed-in', 'top']) els[id] = element(id);
  els['nav-app'].hidden = true;
  els['signed-in'].hidden = true;
  const root = element('html');
  const errors = [];
  const document = {
    documentElement: root,
    getElementById: (id) => els[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'a[href^="/signup"]' ? links : []),
    addEventListener() {},
  };
  const window = {
    matchMedia: () => ({ matches: true }), // reduced motion: skips the demo and GSAP
    addEventListener() {},
    innerWidth: 400,
    scrollY: 0,
    location: { origin: 'https://graphmind.ai' },
    fetch: fetchImpl,
  };
  const context = {
    window,
    document,
    navigator: {},
    location: window.location,
    sessionStorage: { getItem: () => 'k3j9x2m7q1', setItem() {} },
    Blob: class {},
    setTimeout,
    console: { error: (...a) => errors.push(a), warn: (...a) => errors.push(a), log() {} },
    fetch: fetchImpl,
  };
  vm.runInNewContext(source, context);
  return { els, root, errors, ready: window.__gmSignedIn };
}

const reply = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });

/** A stub link whose attributes are real, for the sign-up CTAs. */
function link(href, text) {
  const attrs = { href };
  return { textContent: text, getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; }, attrs };
}

test('signed in: every sign-up call to action opens the app instead (products go straight to theirs)', async () => {
  const hero = link('/signup', 'Start free');
  const circuit = link('/signup?start=circuit', 'Open Circuit with a free account');
  const jack = link('/signup?start=jack', 'Open Jack with a free account');
  const { els, ready } = loadWith([hero, circuit, jack], reply(200, { user: { email: 'a@b.c' } }));
  assert.equal(await ready, true);
  assert.deepEqual([hero.attrs.href, hero.textContent], ['/app/', 'Open app']);
  assert.deepEqual([circuit.attrs.href, circuit.textContent], ['/app/circuit/', 'Open Circuit']);
  assert.deepEqual([jack.attrs.href, jack.textContent], ['/app/jack/', 'Open Jack']);
  assert.equal(els['nav-start'].hidden, true);
});

test('signed out: the sign-up calls to action are untouched', async () => {
  const hero = link('/signup', 'Start free');
  const { ready } = loadWith([hero], reply(401, {}));
  assert.equal(await ready, false);
  assert.deepEqual([hero.attrs.href, hero.textContent], ['/signup', 'Start free']);
});

test('signed in: "Open app" replaces Sign in / Start free, and the skills section appears', async () => {
  const calls = [];
  const { els, root, errors, ready } = load(async (url, init) => {
    if (url === '/api/events') return { status: 204, ok: true, json: async () => ({}) }; // the home-view funnel event
    calls.push({ url, init });
    return reply(200, { user: { id: 'usr_1', email: 'ada@example.com', name: 'Ada' }, via: 'session' })();
  });
  assert.equal(await ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/app/auth/me');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(els['nav-signin'].hidden, true);
  assert.equal(els['nav-start'].hidden, true);
  assert.equal(els['nav-app'].hidden, false);
  assert.equal(els['signed-in'].hidden, false);
  assert.ok(root.classes.has('is-signed-in'));
  assert.deepEqual(errors, []);
});

test('signed out (401), a bad body, a network error, or no fetch at all: nothing changes', async () => {
  const cases = [
    reply(401, { type: 'about:blank', title: 'Unauthorized' }),
    reply(200, {}), // no user in the answer
    reply(500, { user: { id: 'x' } }),
    async () => ({ status: 200, json: async () => { throw new SyntaxError('not JSON'); } }),
    async () => { throw new TypeError('Failed to fetch'); },
    () => { throw new Error('sync throw'); },
    undefined,
  ];
  for (const fetchImpl of cases) {
    const { els, root, errors, ready } = load(fetchImpl);
    assert.equal(await ready, false);
    assert.equal(els['nav-signin'].hidden, false);
    assert.equal(els['nav-start'].hidden, false);
    assert.equal(els['nav-app'].hidden, true);
    assert.equal(els['signed-in'].hidden, true);
    assert.ok(!root.classes.has('is-signed-in'));
    assert.deepEqual(errors, []);
  }
});

test('index.html serves the signed-out page: the signed-in parts start hidden, the funnel labels are tracked', () => {
  assert.match(html, /<a [^>]*id="nav-app"[^>]*href="\/app\/"[^>]*data-track="cta-click"[^>]*hidden>Open app<\/a>/);
  assert.match(html, /<section class="signed-in" id="signed-in"[^>]*hidden>/);
  assert.match(html, /<code id="skills-cmd">npx graphmind-ai skill all --install<\/code>/);
  assert.match(html, /id="skills-copy"/);
  assert.match(html, /href="\/app\/circuit\/#\/insights"/);
  assert.match(html, /GRAPHMIND_TOKEN/);
  // Every funnel label is word-shaped, as /api/events requires.
  for (const [, where] of html.matchAll(/data-where="([^"]+)"/g)) assert.match(where, /^[a-z][a-z0-9-]{0,31}$/);
});
