# @graphmind-ai/openai

OpenAI Node SDK adapter for the GraphMind live agent debugger. Wrap your client
and your tools; your app streams execution events to a local viewer, and the
debugger can **hold execution** at gates (pause / breakpoints / step) and resume
with `continue` / `retry` / `inject` / `abort`. Everything fails open: with no
debugger attached the adapter is a no-op with near-zero overhead, and a debugger
that disconnects mid-hold auto-continues every held gate.

Built entirely on the SDK's public surface — a `Proxy` over the client plus
decoration of the functions you dispatch tool calls to. No fork, no
monkey-patching, no mutation of your client.

## Usage

```ts
import OpenAI from 'openai';
import { graphmind } from '@graphmind-ai/openai';

const gm = graphmind({ app: 'support-agent' });

const client = gm.wrapClient(new OpenAI());
const tools = gm.wrapTools({ searchFlights, checkBudget });

// Optional explicit run boundary (recommended): groups everything into one
// run, names the agent node, and carries the abort controller the debugger's
// `abort` action uses.
await gm.run('handle-ticket', async () => {
  const messages = [{ role: 'user', content: 'Find me a flight to Lisbon' }];

  for (;;) {
    const completion = await client.chat.completions.create({
      model: 'gpt-5.4',
      messages,
      tools: toolSchemas,
    });
    const message = completion.choices[0].message;
    if (!message.tool_calls?.length) return message.content;

    messages.push(message);
    // Parallel calls gate INDEPENDENTLY — hold one, let the other run.
    const results = await Promise.all(
      message.tool_calls.map(async (call) => ({
        call,
        // Pass the tool call as the 2nd argument so the debugger can
        // correlate this execution with the model's tool_call id.
        output: await tools[call.function.name](JSON.parse(call.function.arguments), call),
      })),
    );
    for (const { call, output } of results) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
});

await gm.dispose();
```

The Responses API works the same way:

```ts
const response = await client.responses.create({ model: 'gpt-5.4', input: 'hi' });
const stream = client.responses.stream({ model: 'gpt-5.4', input: 'hi' });
```

`graphmind()` accepts all `@graphmind-ai/client` session options (`url`,
`enabled`, `meta`, timeouts, ...) plus `app`, `sdk`, `tokenFlushIntervalMs` and
`waitForAttach`. Kill switches: `GRAPHMIND_DISABLED=1` always disables;
`NODE_ENV=production` disables unless `GRAPHMIND=1`.

## What it instruments

| you call | gated | streamed to the viewer |
|---|---|---|
| `chat.completions.create` (incl. `stream: true`) | ✅ before / error / after¹ | ✅ |
| `chat.completions.stream()` | ✅ | ✅ |
| `chat.completions.parse()` | ✅ | ✅ |
| `chat.completions.runTools()` | ✅ model turns² | ✅ |
| `responses.create` (incl. `stream: true`) | ✅ before / error / after¹ | ✅ |
| `responses.stream()` | ✅ | ✅ |
| `responses.parse()` | ✅ | ✅ |
| your tool functions via `wrapTools` | ✅ before / after / error | ✅ |
| OpenAI built-in tools (web search, code interpreter, file search, image gen, MCP) | ➖ observe-only | ✅ |

¹ The `after` gate fires for non-streaming requests only — see below.
² The tools `runTools()` executes are gated when you hand it functions from
`gm.wrapTools()`; see [runTools](#runtools).

**Per model request** (one execution of the logical `llm:step` node):

- emits `node.started` before anything is dispatched,
- awaits the `before` gate **BEFORE the HTTP request goes out** — nothing is in
  flight while a gate is held, so holds are indefinite by design and no server
  timeout is ticking,
- tees the response stream so batched `node.token` deltas (one batch per
  execution per ~34ms, i.e. ~30/sec) are observed without disturbing what your
  code consumes — both branches see the identical chunk sequence,
- emits `node.finished` with the text, tool calls, finish reason and token
  usage,
- emits `graph.hint` from the request's `tools` array (plus every name you
  passed to `wrapTools`) on an invocation's first step, so the viewer can render
  the whole graph grey before anything runs.

**Token channels.** Chat Completions maps `delta.content` and `delta.refusal` to
`text`, `delta.reasoning_content` to `reasoning` (present on OpenAI-compatible
reasoning models), and `delta.tool_calls[].function.arguments` to `tool-args`.
The Responses API maps `response.output_text.delta` / `response.refusal.delta`
to `text`, `response.reasoning_summary_text.delta` and
`response.reasoning_text.delta` to `reasoning`, and the
`function_call_arguments` / `custom_tool_call_input` / `mcp_call_arguments` /
`code_interpreter_call_code` deltas to `tool-args`.

