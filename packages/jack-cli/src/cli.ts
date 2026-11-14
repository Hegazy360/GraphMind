#!/usr/bin/env node
/**
 * jack — the GraphMind Jack CLI.
 *
 *   jack serve   [--port auto|0|<n>] [--db .jack/dev.db] [--api-key <key>] [--accounts] [--host <addr>] [--public-origin <url>]
 *                the dashboard + control plane + data plane; --accounts turns on self-serve sign-up
 *   jack init    <openapi file|url> [--out jack.yaml] [--upstream <url>] [--force]
 *   jack check   [--config jack.yaml] [--strict]
 *   jack build   [--config jack.yaml] [--out jack.manifest.json]
 *   jack preview [--config jack.yaml] [--port auto|0|<n>] [--stdio] [--egress any|public]
 *   jack tools   [--url <mcp url>]   (default: the preview running in this worktree)
 *   jack call    <tool> [--args '{...}'] [--yes|--no] [--url …]
 *   jack deploy  [--config jack.yaml] [--project <slug>] [--server <url>]  push jack.yaml and make it live
 *
 * Local state lives in .jack/dev.db (SQLite) unless --db says otherwise.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createJack, SqliteStore, type Jack } from 'jack-api';
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';
import { PROTOCOL_VERSION } from '@graphmind-ai/jack-schema';
import { CompileError, LoadError, UnsupportedDocumentError } from '@graphmind-ai/jack-openapi';
import { buildCommand, checkCommand, initCommand, type Io } from './commands.js';
import { PreviewError, startPreview } from './preview.js';
import { callCommand, loginCommand, logoutCommand, toolsCommand, type ConfirmMode } from './client.js';
import { choosePort, parsePortFlag, PortError, readRunInfo, runFile, worktreeRoot, writeRunInfo } from './ports.js';
import { deployCommand, DeployError } from './deploy.js';
import { loadOrCreateKey } from './preview.js';

const DEFAULT_DB = '.jack/dev.db';

const USAGE = `usage:
  jack serve   [--port auto|0|<n>] [--db .jack/dev.db] [--api-key <key>] [--egress any|public]   the dashboard
               [--accounts] [--no-signup] [--host <addr>] [--public-origin <url>]
               --accounts: users create their own accounts and each sees only their projects
  jack init    <openapi file|url> [--out jack.yaml] [--upstream <url>] [--force]
  jack check   [--config jack.yaml] [--strict]
  jack build   [--config jack.yaml] [--out jack.manifest.json]
  jack preview [--config jack.yaml] [--port auto|0|<n>] [--stdio] [--egress any|public]
  jack tools   [--url <mcp url>]        default: this worktree's running preview
  jack call    <tool> [--args '{"key":"value"}'] [--yes|--no] [--url …]
  jack login   [--url …]                 sign in to a Jack server (tools/call do this when needed)
  jack logout  [--url …]                 revoke and forget that sign-in
  jack deploy  [--config jack.yaml] [--project <slug>] [--server <url>] [--api-key <key>] [--message "…"]

GraphMind Jack speaks MCP ${PROTOCOL_VERSION}.`;

function fail(message: string): never {
  console.error(`jack: ${message}`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      port: { type: 'string' },
      'api-key': { type: 'string' },
      accounts: { type: 'boolean' },
      'no-signup': { type: 'boolean' },
      host: { type: 'string' },
      'public-origin': { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string' },
      upstream: { type: 'string' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      stdio: { type: 'boolean' },
      egress: { type: 'string' },
      url: { type: 'string' },
      args: { type: 'string' },
      yes: { type: 'boolean' },
      no: { type: 'boolean' },
      project: { type: 'string' },
      server: { type: 'string' },
      message: { type: 'string' },
    },
  });

  switch (command) {
    case 'serve': {
      let port;
      try {
        port = parsePortFlag(values.port);
      } catch (err) {
        fail((err as PortError).message);
      }
      if (values.egress !== undefined && values.egress !== 'any' && values.egress !== 'public') fail('--egress must be any or public');
      const root = worktreeRoot();
      const dbPath = resolve(values.db ?? resolve(root, DEFAULT_DB));
      const dataDir = resolve(dirname(dbPath), 'serve');
      mkdirSync(dataDir, { recursive: true });
      const store = new SqliteStore(dbPath);
      const apiKeys = values['api-key'] !== undefined ? [values['api-key']] : [];
      const host = values.host ?? '127.0.0.1';
      if (values['public-origin'] !== undefined) {
        try {
          new URL(values['public-origin']);
        } catch {
          fail('--public-origin must be a URL, e.g. https://jack.example.com');
        }
      }
      // Hosting (a non-loopback --host) needs accounts or a key: never an open control plane on the internet.
      if (host !== '127.0.0.1' && host !== 'localhost' && !values.accounts && apiKeys.length === 0) {
        fail(`--host ${host} exposes the dashboard beyond this machine: add --accounts (self-serve sign-up) or --api-key`);
      }
      const accountStore = values.accounts ? new SqliteAccountStore(resolve(dataDir, 'accounts.db')) : null;
      const chosen = await choosePort(port, 'serve', root);
      // Bind first: every project's issuer and MCP URL are built from the real origin.
      let handle: ((req: Request) => Response | Promise<Response>) | null = null;
      let jack: Jack | null = null;
      const server = serve({ fetch: (req) => handle!(req), port: chosen.port, hostname: host }, (info) => {
        const publicOrigin = (values['public-origin'] ?? `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${info.port}`).replace(/\/$/, '');
        const accounts = accountStore ? createAccounts({ store: accountStore, publicOrigin, allowSignup: !values['no-signup'] }) : undefined;
        jack = createJack({
          store,
          apiKeys,
          publicOrigin,
          dataDir,
          secretKey: loadOrCreateKey(dataDir),
          egress: (values.egress as 'any' | 'public' | undefined) ?? 'any',
          ...(accounts ? { accounts } : {}),
        });
        handle = jack.app.fetch;
        const unregister = writeRunInfo({ service: 'serve', url: publicOrigin, dashboard: publicOrigin }, root);
        if (chosen.note) console.log(`  ${chosen.note}`);
        console.log(`jack serve — dashboard at ${publicOrigin}`);
        console.log(`  data: ${dbPath}${apiKeys.length ? ' · bearer key required for /v1' : ''}`);
        if (accounts) {
          console.log(`  accounts: ${accounts.status().signup ? 'anyone can sign up' : 'sign-up closed'} (${accounts.status().users} user(s), ${resolve(dataDir, 'accounts.db')})`);
          console.log('  jack deploy against this server needs a personal API token: dashboard → Account → API tokens, then --api-key gmt_…');
        }
        console.log(`  projects are served at ${publicOrigin}/p/<slug>/mcp`);
        console.log('  registered for this worktree: `jack deploy` finds this server without --server');
        const stop = () => {
          unregister();
          void jack?.close();
          server.close();
          store.close();
          accountStore?.close();
          process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      return;
    }
    case 'init':
    case 'check':
    case 'build': {
      const io: Io = { out: (l) => console.log(l), err: (l) => console.error(`jack: ${l}`), today: new Date().toISOString().slice(0, 10) };
      let code: number;
      try {
        code =
          command === 'init'
            ? await initCommand(positionals[0], {
                ...(values.out !== undefined ? { out: values.out } : {}),
                ...(values.upstream !== undefined ? { upstream: values.upstream } : {}),
                ...(values.force ? { force: true } : {}),
              }, io)
            : command === 'check'
              ? await checkCommand({ ...(values.config !== undefined ? { config: values.config } : {}), ...(values.strict ? { strict: true } : {}) }, io)
              : await buildCommand({ ...(values.config !== undefined ? { config: values.config } : {}), ...(values.out !== undefined ? { out: values.out } : {}) }, io);
      } catch (err) {
        // Expected, user-facing failures print one clean line; anything else is a bug and keeps its stack.
        if (err instanceof LoadError || err instanceof CompileError || err instanceof UnsupportedDocumentError) fail(err.message);
        throw err;
      }
      if (code !== 0) process.exit(code);
      return;
    }
    case 'preview': {
      const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
      if (values.egress !== undefined && values.egress !== 'any' && values.egress !== 'public') fail('--egress must be any or public');
      let port;
      try {
        port = parsePortFlag(values.port);
      } catch (err) {
        fail((err as PortError).message);
      }
      let handle;
      try {
        handle = await startPreview(
          {
            ...(values.config !== undefined ? { config: values.config } : {}),
            port,
            ...(values.stdio ? {} : { runRoot: worktreeRoot() }),
            ...(values.stdio ? { stdio: true } : {}),
            ...(values.egress !== undefined ? { egress: values.egress as 'any' | 'public' } : {}),
          },
          io,
        );
      } catch (err) {
        if (err instanceof PreviewError || err instanceof LoadError || err instanceof CompileError || err instanceof UnsupportedDocumentError) fail(err.message);
        throw err;
      }
      const stop = () => void handle.close().finally(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'tools':
    case 'call':
    case 'login':
    case 'logout': {
      const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
      const confirm: ConfirmMode = values.yes ? 'yes' : values.no ? 'no' : 'prompt';
      // Default target: the preview running in THIS worktree (never a fixed port another worktree might own).
      let url = values.url;
      if (url === undefined) {
        const running = readRunInfo('preview');
        if (!running) {
          fail(`no jack preview is running in this worktree (${worktreeRoot()}).\n  Start one with \`jack preview\`, or pass --url <mcp url>. (Looked for ${runFile('preview')})`);
        }
        url = running.url;
      }
      const clientOpts = { url, confirm };
      let code: number;
      try {
        code =
          command === 'tools'
            ? await toolsCommand(clientOpts, io)
            : command === 'login'
              ? await loginCommand(clientOpts, io)
              : command === 'logout'
                ? await logoutCommand(clientOpts, io)
                : await callCommand(positionals[0], values.args, clientOpts, io);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      process.exit(code);
    }
    case 'deploy': {
      const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
      try {
        process.exit(
          await deployCommand(
            {
              ...(values.config !== undefined ? { config: values.config } : {}),
              ...(values.project !== undefined ? { project: values.project } : {}),
              ...(values.server !== undefined ? { server: values.server } : {}),
              ...(values['api-key'] !== undefined ? { apiKey: values['api-key'] } : {}),
              ...(values.message !== undefined ? { message: values.message } : {}),
            },
            io,
          ),
        );
      } catch (err) {
        if (err instanceof DeployError || err instanceof LoadError || err instanceof CompileError || err instanceof UnsupportedDocumentError) fail(err.message);
        throw err;
      }
      break;
    }
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      return;
    default:
      fail(`unknown command '${command}'\n${USAGE}`);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
