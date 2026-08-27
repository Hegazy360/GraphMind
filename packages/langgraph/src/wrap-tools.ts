/**
 * Tool wrapping: the honest answer to "how do I get inject with LangGraph".
 *
 * A callback handler observes; it cannot change what it observed. The gates
 * that substitute a result (`inject`) or run it again (`retry`) need a real
 * position in the call stack, so they live here — around the function the tool
 * actually executes:
 *
 *  - `gm.tool(name, fn)` / `gm.wrapTools({...})` wrap a plain async function.
 *  - `gm.wrapStructuredTool(t)` clones a LangChain `tool()` / StructuredTool
 *    and replaces its `func` (or, for class-based tools, its `invoke`).
 *
 * Per call:
 *   `before` gate -> inject returns the value, abort throws, retry re-enters
 *   original call
 *   on throw -> `error` gate BEFORE LangChain sees it: inject swallows the
 *     error and returns the value, retry re-runs, continue rethrows, abort
 *     throws an AbortError-named error
 *   `after` gate post-call, pre-return -> inject substitutes the result
 *
 * EVENTS. When the callback handler is attached it has already announced this
 * tool run (with LangChain's own run id, parentage and toolCallId), so the
 * wrapper stays quiet and only leaves annotations (`injected`, `attempts`) for
 * the handler's `node.finished`. With no handler attached the wrapper emits the
 * node events itself, so a wrapped tool is useful on its own.
 */
import {
  isAbortError,
  type GateDecision,
  type GateNode,
  type RunStatus,
} from '@graphmind-ai/client';
import type { AdapterCore, ToolRunLink } from './core.js';
import { nextId, toolNodeId } from './ids.js';

/** A plain function that can be gated: `(input, ...rest) => result`. */
export type GatedFunction<A extends unknown[] = unknown[], R = unknown> = (
  ...args: A
) => R | Promise<R>;

/** The minimum a LangChain tool must look like for `wrapStructuredTool`. */
export interface StructuredToolLike {
  name?: unknown;
  func?: unknown;
  invoke?: unknown;
}

interface CallSite {
  /** LangChain's tool run id, when the call came through a StructuredTool. */
  runId: string | undefined;
  link: ToolRunLink | undefined;
}

/**
 * Wrap a plain function with the full gate set. `name` is the logical node
 * name; the node id is `tool:<name>`.
 */
export function gateFunction<A extends unknown[], R>(
  core: AdapterCore,
  name: string,
  original: GatedFunction<A, R>,
): GatedFunction<A, R> {
  return async (...args: A): Promise<R> => {
    const attachWait = core.maybeWaitForAttach();
    if (attachWait !== undefined) await attachWait;
    return runGated(core, name, { runId: undefined, link: undefined }, args[0], () =>
      original(...args),
    ) as Promise<R>;
  };
}

/**
 * Clone a LangChain tool with its executing function gated. The clone keeps
 * the prototype (so `isStructuredTool`, `.name`, `.schema`, serialization and
 * LangGraph's `ToolNode` all still work) and never mutates the original.
 */
export function wrapStructuredTool<T extends StructuredToolLike>(core: AdapterCore, tool: T): T {
  const name = typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : 'tool';
  core.wrapperGatedTools.add(name);

  const clone = cloneTool(tool);

  if (typeof tool.func === 'function') {
    // DynamicTool / DynamicStructuredTool (everything `tool()` builds).
    // `func(input, runManager, config)` — runManager.runId is the SAME run id
    // the callback handler saw in handleToolStart, which is how the two sides
    // find each other.
    const original = tool.func as (...args: unknown[]) => unknown;
    (clone as { func: unknown }).func = async (...args: unknown[]): Promise<unknown> => {
      const attachWait = core.maybeWaitForAttach();
      if (attachWait !== undefined) await attachWait;
      const runId = readRunId(args[1]);
      return runGated(core, name, { runId, link: core.toolLink(runId) }, args[0], () =>
        original.apply(clone, args),
      );
    };
    return clone;
  }

  if (typeof tool.invoke === 'function') {
    // A class-based StructuredTool: gate around `invoke`. LangChain's own tool
    // callbacks fire INSIDE the original invoke, so the handler still reports
    // the run; the wrapper's gates simply sit outside it.
    const original = tool.invoke as (...args: unknown[]) => unknown;
    (clone as { invoke: unknown }).invoke = async (...args: unknown[]): Promise<unknown> => {
      const attachWait = core.maybeWaitForAttach();
      if (attachWait !== undefined) await attachWait;
      return runGated(core, name, { runId: undefined, link: undefined }, args[0], () =>
        original.apply(clone, args),
      );
    };
    return clone;
  }

  core.warner.warn(
    `unwrappable-tool:${name}`,
    `wrapStructuredTool("${name}") found neither \`func\` nor \`invoke\`; the tool was returned ` +
      'unchanged and stays observe-only.',
  );
  core.wrapperGatedTools.delete(name);
  return tool;
}

