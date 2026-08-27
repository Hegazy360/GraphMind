/**
 * A real `graphmind-ai` server per scenario: ephemeral port, throwaway SQLite
 * file, no browser, no telemetry (telemetry only fires from the CLI binary).
 * Nothing here is a stub — this is the same `startServer` the `graphmind`
 * command runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type GraphMindServer } from 'graphmind-ai';

export interface LiveServer {
  port: number;
  ingestUrl: string;
  uiUrl: string;
  server: GraphMindServer;
  /** Stop the server and delete its database. Idempotent. */
  stop(): Promise<void>;
}

export async function startLiveServer(): Promise<LiveServer> {
  const dir = mkdtempSync(join(tmpdir(), 'graphmind-live-'));
  const server = await startServer({
    port: 0,
    dbPath: join(dir, 'live-check.db'),
    openBrowser: false,
    log: () => {},
    // An empty env keeps GRAPHMIND_DB / GRAPHMIND_TELEMETRY from the developer's
    // shell out of the run.
    env: {},
  });
  let stopped = false;
  return {
    port: server.port,
    ingestUrl: `ws://127.0.0.1:${server.port}/ingest`,
    uiUrl: `ws://127.0.0.1:${server.port}/ws/ui`,
    server,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await server.close();
      } catch {
        // best effort
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
