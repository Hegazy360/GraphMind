/**
 * `graphmind demo` — the keyless first-run experience.
 *
 * Default: replays the bundled planted-bug trip-planner recording through the
 * REAL ingest pipeline. The CLI process acts as a fake app client (hello
 * handshake, envelope stream with the recorded pacing) that honors the
 * control protocol — the planted error genuinely pauses (the server
 * default-arms `{point:'error'}`), and inject / continue / retry / abort from
 * the viewer steer the replay onto the matching pre-recorded branch (see
 * ../demo/replayer.ts). Uses a server already running on the target port, or
 * starts one in-process for the duration.
 *
 * `--live`: runs the real demo agent (examples/demo-agent) instead — SPAWNED
 * as a child process (`node_modules/.bin/tsx src/main.ts --live`), not
 * imported, because the agent's `ai` + provider dependencies live in the
 * example package, not in this CLI. That means --live works from the
 * GraphMind monorepo checkout (or a dir named by GRAPHMIND_DEMO_AGENT_DIR)
 * and needs ANTHROPIC_API_KEY or OPENAI_API_KEY.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedCli } from '../args.js';
import { startBundledDemoReplay } from '../demo/replayer.js';
import { openBrowser } from '../open-browser.js';
import { DEFAULT_PORT, packageRoot } from '../paths.js';
import { startServer, type GraphMindServer } from '../server.js';
import { recordTelemetry } from '../telemetry.js';
import { VERSION } from '../version.js';

interface EnsuredServer {
  port: number;
  httpUrl: string;
  ingestUrl: string;
  /** Set when this command started the server in-process. */
  started: GraphMindServer | undefined;
}

async function serverIsUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === 'graphmind-ai';
  } catch {
    return false;
  }
}

/** Use the server already on the port, or start one in-process. */
async function ensureServer(parsed: ParsedCli): Promise<EnsuredServer> {
  const port = parsed.flags.port ?? DEFAULT_PORT;
  if (await serverIsUp(port)) {
    return {
      port,
      httpUrl: `http://127.0.0.1:${port}`,
      ingestUrl: `ws://127.0.0.1:${port}/ingest`,
      started: undefined,
    };
  }
  const started = await startServer({
    port,
    ...(parsed.flags.db === undefined ? {} : { dbPath: parsed.flags.db }),
  });
  console.log(`GraphMind v${VERSION} listening on ${started.url} (started for the demo)`);
  return {
    port: started.port,
    httpUrl: started.url,
    ingestUrl: `ws://127.0.0.1:${started.port}/ingest`,
    started,
  };
}

/** Keep an in-process server alive until Ctrl+C, then close it. */
async function holdUntilInterrupt(server: GraphMindServer): Promise<void> {
  console.log('Server stays up so you can explore the run. Press Ctrl+C to stop.');
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
}

function resolveDemoAgentDir(): string | undefined {
  const explicit = process.env['GRAPHMIND_DEMO_AGENT_DIR'];
  // packageRoot is packages/cli/ in the monorepo checkout.
  const candidates = [explicit, join(packageRoot, '..', '..', 'examples', 'demo-agent')];
  for (const dir of candidates) {
    if (dir !== undefined && dir !== '' && existsSync(join(dir, 'src', 'main.ts'))) return dir;
  }
  return undefined;
}

async function runLive(parsed: ParsedCli, server: EnsuredServer): Promise<number> {
  const dir = resolveDemoAgentDir();
  if (dir === undefined) {
    console.error(
      'graphmind demo --live: could not find examples/demo-agent — run from the GraphMind ' +
        'monorepo checkout (after `pnpm install`), or point GRAPHMIND_DEMO_AGENT_DIR at it.',
    );
    return 1;
  }
  const tsx = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  if (!existsSync(tsx)) {
    console.error(`graphmind demo --live: ${tsx} not found — run \`pnpm install\` first.`);
    return 1;
  }
  console.log(`Running the live demo agent from ${dir}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(tsx, [join(dir, 'src', 'main.ts'), '--live'], {
      cwd: dir,
      stdio: 'inherit',
      env: { ...process.env, GRAPHMIND_URL: server.ingestUrl, GRAPHMIND: '1' },
    });
    child.on('error', (error) => {
      console.error(`graphmind demo --live: failed to spawn (${error.message})`);
      resolve(1);
    });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  return code;
}

export async function runDemo(parsed: ParsedCli): Promise<number> {
  recordTelemetry('demo');

  if (parsed.positionals.length > 0) {
    console.error(`unexpected argument "${parsed.positionals[0]}"`);
    return 1;
  }

  let server: EnsuredServer;
  try {
    server = await ensureServer(parsed);
  } catch (error) {
    console.error(`graphmind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.flags.open) openBrowser(server.httpUrl);

  if (parsed.flags.live) {
    const code = await runLive(parsed, server);
    if (server.started !== undefined && code === 0) {
      await holdUntilInterrupt(server.started);
      return 0;
    }
    if (server.started !== undefined) await server.started.close();
    return code;
  }

  console.log('Replaying the recorded demo debug session (no API key needed).');
  console.log(`Watch it at ${server.httpUrl} — the planted bug will pause the run;`);
  console.log('resume it from the viewer (inject a fix, retry, continue, or abort).');

  const replay = await startBundledDemoReplay({
    url: server.ingestUrl,
    log: (message) => console.log(message),
  });
  const outcome = await replay.done;
  if (outcome === 'finished') console.log(`Demo run ${replay.runId} complete.`);

  if (server.started !== undefined) {
    await holdUntilInterrupt(server.started);
    return 0;
  }
  return outcome === 'failed' ? 1 : 0;
}
