/**
 * `graphmind mcp` — expose runs/steps to MCP clients (Claude Code, Cursor)
 * over stdio. Reads the SQLite DB directly (same resolution as `serve`:
 * `--db` beats `GRAPHMIND_DB` beats `~/.graphmind/graphmind.db`), so it
 * works while the GraphMind server/viewer is closed. stdout is the MCP
 * transport — all human output goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ParsedCli } from '../args.js';
import { createMcpServer } from '../mcp/server.js';
import { DEFAULT_PORT, resolveDbPath } from '../paths.js';
import { SqliteStorage } from '../sqlite-storage.js';
import { recordTelemetry } from '../telemetry.js';

export async function runMcp(parsed: ParsedCli): Promise<number> {
  recordTelemetry('mcp');
  if (parsed.positionals.length > 0) {
    console.error(`graphmind mcp: unexpected argument "${parsed.positionals[0]}"`);
    return 1;
  }

  const dbPath = resolveDbPath(parsed.flags.db);
  let storage: SqliteStorage;
  try {
    storage = new SqliteStorage(dbPath);
  } catch (error) {
    console.error(
      `graphmind mcp: cannot open database at ${dbPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  const port = parsed.flags.port ?? DEFAULT_PORT;
  const server = createMcpServer({
    storage,
    viewerBaseUrl: `http://127.0.0.1:${port}`,
  });

  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });

  await server.connect(new StdioServerTransport());
  console.error(`graphmind mcp: serving runs from ${dbPath} over stdio`);
  console.error(`graphmind mcp: deep links target http://127.0.0.1:${port} (run \`graphmind\` to open them)`);

  const shutdown = () => {
    void server.close().catch(() => {});
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await closed; // resolves when the client disconnects (stdin closes) or on signal
  storage.close();
  return 0;
}
