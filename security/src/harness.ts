/**
 * The audit harness.
 *
 * One `runAudit()` call:
 *   1. makes a throwaway home + database (nothing touches ~/.graphmind),
 *   2. starts a REAL GraphMind server on an ephemeral port,
 *   3. attaches a REAL viewer socket on `/ws/ui` and records every frame the
 *      viewer would receive,
 *   4. runs the caller's instrumented agent against it,
 *   5. waits for the run to be persisted, shuts the server down (which
 *      checkpoints the WAL), and
 *   6. collects every artifact GraphMind can hand to a human:
 *        - the SQLite database file, read as raw BYTES (plus -wal / -shm),
 *        - GET /api/runs and GET /api/runs/:id/events response bodies,
 *        - the WebSocket frames the viewer received,
 *        - `graphmind record <id> --html` output (the shareable page),
 *        - `graphmind record <id>` NDJSON output,
 *        - every telemetry payload the CLI sent, captured off the wire.
 *
 * Nothing here mocks GraphMind. The server, the storage, the HTTP API, the
 * viewer protocol and the `record` CLI are the shipped code paths.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';
import { startServer, packageRoot, type GraphMindServer } from 'graphmind-ai';
import type { Artifact } from './scan.js';

const execFileAsync = promisify(execFile);

/** Where the shipped CLI entrypoint lives inside the graphmind-ai package. */
export const CLI_ENTRY: string = join(packageRoot, 'dist', 'cli.js');

export interface AgentContext {
  /** `ws://127.0.0.1:<port>/ingest` — point the instrumented app here. */
  readonly ingestUrl: string;
  /** Environment variables the harness set on this process for the run. */
  readonly env: Record<string, string>;
}

export interface AuditOptions {
  /** Environment variables to set on the app process for the duration. */
  readonly env?: Record<string, string>;
  /** The instrumented agent. Returns the runIds it produced (or none). */
  readonly agent: (ctx: AgentContext) => Promise<void>;
  /** Wait for this many `run.finished` frames before collecting. Default 1. */
  readonly expectRuns?: number;
  /** Also exercise the telemetry path by running the CLI with CI unset. */
  readonly captureTelemetry?: boolean;
}

export interface AuditArtifacts {
  readonly artifacts: Artifact[];
  readonly runIds: string[];
  /** Raw viewer frames, parsed, for structural assertions. */
  readonly viewerFrames: unknown[];
  /** Telemetry request bodies captured off the wire (JSON text). */
  readonly telemetryBodies: string[];
  /** Path of the HTML export, for size / content spot checks. */
  readonly htmlPath: string | undefined;
  readonly ndjsonPath: string | undefined;
  readonly dir: string;
}

/**
 * A viewer: subscribes to '*' then to every run it learns about, and behaves
 * like a real one — it releases any gate the app holds with `continue`.
 * (Pause-on-error is armed by default in a fresh server DebugState, so an
 * adapter that gates on error would otherwise hold forever.)
 */
