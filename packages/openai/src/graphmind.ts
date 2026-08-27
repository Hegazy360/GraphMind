/**
 * The public entry point of @graphmind-ai/openai.
 *
 *   const gm = graphmind({ app: 'support-agent' });
 *   const client = gm.wrapClient(new OpenAI());
 *   const tools = gm.wrapTools({ searchFlights, checkBudget });
 *   await gm.run('handle-ticket', async () => { ... });
 *   await gm.dispose();
 *
 * Fail-open invariants (inherited from @graphmind-ai/client and enforced at
 * this layer too): a disabled session makes wrapClient/wrapTools identity
 * functions; a detached session adds only buffered events and fast-path
 * gates; the adapter never throws into the host app; a debugger that
 * disconnects mid-hold auto-continues every held gate.
 */
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
import { peerVersion } from './peer-version.js';
import { wrapClient } from './wrap-client.js';
import { wrapToolMap } from './wrap-tools.js';

export interface GraphmindOptions extends Omit<SessionOptions, 'appName' | 'sdk'> {
  /** Application name shown in the viewer. Default: "openai-app". */
  app?: string;
  /** Override the reported SDK info. Default: the installed `openai` version. */
  sdk?: SdkInfo;
  /** node.token batching interval per node in ms. Default 34 (~30/sec). */
  tokenFlushIntervalMs?: number;
  /**
   * Attach guarantee for the first execution: when `true` (default timeout,
   * 2000ms) or a number (timeout in ms), the first `gm.run()` / first wrapped
   * request / first wrapped tool call awaits `gm.ready()` before proceeding,
   * so the debugger's gates are armed from the very first event. Still
   * fail-open: on timeout execution continues detached. Later calls are
   * unaffected. Equivalent to calling `await gm.ready(...)` up front.
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
   * Wrap an OpenAI client so `chat.completions.create` and `responses.create`
   * (plus the `.stream()` / `.parse()` / `.runTools()` helpers built on them)
   * stream execution events and honour gates. Proxy-based: the original client
   * is never mutated. Identity when GraphMind is disabled.
   */
  wrapClient<T>(client: T): T;
  /**
   * Wrap the functions your loop dispatches tool calls to with before / after
   * / error gates. Identity when GraphMind is disabled.
   */
  wrapTools<T extends Record<string, unknown>>(tools: T): T;
  /**
   * Optional explicit run boundary (recommended): groups everything `fn` does
   * into one run (AsyncLocalStorage), emits `run.started`/`run.finished` plus
   * an agent node, and carries the AbortController the debugger's `abort`
   * action uses.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /** Release held gates, flush pending events, close the socket. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * The installed `openai` version, for the `sdk` field the viewer shows.
 * `openai`'s `exports` map does not list `./package.json`, so this goes
 * through `peerVersion`, which falls back to the manifest on disk. Degrades
 * to `'unknown'` rather than failing.
 */
function detectOpenAiVersion(): string {
  return peerVersion('openai', import.meta.url) ?? 'unknown';
}

/**
 * Create a GraphMind adapter instance. Never throws; misconfiguration
 * degrades to a disabled session (see @graphmind-ai/client `createSession`).
 */
export function graphmind(options: GraphmindOptions = {}): Graphmind {
  const { app, sdk, tokenFlushIntervalMs, waitForAttach, ...sessionOptions } = options;
  const session = createSession({
    ...sessionOptions,
    appName: app ?? 'openai-app',
    sdk: sdk ?? { name: 'openai', version: detectOpenAiVersion() },
  });
  const core = new AdapterCore(session, options.logger, tokenFlushIntervalMs, waitForAttach);

  return {
    session,

    ready(opts?: ReadyOptions): Promise<boolean> {
      return session.ready(opts);
    },

    wrapClient<T>(client: T): T {
      return wrapClient(client, core);
    },

    wrapTools<T extends Record<string, unknown>>(tools: T): T {
      if (!session.enabled) return tools;
      try {
        return wrapToolMap(tools, core);
      } catch (error) {
        core.warner.warn(
          'wrap-tools-failed',
          `wrapTools failed; returning the tools uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return tools;
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
        }
      });
    },

    async dispose(): Promise<void> {
      core.dispose();
      await session.dispose();
    },
  };
}
