#!/usr/bin/env node
/**
 * Record the homepage's demo clips and screenshots from the real products.
 *
 *   pnpm media                     (from the repo root; builds first)
 *   node apps/platform/scripts/capture-media.mjs [--only debugger,jack] [--out apps/web/media]
 *
 * Nothing here is mocked: the debugger clips drive the built viewer that
 * `npx graphmind-ai` serves (its in-browser fixture run, the same one as
 * graphmind.ai/try), and the Circuit, Jack and hub clips drive the platform
 * with the Circuit onboarding workflows and the Acme Tasks API spec. Every run
 * uses throwaway data in a temp directory; your ~/.graphmind is never touched.
 *
 * Output (apps/web/media):
 *   <scene>.webm   VP8, 1280×800, 25 fps, loops cleanly (ends on a held frame)
 *   <scene>.webp   the poster: the frame that tells the scene's story
 *   <still>.webp   screenshots
 *
 * How: the page's own compositor frames (CDP screencast, JPEG q92) are
 * resampled to a constant frame rate and encoded with the ffmpeg that ships
 * with Playwright (VP8 only, which is why the clips are WebM). A small cursor
 * with click ripples is drawn into the page so a viewer can follow the clicks.
 * Posters go through cwebp when it is installed, else stay JPEG.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { loadWorkflows } from '@graphmind-ai/circuit-cli';
import { createApi as createCircuit, startEngineLoop } from 'circuit-api';
import { createJack, SqliteStore as JackStore } from 'jack-api';
import { createPlatform } from '../dist/index.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({ options: { only: { type: 'string' }, out: { type: 'string' } } });
const OUT = resolve(values.out ?? join(repo, 'apps', 'web', 'media'));
const ONLY = values.only ? new Set(values.only.split(',')) : null;
const want = (name) => ONLY === null || ONLY.has(name);
const W = 1280;
const H = 800;
const FPS = 25;
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'gm-media-'));

// ---------------------------------------------------------------- tools --
function findFfmpeg() {
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, root, join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const d of readdirSync(r).filter((n) => n.startsWith('ffmpeg')).sort().reverse()) {
      for (const bin of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe']) if (existsSync(join(r, d, bin))) return join(r, d, bin);
    }
  }
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.trim();
  throw new Error('no ffmpeg: run `npx playwright install ffmpeg`');
}
const FFMPEG = findFfmpeg();
const CWEBP = spawnSync('which', ['cwebp'], { encoding: 'utf8' }).stdout.trim() || null;

const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStill(jpeg, name) {
  const jpg = join(tmp, `${name}.jpg`);
  writeFileSync(jpg, jpeg);
  if (CWEBP) {
    const r = spawnSync(CWEBP, ['-quiet', '-q', '84', '-m', '6', jpg, '-o', join(OUT, `${name}.webp`)]);
    if (r.status === 0) return `${name}.webp`;
  }
  writeFileSync(join(OUT, `${name}.jpg`), jpeg);
  return `${name}.jpg`;
}

// ------------------------------------------------------------- recorder --
class Recorder {
  constructor(page) {
    this.page = page;
    this.frames = [];
    this.posterFrame = null;
  }
  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      this.frames.push({ t: metadata.timestamp, buf: Buffer.from(data, 'base64') });
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    this.t0 = null;
  }
  /** Everything before this moment is cut (page loads, sign-in). */
  mark() {
    this.t0 = this.frames.at(-1)?.t ?? null;
  }
  poster() {
    this.posterFrame = this.frames.at(-1)?.buf ?? null;
  }
  async stop(name, { hold = 1.6 } = {}) {
    await sleep(400);
    await this.cdp.send('Page.stopScreencast');
    const frames = this.frames.filter((f) => this.t0 === null || f.t >= this.t0);
    if (frames.length === 0) throw new Error(`${name}: no frames`);
    const start = frames[0].t;
    const end = frames.at(-1).t + hold;
    // Resample to a constant rate into one concatenated MJPEG stream on disk
    // (Playwright's ffmpeg build has no pipe protocol), then encode it.
    const mjpeg = join(tmp, `${name}.mjpeg`);
    const chunks = [];
    let i = 0;
    for (let t = start; t <= end; t += 1 / FPS) {
      while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
      chunks.push(frames[i].buf);
    }
    writeFileSync(mjpeg, Buffer.concat(chunks));
    const ff = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', mjpeg,
      '-vf', `scale=${W}:${H}`,
      '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-crf', '8', '-b:v', '2400k', '-qmin', '2', '-qmax', '36',
      '-deadline', 'good', '-cpu-used', '0', '-g', String(FPS * 4), '-an',
      join(OUT, `${name}.webm`),
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (ff.status !== 0) throw new Error(`${name}: ffmpeg exited ${ff.status}`);
    rmSync(mjpeg);
    const poster = writeStill(this.posterFrame ?? frames.at(-1).buf, name);
    const kb = Math.round(statSync(join(OUT, `${name}.webm`)).size / 1024);
    console.log(`  ${name}.webm  ${(end - start).toFixed(1)}s  ${kb} KB   poster ${poster}`);
  }
}

