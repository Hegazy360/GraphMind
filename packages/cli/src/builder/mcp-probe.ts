/**
 * "Test connection" for an MCP node on the canvas: connect to the server the
 * way the generated project will, list its tools, disconnect. The result is
 * what the engineer needs to decide whether the node is right — did it
 * connect, what did it call itself, which tools does it publish — and
 * nothing a run would not reveal anyway.
 *
 * Boundaries, since this spawns a process from an HTTP request:
 *
 *  - only the viewer token reaches it (routes.ts), the same gate as Run;
 *  - a stdio server is spawned with an argv array and no shell, and gets
 *    the MCP SDK's default environment (PATH, HOME and friends), NOT this
 *    server's environment — the debugger's own credentials never cross;
 *  - an HTTP server's bearer token arrives in the request, is used for this
 *    one connection, and is scrubbed out of any message that comes back.
 *    It is never stored and never logged;
 *  - everything is bounded by a timeout, and the child is closed whether
 *    the probe succeeded or not.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { REDACTED } from '../redact-secrets.js';
import type { McpServerSpec } from './spec.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
/** How much of a stdio server's stderr to keep for the failure message. */
const STDERR_TAIL_CHARS = 1500;

export interface ProbeTool {
  name: string;
  description: string;
}

export type ProbeResult =
  | {
      ok: true;
      server: { name: string; version: string };
      tools: ProbeTool[];
      ms: number;
    }
  | {
      ok: false;
      message: string;
      /** The last lines a stdio server wrote to stderr, if any. */
      stderr?: string;
      ms: number;
    };

export interface ProbeOptions {
  /** For an HTTP server that asked for one. Used once; never kept. */
  bearer?: string | undefined;
  timeoutMs?: number | undefined;
}

/** Keep a secret out of anything that goes back to the page. */
function scrubber(secret: string | undefined): (text: string) => string {
  if (secret === undefined || secret.length < 6) return (text) => text;
  return (text) => text.split(secret).join(REDACTED);
}

function transportFor(spec: McpServerSpec, bearer: string | undefined) {
  if (spec.transport === 'stdio') {
    return new StdioClientTransport({
      command: spec.command,
      args: [...spec.args],
      // The SDK's default environment, not ours: PATH and the handful of
      // variables a process needs to start, nothing the debugger holds.
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    });
  }
  const headers: Record<string, string> = {};
  if (bearer !== undefined && bearer !== '') headers['Authorization'] = `Bearer ${bearer}`;
  return new StreamableHTTPClientTransport(new URL(spec.url), Object.keys(headers).length === 0 ? undefined : { requestInit: { headers } });
}

export async function probeMcpServer(spec: McpServerSpec, options: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  const scrub = scrubber(options.bearer);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const client = new Client({ name: 'graphmind-builder-probe', version: '1.0.0' });
  let stderrTail = '';
  let transport: ReturnType<typeof transportFor> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    transport = transportFor(spec, options.bearer);
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      timer.unref();
    });
    // The SDK's transport types are not written for exactOptionalPropertyTypes.
    await Promise.race([client.connect(transport as unknown as Transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    const info = client.getServerVersion();
    return {
      ok: true,
      server: { name: info?.name ?? spec.name, version: info?.version ?? '' },
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        description: scrub(tool.description ?? ''),
      })),
      ms: Date.now() - started,
    };
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    const tail = scrub(stderrTail.trim());
    return {
      ok: false,
      message: message === '' ? 'the server did not connect' : message,
      ...(tail === '' ? {} : { stderr: tail }),
      ms: Date.now() - started,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // already gone
    }
    try {
      await transport?.close();
    } catch {
      // already gone
    }
  }
}