**Token usage** is normalized onto the wire's `inputTokens` / `outputTokens`,
with `totalTokens`, `cachedInputTokens` and `reasoningTokens` carried as loose
fields (the wire schema preserves unknown fields). Chat Completions only reports
usage on a stream when you pass `stream_options: { include_usage: true }` —
that's the API, not the adapter.

**Per tool call** (`wrapTools`):

- `before` gate before your function runs,
- `after` gate post-call, pre-return,
- `error` gate when your function throws, BEFORE the error reaches your loop:
  `inject` swallows the error and returns the injected value as the tool result
  (so the substitution lands in the `tool` message and reaches the model's next
  turn); `retry` re-runs your function; `continue` rethrows the original error;
  `abort` aborts the run's `AbortController` and surfaces an `AbortError`
  (terminal — SDK retry logic never retries abort errors).

**Gating a model request on error.** When a request fails (a 500, a rate limit,
a connection error), the `error` gate fires before the SDK's error reaches your
code: `retry` re-issues the request, `inject` substitutes a completion object as
the result of `create()`, `continue` rethrows the SDK's error untouched, `abort`
ends the run. Pause-on-error is armed by default by the GraphMind CLI. A retried
request stays **one** execution of the node — one `node.started`, one
`node.finished` carrying `attempts` — so the canvas shows a node lighting up
twice rather than two unrelated calls.

**The `after` gate on model requests** fires for non-streaming calls only
(post-response, pre-return; `inject` substitutes the whole completion). A
streamed response is already live by the time it is returned, so there is
nothing meaningful to hold there — the stream tee reports it as it flows.

## How the wrapper works

`gm.wrapClient(client)` returns a `Proxy` tree. Your original client is never
mutated and keeps working uninstrumented, so you can wrap and discard freely,
and `client instanceof OpenAI` still holds.

Only `chat.completions.create` and `responses.create` are intercepted. Every
convenience helper the SDK ships — `.stream()`, `.parse()`, `.runTools()` —
builds on `this._client.<resource>.create(...)` internally, so the wrapper calls
them against a view of the resource whose `_client` points back at the wrapped
client. One interception point covers them all, and nothing is instrumented
twice.

Methods the adapter does not instrument are returned **bound to the real
object**: the OpenAI client class uses `#private` fields, and calling such a
method with a `Proxy` as `this` would throw. `client.post(...)`,
`client.embeddings.create(...)` and friends work exactly as before.

`wrapClient` is idempotent — wrapping an already-wrapped client returns it
unchanged — and returns its input untouched when GraphMind is disabled or when
the value is not an object. Any client exposing the same resources works: Azure
OpenAI, or an OpenAI-compatible gateway.

### `runTools`

`chat.completions.runTools()` runs its own tool loop inside the SDK. Its model
turns are gated and reported normally. To gate the tool executions too, hand it
functions from `gm.wrapTools()`:

```ts
const tools = gm.wrapTools({ getWeather });

client.chat.completions.runTools({
  model: 'gpt-5.4',
  messages,
  tools: [{
    type: 'function',
    function: {
      name: 'getWeather',
      description: '...',
      parameters: { /* ... */ },
      function: tools.getWeather,   // gated
      parse: JSON.parse,
    },
  }],
});
```

The runner passes itself (not the tool call) as the second argument, so those
executions get generated instance ids rather than OpenAI's `tool_call` ids.

### Deliberately not instrumented

- **`client.beta.*`**, the **Realtime API** (WebRTC/WebSocket sessions, not
  request/response) and the **Assistants API**. Neither fits the
  gate-before-the-request model; both are on the list if people ask.
- **`responses.retrieve(id, { stream: true })`** — resuming an existing
  response's stream. `responses.stream({ response_id })` takes that path
  internally; the resumed stream is passed through unobserved.
- **Batch, files, embeddings, images, audio, moderations, fine-tuning** — not
  agent execution steps.
- **`client.responses.create({ background: true })`** is reported as one step
  when the request returns, not for the lifetime of the background job.

## Attach guarantee: `gm.ready()` / `waitForAttach`

The transport is lazy and fails open, so an agent that starts immediately can
run past its first gates before the debugger's handshake lands. When you want
pause guarantees from the very first event, either await attachment explicitly:

