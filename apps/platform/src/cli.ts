#!/usr/bin/env node
/**
 * graphmind-platform — run the whole end-user experience on one origin.
 *
 *   platform dev    [--port 4800] [--workflows <module>] [--mcp <config.json>] [--data .platform] [--no-signup] [--no-site]
 *                   the homepage at /, the hub at /app/, Circuit at /app/circuit/, Jack at /app/jack/
 *   platform serve  --public-origin <url> [--host 0.0.0.0] [--port 4800] [--workflows <module>] [--data <dir>] [--no-signup]
 *                   the hosted shape: the hub at /, no homepage (graphmind.ai serves that)
 *
 * State: `<data>/accounts.db`, `<data>/circuit.db`, `<data>/jack.db`, `<data>/jack/` (sign-in state), all SQLite.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { Executor, SqliteJournalStore } from '@graphmind-ai/circuit-engine';
import { loadWorkflows } from '@graphmind-ai/circuit-cli';
import { FilePinStore, loadMcpConfig, McpConnections } from '@graphmind-ai/circuit-mcp';
import { createApi as createCircuit, startEngineLoop } from 'circuit-api';
import { createJack, SqliteStore as JackStore } from 'jack-api';
import { loadOrCreateKey } from './key.js';
import { createPlatform, hubPathFor } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const DEFAULT_WORKFLOWS = resolve(repoRoot, 'examples', 'circuit-onboarding', 'workflows.mjs');
const DEFAULT_MCP = resolve(repoRoot, 'examples', 'circuit-onboarding', 'circuit.mcp.json');
const DEFAULT_SITE = resolve(repoRoot, 'apps', 'web');
const DEFAULT_TRY = resolve(repoRoot, 'apps', 'viewer', 'dist-try', 'try');

const USAGE = `usage:
  graphmind-platform dev    [--port 4800] [--workflows <module>] [--mcp <config.json>] [--data .platform] [--no-signup] [--no-site]
  graphmind-platform serve  --public-origin <url> [--host 0.0.0.0] [--port 4800] [--workflows <module>] [--data <dir>] [--no-signup]

dev    everything on http://127.0.0.1:<port>: the homepage, /signup, the hub at /app/, Circuit and Jack.
serve  the hosted shape (app.graphmind.ai): the hub at /, accounts required, binds --host.`;

function fail(message: string): never {
  console.error(`graphmind-platform: ${message}`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      workflows: { type: 'string' },
      mcp: { type: 'string' },
      data: { type: 'string' },
      'public-origin': { type: 'string' },
      'no-signup': { type: 'boolean' },
      'no-site': { type: 'boolean' },
    },
  });
  if (command !== 'dev' && command !== 'serve') {
    console.log(USAGE);
    process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 1);
  }
  const hosted = command === 'serve';
  const host = values.host ?? (hosted ? '0.0.0.0' : '127.0.0.1');
  const port = Number(values.port ?? 4800);
  if (hosted && values['public-origin'] === undefined) fail('serve needs --public-origin <url> (the address browsers use, e.g. https://app.graphmind.ai)');
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const publicOrigin = (values['public-origin'] ?? `http://${shownHost}:${port}`).replace(/\/$/, '');
  try {
    new URL(publicOrigin);
  } catch {
    fail('--public-origin must be a URL');
  }
  const site = hosted || values['no-site'] ? undefined : DEFAULT_SITE;
  const hubPath = hubPathFor(site !== undefined);
  const data = resolve(values.data ?? resolve(repoRoot, '.platform'));
  mkdirSync(resolve(data, 'jack'), { recursive: true });

  // Accounts: one store, one cookie, shared by everything below.
  const accountStore = new SqliteAccountStore(resolve(data, 'accounts.db'));
  const accounts = createAccounts({ store: accountStore, publicOrigin, allowSignup: !values['no-signup'] });

  // Circuit.
  const workflowsFile = resolve(values.workflows ?? DEFAULT_WORKFLOWS);
  if (!existsSync(workflowsFile)) fail(`workflows module not found: ${workflowsFile}`);
  const defs = await loadWorkflows(workflowsFile);
  // MCP connections for the workflows (the demo's refund-request calls a local billing server).
  // stdio commands in the config run from the config file's directory, as `circuit dev` does from the example's.
  const mcpFile = values.mcp !== undefined ? resolve(values.mcp) : values.workflows === undefined ? DEFAULT_MCP : undefined;
  let mcp: McpConnections | undefined;
  if (mcpFile !== undefined && existsSync(mcpFile)) {
    const config = loadMcpConfig(mcpFile);
    for (const spec of Object.values(config.connections)) {
      if (spec.transport === 'stdio' && spec.cwd === undefined) spec.cwd = dirname(mcpFile);
    }
    mcp = new McpConnections(config, new FilePinStore(resolve(data, 'mcp-pins.json')));
  }
  const journal = new SqliteJournalStore(resolve(data, 'circuit.db'));
  const executor = new Executor({ store: journal, workflows: defs, ...(mcp ? { mcp } : {}) });
  const loop = startEngineLoop(executor);
  const circuit = createCircuit({ executor, store: journal, workflows: () => defs, onWork: loop.kick, accounts });

  // Jack.
  const jackStore = new JackStore(resolve(data, 'jack.db'));
  const jack = createJack({
    store: jackStore,
    accounts,
    publicOrigin,
    dataDir: resolve(data, 'jack'),
    secretKey: loadOrCreateKey(resolve(data, 'jack')),
    egress: hosted ? 'public' : 'any',
    dashboardPath: `${hubPath}/jack/`,
  });

  const tryDist = site !== undefined && existsSync(DEFAULT_TRY) ? DEFAULT_TRY : undefined;
  const app = createPlatform({ accounts, circuit, jack, ...(site !== undefined ? { site } : {}), ...(tryDist !== undefined ? { tryDist } : {}) });
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    const origin = values['public-origin'] ?? `http://${shownHost}:${info.port}`;
    const st = accounts.status();
    console.log(`graphmind-platform ${command} — ${origin}`);
    if (site !== undefined) {
      console.log(`  homepage   ${origin}/                 (apps/web, with /signup and /login wired to the hub)`);
      console.log(tryDist ? `  try        ${origin}/try/?fixture=1    the in-browser debugger the homepage embeds` : '  try        not built: pnpm --filter viewer build:try (the homepage demo will show its poster)');
    }
    console.log(`  hub        ${origin}${hubPath}/          sign in, your products, your account`);
    console.log(`  circuit    ${origin}${hubPath}/circuit/  ${defs.length} workflow(s): ${defs.map((d) => d.config.name).join(', ')} (${basename(workflowsFile)}${mcp ? `, MCP: ${mcp.connectionNames().join(', ')}` : ''})`);
    console.log(`  jack       ${origin}${hubPath}/jack/     projects serve MCP at ${origin}/p/<slug>/mcp`);
    console.log(`  accounts   ${st.signup ? 'anyone can sign up' : 'sign-up closed'} · ${st.users} user(s) · ${data}`);
    if (!hosted) console.log('  walk it:   open the homepage, click "Create a free account", then open Circuit and Jack from the hub.');
  });
  const stop = () => {
    loop.stop();
    void jack.close();
    journal.close();
    jackStore.close();
    accountStore.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
