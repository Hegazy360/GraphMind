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
  err(
    `graphmind mcp-proxy: reporting to ${effectiveUrl} ` +
      '(run `graphmind` to watch; nothing breaks if it is not up)',
  );

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

  return await handle.done;
}
