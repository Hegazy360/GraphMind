# @graphmind-ai/langgraph

LangChain / LangGraph adapter for the GraphMind live agent debugger. Attach a
callback handler and your graph streams to a local viewer as it runs — and the
debugger can **hold execution** at gates (breakpoints, step, pause-on-error)
and resume with `continue` / `retry` / `inject` / `abort`.

Everything fails open: with no debugger attached the adapter is a no-op with
near-zero overhead, and a debugger that disconnects mid-hold auto-continues
every held gate.

```bash
npm i @graphmind-ai/langgraph
npx graphmind-ai serve      # the debugger + viewer
```

## Usage

```ts
import { graphmind } from '@graphmind-ai/langgraph';

const gm = graphmind({ app: 'research-agent' });

await graph.invoke(input, { callbacks: [gm.handler()] });
// or:  await graph.invoke(input, { callbacks: gm.callbacks() });
```

`gm.config()` is the batteries-included version — a fresh handler **and** its
abort signal, merged onto whatever config you pass:

```ts
const cfg = gm.config({ configurable: { thread_id: threadId } });
await graph.invoke(input, cfg);
```

Use **one handler per invocation** (both forms above do): a handler carries
that invocation's abort signal.

`graphmind()` accepts all `@graphmind-ai/client` session options (`url`,
`enabled`, `meta`, timeouts, …) plus `app`, `sdk`, `chains`, `maxPayloadChars`,
`autoRun`, `abortMode`, `tokenFlushIntervalMs` and `waitForAttach`. Kill
switches: `GRAPHMIND_DISABLED=1` always disables; `NODE_ENV=production`
disables unless `GRAPHMIND=1`.

## Capability matrix

What each instrumentation path can actually do. This is the honest version —
LangChain callbacks are a one-way channel, so a handler can *hold* work but
never *change* it.

| Where | pause / step | pause on error | abort | retry | inject |
|---|---|---|---|---|---|
| LangGraph node (`handleChainStart`) | ✅ holds the node body | ✅ | ✅ | ❌ | ❌ |
| LCEL chain / runnable | ✅ | ✅ | ✅ | ❌ | ❌ |
| Chat model / LLM (`handleChatModelStart`) | ✅ holds before the request | ✅ | ✅ | ❌ | ❌ |
| Tool via callbacks only | ✅ holds before the body | ✅ | ✅ | ❌ | ❌ |
| Retriever | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Tool via `gm.wrapStructuredTool()`** | ✅ | ✅ | ✅ | **✅** | **✅** |
| **Function via `gm.tool()` / `gm.wrapTools()`** | ✅ | ✅ | ✅ | **✅** | **✅** |
| `after` gate (inspect a finished node) | ✅ observe-only | — | ✅ | ❌ | ❌ |
| `after` gate on a wrapped tool | ✅ | — | ✅ | **✅** | **✅** |

**Why pause works.** `CallbackManager` **awaits** handler methods when the
handler asks it to (`_awaitHandler: true`, which this handler sets), and it
awaits them *before* the announced work runs — `StructuredTool.call` awaits
`handleToolStart` before `_call`, a Pregel node awaits `handleChainStart`
before the node body, a chat model awaits `handleChatModelStart` before the
provider request. Awaiting a GraphMind gate there genuinely stops the clock.
This is verified by timestamp ordering in `test/handler.test.ts`, not assumed:
the tests hold a tool for a full second and assert its body had not started.

**Why inject/retry do not work through callbacks.** A handler is told what
happened; it has no return channel into the thing it observed. It cannot hand
back a different tool result or ask for the call to be made again. If the
debugger sends `inject` or `retry` at a callback-only gate, the adapter warns
once (naming the wrapper you need) and continues — it never silently pretends
to have substituted something.

**How abort works.** Two mechanisms, both on by default:

1. The handler throws an `AbortError`-named error out of the callback.
   LangChain propagates it (the handler runs with `raiseError: true`), so the
   node — and normally the whole graph invocation — fails immediately.
