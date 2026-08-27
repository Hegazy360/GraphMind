# @graphmind-ai/anthropic

Anthropic TypeScript SDK adapter for the **GraphMind live agent debugger**.
Wrap your client and your tool functions; your app streams execution events to
a local viewer, and the debugger can **hold execution** at gates (pause /
breakpoints / step) and resume with `continue` / `retry` / `inject` / `abort`.

Everything fails open: with no debugger attached the adapter is a near-zero-cost
no-op, and a debugger that disconnects mid-hold auto-continues every held gate.

Built by **wrapping**, not patching: `wrapClient` returns a Proxy of your
client (your object is never mutated), and `wrapTools` decorates plain async
functions. The raw Anthropic SDK has no middleware hook and no tool runtime, so
those two seams are the whole surface.

## Install

```sh
npm i -D @graphmind-ai/anthropic graphmind-ai
```

`@anthropic-ai/sdk` is a peer dependency (`>=0.60.0 <1`; the suite runs against
both 0.60.0 and 0.121.0). Run the debugger with `npx graphmind-ai` and open
the viewer.

## Usage

```ts
import Anthropic from '@anthropic-ai/sdk';
import { graphmind } from '@graphmind-ai/anthropic';

const gm = graphmind({ app: 'support-agent' });

const client = gm.wrapClient(new Anthropic());          // Proxy: instruments messages.*
const tools = gm.wrapTools({ searchFlights, checkBudget });  // plain fns -> gated fns

await gm.run('handle-ticket', async () => {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: ticket }];

  for (;;) {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      tools: toolSchemas,
      messages,
    });
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason !== 'tool_use') return message;

    const results = await Promise.all(
      message.content
        .filter((b) => b.type === 'tool_use')
        .map(async (block) => ({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          // Gated: the debugger can hold, retry, or substitute this result.
          content: JSON.stringify(await tools[block.name](block.input)),
        })),
    );
    messages.push({ role: 'user', content: results });
  }
});

await gm.dispose();
```

Streaming works the same way — both forms are instrumented:

```ts
const stream = await client.messages.create({ ...params, stream: true });
for await (const event of stream) { /* ... */ }

const helper = client.messages.stream(params);      // the MessageStream helper
helper.on('text', (delta) => process.stdout.write(delta));
const final = await helper.finalMessage();
```

`graphmind()` accepts all `@graphmind-ai/client` session options (`url`,
`enabled`, `meta`, timeouts, ...) plus `app`, `sdk`, `tokenFlushIntervalMs` and
`waitForAttach`. Kill switches: `GRAPHMIND_DISABLED=1` always disables;
`NODE_ENV=production` disables unless `GRAPHMIND=1`.

## API

| | |
|---|---|
| `graphmind(options?)` | Create an adapter instance. Never throws. |
| `gm.wrapClient(client)` | Instrumented **view** of an Anthropic client (a Proxy). |
| `gm.wrapTools({ ... })` | Gate a record of tool functions. Wrapped tools are async. |
| `gm.tool(name, fn)` | Gate a single function. |
| `gm.run(name, fn)` | Explicit run boundary (recommended). |
| `gm.ready(opts?)` | Attach guarantee — resolves `true` once the handshake lands. |
| `gm.session` | The underlying session (stats, custom events). |
| `gm.dispose()` | Release held gates, flush, close the socket. Idempotent. |

## Gate points

**Per `messages.create` call** (streaming and non-streaming, on both
`client.messages` and `client.beta.messages`):

- `node.started` — kind `llm`, nodeId `llm:step`, one `instanceId` per call.
- **`before` gate, awaited BEFORE the SDK method is called.** Nothing is in
  flight while the gate is held: no socket, no request, no timeout clock. This
  is the core guarantee, and it is verified by a test that asserts the scripted
  HTTP layer saw zero requests during the hold.
- The result is observed: a `Message` is reported directly; a `Stream` is
  returned as a delegating Proxy that tees `node.token` deltas (text,
  thinking → `reasoning`, `tool_use` input JSON → `tool-args`), batched at one
  frame per node per ~34ms.
- `node.finished` with usage — `inputTokens` / `outputTokens` plus
  `cacheReadTokens` / `cacheCreationTokens` when the response reports them.
- `graph.hint` on the first call of an invocation, from the request's `tools`
  array, so the viewer pre-renders the whole roster in grey.

**Per wrapped tool call** (parallel calls gate independently — each invocation
is its own async frame, so `await Promise.all([...])` holds each separately):

- `before` gate before the original function body runs.
- `after` gate post-body, pre-return (fires in step mode / on an explicit
  `after` breakpoint).
- `error` gate when the function throws, **before the error reaches your loop**:
  - `inject` — swallow the error and return the injected value as the result;
    it becomes the next turn's `tool_result` (verified end-to-end by a test).
  - `retry` — re-invoke the original function (the before-gate fires again).
  - `continue` — rethrow the original error; your own error handling wins.
  - `abort` — abort the run's `AbortController` and throw an `AbortError`-named
    reason (terminal; the next `messages.create` in the run refuses to start).

