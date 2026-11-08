/**
 * McpConnections — the engine's McpGateway over real MCP servers.
 *
 * - Connections are opened lazily on first use and reused (stdio child
 *   processes or Streamable HTTP).
 * - **Tool pinning (trust on first use):** the first time a tool is seen, a
 *   SHA-256 of its name, description and input schema is pinned. If a later
 *   listing differs — a "rug pull", or just an upgraded server — calls to that
 *   tool pause for a human instead of silently running a tool whose meaning
 *   changed. Accepting the change re-pins it.
 * - **Policy per tool:** allow (default) | approve (every call pauses for a
 *   human) | deny (the step fails with PolicyDenied).
 * - A tool that *returns* an error (isError) is a failed step, not a success
 *   — so it retries and pauses like any other failure.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpGateway, McpPolicy } from '@graphmind-ai/circuit-engine';
import type { JsonValue } from '@graphmind-ai/circuit-schema';

export type ConnectionSpec = (
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  /** Tests and embedders: supply a ready transport. */
  | { transport: 'custom'; connect: () => Transport | Promise<Transport> }
) & {
  /** Per-tool policy; `*` sets the default. Unlisted tools: allow. */
  policy?: Record<string, McpPolicy>;
};

export interface McpConfig {
  connections: Record<string, ConnectionSpec>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Where pins live. File-backed in dev; the hosted service stores them per environment. */
export interface PinStore {
  get(connection: string, tool: string): string | undefined;
  set(connection: string, tool: string, hash: string): void;
}

export class MemoryPinStore implements PinStore {
  private readonly pins = new Map<string, string>();
  get(c: string, t: string) {
    return this.pins.get(`${c}\u0000${t}`);
  }
  set(c: string, t: string, h: string) {
    this.pins.set(`${c}\u0000${t}`, h);
  }
}

export class FilePinStore implements PinStore {
  private data: Record<string, Record<string, string>>;
  constructor(private readonly path: string) {
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
    } catch {
      this.data = {};
    }
  }
  get(c: string, t: string) {
    return this.data[c]?.[t];
  }
  set(c: string, t: string, h: string) {
    (this.data[c] ??= {})[t] = h;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

export function toolHash(tool: ToolInfo): string {
  const canonical = JSON.stringify([tool.name, tool.description ?? '', sortKeys(tool.inputSchema)]);
  return createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export class McpToolError extends Error {
  override name = 'McpToolError';
}

export class UnknownConnectionError extends Error {
  override name = 'UnknownConnectionError';
}

/** Turn a CallToolResult into the step's JSON value (or a thrown failure). */
export function toolResultValue(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): JsonValue {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  if (result.isError === true) throw new McpToolError(text || 'the tool reported an error');
  if (result.structuredContent !== undefined) return result.structuredContent as JsonValue;
  if (text === '') return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export class McpConnections implements McpGateway {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly tools = new Map<string, Map<string, ToolInfo>>();

  constructor(
    private readonly config: McpConfig,
    private readonly pins: PinStore = new MemoryPinStore(),
  ) {}

  connectionNames(): string[] {
    return Object.keys(this.config.connections);
  }

  private spec(connection: string): ConnectionSpec {
    const spec = this.config.connections[connection];
    if (!spec) {
      throw new UnknownConnectionError(
        `No MCP connection named '${connection}'. Configured: ${this.connectionNames().join(', ') || '(none)'}`,
      );
    }
    return spec;
  }

  private client(connection: string): Promise<Client> {
    let pending = this.clients.get(connection);
    if (!pending) {
      const spec = this.spec(connection);
      pending = (async () => {
        let transport: Transport;
        if (spec.transport === 'stdio') {
          transport = new StdioClientTransport({
            command: spec.command,
            args: spec.args ?? [],
            ...(spec.env !== undefined ? { env: spec.env } : {}),
            ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
            stderr: 'ignore',
          });
        } else if (spec.transport === 'http') {
          transport = new StreamableHTTPClientTransport(
            new URL(spec.url),
            spec.headers ? { requestInit: { headers: spec.headers } } : undefined,
          );
        } else {
          transport = await spec.connect();
        }
        const client = new Client({ name: 'graphmind-circuit', version: '0.0.1' });
        await client.connect(transport);
        return client;
      })();
      // A failed connect must not poison the cache: the next step retries it.
      pending.catch(() => this.clients.delete(connection));
      this.clients.set(connection, pending);
    }
    return pending;
  }

  /** List (and cache) a connection's tools. `refresh` re-reads them from the server. */
  async listTools(connection: string, refresh = false): Promise<ToolInfo[]> {
    if (!refresh && this.tools.has(connection)) return [...(this.tools.get(connection)?.values() ?? [])];
    const client = await this.client(connection);
    const found = new Map<string, ToolInfo>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        found.set(t.name, {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.tools.set(connection, found);
    return [...found.values()];
  }

  private policyFor(connection: string, tool: string): McpPolicy {
    const policy = this.spec(connection).policy ?? {};
    return policy[tool] ?? policy['*'] ?? 'allow';
  }

  async inspect(connection: string, tool: string): Promise<{ policy: McpPolicy; changed?: string }> {
    const policy = this.policyFor(connection, tool);
    // Always re-list here: a definition can change between runs.
    const info = (await this.listTools(connection, true)).find((t) => t.name === tool);
    if (!info) throw new McpToolError(`MCP server '${connection}' has no tool '${tool}'`);
    const hash = toolHash(info);
    const pinned = this.pins.get(connection, tool);
    if (pinned === undefined) {
      this.pins.set(connection, tool, hash); // trust on first use
      return { policy };
    }
    if (pinned !== hash) return { policy, changed: `pinned ${pinned.slice(0, 12)}…, now ${hash.slice(0, 12)}…` };
    return { policy };
  }

  async call(connection: string, tool: string, args: JsonValue, opts: { acceptDefinition: boolean }): Promise<JsonValue> {
    const client = await this.client(connection);
    if (opts.acceptDefinition) {
      const info = (await this.listTools(connection, true)).find((t) => t.name === tool);
      if (info) this.pins.set(connection, tool, toolHash(info));
    }
    const result = await client.callTool({
      name: tool,
      arguments: (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>,
    });
    return toolResultValue(result as Parameters<typeof toolResultValue>[0]);
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map(async (p) => (await p.catch(() => null))?.close().catch(() => {})));
  }
}

export function loadMcpConfig(path: string): McpConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as McpConfig;
  if (!raw || typeof raw !== 'object' || typeof raw.connections !== 'object') {
    throw new Error(`${path}: expected {"connections": {"<name>": {"transport": "stdio"|"http", ...}}}`);
  }
  return raw;
}
