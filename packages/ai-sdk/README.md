# @graphmind/ai-sdk

Vercel AI SDK adapter for the GraphMind live agent debugger. Wrap your model
and tools; your app streams execution events to a local viewer, and the
debugger can hold execution at gates (pause / breakpoints / step) and resume
with `continue` / `retry` / `inject` / `abort`. Everything fails open: with no
debugger attached the adapter is a no-op with near-zero overhead, and a
debugger that disconnects mid-hold auto-continues every held gate.

Built only on public AI SDK extension points: `wrapLanguageModel` middleware
plus tool-`execute` decoration. No fork, no monkey-patching.

## Usage

```ts
import { graphmind } from '@graphmind/ai-sdk';
import { streamText } from 'ai';

const gm = graphmind({ app: 'support-agent' });

const model = gm.wrapModel(anthropic('claude-sonnet-4-5'));
const tools = gm.wrapTools({ searchFlights, checkBudget });

// Optional explicit run boundary (recommended): groups everything into one
// run, names the agent node, and carries the abort controller the debugger's
// `abort` action uses.
await gm.run('handle-ticket', () =>
  streamText({ model, tools, prompt: '...' }).consumeStream(),
);

await gm.dispose();
```

`graphmind()` accepts all `@graphmind/client` session options (`url`,
`enabled`, `meta`, timeouts, ...) plus `app`, `sdk`, `tokenFlushIntervalMs`
and `waitForAttach`. Kill switches: `GRAPHMIND_DISABLED=1` always
disables; `NODE_ENV=production` disables unless `GRAPHMIND=1`.

## Attach guarantee: `gm.ready()` / `waitForAttach`

The transport is lazy and fails open, so an agent that starts immediately can
run past its first gates before the debugger's handshake lands. When you want
pause guarantees from the very first event, either await attachment
explicitly:

```ts
const gm = graphmind({ app: 'support-agent' });
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
resolves — or `false` on timeout / when GraphMind is disabled. It never
throws; concurrent calls share one connection attempt; a call after
attachment resolves `true` instantly; and it works again after a disconnect
(a new call kicks an immediate reconnect instead of waiting out the
background retry interval). `false` is not an error — it means "continue
detached", preserving the fail-open contract.

With `waitForAttach` set, the **first** `gm.run()` / first wrapped model step
/ first wrapped tool call awaits `gm.ready()` (a number is the timeout in ms)
before proceeding. Still fail-open: on timeout the app continues detached,
and later calls never wait. Disabled sessions skip the wait entirely.

## What it does

**wrapModel** (per model step, `wrapStream`/`wrapGenerate`):

- emits `node.started` (logical node `llm:step`, one `instanceId` per step),
- awaits the `before` gate BEFORE calling `doStream`/`doGenerate` — nothing
  is in flight while a gate is held, so holds are indefinite-by-design,
- tees the provider stream to emit batched `node.token` deltas (one batch per
  node per ~34ms, i.e. ~30/sec) without disturbing what the SDK consumes,
- emits `node.finished` with token usage from the finish part,
- emits `graph.hint` from `params.tools` on an invocation's first step so the
  viewer can render the full tool roster grey before anything runs.

**wrapTools** (per tool call; parallel calls gate independently):

- `before` gate before the original `execute` runs,
- `after` gate post-`execute`, pre-return,
- `error` gate when `execute` throws, BEFORE the SDK sees the error:
  `inject` swallows the error and returns the injected value as the tool
  result; `retry` re-invokes the original execute; `continue` rethrows the
  original error (the SDK serializes it as an error-text tool result and
  keeps looping); `abort` aborts the run's AbortController and surfaces an
  `AbortError` (terminal — AI SDK retry logic never retries abort errors).

**Streaming tools** (`execute` declared as `async function*`): wrapped with a
non-async delegate so the SDK still sees an AsyncIterable on the direct
return value. Gated at before-start only; chunks are observed (as `node.token`
previews) but never paused mid-stream; mid-stream errors are observed, not
gated. A plain `async` execute that *returns* an AsyncIterable cannot be
passed through synchronously — the adapter drains it to the final value and
warns once; declare it `async function*` to keep preliminary results.

**Provider-executed tools** (`providerExecuted` / MCP-style): they run on the
provider's side, so they cannot be gated. The adapter observes them from
stream parts and emits `node.started`/`node.finished` with extra payload
fields `providerExecuted: true` and `ungated: true` (the wire schema is
loose — unknown fields are preserved), so viewers can render the "ungated"
affordance. The same fields mark them in `graph.hint`.

**Timeout neutralization** (attached only): `ai`'s `timeout` configs
(`totalMs`/`stepMs`/`toolMs`/...) materialize as abort signals whose reason
is named `TimeoutError`. While a debugger is attached, a held gate would burn
those budgets, so the adapter chains — never replaces — user/SDK abort
signals with the debugger's and filters timeout-driven aborts out of what the
model call and tool executes see, warning once. User aborts (any other
reason) pass through untouched. When detached, signals are untouched.
Limits: `toolMs` is fully neutralized; `totalMs`/`stepMs`/`chunkMs` are
stripped from the in-flight provider call, but `streamText`'s own outer loop
also watches its merged signal, so those can still abort the surrounding run
after a long hold — prefer removing `timeout` while debugging (the warning
says so).

## Node identity (decisions.md #1)

One logical node per code location; executions light it up:

| node        | nodeId            | instanceId          |
|-------------|-------------------|---------------------|
| agent (run) | `agent:<runName>` | runId               |
| model step  | `llm:step`        | `<invocationId>:sN` |
| tool call   | `tool:<toolName>` | toolCallId          |

Steps are grouped into invocations by the ALS run context (`gm.run`), with a
prompt-prefix heuristic inside a scope: a step whose prompt shares the first
message and has grown continues the previous invocation. Outside `gm.run`
all steps share one scope, so two *concurrent* un-run-wrapped calls with the
same first message can be merged into one invocation — wrap concurrent work
in `gm.run` to avoid this.

`node.finished` payloads carry the extra fields `instanceId` (correlation),
`injected: true` (result substituted by the debugger), and for streaming
tools `streaming: true` + `chunks`.

## Fail-open invariants

- Disabled session (`enabled: false` or kill switch): `wrapModel`/`wrapTools`
  return their inputs unchanged (identity, zero overhead).
- Enabled but detached: gates resolve `continue` on a fast path; events go to
  the replay ring buffer only.
- The adapter never throws into the host app; internal failures degrade to
  rate-limited warnings and uninstrumented behavior.
- Disconnect mid-hold releases every held gate with `continue`.

## Version support

Primary target: `ai` v7 (provider spec V4; validated against 7.0.79). The
peer range is `>=6 <8`; the SDK-surface-touching code is isolated in
`src/sdk-types.ts` (duck-typed stream parts / params / usage shapes that also
match v6's V3 spec) plus the single `wrapLanguageModel` runtime import, so a
v6 compat shim stays small. **v6 is untested** — see the repo decisions log
(`ai-v6` dist-tag CI matrix later).
