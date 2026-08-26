/**
 * The public entry point of @graphmind-ai/anthropic.
 *
 *   const gm = graphmind({ app: 'support-agent' });
 *   const client = gm.wrapClient(new Anthropic());
 *   const tools = gm.wrapTools({ searchFlights, checkBudget });
 *   await gm.run('handle-ticket', async () => { ...your loop... });
 *   await gm.ready();
 *   await gm.dispose();
 *
 * Fail-open invariants (inherited from @graphmind-ai/client and enforced at
 * this layer too): a disabled session makes wrapClient/wrapTools identity
 * functions; a detached session adds only buffered events and fast-path
 * gates; the adapter never throws into the host app; a debugger that
 * disconnects mid-hold auto-continues every held gate.
 */
import { createRequire } from 'node:module';
import {
  createSession,
  isAbortError,
  toErrorInfo,
  type ReadyOptions,
  type RunContext,
  type SdkInfo,
  type Session,
  type SessionOptions,
} from '@graphmind-ai/client';
import { AdapterCore } from './core.js';
import { agentNodeId } from './ids.js';
import { wrapClient } from './wrap-client.js';
import {
  wrapToolFn,
  wrapToolSet,
  type AnyToolFn,
  type GatedFn,
  type GatedTools,
  type ToolFnSet,
} from './wrap-tools.js';

export interface GraphmindOptions extends Omit<SessionOptions, 'appName' | 'sdk'> {
  /** Application name shown in the viewer. Default: "anthropic-app". */
  app?: string;
  /** Override the reported SDK info. Default: the installed SDK version. */
  sdk?: SdkInfo;
  /** node.token batching interval per node in ms. Default 34 (~30/sec). */
  tokenFlushIntervalMs?: number;
  /**
   * Attach guarantee for the first execution: when `true` (default timeout,
   * 2000ms) or a number (timeout in ms), the first `gm.run()` / first
   * instrumented `messages.create` / first wrapped tool call awaits
   * `gm.ready()` before proceeding, so the debugger's gates are armed from the
   * very first event. Still fail-open: on timeout execution continues
   * detached. Later calls are unaffected. Equivalent to awaiting `gm.ready()`
   * up front.
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
   * Return an instrumented VIEW of an Anthropic client (a Proxy — the client
   * you pass in is never mutated). `messages.create` (streaming and
   * non-streaming) and `messages.stream` are gated and observed, on both
   * `client.messages` and `client.beta.messages`. Identity when GraphMind is
   * disabled.
   */
  wrapClient<T extends object>(client: T): T;
  /**
   * Wrap each tool function with before/after/error gates. Wrapped tools are
   * always async. Identity when GraphMind is disabled.
   */
  wrapTools<T extends ToolFnSet>(tools: T): GatedTools<T>;
  /** Single-function form of `wrapTools`. */
  tool<F extends AnyToolFn>(name: string, fn: F): GatedFn<F>;
  /**
   * Optional explicit run boundary (recommended): groups everything `fn` does
   * into one run (AsyncLocalStorage), emits `run.started`/`run.finished` plus
   * an agent node, chains successive `messages.create` calls into one
   * invocation, and carries the AbortController the debugger's `abort` action
   * uses.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /** Release held gates, flush pending events, close the socket. Idempotent. */
  dispose(): Promise<void>;
}

function detectSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // The package exports `./version` but not `./package.json`.
    const mod = require('@anthropic-ai/sdk/version.js') as { VERSION?: string };
    return typeof mod.VERSION === 'string' ? mod.VERSION : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a GraphMind adapter instance. Never throws; misconfiguration
 * degrades to a disabled session (see @graphmind-ai/client `createSession`).
 */
export function graphmind(options: GraphmindOptions = {}): Graphmind {
  const { app, sdk, tokenFlushIntervalMs, waitForAttach, ...sessionOptions } = options;
  const session = createSession({
    ...sessionOptions,
    appName: app ?? 'anthropic-app',
    sdk: sdk ?? { name: '@anthropic-ai/sdk', version: detectSdkVersion() },
  });
  const core = new AdapterCore(session, options.logger, tokenFlushIntervalMs, waitForAttach);

  return {
    session,

    ready(opts?: ReadyOptions): Promise<boolean> {
      return session.ready(opts);
    },

    wrapClient<T extends object>(client: T): T {
      // Disabled = identity: zero overhead, zero surface.
      if (!session.enabled) return client;
      try {
        return wrapClient(client, core);
      } catch (error) {
        core.warner.warn(
          'wrap-client-failed',
          `wrapClient failed; returning the client uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return client;
      }
    },

    wrapTools<T extends ToolFnSet>(tools: T): GatedTools<T> {
      if (!session.enabled) return tools as unknown as GatedTools<T>;
      try {
        return wrapToolSet(tools, core);
      } catch (error) {
        core.warner.warn(
          'wrap-tools-failed',
          `wrapTools failed; returning the tools uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return tools as unknown as GatedTools<T>;
      }
    },

    tool<F extends AnyToolFn>(name: string, fn: F): GatedFn<F> {
      if (!session.enabled) return fn as unknown as GatedFn<F>;
      try {
        return wrapToolFn(name, fn, core);
      } catch (error) {
        core.warner.warn(
          'wrap-tool-failed',
          `tool("${name}") failed; returning it uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return fn as unknown as GatedFn<F>;
      }
    },

    async run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T> {
      const attachWait = core.maybeWaitForAttach(); // waitForAttach: first-run gate
      if (attachWait !== undefined) await attachWait;
      return session.run(name, async (ctx) => {
        const nodeId = agentNodeId(name);
        const startedAt = Date.now();
        core.startNode({
          nodeId,
          kind: 'agent',
          name,
          instanceId: ctx.runId,
          input: undefined,
        });
        try {
          const result = await fn(ctx);
          core.finishNode({
            nodeId,
            instanceId: ctx.runId,
            output: undefined,
            durationMs: Date.now() - startedAt,
            status: ctx.signal.aborted ? 'aborted' : 'ok',
          });
          return result;
        } catch (error) {
          const aborted = ctx.signal.aborted || isAbortError(error);
          if (!aborted) {
            core.session.emit('node.error', {
              nodeId,
              instanceId: ctx.runId,
              error: toErrorInfo(error),
            });
          }
          core.finishNode({
            nodeId,
            instanceId: ctx.runId,
            output: undefined,
            durationMs: Date.now() - startedAt,
            status: aborted ? 'aborted' : 'error',
          });
          throw error; // the host's own error — always propagates
        } finally {
          core.clearToolUseScope(ctx.runId);
        }
      });
    },

    async dispose(): Promise<void> {
      core.dispose();
      await session.dispose();
    },
  };
}
