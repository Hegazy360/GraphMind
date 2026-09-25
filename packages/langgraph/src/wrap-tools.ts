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
 * EDITED ARGUMENTS (0.6.0, contract C2). A call whose input is an object is
 * offered as `editable` at every gate (the session shows it only when the app
 * and the debugger both enabled edits). `continue` + input at `before`, or
 * `retry` + input at `after` / `error`, runs the REAL function with the edit
 * merged into the live input (top-level keys replace). A LangChain tool's own
 * `schema` (zod `safeParseAsync`, a Standard Schema, or JSON Schema) checks
 * the merged input first — LangChain parsed the MODEL's arguments before
 * `func` ran, and an edit arrives after that — and its parsed value is what
 * runs; a refusal keeps the gate held. The schema's transforms never run
 * twice: `func` gets LangChain's PARSED copy, so the edit is merged into the
 * arguments the tool was called with (kept by the clone's `call`), and a
 * class-based tool's `invoke` — which parses again itself — is handed the
 * merged arguments. A plain `gm.tool` function carries no schema, so its
 * merged input is not checked further. A `ToolCall` handed to a class-based
 * tool's `invoke` is recorded as its `args` (the id as `toolCallId`) — the
 * shape an edit is merged into — and keeps its id and name. The
 * latest accepted edit stays the call's input for later attempts; the node's
 * recorded input (and so the loop fingerprint) keeps what the model asked
 * for, and `exec.resumed.edited` records what ran. The `after` gate also
 * hands the result to the session's after-gate detectors.
 *
 * EVENTS. When the callback handler is attached it has already announced this
 * tool run (with LangChain's own run id, parentage and toolCallId), so the
 * wrapper stays quiet and only leaves annotations (`injected`, `attempts`) for
 * the handler's `node.finished`. With no handler attached the wrapper emits the
 * node events itself, so a wrapped tool is useful on its own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { monotonicNow, elapsedMs } from '@graphmind-ai/client';
import {
  CONTINUE_DECISION,
  editedArgs,
  isAbortError,
  isEditableToolInput,
  toolGateOptions,
  toolSchemaCheck,
  type GateDecision,
  type GateNode,
  type GateOptions,
  type RunStatus,
  type SchemaCheck,
  type ToolEdit,
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
 * How one call can take edited arguments: the live input an edit merges into,
 * the tool's schema check, and how to make the call with other arguments.
 * Absent when the call's input cannot take an edit (not an object).
 */
interface EditSite {
  live: unknown;
  check: SchemaCheck | undefined;
  callWith: (args: unknown) => unknown;
  /**
   * `live` is what LangChain PARSED with the tool's schema (a `tool()` func):
   * an edit is merged into `input`, the arguments as they were passed, so
   * the schema's transforms never run twice (see toolArgsValidator).
   */
  parsed?: boolean;
  /** With `parsed`: the arguments LangChain parsed `live` from, when known. */
  input?: unknown;
  /**
   * The call parses what it is handed itself (a class-based tool's
   * `invoke`): it is handed the MERGED arguments, never the schema's parsed
   * output (which would be parsed a second time).
   */
  parsesItself?: boolean;
}

/**
 * The edit site for a call whose input is its first argument: editable when
 * that argument is an object (or nothing), re-invoked with the edit in its
 * place and every other argument unchanged.
 */
function firstArgumentSite(
  args: readonly unknown[],
  check: SchemaCheck | undefined,
  invoke: (args: unknown[]) => unknown,
): EditSite | undefined {
  if (args.length === 0 || !isEditableToolInput(args[0])) return undefined;
  return { live: args[0], check, callWith: (edited) => invoke([edited, ...args.slice(1)]) };
}

/**
 * A LangChain `ToolCall` (`{name, args, id, type: 'tool_call'}`), as ToolNode
 * hands it to `invoke`. Never throws (a hostile input reads as "not one").
 */
function isToolCall(value: unknown): value is Record<string, unknown> & { args: unknown } {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { type?: unknown }).type === 'tool_call' &&
      'args' in value
    );
  } catch {
    return false;
  }
}

/**
 * The edit site for a class-based tool's `invoke(input, ...rest)`: a
 * `ToolCall` has its `args` edited (its id and name kept); plain arguments
 * are edited in place. Never throws: an input that cannot be read is simply
 * not editable.
 */
