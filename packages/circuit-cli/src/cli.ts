#!/usr/bin/env node
/**
 * circuit — the GraphMind Circuit CLI.
 *
 *   circuit dev     --workflows <module> [--port 4810] [--db <path>] [--api-key <key>]
 *   circuit runs    [--db <path>] [--workflow <name>] [--status <s>]
 *   circuit show    <runId> [--db <path>]
 *   circuit resume  <runId> <seq> <action> [--output <json>] [--input <json>] [--reason <text>] [--actor <who>] [--db]
 *   circuit record  <runId> --out <file.json> [--db <path>]
 *   circuit test    --workflows <module> [--fixtures <dir>]
 *   circuit check   --workflows <module> [--db <path>]      (the deploy check)
 *
 * Local state lives in .circuit/dev.db (SQLite) unless --db says otherwise.
 */
import { mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import {
  checkDeploy,
  Executor,
  exportFixture,
  SqliteJournalStore,
} from '@graphmind-ai/circuit-engine';
import { resumeAction, type JsonValue } from '@graphmind-ai/circuit-schema';
import { createApi, startEngineLoop } from 'circuit-api';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  createWorkflowMcpServer,
  FilePinStore,
  generateDeclarations,
  loadMcpConfig,
  McpConnections,
  type ToolInfo,
} from '@graphmind-ai/circuit-mcp';
import { loadWorkflows } from './load.js';
import { describeVerdict, runFixtureTests } from './testing.js';
import { importN8n, importPipedream } from './import.js';
import { scaffoldWorkflow, TEMPLATES } from './scaffold.js';

const DEFAULT_DB = '.circuit/dev.db';

function openStore(db: string | undefined): SqliteJournalStore {
  const path = resolve(db ?? DEFAULT_DB);
  mkdirSync(dirname(path), { recursive: true });
  return new SqliteJournalStore(path);
}

function parseJsonFlag(raw: string | undefined, flag: string): JsonValue | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    fail(`--${flag} must be valid JSON, got: ${raw}`);
  }
}

function fail(message: string): never {
  console.error(`circuit: ${message}`);
  process.exit(1);
}

/** MCP connections from a config file; tool pins are stored next to the dev database. */
function openMcp(configPath: string, db: string | undefined): McpConnections {
  const pins = resolve(dirname(resolve(db ?? DEFAULT_DB)), 'mcp-pins.json');
  return new McpConnections(loadMcpConfig(resolve(configPath)), new FilePinStore(pins));
}

