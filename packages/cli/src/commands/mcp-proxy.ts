/**
 * `graphmind mcp-proxy -- <command> [args...]`
 *
 * The CLI shell around `startMcpProxy`: work out what to run, wire the real
 * process streams, and get out of the way. stdout belongs to the MCP protocol
 * from the first byte, so everything this file prints goes to stderr.
 */
import type { Readable, Writable } from 'node:stream';
import { resolveUrl } from '@graphmind-ai/client';
import type { ParsedCli } from '../args.js';
import { mcpProxyHelp } from '../mcp-proxy/help.js';
import { startMcpProxy } from '../mcp-proxy/proxy.js';
import { DEFAULT_PORT } from '../paths.js';
import { recordTelemetry } from '../telemetry.js';
import { VERSION } from '../version.js';

/**
 * How long to wait for the debugger before reporting whether it picked up.
 * Long enough for a local server that is already listening, short enough that
 * the answer arrives while the developer is still looking at the terminal.
 */
const ATTACH_NOTICE_MS = 1_500;

export interface McpProxyIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

const defaultIo = (): McpProxyIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

/** Print the zero-config guide. Always stderr — stdout is the wire. */
export function printMcpProxyHelp(write: (line: string) => void, port: number): void {
  for (const line of mcpProxyHelp(port)) write(line);
}

export async function runMcpProxy(parsed: ParsedCli, io: McpProxyIo = defaultIo()): Promise<number> {
  const err = (line: string): void => void io.stderr.write(`${line}\n`);

  // `--` is the documented form; bare positionals are accepted so that
  // `graphmind mcp-proxy node server.js` does the obvious thing too.
  const argv = parsed.rest !== undefined && parsed.rest.length > 0 ? parsed.rest : parsed.positionals;
  const port = parsed.flags.port ?? DEFAULT_PORT;

  const command = argv[0];
  if (command === undefined || command === '') {
    printMcpProxyHelp(err, port);
    return 1;
  }

  recordTelemetry('mcp-proxy');

  // `--port` targets a GraphMind on a non-default port. Without it, let the
  // client resolve the endpoint itself so GRAPHMIND_URL still works — passing
  // a hard-coded default here would silently override the user's env.
  const url =
    parsed.flags.port === undefined ? undefined : `ws://127.0.0.1:${parsed.flags.port}/ingest`;
  const effectiveUrl = resolveUrl(url, process.env as Record<string, string | undefined>);
  err(`graphmind mcp-proxy v${VERSION}: proxying ${argv.join(' ')}`);
  err(`graphmind mcp-proxy: reporting to ${effectiveUrl}`);

  const handle = startMcpProxy({
    command,
    args: argv.slice(1),
    clientIn: io.stdin,
    clientOut: io.stdout,
    clientErr: io.stderr,
    log: err,
    ...(url === undefined ? {} : { sessionOptions: { url } }),
    handleSignals: true,
    trace: parsed.flags.trace,
    waitForAttach: parsed.flags.waitForAttach,
    viewerUrl: `http://127.0.0.1:${port}`,
    captureStderr: !parsed.flags.inheritStderr,
    ...(parsed.flags.maxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: parsed.flags.maxFrameBytes }),
  });

  // Say whether the debugger actually picked up, once, as soon as we know.
  //
  // The proxy is deliberately invisible when GraphMind is not running — that
  // is what makes it safe to leave in an `mcpServers` config forever — but
  // "invisible" and "you forgot to start it" look identical from the outside,
  // and someone who wanted a graph gets a normal-looking session and no
  // graph. The old line said "run `graphmind` to watch; nothing breaks if it
  // is not up", which is true and is not an answer to "will I get a graph".
  //
  // Reported here rather than at exit because an MCP host does not close the
  // pipe on shutdown, it KILLS the child — so an exit-time message is the one
  // message that never prints where it is needed.
  void handle.session
    .ready({ timeoutMs: ATTACH_NOTICE_MS })
    .then((attached) => {
      if (attached) {
        err(`graphmind mcp-proxy: attached — watch it at http://127.0.0.1:${port}`);
        return;
      }
      // Deliberately "not yet": the client keeps retrying and replays its
      // buffer, so starting the debugger now still captures this session.
      err(
        `graphmind mcp-proxy: GraphMind is not running at ${effectiveUrl}, so nothing is ` +
          'being recorded yet. Start it and this session will attach: npx graphmind-ai',
      );
    })
    .catch(() => undefined);

  return await handle.done;
}