/** Shallow clone that preserves the prototype and own (including accessor) props. */
function cloneTool<T extends object>(tool: T): T {
  const clone = Object.create(
    Object.getPrototypeOf(tool) as object,
    Object.getOwnPropertyDescriptors(tool),
  ) as T;
  return clone;
}

function readRunId(runManager: unknown): string | undefined {
  if (runManager === null || typeof runManager !== 'object') return undefined;
  const runId = (runManager as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

/** The gate loop shared by every wrapping style. */
async function runGated(
  core: AdapterCore,
  name: string,
  site: CallSite,
  input: unknown,
  call: () => unknown,
): Promise<unknown> {
  const nodeId = site.link?.nodeId ?? toolNodeId(name);
  const node: GateNode = { nodeId, kind: 'tool', name };
  // With a handler attached the node events are already the handler's job.
  const ownsEvents = site.link === undefined;
  const instanceId = site.link?.instanceId ?? nextId('call');
  const startedAt = Date.now();
  const runIn = <T>(fn: () => T | Promise<T>): Promise<T> => core.runIn(site.runId, fn);
  // Resolved inside the run context so it picks up that run's abort reason.
  const abortError = (): Promise<Error> =>
    runIn(() => core.abortError(core.session.currentRun()));

  if (ownsEvents) {
    await runIn(() =>
      core.startNode({
        nodeId,
        kind: 'tool',
        name,
        instanceId,
        input,
        extra: { gates: 'full' },
      }),
    );
  }

  let attempts = 0;
  const note = (extra: Record<string, unknown>): void => {
    if (!ownsEvents) core.annotateTool(site.runId, extra);
  };
  const finish = (output: unknown, status: RunStatus, extra?: Record<string, unknown>): void => {
    if (!ownsEvents) return;
    core.finishNode({
      nodeId,
      instanceId,
      output,
      durationMs: Date.now() - startedAt,
      status,
      extra: { attempts, ...extra },
    });
  };

  for (;;) {
    const pre = await gate(core, site, 'before', node);
    if (pre.action === 'abort') {
      note({ aborted: true, attempts });
      await runIn(() => finish(undefined, 'aborted'));
      throw await abortError();
    }
    if (pre.action === 'inject') {
      note({ injected: true, attempts });
      await runIn(() => finish(pre.output, 'ok', { injected: true }));
      return pre.output;
    }
    // 'retry' before execution is equivalent to continue.

    attempts += 1;
    let result: unknown;
    try {
      result = await call();
    } catch (error) {
      if (isAbortError(error)) {
        note({ aborted: true, attempts });
        await runIn(() => finish(undefined, 'aborted'));
        throw error;
      }
      // The error gate fires BEFORE LangChain (and the graph) sees the failure.
      // Exactly one `node.error` per failure: the handler reports the ones
      // LangChain gets to see (continue / abort), and the wrapper reports the
      // ones it swallows (inject / retry), which would otherwise be invisible.
      const decision = await runIn(async () => {
        if (ownsEvents) core.errorNode(nodeId, instanceId, error);
        return core.session.gate('error', node);
      });
      const swallowed = decision.action === 'inject' || decision.action === 'retry';
      if (swallowed && !ownsEvents) await runIn(() => core.errorNode(nodeId, instanceId, error));
      if (decision.action === 'inject') {
        note({ injected: true, attempts, recoveredFromError: true });
        await runIn(() => finish(decision.output, 'ok', { injected: true }));
        return decision.output;
      }
      if (decision.action === 'retry') continue;
      if (decision.action === 'abort') {
        note({ aborted: true, attempts });
        await runIn(() => finish(undefined, 'aborted'));
        throw await abortError();
      }
      note({ attempts });
      await runIn(() => finish(undefined, 'error'));
      throw error; // 'continue': LangChain sees the original error
    }

    const post = await gate(core, site, 'after', node);
    if (post.action === 'inject') {
      note({ injected: true, attempts });
      await runIn(() => finish(post.output, 'ok', { injected: true }));
      return post.output;
    }
    if (post.action === 'retry') continue;
    if (post.action === 'abort') {
      note({ aborted: true, attempts });
      await runIn(() => finish(result, 'aborted'));
      throw await abortError();
    }
    note({ attempts });
    await runIn(() => finish(result, 'ok'));
    return result;
  }
}

function gate(
  core: AdapterCore,
  site: CallSite,
  point: 'before' | 'after' | 'error',
  node: GateNode,
): Promise<GateDecision> {
  return core.runIn(site.runId, () => core.session.gate(point, node));
}