const USAGE = `usage:
  circuit dev     --workflows <module> [--port 4810] [--db ${DEFAULT_DB}] [--api-key <key>]
  circuit runs    [--db] [--workflow <name>] [--status <s>]
  circuit show    <runId> [--db]
  circuit resume  <runId> <seq> <continue|retry|inject|edit|skip|abort> [--output <json>] [--input <json>] [--reason] [--actor] [--db]
  circuit record  <runId> --out <file.json> [--db]
  circuit test    --workflows <module> [--fixtures circuit.fixtures]
  circuit check   --workflows <module> [--db]
  circuit import  <n8n|pipedream> <export.json> [--out <dir>]          generate a Circuit workflow skeleton
  circuit mcp pull  --mcp <circuit.mcp.json> [--out circuit.mcp.d.ts]   generate types for ctx.mcp(...)
  circuit mcp serve [--api http://127.0.0.1:4810] [--api-key]          expose workflows as MCP tools (stdio)
  (dev also takes --mcp <circuit.mcp.json> to give workflows MCP connections)`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      workflows: { type: 'string' },
      db: { type: 'string' },
      port: { type: 'string' },
      'api-key': { type: 'string' },
      workflow: { type: 'string' },
      status: { type: 'string' },
      output: { type: 'string' },
      input: { type: 'string' },
      reason: { type: 'string' },
      actor: { type: 'string' },
      out: { type: 'string' },
      fixtures: { type: 'string' },
      mcp: { type: 'string' },
      api: { type: 'string' },
    },
  });

  switch (command) {
    case 'dev': {
      if (values.workflows === undefined) fail('dev needs --workflows <module>');
      const workflowsFile = resolve(values.workflows);
      let defs = await loadWorkflows(workflowsFile);
      const store = openStore(values.db);
      const mcp = values.mcp !== undefined ? openMcp(values.mcp, values.db) : undefined;
      const executor = new Executor({ store, workflows: defs, ...(mcp ? { mcp } : {}) });
      if (mcp) console.log(`circuit dev — MCP connections: ${mcp.connectionNames().join(', ')}`);
      const loop = startEngineLoop(executor);

      // Hot reload: re-import the workflows file when it changes. Watch the
      // directory and filter, because editors replace files on save.
      let reloading = false;
      let again = false;
      const reload = async (): Promise<void> => {
        if (reloading) {
          again = true;
          return;
        }
        reloading = true;
        try {
          defs = await loadWorkflows(workflowsFile, { bust: true });
          executor.replaceWorkflows(defs);
          console.log(`reloaded — ${defs.length} workflow(s): ${defs.map((d) => d.config.name).join(', ')}`);
        } catch (err) {
          console.error(`reload failed (fix the file and save again): ${err instanceof Error ? err.message : err}`);
        } finally {
          reloading = false;
          if (again) {
            again = false;
            void reload();
          }
        }
      };
      let debounce: NodeJS.Timeout | undefined;
      watch(dirname(workflowsFile), (_event, file) => {
        if (file !== basename(workflowsFile)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => void reload(), 200);
      });

      const app = createApi({
        executor,
        store,
        workflows: () => defs,
        onWork: loop.kick,
        devTools: {
          templates: Object.keys(TEMPLATES),
          scaffold: (name, template) => scaffoldWorkflow(workflowsFile, name, template),
        },
        ...(values['api-key'] !== undefined ? { apiKeys: [values['api-key']] } : {}),
      });
      const port = Number(values.port ?? 4810);
      serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
        console.log(`circuit dev — ${defs.length} workflow(s): ${defs.map((d) => d.config.name).join(', ')}`);
        console.log(`  dashboard  http://127.0.0.1:${info.port}/`);
        console.log(`  api        http://127.0.0.1:${info.port}/v1`);
        console.log(`  db         ${resolve(values.db ?? DEFAULT_DB)}`);
        console.log(`  start a run: POST http://127.0.0.1:${info.port}/v1/workflows/<name>/runs  {"input": ...}`);
        console.log(`  guide: docs/circuit/USAGE.md`);
      });
      return;
    }

    case 'runs': {
      const store = openStore(values.db);
      const executor = new Executor({ store });
      const runs = executor.listRuns({
        ...(values.workflow !== undefined ? { workflow: values.workflow } : {}),
        ...(values.status !== undefined ? { status: values.status as never } : {}),
        limit: 50,
      });
      for (const run of runs) {
        const paused = run.pausedSeq !== undefined ? ` paused@${run.pausedSeq}` : '';
        console.log(`${run.id}  ${run.workflow.padEnd(24)} ${run.status}${paused}`);
      }
      if (runs.length === 0) console.log('(no runs)');
      store.close();
      return;
    }

    case 'show': {
      const runId = positionals[0] ?? fail('show needs a runId');
      const store = openStore(values.db);
      const run = store.getRun(runId) ?? fail(`run ${runId} not found`);
      console.log(JSON.stringify({ run, journal: store.listJournal(runId) }, null, 2));
      store.close();
      return;
    }

    case 'resume': {
      const [runId, seqRaw, actionRaw] = positionals;
      if (runId === undefined || seqRaw === undefined || actionRaw === undefined) {
        fail('resume needs: <runId> <seq> <action>');
      }
      const action = resumeAction.parse(actionRaw);
      const store = openStore(values.db);
      const executor = new Executor({ store });
      const output = parseJsonFlag(values.output, 'output');
      const input = parseJsonFlag(values.input, 'input');
      const run = executor.resume(runId, Number(seqRaw), action, {
        actor: values.actor ?? 'cli',
        ...(values.reason !== undefined ? { reason: values.reason } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(input !== undefined ? { input } : {}),
      });
      console.log(`${run.id} → ${run.status} (will continue on the next dev tick)`);
      store.close();
      return;
    }

    case 'record': {
      const runId = positionals[0] ?? fail('record needs a runId');
      const out = values.out ?? fail('record needs --out <file.json>');
      const store = openStore(values.db);
      const fixture = exportFixture(store, runId);
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`recorded ${fixture.workflow} (${fixture.journal.length} entries) → ${out}`);
      store.close();
      return;
    }

    case 'test': {
      if (values.workflows === undefined) fail('test needs --workflows <module>');
      const defs = await loadWorkflows(values.workflows);
      const dir = resolve(values.fixtures ?? 'circuit.fixtures');
      const { results, failed } = await runFixtureTests(defs, dir);
      for (const result of results) {
        console.log(`${result.verdict.kind === 'pass' ? 'ok  ' : 'FAIL'} ${result.file} (${result.workflow}) — ${describeVerdict(result.verdict)}`);
      }
      console.log(`${results.length - failed}/${results.length} fixtures pass`);
      if (failed > 0) process.exit(1);
      return;
    }

    case 'import': {
      const [kind, file] = positionals;
      if ((kind !== 'n8n' && kind !== 'pipedream') || file === undefined) {
        fail('import needs: <n8n|pipedream> <export.json>');
      }
      const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));
      const generated = kind === 'n8n' ? importN8n(raw, file) : importPipedream(raw, file);
      const outDir = resolve(values.out ?? '.');
      mkdirSync(outDir, { recursive: true });
      const target = resolve(outDir, generated.fileName);
      writeFileSync(target, generated.source);
      console.log(`wrote ${target}`);
      console.log(`  ${generated.steps} step(s); ${generated.todos.length} need porting (each throws TODO(circuit-import) until you do)`);
      for (const note of generated.notes) console.log(`  note: ${note}`);
      console.log(`  run it:   circuit dev --workflows ${generated.fileName}`);
      console.log(`  porting:  start a run; it pauses at the first TODO step — port that step, save, retry from the dashboard.`);
      return;
    }

    case 'check': {
      if (values.workflows === undefined) fail('check needs --workflows <module>');
      const defs = await loadWorkflows(values.workflows);
      const store = openStore(values.db);
      const report = await checkDeploy(defs, store);
      if (report.broken.length === 0) {
        console.log(`deploy check: ${report.checked} in-flight run(s) checked, all compatible`);
      } else {
        console.error(`deploy check: ${report.broken.length} of ${report.checked} in-flight run(s) would BREAK:`);
        for (const broken of report.broken) {
          const why =
            broken.outcome.kind === 'diverged'
              ? broken.outcome.divergence.type
              : broken.outcome.kind;
          console.error(`  ${broken.runId} (${broken.workflow}, ${broken.status}) — ${why}`);
        }
        process.exit(1);
      }
      store.close();
      return;
    }

    case 'mcp': {
      const sub = positionals[0];
      if (sub === 'pull') {
        const configPath = values.mcp ?? 'circuit.mcp.json';
        const mcp = openMcp(configPath, values.db);
        const byConnection: Record<string, ToolInfo[]> = {};
        try {
          for (const name of mcp.connectionNames()) {
            byConnection[name] = await mcp.listTools(name, true);
            console.log(`  ${name}: ${byConnection[name].map((t) => t.name).join(', ') || '(no tools)'}`);
          }
        } finally {
          await mcp.close();
        }
        const out = resolve(values.out ?? 'circuit.mcp.d.ts');
        writeFileSync(out, generateDeclarations(byConnection));
        console.log(`wrote ${out} — ctx.mcp(...).call(...) is now typed`);
        return;
      }
      if (sub === 'serve') {
        // serveStdio owns the 2026-07-28 protocol era and falls back for
        // older clients; tool listings are dynamic, so workflows added while
        // this runs (dev reload, scaffolds) appear without a restart.
        serveStdio(() =>
          createWorkflowMcpServer({
            apiBase: values.api ?? 'http://127.0.0.1:4810',
            ...(values['api-key'] !== undefined ? { apiKey: values['api-key'] } : {}),
          }),
        );
        console.error(`circuit mcp serve — workflows from ${values.api ?? 'http://127.0.0.1:4810'} as MCP tools on stdio`);
        return;
      }
      fail('mcp needs a subcommand: pull | serve');
    }

    default:
      console.log(USAGE);
      if (command !== undefined && command !== 'help' && command !== '--help') process.exit(1);
  }
}

// Run main() only when this file is the entry point (bin shim, symlink or
// `node dist/cli.js`), never when imported. Compare real paths so symlinked
// bins (pnpm/npm .bin) are recognized.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`circuit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