class ViewerClient {
  readonly rawFrames: string[] = [];
  readonly frames: unknown[] = [];
  readonly runIds = new Set<string>();
  finishedRuns = 0;
  resumedPauses = 0;
  private controlSeq = 0;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(httpUrl: string): Promise<ViewerClient> {
    const ws = new WebSocket(`${httpUrl.replace(/^http/, 'ws')}/ws/ui`);
    const client = new ViewerClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (data) => client.onFrame(String(data)));
    ws.send(JSON.stringify({ type: 'subscribe', runId: '*' }));
    return client;
  }

  private onFrame(text: string): void {
    this.rawFrames.push(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    this.frames.push(parsed);
    const frame = parsed as Record<string, unknown>;
    const type = frame['type'];

    if (type === 'runs' && Array.isArray(frame['runs'])) {
      for (const run of frame['runs'] as { id?: unknown }[]) {
        if (typeof run.id === 'string') this.subscribeRun(run.id);
      }
    }
    if (type === 'run.update') {
      const run = frame['run'] as { id?: unknown; status?: unknown } | undefined;
      if (run !== undefined && typeof run.id === 'string') this.subscribeRun(run.id);
    }
    if (type === 'event') {
      const envelope = frame['envelope'] as
        | { type?: unknown; runId?: unknown; payload?: Record<string, unknown> }
        | undefined;
      if (envelope !== undefined && typeof envelope.runId === 'string') {
        this.subscribeRun(envelope.runId);
      }
      if (envelope?.type === 'run.finished') this.finishedRuns += 1;
      if (envelope?.type === 'exec.paused' && typeof envelope.runId === 'string') {
        const pauseId = envelope.payload?.['pauseId'];
        if (typeof pauseId === 'string') this.resume(envelope.runId, pauseId);
      }
    }
  }

  /** Release a held gate the way the viewer's "continue" button does. */
  private resume(runId: string, pauseId: string): void {
    this.resumedPauses += 1;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'control',
          envelope: {
            gm: PROTOCOL_VERSION,
            seq: this.controlSeq++,
            ts: Date.now(),
            runId,
            type: 'exec.resume',
            payload: { pauseId, action: 'continue' },
          },
        }),
      );
    } catch {
      // socket closing; the app fails open on disconnect anyway
    }
  }

  private subscribeRun(runId: string): void {
    if (runId === '*' || this.runIds.has(runId)) return;
    this.runIds.add(runId);
    try {
      this.ws.send(JSON.stringify({ type: 'subscribe', runId }));
    } catch {
      // the socket is closing; nothing to do
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/** Collects POSTs to a local endpoint so telemetry can be read off the wire. */
class TelemetrySink {
  readonly bodies: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<TelemetrySink> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const sink = new TelemetrySink(server, `http://127.0.0.1:${port}/api/telemetry`);
    server.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        sink.bodies.push(
          JSON.stringify({
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.writeHead(204);
        res.end();
      });
    });
    return sink;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function readIfPresent(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

export async function runAudit(options: AuditOptions): Promise<AuditArtifacts> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-audit-'));
  const dbPath = join(dir, 'graphmind.db');
  const gmHome = join(dir, 'gm-home');

  const telemetry = await TelemetrySink.start();
  const restoreEnv = applyEnv({ ...(options.env ?? {}), GRAPHMIND_HOME: gmHome });

  let server: GraphMindServer | undefined;
  let viewer: ViewerClient | undefined;
  try {
    server = await startServer({
      port: 0,
      dbPath,
      openBrowser: false,
      log: () => {},
      env: { GRAPHMIND_RETENTION: 'off' },
    });
    viewer = await ViewerClient.connect(server.url);

    await options.agent({
      ingestUrl: `ws://127.0.0.1:${server.port}/ingest`,
      env: options.env ?? {},
    });

    const expected = options.expectRuns ?? 1;
    await waitUntil(
      () => viewer !== undefined && viewer.finishedRuns >= expected,
      20_000,
      `${expected} run.finished frame(s) at the viewer`,
    );

    // Give the last few envelopes time to be persisted before reading.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const runIds = [...viewer.runIds];
    const httpArtifacts = await fetchHttpArtifacts(server.url, runIds);
    viewer.close();
    await server.close(); // checkpoints the WAL
    server = undefined;

    const dbBytes = readIfPresent(dbPath);
    const walBytes = readIfPresent(`${dbPath}-wal`);
    const shmBytes = readIfPresent(`${dbPath}-shm`);

    const exportArtifacts: Artifact[] = [];
    let htmlPath: string | undefined;
    let ndjsonPath: string | undefined;
    const primaryRun = runIds[0];
    if (primaryRun !== undefined) {
      ndjsonPath = join(dir, 'export.ndjson');
      await runCli(
        ['record', primaryRun, '--db', dbPath, '--out', ndjsonPath],
        gmHome,
        telemetry.url,
        options.captureTelemetry === true,
      );
      exportArtifacts.push({
        name: 'NDJSON export (graphmind record)',
        surface: 'ndjson-export',
        content: readFileSync(ndjsonPath, 'utf8'),
      });

      htmlPath = join(dir, 'export.html');
      await runCli(
        ['record', primaryRun, '--db', dbPath, '--html', '--out', htmlPath],
        gmHome,
        telemetry.url,
        options.captureTelemetry === true,
      );
      exportArtifacts.push({
        name: 'HTML export (graphmind record --html)',
        surface: 'html-export',
        content: readFileSync(htmlPath, 'utf8'),
      });
    }

    // Telemetry is fire-and-forget with an unref'd socket: give it a beat.
    if (options.captureTelemetry === true) {
      await waitUntil(
        () => telemetry.bodies.length > 0,
        5_000,
        'a telemetry payload from the record CLI',
      ).catch(() => undefined);
    }

    const artifacts: Artifact[] = [
      ...(dbBytes !== undefined
        ? [{ name: 'SQLite database (raw bytes)', surface: 'sqlite', content: dbBytes }]
        : []),
      ...(walBytes !== undefined
        ? [{ name: 'SQLite WAL (raw bytes)', surface: 'sqlite', content: walBytes }]
        : []),
      ...(shmBytes !== undefined
        ? [{ name: 'SQLite SHM (raw bytes)', surface: 'sqlite', content: shmBytes }]
        : []),
      ...httpArtifacts,
      {
        name: 'WebSocket frames received by the viewer',
        surface: 'websocket',
        content: viewer.rawFrames.join('\n'),
      },
      ...exportArtifacts,
      {
        name: 'telemetry payloads',
        surface: 'telemetry',
        content: telemetry.bodies.join('\n'),
      },
    ];

    return {
      artifacts,
      runIds,
      viewerFrames: viewer.frames,
      telemetryBodies: telemetry.bodies,
      htmlPath,
      ndjsonPath,
      dir,
    };
  } finally {
    viewer?.close();
    if (server !== undefined) await server.close();
    await telemetry.close();
    restoreEnv();
  }
}

/** Delete the audit's scratch directory (call after assertions). */
export function cleanupAudit(result: AuditArtifacts): void {
  try {
    rmSync(result.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

async function fetchHttpArtifacts(baseUrl: string, runIds: string[]): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const runsRes = await fetch(`${baseUrl}/api/runs`);
  out.push({
    name: 'GET /api/runs',
    surface: 'http-api',
    content: await runsRes.text(),
  });
  for (const runId of runIds) {
    const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events?limit=5000`);
    out.push({
      name: `GET /api/runs/${runId}/events`,
      surface: 'http-api',
      content: await res.text(),
    });
  }
  return out;
}

/**
 * Run the shipped CLI in a child process. Telemetry is force-enabled only
 * when the caller asked for it (the CLI disables itself whenever CI is set,
 * which is exactly the behaviour the telemetry test also asserts).
 */
async function runCli(
  args: string[],
  gmHome: string,
  telemetryUrl: string,
  enableTelemetry: boolean,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRAPHMIND_HOME: gmHome,
    GRAPHMIND_TELEMETRY_URL: telemetryUrl,
  };
  if (enableTelemetry) {
    delete env['CI'];
    env['GRAPHMIND_TELEMETRY'] = '1';
  } else {
    env['GRAPHMIND_TELEMETRY'] = '0';
  }
  const { stdout } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Set env vars for the duration of the run; returns the undo. */
function applyEnv(vars: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export { runCli, waitUntil };