function invokeSite(
  args: readonly unknown[],
  check: SchemaCheck | undefined,
  invoke: (args: unknown[]) => unknown,
): EditSite | undefined {
  try {
    const first = args[0];
    if (!isToolCall(first)) return firstArgumentSite(args, check, invoke);
    const live = first.args;
    if (!isEditableToolInput(live)) return undefined;
    return {
      live,
      check,
      callWith: (edited) => invoke([{ ...first, args: edited }, ...args.slice(1)]),
      parsesItself: true,
    };
  } catch {
    return undefined;
  }
}

/**
 * What a class-based tool's `invoke` records as the node's input: a
 * `ToolCall`'s `args` — the same shape an edit is merged into (the viewer
 * pre-fills its editor from the record), never the `{name, args, id, type}`
 * envelope — with its id as `toolCallId`, as the callback handler records a
 * tool run.
 */
function invokeRecord(first: unknown): { input: unknown; extra?: Record<string, unknown> } {
  try {
    if (!isToolCall(first)) return { input: first };
    const id = first['id'];
    return typeof id === 'string' && id.length > 0 ? { input: first.args, extra: { toolCallId: id } } : { input: first.args };
  } catch {
    return { input: first };
  }
}

/**
 * The arguments a wrapped `tool()` was CALLED with, for its func (which gets
 * LangChain's parsed copy): the clone's `call` stores them for the duration
 * of the call. Keyed by the clone, so a func reached any other way finds
 * nothing.
 */
const callInputs = new AsyncLocalStorage<{ tool: object; input: unknown }>();

