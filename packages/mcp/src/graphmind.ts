/**
 * The public entry point of @graphmind-ai/mcp.
 *
 *   const gm = graphmind({ app: 'my-mcp-server' });
 *   const server = gm.wrapServer(new McpServer({ name: 'my-server', version: '1.0.0' }));
 *   server.registerTool('search', { inputSchema }, async ({ q }) => ({ content: [...] }));
 *   await server.connect(new StdioServerTransport());
 *
 * Fail-open invariants (inherited from @graphmind-ai/client and enforced at
 * this layer too): a disabled session makes `wrapServer` an identity function;
 * a detached session adds only buffered events and fast-path gates; the
 * adapter never throws into the host server; a debugger that disconnects
 * mid-hold auto-continues every held gate.
 */
import {
  createSession,
  type ReadyOptions,
  type RunContext,
  type SdkInfo,
  type Session,
  type SessionOptions,
} from '@graphmind-ai/client';
import { AdapterCore } from './core.js';
import { peerVersion } from './peer-version.js';
import { wrapServer } from './wrap-server.js';

const MCP_SDK = '@modelcontextprotocol/sdk';

export interface GraphmindOptions extends Omit<SessionOptions, 'appName' | 'sdk'> {
  /** Application name shown in the viewer. Default: "mcp-server". */
  app?: string;
  /** Override the reported SDK info. Default: the installed MCP SDK version. */
  sdk?: SdkInfo;
  /**
   * Override the name/version on the `server` node. By default the adapter
   * uses the `{ name, version }` you gave the SDK's own server, falling back
   * to `app`.
   */
  server?: { name?: string; version?: string };
  /**
   * Attach guarantee for the first execution: when `true` (default timeout,
   * 2000ms) or a number (timeout in ms), the first `connect()` — or the first
   * instrumented request, if the server was already connected — awaits
   * `gm.ready()` before proceeding, so the debugger's gates are armed from the
   * very first request. Still fail-open: on timeout the server carries on
   * detached. Later calls are unaffected. Equivalent to awaiting `gm.ready()`
   * before `connect()`.
   */
  waitForAttach?: boolean | number;
}

export interface Graphmind {
  /** The underlying GraphMind session (advanced: stats, custom events). */
  readonly session: Session;
  /**
   * Attach guarantee: force the lazy transport to connect now and resolve
   * `true` once the handshake completes (gates armed), `false` on timeout
   * (default 2000ms) or when GraphMind is disabled. Never throws; concurrent
   * calls share one attempt; resolves instantly when already attached; works
   * again after a disconnect. `false` means "continue detached", not an error.
   */
  ready(opts?: ReadyOptions): Promise<boolean>;
  /**
   * Return an instrumented VIEW of an MCP server (a Proxy — the server you
   * pass in is never mutated). Works on the high-level `McpServer` and on the
   * low-level `Server`. Register your tools, resources and prompts on the
   * value this returns and they are gated; `connect()` through it and the
   * viewer learns the graph. Identity when GraphMind is disabled.
   */
  wrapServer<T extends object>(server: T): T;
  /**
   * Optional explicit run boundary. Requests open their own runs, so this is
   * only for grouping work you drive yourself (a warm-up, a scheduled job): it
   * emits `run.started` / `run.finished` and carries the AbortController the
   * debugger's `abort` action uses. A request handled while this run is open
   * joins it instead of opening a second one.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /** Release held gates, close the socket, stop timers. Idempotent. */
  dispose(): Promise<void>;
}

/** The installed MCP SDK version, for the `sdk` field the viewer shows. */
function detectSdkVersion(): string {
  return peerVersion(MCP_SDK, import.meta.url) ?? 'unknown';
}

/**
 * Create a GraphMind adapter instance. Never throws; misconfiguration
 * degrades to a disabled session (see @graphmind-ai/client `createSession`).
 */
export function graphmind(options: GraphmindOptions = {}): Graphmind {
  const { app, sdk, server, waitForAttach, ...sessionOptions } = options;
  const appName = app ?? 'mcp-server';
  const session = createSession({
    ...sessionOptions,
    appName,
    sdk: sdk ?? { name: MCP_SDK, version: detectSdkVersion() },
  });
  const core = new AdapterCore(session, options.logger, waitForAttach);

  return {
    session,

    ready(opts?: ReadyOptions): Promise<boolean> {
      return session.ready(opts);
    },

    wrapServer<T extends object>(target: T): T {
      // Disabled = identity: zero overhead, zero surface.
      if (!session.enabled) return target;
      try {
        return wrapServer(target, core, {
          appName,
          ...(server !== undefined ? { server } : {}),
        });
      } catch (error) {
        core.warner.warn(
          'wrap-server-failed',
          `wrapServer failed; returning the server uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return target;
      }
    },

    run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T> {
      return session.run(name, fn);
    },

    async dispose(): Promise<void> {
      await session.dispose();
    },
  };
}