// --------------------------------------------------------------- cursor --
const CURSOR = () => {
  const install = () => {
    if (document.getElementById('__gm_cursor')) return;
    const c = document.createElement('div');
    c.id = '__gm_cursor';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-60px,-60px)' });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.6 12.6 Z');
    p.setAttribute('fill', '#ffffff');
    p.setAttribute('stroke', '#0a0a0c');
    p.setAttribute('stroke-width', '1.4');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    c.append(svg);
    document.documentElement.append(c);
    const at = (window.__gmCursorAt ??= { x: -60, y: -60 });
    c.style.transform = `translate(${at.x - 3}px, ${at.y - 2}px)`;
    addEventListener('mousemove', (e) => {
      at.x = e.clientX;
      at.y = e.clientY;
      c.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
    }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: '36px', height: '36px', borderRadius: '50%', border: '2px solid #4ade80', background: 'rgba(74,222,128,.18)', zIndex: '2147483646', pointerEvents: 'none' });
      document.documentElement.append(r);
      r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => r.remove();
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
};

/** Human pacing: an eased glide to the target, a beat, a click. */
function actor(page) {
  let x = W / 2;
  let y = H / 2;
  const glide = async (tx, ty, ms = 340) => {
    const n = Math.max(8, Math.round(ms / 16));
    const sx = x;
    const sy = y;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await page.mouse.move(sx + (tx - sx) * e, sy + (ty - sy) * e);
      await sleep(16);
    }
    x = tx;
    y = ty;
  };
  const center = async (target) => {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 20_000 });
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    return { x: b.x + Math.min(b.width / 2, 60), y: b.y + b.height / 2, loc };
  };
  return {
    page,
    async to(target, ms) {
      const c = await center(target);
      await glide(c.x, c.y, ms);
    },
    async click(target, { before = 90, after = 220 } = {}) {
      const c = await center(target);
      await glide(c.x, c.y);
      await sleep(before);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(after);
    },
    async type(target, text, { clear = true, delay = 12 } = {}) {
      await this.click(target, { after: 120 });
      if (clear) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(text, { delay });
      await sleep(160);
    },
    async park() {
      await page.mouse.move(x, y); // re-draw the cursor after a navigation
    },
    wait: sleep,
  };
}

/** Stills are of the product, not of our cursor. */
const hideCursor = (page) => page.evaluate(() => document.getElementById('__gm_cursor')?.remove());

async function newPage(browser, { storageState } = {}) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark', bypassCSP: true, ...(storageState ? { storageState } : {}) });
  await context.addInitScript(CURSOR);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('graphmind.connectSeen', '1');
    } catch {}
  });
  const page = await context.newPage();
  return { context, page, me: actor(page) };
}