2. `handler.signal` is aborted. Pass it as the LangChain config's `signal`
   (`gm.config()` does) so in-flight provider requests and the Pregel loop
   between steps stop too.

`abortMode: 'signal'` turns off (1) if you would rather keep full control of
error flow; then `signal` is the only channel, so you must pass it.

**Parallel branches gate independently.** LangGraph runs fan-out nodes
concurrently and each holds its own gate — pausing one branch does not freeze
the others. Also tested.

## Getting the full gate set on tools

Wrap the tool. The wrapper sits around the function the tool actually
executes, which is a real position in the call stack:

```ts
import { tool } from '@langchain/core/tools';

const searchFlights = gm.wrapStructuredTool(
  tool(async ({ from, to }) => api.search(from, to), {
    name: 'searchFlights',
    description: 'Search for flights',
    schema: z.object({ from: z.string(), to: z.string() }),
  }),
);

// several at once (records or arrays; LangChain tools and plain functions)
const tools = gm.wrapTools({ searchFlights, checkBudget });

// a plain async function called inside a graph node
const scoreLead = gm.tool('scoreLead', async (lead) => model.score(lead));
```

`wrapStructuredTool` returns a **clone** with the same prototype, name and
schema — `isStructuredTool`, `ToolNode`, serialization and your original tool
all keep working. Per call it runs:

- `before` gate → `inject` returns your value without running the tool,
  `abort` throws, `retry` is a no-op,
- on a throw, the `error` gate fires **before LangChain sees the failure**:
  `inject` swallows the error and returns your value, `retry` re-runs the tool,
  `continue` rethrows the original, `abort` throws an `AbortError`,
- `after` gate post-execute, pre-return → `inject` patches the result.

