#!/usr/bin/env node
/**
 * The `graphmind` binary. `graphmind` (or `graphmind serve`) starts the
 * local server; future subcommands (`import`, `mcp`, `record`) slot into
 * the command table below.
 */
import { OPTION_HELP, parseCliArgs, type ParsedCli } from './args.js';
import { EXIT_CODE_HELP, runPauses, runResume, runWait } from './commands/control.js';
import { runDemo } from './commands/demo.js';
import { runImport } from './commands/import.js';
import { runInit } from './commands/init.js';
import { runMcp } from './commands/mcp.js';
import { printMcpProxyHelp, runMcpProxy } from './commands/mcp-proxy.js';
import { runRecord } from './commands/record.js';
import { runRuns } from './commands/runs.js';
import { runSkill } from './commands/skill.js';
import { MCP_PROXY_SUMMARY } from './mcp-proxy/help.js';
import { DEFAULT_PORT } from './paths.js';
import { startServer } from './server.js';
import { recordTelemetry } from './telemetry.js';
import { VERSION } from './version.js';

interface CommandDef {
  summary: string;
  run(parsed: ParsedCli): Promise<number>;
  /**
   * Optional per-command `--help`. Commands with their own setup story
   * (mcp-proxy) print it instead of the global option list.
   */
  help?(parsed: ParsedCli): void;
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
  'mcp-proxy': {
    summary: MCP_PROXY_SUMMARY,
    run: runMcpProxy,
    // stderr, never stdout: `graphmind mcp-proxy --help` may well be run by a
    // client that is already treating our stdout as the protocol channel.
    help: (parsed) =>
      printMcpProxyHelp(
        (line) => void process.stderr.write(`${line}\n`),
        parsed.flags.port ?? DEFAULT_PORT,
      ),
  },
  runs: {
    summary: 'List stored runs, prune old ones, or delete them',
    run: runRuns,
  },
  record: {
    summary: 'Export a run: NDJSON fixture, or --html to share it',
    run: runRecord,
  },
  pauses: {
    summary: 'List the pauses held right now (--run <id>, --json)',
    run: runPauses,
  },
  wait: {
    summary: 'Block until a pause appears; print it and what to run next',
    run: runWait,
  },
  resume: {
    summary: 'Release a pause: resume <pauseId> --run <id> --action <a>',
    run: runResume,
  },
  skill: {
    summary: 'Print the GraphMind Agent Skill, or --install it here',
    run: runSkill,
  },
};

function printHelp(): void {
  const lines = [
    `graphmind v${VERSION} — live debugger for AI agents (local-only server)`,
    '',
    'Usage: graphmind [command] [options]',
    '',
    'Commands:',
    ...Object.entries(commands).map(([name, def]) => `  ${name.padEnd(11)}${def.summary}`),
    '',
    'Options:',
    ...OPTION_HELP,
    '',
    'Exit codes (pauses, wait, resume):',
    ...EXIT_CODE_HELP,
  ];
  console.log(lines.join('\n'));
}

async function runServe(parsed: ParsedCli): Promise<number> {
  if (parsed.positionals.length > 0) {
    console.error(`unexpected argument "${parsed.positionals[0]}"`);
    return 1;
  }
  const json = parsed.flags.json;
  // `--json`: stdout carries exactly one JSON line; everything else (server
  // log lines included) goes to stderr, so a script can read stdout.
  const say = (message: string): void => {
    if (json) console.error(message);
    else console.log(message);
  };
  let server;
  try {
    server = await startServer({
      ...(parsed.flags.port === undefined ? {} : { port: parsed.flags.port }),
      ...(parsed.flags.db === undefined ? {} : { dbPath: parsed.flags.db }),
      ...(parsed.flags.pauseOnError === undefined
        ? {}
        : { pauseOnError: parsed.flags.pauseOnError }),
      ...(parsed.flags.allowControl === undefined ? {} : { allowControl: parsed.flags.allowControl }),
      editInput: parsed.flags.editInput,
      runFile: true,
      ...(json ? { log: (message: string) => console.error(message) } : {}),
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`graphmind: ${err.message}`);
    return 1;
  }

  recordTelemetry('serve');
  if (json) {
    // Never a token: this line lands in CI logs and agent transcripts.
    console.log(JSON.stringify({ port: server.port, url: server.url, pid: process.pid, version: VERSION }));
  } else {
    console.log(`GraphMind v${VERSION} listening on ${server.url}`);
    // The viewer token only ever travels in a URL fragment, and that URL is
    // printed only to a terminal — never into a pipe, a log file or CI output.
    if (process.stdout.isTTY === true) {
      console.log(`  viewer   ${server.url}/#token=${server.tokens.viewer}`);
    } else {
      console.log(`  viewer   ${server.url}`);
    }
    if (server.openerPath !== undefined) {
      console.log(`           (full control: open ${server.openerPath})`);
    }
    console.log(`  ingest   ws://127.0.0.1:${server.port}/ingest`);
    console.log(`  ui ws    ws://127.0.0.1:${server.port}/ws/ui`);
    console.log(`  db       ${server.dbPath}`);
    // Pause-on-error is default-on and the single most surprising thing the
    // server does to a run, so say what is armed and how to change it.
    const errorScopes = server.hub.state.breakpoints
      .filter((matcher) => matcher.point === 'error')
      .map((matcher) => (matcher.kind === undefined ? 'every node' : `${matcher.kind} nodes`));
    console.log(
      `  pause    on error: ${errorScopes.length === 0 ? 'off' : errorScopes.join(', ')}` +
        ' (--pause-on-error <on|off|kind>)',
    );
    console.log(
      `  control  agent (graphmind resume): ${server.control.agentLevel}` +
        ' (--allow-control=off|resume|inject|edit); input edits: ' +
        `${server.control.editInput ? 'allowed with a credential' : 'off'} (--no-edit-input)`,
    );
    console.log('Press Ctrl+C to stop.');
  }

  if (parsed.flags.open) server.openViewer();

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      say(`\nReceived ${signal}, shutting down...`);
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
    const withHelp = commands[parsed.command];
    if (withHelp?.help !== undefined) {
      withHelp.help(parsed);
      return 0;
    }
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