/** The schema a LangChain tool carries (`tool.schema`), as a check for edits. */
function schemaCheckOf(tool: object): SchemaCheck | undefined {
  try {
    return toolSchemaCheck((tool as { schema?: unknown }).schema);
  } catch {
    return undefined;
  }
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
    return runGated(
      core,
      name,
      { runId: undefined, link: undefined },
      args[0],
      () => original(...args),
      firstArgumentSite(args, undefined, (next) => original(...(next as A))),
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
  const check = schemaCheckOf(tool);

  if (typeof tool.func === 'function') {
    // DynamicTool / DynamicStructuredTool (everything `tool()` builds).
    // `func(input, runManager, config)` — runManager.runId is the SAME run id
    // the callback handler saw in handleToolStart, which is how the two sides
    // find each other. `input` is what LangChain parsed with `schema`.
    const original = tool.func as (...args: unknown[]) => unknown;
    (clone as { func: unknown }).func = async (...args: unknown[]): Promise<unknown> => {
      const called = callInputs.getStore();
      const attachWait = core.maybeWaitForAttach();
      if (attachWait !== undefined) await attachWait;
      const runId = readRunId(args[1]);
      const site = firstArgumentSite(args, check, (next) => original.apply(clone, next));
      return runGated(
        core,
        name,
        { runId, link: core.toolLink(runId) },
        args[0],
        () => original.apply(clone, args),
        site === undefined
          ? undefined
          : { ...site, parsed: true, input: called?.tool === clone ? called.input : undefined },
      );
    };
    // `call` (which `invoke` goes through) has the arguments as passed; func
    // only gets the parsed copy. Keep them for the func's edit site.
    const originalCall = (tool as { call?: unknown }).call;
    if (typeof originalCall === 'function') {
      (clone as unknown as { call: unknown }).call = function (this: unknown, ...args: unknown[]): unknown {
        let input: unknown;
        try {
          input = isToolCall(args[0]) ? args[0].args : args[0];
        } catch {
          input = undefined;
        }
        return callInputs.run({ tool: clone, input }, () =>
          (originalCall as (...a: unknown[]) => unknown).apply(this, args),
        );
      };
    }
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
      const record = invokeRecord(args[0]);
      return runGated(
        core,
        name,
        { runId: undefined, link: undefined },
        record.input,
        () => original.apply(clone, args),
        invokeSite(args, check, (next) => original.apply(clone, next)),
        record.extra,
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
  originalCall: () => unknown,
  editSite?: EditSite,
  startExtra?: Record<string, unknown>,
): Promise<unknown> {
  const nodeId = site.link?.nodeId ?? toolNodeId(name);
  // With a handler attached the node events are already the handler's job.
  const ownsEvents = site.link === undefined;
  const instanceId = site.link?.instanceId ?? nextId('call');
  // exec.paused names this call (parallel calls of one tool stay apart).
  const node: GateNode = { nodeId, kind: 'tool', name, instanceId };
  const startedAt = monotonicNow();
  const runIn = <T>(fn: () => T | Promise<T>): Promise<T> => core.runIn(site.runId, fn);
  // Resolved inside the run context so it picks up that run's abort reason.
  const abortError = (): Promise<Error> =>
    runIn(() => core.abortError(core.session.currentRun()));

  // What runs: the call as it came, until an edit is accepted.
  let call = originalCall;
  let live = editSite?.live;
  let rawInput = editSite?.input;
  const edit = (): ToolEdit | undefined =>
    editSite !== undefined && isEditableToolInput(live)
      ? { args: live, check: editSite.check, parsed: editSite.parsed, input: rawInput }
      : undefined;
  const applyEdit = (decision: GateDecision): void => {
    const edited = editSite === undefined ? undefined : editedArgs(decision);
    if (editSite === undefined || edited === undefined) return;
    if (editSite.parsesItself === true) {
      // `invoke` parses what it gets: hand it the merged arguments.
      const merged = edited.input ?? edited.args;
      live = merged;
      call = () => editSite.callWith(merged);
      return;
    }
    live = edited.args;
    rawInput = edited.input;
    call = () => editSite.callWith(edited.args);
  };

  if (ownsEvents) {
    await runIn(() =>
      core.startNode({
        nodeId,
        kind: 'tool',
        name,
        instanceId,
        input,
        extra: { gates: 'full', ...startExtra },
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
      durationMs: elapsedMs(startedAt),
      status,
      extra: { attempts, ...extra },
    });
  };

  for (;;) {
    const pre = await gate(core, site, 'before', node, toolGateOptions(core.session, edit));
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
    applyEdit(pre);

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
      // Exactly one PAUSE per failure, here. A wrapper is a real position in
      // the call stack, so this is the only error gate that can substitute or
      // re-run anything; claiming the error means the handler's ancestor gates
      // (the LangGraph node, the root chain) let the same failure past on its
      // way out instead of stopping the user again at every level for an error
      // they already released. An inner wrapper that claimed it first keeps
      // the pause, and this one behaves as `continue`.
      const owned = core.claimError(error);
      // Exactly one `node.error` per failure: the handler reports the ones
      // LangChain gets to see (continue / abort), and the wrapper reports the
      // ones it swallows (inject / retry), which would otherwise be invisible.
      const decision = await runIn(async () => {
        if (ownsEvents) core.errorNode(nodeId, instanceId, error);
        return owned ? core.session.gate('error', node, toolGateOptions(core.session, edit)) : CONTINUE_DECISION;
      });
      const swallowed = decision.action === 'inject' || decision.action === 'retry';
      if (swallowed && !ownsEvents) await runIn(() => core.errorNode(nodeId, instanceId, error));
      if (decision.action === 'inject') {
        note({ injected: true, attempts, recoveredFromError: true });
        await runIn(() => finish(decision.output, 'ok', { injected: true }));
        return decision.output;
      }
      if (decision.action === 'retry') {
        // The re-run may throw this very object again; that is a new failure
        // and deserves its own pause.
        core.releaseError(error);
        applyEdit(decision);
        continue;
      }
      if (decision.action === 'abort') {
        note({ aborted: true, attempts });
        await runIn(() => finish(undefined, 'aborted'));
        throw await abortError();
      }
      note({ attempts });
      await runIn(() => finish(undefined, 'error'));
      throw error; // 'continue': LangChain sees the original error
    }

    const post = await gate(core, site, 'after', node, toolGateOptions(core.session, edit, { result }));
    if (post.action === 'inject') {
      note({ injected: true, attempts });
      await runIn(() => finish(post.output, 'ok', { injected: true }));
      return post.output;
    }
    if (post.action === 'retry') {
      applyEdit(post);
      continue;
    }
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
  options: GateOptions | undefined,
): Promise<GateDecision> {
  return core.runIn(site.runId, () => core.session.gate(point, node, options));
}