When the callback handler is attached it already announced the tool run (with
LangChain's run id, parentage and `toolCallId`), so the wrapper stays quiet and
just annotates the result (`injected: true`, `attempts: n`,
`recoveredFromError: true`). A failure the wrapper swallows — because you
injected or retried — is still reported as `node.error` exactly once, so a
retry never silently disappears from the canvas. With no handler attached the
wrapper emits its own node events, so a wrapped tool is useful on its own.

## What lands on the canvas

| LangChain run | GraphMind node | `nodeId` | `instanceId` |
|---|---|---|---|
| root run (the graph / chain you invoked) | `agent` | `agent:<name>` | LangChain run id |
| LangGraph node | `chain` | `chain:<langgraph_node>` | LangChain run id |
| LCEL chain / runnable | `chain` | `chain:<runName>` | LangChain run id |
| chat model / LLM | `llm` | `llm:<model or class>` | LangChain run id |
| tool | `tool` | `tool:<name>` | `toolCallId` (or run id) |
| retriever | `retriever` | `retriever:<name>` | LangChain run id |

One logical node per code location; executions light it up (decisions.md #1).
Parentage follows LangChain's `parentRunId`. LangGraph's hidden internals
(anything tagged `langsmith:hidden`, such as `__start__`) are skipped, and
their children re-attach to the nearest visible ancestor.

Payloads carry extra fields the wire schema preserves: `langgraphNode`,
`langgraphStep`, `threadId`, `tags`, `toolCallId`, `provider`, `modelId`,
`gates` (`full` for wrapper-gated tools, `before+error` otherwise), plus
`injected` / `attempts` from a wrapper.

Streamed tokens (`handleLLMNewToken`) are batched into `node.token` — one batch
per node per ~34ms (~30/sec), so a fast provider stream cannot flood the wire.
Usage is read from `usage_metadata`, `llmOutput.tokenUsage`, `llmOutput.usage`
or `generationInfo.usage`, whichever your provider fills in.

### Options that shape the graph

```ts
graphmind({
  chains: 'all',          // 'all' (default) | 'langgraph' | 'none'
  maxPayloadChars: 20000, // bigger inputs/outputs ship as a truncated preview
});
```

`chains: 'langgraph'` renders only the graph and its named nodes (no inner LCEL
noise); `'none'` keeps only LLMs, tools and retrievers.

Graph state can be large, cyclic or full of class instances, so every payload
goes through a sanitizer: cycles become `'[Circular]'`, unserializable values
degrade instead of throwing, and anything over `maxPayloadChars` is replaced by
`{ __graphmind: 'truncated', preview, chars }`.

Optionally pre-render the whole graph grey before anything executes:

```ts
gm.hintGraph(compiledGraph); // reads compiledGraph.getGraph().nodes
```

## Runs

Each root invocation gets its own GraphMind run automatically, named after the
root runnable (`LangGraph` for a compiled graph) — so two `graph.invoke()`
calls are two runs on the canvas, not one merged blob. Override the name with
`gm.handler({ runName: 'nightly-research' })`.

For an explicit boundary around more than the graph call, use `gm.run`:

```ts
await gm.run('handle-ticket', async () => {
  const plan = await planner.invoke(input, { callbacks: gm.callbacks() });
  return graph.invoke(plan, { callbacks: gm.callbacks() });
});
```

A handler started inside `gm.run` joins that run instead of opening its own.
`autoRun: false` turns the automatic run off entirely (everything is attributed
to the session's implicit run).

## Attach guarantee: `gm.ready()` / `waitForAttach`

The transport is lazy and fails open, so a graph that starts immediately can
run past its first gates before the debugger's handshake lands:

```ts
const gm = graphmind({ app: 'research-agent' });
const attached = await gm.ready();            // default timeout 2000ms

// or let the adapter do it on first use
const gm = graphmind({ app: 'research-agent', waitForAttach: true }); // 2000ms
const gm = graphmind({ app: 'research-agent', waitForAttach: 500 });  // 500ms
```

`ready()` resolves `true` once the handshake completes — the viewer's
breakpoints and mode are armed *before* it resolves — or `false` on timeout or
when GraphMind is disabled. `false` is not an error; it means "continue
detached".

## Fail-open invariants

- Disabled session (`enabled: false` or a kill switch): the handler is inert
  and every wrapper is an identity function.
- Enabled but detached: gates resolve `continue` on a fast path; events go to
  the replay ring buffer only.
- The adapter never throws into your graph. Every handler body is wrapped in a
  guard that rethrows **only** the one abort it was asked to raise; anything
  else degrades to a one-shot warning and observe-only behavior for that event.
- A debugger that disconnects mid-hold releases every held gate with
  `continue`; so does `gm.dispose()`.

## Known limits

- `inject` / `retry` need the tool wrappers. There is no callback-only path,
  and there cannot be one.
- Aborting through a callback logs one `Error in handler GraphMindCallbackHandler…`
  line from LangChain itself (its manager logs before rethrowing). That is
  LangChain's message, not a GraphMind failure.
- `handleLLMNewToken` tokens are reported on the `text` channel; reasoning
  deltas are not separated yet.
- Node inputs and outputs are whatever LangChain hands the callback — for a
  LangGraph node that is the channel update, not the full state.
- A plain `gm.tool()` function called *outside* `gm.run` while several graphs
  run concurrently cannot be attributed to a specific run; wrap concurrent work
  in `gm.run` (or wrap the LangChain tool instead) when that matters.
- The handler forces `awaitHandlers` on itself. That is what makes gates real;
  it also means your own callback work is serialized behind it per run.
- LangGraph `interrupt()` / human-in-the-loop checkpoints are surfaced as
  ordinary chain errors today; there is no dedicated interrupt affordance yet.

## Version support

Primary target: `@langchain/core` 1.x (validated against 1.2.9) and
`@langchain/langgraph` 1.x (validated against 1.4.13). The peer ranges are
`@langchain/core >=0.3 <2` and an optional `@langchain/langgraph >=0.2 <2`.
Everything version-sensitive is isolated in `src/lc-types.ts` — including the
`handleChainStart` argument order, which differs between `@langchain/core`'s
type declaration and its runtime call site; the adapter accepts either.