// ------------------------------------------------------------- servers --
async function startDebugger() {
  const port = await freePort();
  const home = join(tmp, 'graphmind-home');
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [join(repo, 'packages', 'cli', 'dist', 'cli.js'), 'serve', '--no-open', '--port', String(port), '--db', join(tmp, 'graphmind.db')], {
    env: { ...process.env, GRAPHMIND_HOME: home, GRAPHMIND_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let token;
  for (let i = 0; i < 100 && !token; i++) {
    await sleep(100);
    const run = join(home, 'run');
    if (!existsSync(run)) continue;
    for (const f of readdirSync(run)) token ??= /#token=([A-Za-z0-9_.-]+)/.exec(readFileSync(join(run, f), 'utf8'))?.[1];
  }
  if (!token) throw new Error('the debugger did not start (is the viewer built? pnpm build:viewer)');
  return { base, token, stop: () => child.kill() };
}

async function startPlatform() {
  let handler;
  const server = await new Promise((r) => {
    const s = serve({ fetch: (q) => handler(q), port: 0, hostname: '127.0.0.1' }, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const accounts = createAccounts({ store: new SqliteAccountStore(join(tmp, 'accounts.db')), publicOrigin: base });
  const defs = await loadWorkflows(join(repo, 'examples', 'circuit-onboarding', 'workflows.mjs'));
  const journal = new SqliteJournalStore(join(tmp, 'circuit.db'));
  const executor = new Executor({ store: journal, workflows: defs });
  const loop = startEngineLoop(executor);
  const circuit = createCircuit({ executor, store: journal, workflows: () => defs, onWork: loop.kick, accounts });
  const jack = createJack({ store: new JackStore(join(tmp, 'jack.db')), accounts, publicOrigin: base, dataDir: join(tmp, 'jack'), secretKey: randomBytes(32), egress: 'any', dashboardPath: '/app/jack/' });
  handler = createPlatform({ accounts, circuit, jack, site: join(repo, 'apps', 'web') }).fetch;
  // One account for every platform scene, signed in through the real endpoint.
  const res = await fetch(`${base}/app/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'ada@acme.dev', password: 'correct-horse-battery', name: 'Ada Lovelace' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const [name, value] = cookie.split('=');
  const storageState = { cookies: [{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }], origins: [] };
  return {
    base,
    storageState,
    stop: async () => {
      loop.stop();
      await jack.close();
      server.close();
    },
  };
}

// --------------------------------------------------------------- scenes --
/** Debugger: the graph lights up live, pauses on a failing tool, a fix is injected, the run finishes. */
async function sceneDebugger(browser, dbg) {
  const { context, page, me } = await newPage(browser);
  const rec = new Recorder(page);
  await rec.start();
  await page.goto(`${dbg.base}/?fixture=1`);
  rec.mark();
  await me.park();
  await page.getByText(/paused on error/i).first().waitFor({ timeout: 30_000 });
  await me.wait(900);
  await me.to(page.locator('.react-flow__node', { hasText: 'currencyConvert' }).first(), 700);
  await me.wait(700);
  rec.poster();
  await me.click(page.locator('.react-flow__node', { hasText: 'currencyConvert' }).getByRole('button', { name: /Inject/ }).first());
  const editor = page.getByLabel(/Replacement output/i);
  await editor.waitFor();
  await me.wait(500);
  await me.type(editor, '{ "result": 1489.70, "to": "USD" }', { delay: 20 });
  await me.wait(300);
  await me.click(page.getByRole('button', { name: /Inject & resume/i }));
  const node = page.locator('.react-flow__node', { hasText: 'currencyConvert' }).first();
  await node.getByText(/^done$/i).waitFor({ timeout: 15_000 });
  await me.wait(2200); // the agent carries on; hold on the graph, then loop
  await rec.stop('debugger');
  await context.close();
}

/** The Behaviour verdict and the run's totals, as a still. */
async function stillBehaviour(browser, dbg) {
  const { context, page } = await newPage(browser);
  await page.goto(`${dbg.base}/?fixture=1`);
  await page.getByText(/paused on error/i).first().waitFor({ timeout: 30_000 });
  await page.keyboard.press('c'); // continue past the error: a run with one honest failure in it
  await page.waitForTimeout(6000);
  const strip = page.getByRole('button', { name: /Behaviour/ }).first();
  if (await strip.count()) await strip.click();
  await page.waitForTimeout(800);
  await hideCursor(page);
  writeStill(await page.screenshot({ type: 'jpeg', quality: 92 }), 'behaviour');
  console.log('  behaviour still');
  await context.close();
}

/** Build a workflow: add an MCP server and a sub-agent on the canvas, then read the code it becomes. */
async function sceneBuilder(browser, dbg) {
  const { context, page, me } = await newPage(browser);
  const rec = new Recorder(page);
  await rec.start();
  await page.goto(`${dbg.base}/#token=${dbg.token}`);
  await page.waitForTimeout(800);
  await page.goto(`${dbg.base}/#/build`);
  await page.locator('.gm-bnode').first().waitFor();
  await page.waitForTimeout(500);
  rec.mark();
  await me.park();
  await me.wait(600);
  await me.click(page.getByRole('button', { name: /^\+?\s*MCP server$/ }));
  await me.type(page.getByLabel('MCP server name'), 'filesystem', { delay: 45 });
  await me.wait(500);
  await me.click(page.getByRole('button', { name: /^\+?\s*Sub-agent$/ }));
  await me.type(page.getByLabel('Sub-agent name'), 'researcher', { delay: 45 });
  await me.type(page.locator('.gm-builder-railbody textarea').first(), 'Look things up and summarise.', { delay: 16 });
  await me.wait(200);
  // Zoom the canvas out so the whole graph is in frame.
  await me.to(page.locator('.react-flow__pane').first(), 500);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 90);
    await me.wait(160);
  }
  await me.wait(900);
  rec.poster();
  await me.click(page.locator('button, [role=tab]', { hasText: /^Code/ }).first());
  await me.wait(1200);
  const code = page.locator('pre, .gm-code, code').last();
  if (await code.count()) {
    await me.to(code, 600);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 200);
      await me.wait(200);
    }
  }
  await me.wait(1200);
  await rec.stop('builder');
  await context.close();
}

/** Circuit: a run pauses on a failing step, gets an injected fix, an approval, an event, and completes. */
async function sceneCircuit(browser, plat) {
  const { context, page, me } = await newPage(browser, { storageState: plat.storageState });
  const rec = new Recorder(page);
  await rec.start();
  await page.goto(`${plat.base}/app/circuit/`);
  await page.getByText(/connected/).waitFor();
  await page.waitForTimeout(400);
  rec.mark();
  await me.park();
  await me.wait(500);
  await me.click(page.getByRole('button', { name: 'New run' }));
  await me.wait(300);
  await page.selectOption('#nr-wf', 'triage-invoice');
  await me.wait(700);
  await me.click(page.getByRole('button', { name: 'Start run' }));
  await page.getByText('This step failed — fix it and resume').waitFor({ timeout: 10_000 });
  await me.wait(900);
  rec.poster();
  await me.click(page.locator('.tabs').getByRole('button', { name: 'Inject result' }));
  await me.type(page.locator('#fix-json'), '{"invoiceId":"flaky-big-001","amount":25000}', { delay: 10 });
  await me.type(page.locator('#fix-reason'), 'ERP down; amount from the PDF', { delay: 22 });
  await me.click(page.locator('.fix-panel').getByRole('button', { name: 'Inject result' }).last());
  await page.getByText('Approval requested').waitFor({ timeout: 10_000 });
  await me.wait(900);
  await me.click(page.getByRole('button', { name: 'Approve' }));
  await page.locator('.node', { hasText: 'payment' }).getByText('waiting for "payment.settled"').waitFor({ timeout: 10_000 });
  await me.wait(1800);
  await rec.stop('circuit');
  await context.close();
}

/** Jack: an OpenAPI spec in, a curated set of tools, deployed to an MCP URL. */
async function sceneJack(browser, plat) {
  const spec = readFileSync(join(repo, 'examples', 'jack-tasks', 'openapi.json'), 'utf8');
  const { context, page, me } = await newPage(browser, { storageState: plat.storageState });
  const rec = new Recorder(page);
  await rec.start();
  await page.goto(`${plat.base}/app/jack/`);
  await page.locator('[data-testid=start]').waitFor();
  await page.waitForTimeout(400);
  rec.mark();
  await me.park();
  await me.wait(500);
  await me.click('[data-testid=start]');
  await me.click('#spec-text', { after: 120 });
  await page.fill('#spec-text', spec); // pasted
  await page.fill('#spec-upstream', 'https://api.acme-tasks.dev');
  await me.click('#analyze');
  await page.locator('[data-testid=import-preview]').waitFor();
  await me.wait(700);
  await me.to('#create-project', 600);
  await page.fill('#project-slug', 'acme-tasks');
  await me.click('#create-project');
  await page.locator('[data-testid=tool-count]').waitFor();
  await me.wait(900);
  await me.click(page.locator('[data-testid=toggle-create_task] + span'));
  await me.wait(500);
  rec.poster();
  await me.click('[data-tab=deploy]');
  await me.type('[data-testid=deploy-message]', 'first version', { delay: 28 });
  await me.click('[data-testid=deploy]');
  await page.locator('[data-testid=live-version]').waitFor();
  await me.wait(500);
  const cmd = page.locator('[data-testid=claude-cmd]');
  if (await cmd.count()) await me.to(cmd, 700);
  await me.wait(1800);
  await rec.stop('jack');
  await context.close();
}

/** The hub: one account, every product. */
async function stillHub(browser, plat) {
  const { context, page } = await newPage(browser, { storageState: plat.storageState });
  await page.goto(`${plat.base}/app/`);
  await page.locator('[data-testid=open-circuit]').waitFor();
  await page.waitForTimeout(400);
  await hideCursor(page);
  writeStill(await page.screenshot({ type: 'jpeg', quality: 92 }), 'hub');
  await page.goto(`${plat.base}/app/#/account`);
  await page.locator('[data-testid=mint-token]').waitFor();
  await page.waitForTimeout(400);
  await hideCursor(page);
  writeStill(await page.screenshot({ type: 'jpeg', quality: 92 }), 'account');
  console.log('  hub + account stills');
  await context.close();
}

// ----------------------------------------------------------------- main --
const browser = await chromium.launch();
let dbg;
let plat;
try {
  console.log(`capture-media → ${OUT}  (ffmpeg: ${FFMPEG}${CWEBP ? ', cwebp' : ''})`);
  if (want('debugger') || want('builder') || want('behaviour')) dbg = await startDebugger();
  if (want('circuit') || want('jack') || want('hub')) plat = await startPlatform();
  if (want('debugger')) await sceneDebugger(browser, dbg);
  if (want('behaviour')) await stillBehaviour(browser, dbg);
  if (want('builder')) await sceneBuilder(browser, dbg);
  if (want('circuit')) await sceneCircuit(browser, plat);
  if (want('jack')) await sceneJack(browser, plat);
  if (want('hub')) await stillHub(browser, plat);
} finally {
  await browser.close();
  dbg?.stop();
  await plat?.stop();
  rmSync(tmp, { recursive: true, force: true });
}
