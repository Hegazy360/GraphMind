/**
 * Edit tool arguments END TO END (0.6.0, contracts C2 + C3) — no fixtures.
 *
 * Everything else in this suite drives the viewer against a replay. This file
 * starts the real thing as child processes and drives it through the browser:
 *
 *   - `graphmind serve --no-open --port <free> --db <tmp> --allow-control=edit`
 *     from packages/cli/dist, serving the viewer bundle this suite just built
 *     (GRAPHMIND_VIEWER_DIST), with a private GRAPHMIND_HOME;
 *   - a real agent (examples/e2e/src/edit-agent.mjs): @graphmind-ai/sdk around
 *     a MockLanguageModelV4 from `ai/test`, whose tool call carries a bad
 *     argument (`to: "XYZ"`) that makes the real tool throw; the server's
 *     default `{point:'error'}` breakpoint holds it at an editable error gate;
 *   - the viewer opened the way `graphmind serve` opens it: the private
 *     redirect file `$GRAPHMIND_HOME/run/open-<port>.html`, which lands on
 *     `/#token=<viewer token>` (W3).
 *
 * Proven here, in a real browser: the schema refusal for an invalid edit, a
 * valid edit that the tool really runs with, the agent finishing, the edited
 * pill with before/after and "resumed by viewer"; a tab without the token is
 * offered only continue / retry / abort (the server would refuse the rest)
 * and continue works; and first-writer-wins across tabs — the hub's own
 * "taken" said at once, in plain words, both on the card of a tab that
 * clicked Continue and in the argument editor of a tab that sent an edit.
 *
 * Requires the workspace packages to be built (`pnpm -r --filter
 * './packages/**' run build`): the server is packages/cli/dist and the agent
 * imports @graphmind-ai/sdk's dist. Skipped locally when they are not; on CI
 * (viewer-e2e builds them) a missing build is a failure, not a skip.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, type ConsoleGuard } from './harness.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const SDK = join(REPO, 'packages', 'ai-sdk', 'dist', 'index.js');
const AGENT = join(REPO, 'examples', 'e2e', 'src', 'edit-agent.mjs');
const VIEWER_DIST = join(REPO, 'apps', 'viewer', 'dist');
const TOOL_NODE = 'tool:convertCurrency';

const built = existsSync(CLI) && existsSync(SDK);
test.skip(
  !built && process.env['CI'] === undefined,
  'needs the workspace packages built: pnpm -r --filter ./packages/** run build',
);

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GRAPHMIND')) env[key] = value;
  }
  return { ...env, GRAPHMIND_TELEMETRY: '0', DO_NOT_TRACK: '1', GRAPHMIND_RETENTION: 'off', ...extra };
}

interface Proc {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

function launch(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => out, exited };
}

interface Stack {
  port: number;
  home: string;
  server: Proc;
  /** The private redirect file `graphmind serve` opens the browser with. */
  opener: string;
  startAgent: (extra?: Record<string, string>) => Proc;
  /** Stored events of the (only) run, straight from the server. */
  events: () => Promise<{ type: string; payload: Record<string, any> }[]>;
  stop: () => Promise<void>;
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-edit-e2e-'));
  const home = join(dir, 'home');
  const port = await freePort();
  const server = launch(
    [CLI, 'serve', '--no-open', '--port', String(port), '--db', join(dir, 'g.db'), '--allow-control=edit'],
    childEnv({ GRAPHMIND_HOME: home, GRAPHMIND_VIEWER_DIST: VIEWER_DIST }),
  );
  const agents: Proc[] = [];
  const stop = async (): Promise<void> => {
    for (const agent of agents) agent.child.kill('SIGKILL');
    server.child.kill('SIGTERM');
    await Promise.race([server.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await expect.poll(() => server.out(), { timeout: 20_000, message: 'graphmind serve banner' }).toContain('Press Ctrl+C');
  } catch (error) {
    await stop();
    throw new Error(`graphmind serve did not start:\n${server.out()}\n${String(error)}`);
  }
  const opener = join(home, 'run', `open-${port}.html`);
  expect(existsSync(opener), 'the redirect file exists').toBe(true);
  return {
    port,
    home,
    server,
    opener,
    startAgent: (extra = {}) => {
      const agent = launch([AGENT], childEnv({ GRAPHMIND_URL: `ws://127.0.0.1:${port}/ingest`, ...extra }));
      agents.push(agent);
      return agent;
    },
    events: async () => {
      const runs = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()) as { runs: { id: string }[] };
      const runId = runs.runs[0]?.id;
      if (runId === undefined) return [];
      const page = (await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`)).json()) as {
        events: { type: string; payload: Record<string, any> }[];
      };
      return page.events;
    },
    stop,
  };
}

/** The harness guards the test's own page; a second tab gets the same guard. */
function guarded(page: Page, guard: ConsoleGuard): Page {
  page.on('console', (message) => {
    if (message.type() === 'error') guard.record(`console.error (${page.url()}): ${message.text()}`);
  });
  page.on('pageerror', (error) => guard.record(`pageerror (${page.url()}): ${error.message}`));
  return page;
}

/** Open the viewer through `graphmind serve`'s redirect file, as the CLI does. */
async function openWithToken(page: Page, stack: Stack): Promise<void> {
  await page.goto(pathToFileURL(stack.opener).href);
  await page.waitForURL(`http://127.0.0.1:${stack.port}/**`);
  await expect(page.locator('.gm-chip--control')).toHaveText('full control · agent: edit');
  // The token never stays in the address bar.
  expect(page.url()).not.toContain('token');
}

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Node inspector' });
}

function footer(page: Page) {
  return inspector(page).locator('footer.gm-inspect-held');
}

function editor(page: Page) {
  return page.getByRole('group', { name: 'Edit arguments for convertCurrency' });
}

function argsBox(page: Page) {
  return editor(page).getByRole('textbox', { name: 'Arguments for convertCurrency, as JSON' });
}

function banner(page: Page) {
  return page.locator(`.react-flow__node[data-id="${TOOL_NODE}"] .gm-pause-banner`);
}

async function waitForHeld(page: Page): Promise<void> {
  await expect(banner(page)).toBeVisible({ timeout: 30_000 });
  await expect(footer(page)).toBeVisible();
  // The inspector leads with why it failed (the footer's row does not repeat it).
  await expect(inspector(page)).toContainText('unknown currency code "XYZ"');
}

async function openEditor(page: Page): Promise<void> {
  await footer(page).getByRole('button', { name: 'Edit arguments…', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(argsBox(page)).toHaveValue(/"to": "XYZ"/);
}

async function draftWith(page: Page, patch: Record<string, unknown>): Promise<void> {
  const current = JSON.parse(await argsBox(page).inputValue()) as Record<string, unknown>;
  await argsBox(page).fill(JSON.stringify({ ...current, ...patch }, null, 2));
}

function agentResult(agent: Proc): { text: string; executedWith: { to: string }[] } | undefined {
  const line = agent.out().split('\n').find((l) => l.startsWith('EDIT_AGENT_RESULT '));
  return line === undefined ? undefined : (JSON.parse(line.slice('EDIT_AGENT_RESULT '.length)) as never);
}

let stack: Stack | undefined;
const extraContexts: BrowserContext[] = [];

test.afterEach(async ({ page }) => {
  // Pages first: a viewer whose server vanishes under it retries, and the
  // browser logs every failed socket as a console error.
  for (const context of extraContexts.splice(0)) await context.close();
  for (const other of page.context().pages()) await other.close();
  await stack?.stop();
  stack = undefined;
});

test('edit a real held tool call: schema refusal, valid retry, the tool runs it, the agent finishes', async ({ page }) => {
  stack = await startStack();
  await openWithToken(page, stack);
  const agent = stack.startAgent();

  await waitForHeld(page);
  await expect(page.locator('.gm-topbar-title .gm-pill').first()).toHaveText('paused');
  await openEditor(page);
  await expect(editor(page).getByTestId('edit-scope')).toHaveText(
    'This call only. The model still sees the arguments it asked for.',
  );

  // 1. An edit the tool's own schema refuses (three letters): the app says
  //    so, the gate stays held, the draft stays.
  await draftWith(page, { to: 'US dollars' });
  await expect(editor(page).getByTestId('edit-diff')).toContainText('1 change — only this key is sent');
  await editor(page).getByRole('button', { name: 'Retry with 1 change' }).click();
  await expect(editor(page).getByTestId('edit-refusal')).toHaveText(
    'The tool\'s schema rejected this: field "to" is too long (at most 3 characters)',
  );
  await expect(banner(page)).toBeVisible();
  await expect(argsBox(page)).toHaveValue(/"to": "US dollars"/);

  // 2. A valid edit: the REAL tool runs with it and the agent carries on.
  await draftWith(page, { to: 'USD' });
  await argsBox(page).press('ControlOrMeta+Enter');
  await expect(banner(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.gm-topbar-title .gm-pill').first()).toHaveText('done', { timeout: 20_000 });
  expect(await agent.exited).toBe(0);
  const result = agentResult(agent);
  expect(result?.executedWith.map((args) => args.to)).toEqual(['XYZ', 'USD']);
  expect(result?.text).toContain('"to":"USD"');
  expect(result?.text).toContain('"converted":109');

  // 3. The trail: the edited pill, before/after, and who resumed it.
  await expect(page.locator(`.react-flow__node[data-id="${TOOL_NODE}"] .gm-pill--edited`)).toHaveText('edited');
  const edited = inspector(page).getByTestId('edited-args');
  await expect(edited).toBeVisible();
  const rows = edited.getByTestId('edited-change');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('to');
  await expect(rows.first()).toContainText('"XYZ"');
  await expect(rows.first()).toContainText('"USD"');
  const resumedBy = inspector(page).getByTestId('resumed-by');
  await expect(resumedBy).toHaveCount(1);
  await expect(resumedBy).toContainText('error → retry (edited input) · resumed by viewer');

  // And the server's record agrees: stamped by the hub, not the app.
  const events = await stack.events();
  const refused = events.filter((e) => e.type === 'exec.refused');
  expect(refused).toHaveLength(1);
  expect(refused[0]?.payload).toMatchObject({ code: 'schema' });
  const resumed = events.filter((e) => e.type === 'exec.resumed');
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.payload).toMatchObject({ action: 'retry', principal: 'viewer', edited: { after: { to: 'USD' } } });
});

test('a tab without the token can continue, retry and abort — it is not offered an edit or an inject, and says why', async ({
  browser,
  consoleGuard,
}) => {
  stack = await startStack();
  // A fresh context has no stored token: the plain URL, not the redirect file.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  extraContexts.push(context);
  const tokenless = guarded(await context.newPage(), consoleGuard);
  await tokenless.goto(`http://127.0.0.1:${stack.port}/`);
  await expect(tokenless.locator('.gm-chip--control')).toContainText('no token');
  stack.startAgent();

  await waitForHeld(tokenless);
  // The server refuses an edit or an inject from a tokenless socket, so the
  // viewer does not offer them there — and says why, where they would be.
  await expect(footer(tokenless).getByRole('button', { name: 'Edit arguments…', exact: true })).toHaveCount(0);
  await expect(footer(tokenless).getByRole('button', { name: /^Inject/ })).toHaveCount(0);
  await expect(inspector(tokenless).getByTestId('pause-tokenless')).toContainText(
    'No token: this tab can continue, retry and abort.',
  );
  // Continue still works for a tokenless tab (0.5 behaviour): the tool's error
  // goes back to the model and the run finishes.
  await footer(tokenless).getByRole('button', { name: /^Continue/ }).click();
  await expect(banner(tokenless)).toHaveCount(0, { timeout: 20_000 });
  await expect(inspector(tokenless).getByTestId('resumed-by')).toContainText('error → continue · resumed by tokenless viewer');
});

test('first writer wins across tabs: a later Continue and a later edit are both told "taken", at once', async ({
  page,
  consoleGuard,
}) => {
  stack = await startStack();
  await openWithToken(page, stack);
  // Two more tabs: same origin, so the same stored token — full control too.
  const second = guarded(await page.context().newPage(), consoleGuard);
  await second.goto(`http://127.0.0.1:${stack.port}/`);
  await expect(second.locator('.gm-chip--control')).toHaveText('full control · agent: edit');
  const third = guarded(await page.context().newPage(), consoleGuard);
  await third.goto(`http://127.0.0.1:${stack.port}/`);
  await expect(third.locator('.gm-chip--control')).toHaveText('full control · agent: edit');
  // Each run of the tool's schema takes 1.2 s, and an AI SDK edit runs it
  // twice (the model's raw arguments are checked first, so a transform never
  // runs twice), so the first tab's edit is still being answered (the hub's
  // pause is "resolving") for about 2.4 s — while the others resume. Twice the
  // delay must stay under the client's 4 s validation limit.
  const agent = stack.startAgent({ EDIT_AGENT_VALIDATE_DELAY_MS: '1200' });

  await waitForHeld(page);
  await waitForHeld(second);
  await waitForHeld(third);
  // The third tab has its own edit ready before the race.
  await openEditor(third);
  await draftWith(third, { to: 'JPY' });
  await openEditor(page);
  await draftWith(page, { to: 'GBP' });
  await editor(page).getByRole('button', { name: 'Retry with 1 change' }).click();
  await expect(editor(page).getByRole('button', { name: 'Checking…' })).toBeDisabled();
  const port = stack.port;
  await expect
    .poll(async () => {
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/pauses`)).json()) as { pauses: { state: string }[] };
      return body.pauses[0]?.state;
    }, { intervals: [50] })
    .toBe('resolving');

  // Meanwhile the second tab clicks Continue on the card and the third sends
  // its edit: the hub refuses both — taken — and each tab says so at once,
  // where the button was pressed (not "no answer from the app" in 10 s).
  await Promise.all([
    banner(second).getByRole('button', { name: /^Continue/ }).click(),
    editor(third).getByRole('button', { name: 'Retry with 1 change' }).click(),
  ]);
  const taken = banner(second).getByTestId('pause-reply');
  await expect(taken).toHaveText(/^Taken — another resume for this pause got there first/, { timeout: 2_000 });
  await expect(taken).toContainText('Yours was not sent.');
  const editTaken = editor(third).getByTestId('edit-reply');
  await expect(editTaken).toHaveText(/^Taken — another resume for this pause got there first/, { timeout: 2_000 });
  await expect(editTaken).toContainText('Your edit was not sent.');
  await expect(editor(third).getByTestId('edit-timeout')).toHaveCount(0);

  // The first tab's edit wins: released, run with it, finished — in both tabs.
  await expect(banner(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(banner(second)).toHaveCount(0, { timeout: 20_000 });
  await expect(banner(third)).toHaveCount(0, { timeout: 20_000 });
  expect(await agent.exited).toBe(0);
  expect(agentResult(agent)?.executedWith.map((args) => args.to)).toEqual(['XYZ', 'GBP']);
  for (const tab of [page, second, third]) {
    await expect(tab.locator(`.react-flow__node[data-id="${TOOL_NODE}"] .gm-pill--edited`)).toHaveText('edited');
  }
  const resumed = (await stack.events()).filter((e) => e.type === 'exec.resumed');
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.payload).toMatchObject({ action: 'retry', principal: 'viewer', edited: { after: { to: 'GBP' } } });
});