```ts
const attached = await gm.ready();                 // default timeout 2000ms
const attached = await gm.ready({ timeoutMs: 500 });
```

or let the adapter do it on first use:

```ts
const gm = graphmind({ app: 'support-agent', waitForAttach: true });  // 2000ms
const gm = graphmind({ app: 'support-agent', waitForAttach: 500 });   // 500ms
```

`gm.ready()` force-starts the connection immediately and resolves `true` once
the handshake completes — the viewer's breakpoints/mode are armed *before* it
resolves — or `false` on timeout / when GraphMind is disabled. It never throws;
concurrent calls share one connection attempt; a call after attachment resolves
`true` instantly; and it works again after a disconnect. `false` is not an
error — it means "continue detached", preserving the fail-open contract.

With `waitForAttach` set, the **first** `gm.run()` / first wrapped request /
first wrapped tool call awaits `gm.ready()` before proceeding. Still fail-open:
on timeout the app continues detached, and later calls never wait.

## Node identity (decisions.md #1)

One logical node per code location; executions light it up:

| node        | nodeId            | instanceId                       |
|-------------|-------------------|----------------------------------|
| agent (run) | `agent:<runName>` | runId                            |
| model call  | `llm:step`        | `<invocationId>:sN`              |
| tool call   | `tool:<toolName>` | OpenAI `tool_call.id` / `call_id`|
| built-in tool | `tool:<name>`   | the Responses output item id     |

Both OpenAI APIs map onto the same `llm:step` node (an app migrating from Chat
Completions to Responses keeps its graph); the concrete API is reported as an
`api` field on the node payloads.

Requests are grouped into invocations so the viewer can show "step 3 of the
handle-ticket loop". Grouping is scoped by the `gm.run` context, and inside a
scope two heuristics chain steps: an exact match on `previous_response_id`
(Responses API), and prompt-prefix growth — a request whose first message is
unchanged and whose message count has grown continues the previous invocation.
Outside `gm.run` all requests share one scope, so two *concurrent* loops with
the same first message can be merged into one invocation; wrap concurrent work
in `gm.run` to keep them apart.

`node.finished` payloads carry `instanceId` plus the loose fields `api`,
`injected: true` (result substituted by the debugger) and `streamed: true`.
`node.token` batches carry `instanceId` too (a loose field): token deltas are
batched **per execution**, so two concurrent requests sharing the `llm:step`
node never interleave their answers into one stream.

The stream tee is driven by GraphMind's observer, so a node reaches
`node.finished` even if your code abandons the stream half-way. The cost is
that the HTTP response is read to completion in the background rather than at
your reading pace.

## Timeouts and abort signals (decisions.md #3)

The SDK's own `timeout` option starts when the HTTP request is dispatched, which
happens *after* the `before` gate releases — holds never eat into it.

An `AbortSignal.timeout()` you pass as `options.signal` is different: it is
already running when the gate holds. While a debugger is attached, the adapter
**chains** — never replaces — your signal with the debugger's run signal and
filters timeout-driven aborts out of what the request sees, warning once. Your
own aborts (any other reason) pass through untouched. When detached, signals are
not touched at all.

## Fail-open invariants

- Disabled session (`enabled: false` or a kill switch): `wrapClient` /
  `wrapTools` return their inputs unchanged (identity, zero overhead).
- Enabled but detached: gates resolve `continue` on a fast path; events go to
  the replay ring buffer only.
- The adapter never throws into the host app; internal failures degrade to
  rate-limited warnings and uninstrumented behavior.
- Disconnect mid-hold releases every held gate with `continue`.

## Version support

Primary target: `openai` v6 (validated against 6.49.0). The peer range is
`>=5 <7`; **v5 is untested** — it ships the same resources, `Stream.tee()` and
`APIPromise._thenUnwrap`, so it is expected to work, but nothing here proves it.
Every SDK shape the adapter reads is duck-typed in `src/sdk-types.ts` and there
is **no runtime import of `openai`** at all — the package only ever touches
objects you hand it, so a new SDK major needs at most that one file revisited.

One fidelity note: a gated `create()` returns a `Promise` subclass that
re-implements `APIPromise`'s helpers (`asResponse()`, `withResponse()`,
`_thenUnwrap()`) on top of the eventual SDK promise — the debugger has to await
a gate before the SDK's own `APIPromise` can exist. `instanceof Promise` holds;
`instanceof APIPromise` does not. Nothing in the SDK branches on that.