**Server-executed tools** (`server_tool_use`: web search, web fetch, code
execution, ...) run on Anthropic's side and cannot be held. They are observed
from the response and emitted as tool nodes carrying `serverExecuted: true` and
`ungated: true`. `graph.hint` marks the same way any tool GraphMind cannot
hold — built-in tool definitions, and any tool name you did not pass through
`gm.wrapTools` / `gm.tool`.

## Node identity (decisions.md #1)

One logical node per code location; executions light it up.

| node | nodeId | instanceId |
|---|---|---|
| agent (run) | `agent:<runName>` | runId |
| model call | `llm:step` | `<invocationId>:sN` |
| tool call | `tool:<toolName>` | the model's `tool_use` id |
| server tool | `tool:<toolName>` | the `server_tool_use` id |

Because the raw SDK has no tool runtime, a wrapped tool function receives no
call id. The adapter queues the `tool_use` ids it observed on the LLM step,
per (run scope, tool name), and hands them out in issue order — so a tool node's
`instanceId` is the model's real call id, including for parallel calls. If the
adapter never observed the requesting step (e.g. you wrapped tools but not the
client), a synthetic `call_*` id is used instead.

Successive `messages.create` calls chain into one invocation: within a run
scope, a call whose first message is unchanged and whose `messages` array has
grown continues the previous invocation (`:s0`, `:s1`, ...).

## Attach guarantee: `gm.ready()` / `waitForAttach`

The transport is lazy and fails open, so an agent that starts immediately can
run past its first gates before the debugger's handshake lands. To get pause
guarantees from the first event, either await attachment explicitly:

```ts
const attached = await gm.ready();                 // default timeout 2000ms
const attached = await gm.ready({ timeoutMs: 500 });
```

or let the adapter do it on first use:

```ts
const gm = graphmind({ app: 'support-agent', waitForAttach: true });  // 2000ms
const gm = graphmind({ app: 'support-agent', waitForAttach: 500 });   // 500ms
```

`gm.ready()` force-starts the connection and resolves `true` once the handshake
completes (breakpoints/mode armed *before* it resolves), or `false` on timeout /
when GraphMind is disabled. It never throws. `false` is not an error — it means
"continue detached". With `waitForAttach`, the **first** `gm.run()` / first
instrumented `messages.create` / first wrapped tool call waits; later calls
never do.

## Fail-open invariants

- **Disabled** (`enabled: false` or a kill switch): `wrapClient`, `wrapTools`
  and `tool` return their inputs unchanged — identity, zero overhead, nothing
  emitted, no network.
- **Enabled but detached**: gates resolve `continue` on a shared-resolved-promise
  fast path; events only go to the replay ring buffer. Measured at well under
  0.5ms per fully gated tool call in the test suite.
- The adapter **never throws into your app**: internal failures (including
  unserializable payloads) degrade to rate-limited warnings and uninstrumented
  behavior; your results and your errors pass through untouched.
- A debugger that disconnects mid-hold releases every held gate with `continue`.

## Limitations

- **`create()` returns a stand-in, not the SDK's `APIPromise`.** Holding a gate
  before the request means the adapter cannot hand back the object the SDK
  creates when it issues the call. The returned value is a promise of exactly
  the same result, and re-exposes `withResponse()` and `asResponse()`; other
  `APIPromise` internals (e.g. `_thenUnwrap`) are not reproduced. `await`,
  `.then/.catch/.finally`, `withResponse()` and `asResponse()` — everything an
  app realistically uses — behave identically.
- **`Stream.tee()` bypasses observation.** The returned stream is a Proxy whose
  `Symbol.asyncIterator` delegates to the real one; `tee()` reads the stream's
  internal iterator instead, so branches obtained from it are not observed.
  Iterate the stream (or use `messages.stream()`) to keep observation.
- **Grouping outside `gm.run`** shares one scope, so two *concurrent* loops
  starting from the same first message can be merged into one invocation, and
  their `tool_use` correlation queues can interleave. Wrap concurrent work in
  `gm.run` — it is the recommended boundary anyway.
- **Abort cancels cooperatively.** `abort` aborts the run's `AbortController`,
  which is chained into the request's signal while attached; a tool function
  already running keeps running unless it observes the run signal itself.
- **Only `messages.create` / `messages.stream` are instrumented** (plus their
  `beta` equivalents). `messages.batches`, `countTokens`, and every other
  resource pass through untouched.
- **Retries are the SDK's.** GraphMind gates a logical call once; the SDK's
  own `maxRetries` attempts happen inside that call and are not gated
  individually.

## Version support

Peer range `>=0.60.0 <1`. The full test suite is run against **0.121.0**
(the dev dependency) and against **0.60.0** — both ends of the range, same 53
assertions, no code paths conditioned on version.

The adapter never imports `@anthropic-ai/sdk` at runtime and never names its
classes: every shape it reads is duck-typed in `src/sdk-types.ts` against the
installed `.d.ts`, so a new SDK release does not break it.
