/**
 * The public entry point of @graphmind/ai-sdk.
 *
 *   const gm = graphmind({ app: 'support-agent' });
 *   const model = gm.wrapModel(anyLanguageModel);
 *   const tools = gm.wrapTools({ searchFlights, checkBudget });
 *   await gm.run('handle-ticket', () => streamText({ model, tools, ... }));
 *   gm.dispose();
 *
 * Fail-open invariants (inherited from @graphmind/client and enforced at
 * this layer too): a disabled session makes wrapModel/wrapTools identity
 * functions; a detached session adds only buffered events and fast-path
 * gates; the adapter never throws into the host app; a debugger that
 * disconnects mid-hold auto-continues every held gate.
 */
import { createRequire } from 'node:module';
import {
  createSession,
  isAbortError,
  toErrorInfo,
  type RunContext,
  type SdkInfo,
  type Session,
  type SessionOptions,
} from '@graphmind/client';
import { wrapLanguageModel, type ToolSet } from 'ai';
import { AdapterCore } from './core.js';
import { agentNodeId } from './ids.js';
import { createDebugMiddleware } from './middleware.js';
import { wrapToolSet } from './wrap-tools.js';

/** Anything `wrapLanguageModel` accepts (a V2/V3/V4 language model). */
export type WrapModelInput = Parameters<typeof wrapLanguageModel>[0]['model'];
/** What `wrapLanguageModel` returns (a spec-V4 language model). */
export type WrappedLanguageModel = ReturnType<typeof wrapLanguageModel>;

export interface GraphmindOptions extends Omit<SessionOptions, 'appName' | 'sdk'> {
  /** Application name shown in the viewer. Default: "ai-app". */
  app?: string;
  /** Override the reported SDK info. Default: the installed `ai` version. */
  sdk?: SdkInfo;
  /** node.token batching interval per node in ms. Default 34 (~30/sec). */
  tokenFlushIntervalMs?: number;
}

export interface Graphmind {
  /** The underlying GraphMind session (advanced: stats, custom events). */
  readonly session: Session;
  /**
   * Wrap a language model with the debug middleware (via the SDK's public
   * `wrapLanguageModel`). Identity when GraphMind is disabled.
   */
  wrapModel(model: WrapModelInput): WrappedLanguageModel;
  /**
   * Wrap every tool's `execute` with before/after/error gates. Identity when
   * GraphMind is disabled. Provider-executed tools pass through untouched
   * (observed from the stream instead).
   */
  wrapTools<TOOLS extends ToolSet>(tools: TOOLS): TOOLS;
  /**
   * Optional explicit run boundary: groups everything `fn` does into one run
   * (AsyncLocalStorage), emits `run.started`/`run.finished` plus an agent
   * node, and carries the AbortController the debugger's `abort` action uses.
   */
  run<T>(name: string, fn: (ctx: RunContext) => T | Promise<T>): Promise<T>;
  /** Release held gates, flush pending events, close the socket. Idempotent. */
  dispose(): Promise<void>;
}

function detectAiVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('ai/package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a GraphMind adapter instance. Never throws; misconfiguration
 * degrades to a disabled session (see @graphmind/client `createSession`).
 */
export function graphmind(options: GraphmindOptions = {}): Graphmind {
  const { app, sdk, tokenFlushIntervalMs, ...sessionOptions } = options;
  const session = createSession({
    ...sessionOptions,
    appName: app ?? 'ai-app',
    sdk: sdk ?? { name: 'ai', version: detectAiVersion() },
  });
  const core = new AdapterCore(session, options.logger, tokenFlushIntervalMs);
  const middleware = createDebugMiddleware(core);

  return {
    session,

    wrapModel(model: WrapModelInput): WrappedLanguageModel {
      // Disabled = identity: zero overhead, zero surface. (The SDK accepts
      // V2/V3 models directly, so returning the input unchanged is safe.)
      if (!session.enabled) return model as WrappedLanguageModel;
      try {
        return wrapLanguageModel({ model, middleware });
      } catch (error) {
        core.warner.warn(
          'wrap-model-failed',
          `wrapModel failed; returning the model uninstrumented (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        return model as WrappedLanguageModel;
      }
    },

    wrapTools<TOOLS extends ToolSet>(tools: TOOLS): TOOLS {
      if (!session.enabled) return tools;
      try {
        return wrapToolSet(tools, core);
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
            output: undefined,
            durationMs: Date.now() - startedAt,
            status: ctx.signal.aborted ? 'aborted' : 'ok',
          });
          return result;
        } catch (error) {
          const aborted = ctx.signal.aborted || isAbortError(error);
          if (!aborted) {
            core.session.emit('node.error', { nodeId, error: toErrorInfo(error) });
          }
          core.finishNode({
            nodeId,
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
