#!/usr/bin/env node
/**
 * The `graphmind` binary. `graphmind` (or `graphmind serve`) starts the
 * local server; future subcommands (`import`, `mcp`, `record`) slot into
 * the command table below.
 */
import { parseCliArgs, type ParsedCli } from './args.js';
import { runDemo } from './commands/demo.js';
import { runImport } from './commands/import.js';
import { runInit } from './commands/init.js';
import { runMcp } from './commands/mcp.js';
import { runRecord } from './commands/record.js';
import { runRuns } from './commands/runs.js';
import { openBrowser } from './open-browser.js';
import { DEFAULT_PORT } from './paths.js';
import { startServer } from './server.js';
import { recordTelemetry } from './telemetry.js';
import { VERSION } from './version.js';

interface CommandDef {
  summary: string;
  run(parsed: ParsedCli): Promise<number>;
}

const commands: Record<string, CommandDef> = {
  serve: {
    summary: 'Start the GraphMind server (the default command)',
    run: runServe,
  },
  demo: {
    summary: 'Replay the bundled demo debug session (--live runs it for real)',
    run: runDemo,
  },
  init: {
    summary: 'Detect this project\'s agent framework and print the setup steps',
    run: runInit,
  },
  import: {
    summary: 'Import an OTel/OpenInference trace file as a run (best-effort)',
    run: runImport,
  },
  mcp: {
    summary: 'Serve runs to MCP clients (Claude Code, Cursor) over stdio',
    run: runMcp,
  },
  runs: {
    summary: 'List stored runs, prune old ones, or delete them',
    run: runRuns,
  },
  record: {
    summary: 'Capture a run to a replayable NDJSON fixture',
    run: runRecord,
  },
};

function printHelp(): void {
  const lines = [
    `graphmind v${VERSION} — live debugger for AI agents (local-only server)`,
    '',
    'Usage: graphmind [command] [options]',
    '',
    'Commands:',
    ...Object.entries(commands).map(([name, def]) => `  ${name.padEnd(10)}${def.summary}`),
    '',
    'Options:',
    `  --port <n>     Port to listen on (default ${DEFAULT_PORT}; always binds 127.0.0.1)`,
    '  --db <path>    SQLite database file (default ~/.graphmind/graphmind.db,',
    '                 or GRAPHMIND_DB)',
    '  --no-open      Do not open the viewer in a browser',
    '  --live         (demo) run the real demo agent with your API key',
    '  --install      (init) run the package-manager install',
    '  --write        (init) write a graphmind.example.ts snippet file',
    '  --out <file>   (record) output NDJSON path',
    '  --prune        (runs) apply the retention policy now',
    '  --keep <n>     (runs) keep/show the n newest runs',
    '  --days <n>     (runs) keep runs from the last n days',
    '  --rm <runId>   (runs) delete one run   --clear --yes  delete all',
    '  -v, --version  Print the version and exit',
    '  -h, --help     Show this help',
  ];
  console.log(lines.join('\n'));
}

async function runServe(parsed: ParsedCli): Promise<number> {
  if (parsed.positionals.length > 0) {
    console.error(`unexpected argument "${parsed.positionals[0]}"`);
    return 1;
  }
  let server;
  try {
    server = await startServer({
      ...(parsed.flags.port === undefined ? {} : { port: parsed.flags.port }),
      ...(parsed.flags.db === undefined ? {} : { dbPath: parsed.flags.db }),
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`graphmind: ${err.message}`);
    return 1;
  }

  recordTelemetry('serve');
  console.log(`GraphMind v${VERSION} listening on ${server.url}`);
  console.log(`  viewer   ${server.url}`);
  console.log(`  ingest   ws://127.0.0.1:${server.port}/ingest`);
  console.log(`  ui ws    ws://127.0.0.1:${server.port}/ws/ui`);
  console.log(`  db       ${server.dbPath}`);
  console.log('Press Ctrl+C to stop.');

  if (parsed.flags.open) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down...`);
      void server.close().then(resolve, resolve);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.flags.help) {
    printHelp();
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) console.error(`graphmind: ${error}`);
    console.error('Run "graphmind --help" for usage.');
    return 1;
  }
  const command = commands[parsed.command];
  if (command === undefined) {
    console.error(`graphmind: unknown command "${parsed.command}"`);
    console.error('Run "graphmind --help" for usage.');
    return 1;
  }
  return command.run(parsed);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`graphmind: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
