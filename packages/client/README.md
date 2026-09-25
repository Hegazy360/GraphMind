# @graphmind-ai/client

Adapter-agnostic runtime for the **GraphMind live agent debugger**. This
package owns the session (WebSocket transport + event buffer), the run
context, and the **gate engine** — the cooperative pause points that let a
viewer hold, step, inject into, retry, or abort a running agent.

It has **no dependency on any AI SDK**. Adapters (e.g. for Vercel's `ai`
package) are separate packages that translate SDK callbacks/middleware into
`session.emit(...)` and `await session.gate(...)`.

> **Publishing note:** private until the npm scope question is settled (the
> `@graphmind` scope is taken); see `@graphmind-ai/schema`'s README.

## Quick start (what an adapter does)

```ts
import { createSession } from '@graphmind-ai/client';

const session = createSession({
  appName: 'trip-planner',
  sdk: { name: 'ai', version: '7.0.79' },
});

await session.run('book-trip', async (ctx) => {
  session.emit('node.started', {
    nodeId: 'tool:searchFlights', kind: 'tool', name: 'searchFlights',
    instanceId: 'call-1', input: { from: 'VIE', to: 'LIS' },
  });

  const decision = await session.gate('before', {
    nodeId: 'tool:searchFlights', kind: 'tool', name: 'searchFlights',
    instanceId: 'call-1', // 0.6: named on exec.paused (parallel calls stay apart)
  });
  if (decision.action === 'inject') return decision.output;   // skip execution
  if (decision.action === 'abort') throw ctx.signal.reason;   // see "Abort"

  // ... run the real tool, passing ctx.signal into SDK calls ...
});

await session.dispose();
```

## Behavior guarantees

- **Never throws into the host.** Every public method catches internal
  errors, degrades to a no-op, and logs one rate-limited
  `console.warn` (default: at most one line per failure kind per minute).
  Errors thrown by *your* function inside `session.run` are yours and
  propagate untouched.
- **Fail-open.** If the viewer disconnects (or the session is disposed),
  every held gate resolves `{action:'continue'}` immediately — measured
  under 100ms in tests — and breakpoints/mode are forgotten until the next
  `hello.ack` re-arms them.
- **Free when detached.** `gate()` short-circuits to a shared resolved
  promise when no viewer is attached or nothing matches. The test suite
  asserts average awaited-gate cost < 1ms (typical is microseconds; the
  spike measured 0.03ms worst-case).
- **Lazy, resilient transport.** Nothing touches the network until the first
  `run`/`emit`/`gate` (or an explicit `ready()` — see the attach guarantee
  below). Connects get 300ms (`connectTimeoutMs`), the handshake 1s, then the
  session stays detached and retries in the background every 10s
  (`retryIntervalMs`). Losing an *established* attachment is treated as the
  urgent case it is: the first reconnects happen after 200ms, 400ms and 800ms
  before the steady-state interval takes over, because every millisecond dark
  is events being pushed through a finite buffer. (Measured with the soak
  harness: a blip costs **206ms** dark, where the flat 10s interval cost
  **9.99s**.) All timers are unref'd — the session never keeps your process
  alive.
- **Replay-on-attach.** Events are kept in a bounded ring buffer (default 5000
  frames or 8 MiB, whichever binds first, drop-oldest; `bufferSize` /
  `maxBufferBytes`). On attach the whole buffer is replayed oldest-first with
  original `seq` numbers, so a viewer that attaches mid-run still renders
  history (and deduplicates by `seq` on reconnects).
- **Loss is never silent.** If the debugger is unreachable for longer than the
  buffer holds, the events that never made it are counted with their `seq`
  range and announced two ways: a **gap marker** on the next attach — a real
  `graph.hint` envelope carrying `payload.gap = {droppedCount, fromSeq, toSeq,
  reason}`, which the server stores and the viewer can render — and a
  rate-limited warning in your own logs. `session.stats().lost` is the honest
  count (`dropped` also counts frames that were delivered and then aged out of
  the replay buffer, which is not loss).

## Attach guarantee: `session.ready()`

The transport is lazy, so a run that starts immediately after `createSession`
can fail-open past its first gates before the handshake lands. When you need
pause guarantees from the very first event:

```ts
const attached = await session.ready();            // default timeout 2000ms
const attached = await session.ready({ timeoutMs: 500 });
```

`ready()` force-starts the connection immediately (even before any emit) and
resolves `true` once the handshake completes — breakpoints/mode from the
`hello.ack` are armed *before* it resolves. It resolves `false` on timeout,
and immediately when the session is disabled or disposed. It never throws
(and never rejects): `false` means "still detached — carry on", keeping the
fail-open contract. Concurrent calls share one connection attempt; a call
after attachment resolves `true` instantly; after a disconnect a new call
re-arms (it kicks an immediate reconnect instead of waiting out
`retryIntervalMs`).

## Kill switches

| Condition | Effect |
|---|---|
| `GRAPHMIND_DISABLED=1` | Disabled. Beats everything, including `enabled: true`. |
| `enabled` option set | As given (unless the above). |
| `NODE_ENV=production` | Disabled unless `GRAPHMIND=1`. |
| otherwise | Enabled. |

Disabled sessions no-op everything: no sockets, no buffering, no warnings —
but `session.run` still executes your function and still hands it a working
`RunContext` (ids + abort signal), so adapter code never needs to branch.

`GRAPHMIND_URL` overrides the default endpoint
`ws://127.0.0.1:4747/ingest` (or pass `url`).

## Recording less: the redaction switches (0.5.0)

Four whole-field kill switches stop values being recorded at all. Set them in
the environment of the **instrumented app** (not the server), or pass them as
session options on any adapter (`graphmind({ hideInputs: true, … })`); either
source turning a switch on turns it on — the environment is a floor code
cannot lower.

| Switch | Replaces with `"__REDACTED__"` |
|---|---|
| `GRAPHMIND_HIDE_INPUTS` / `hideInputs` | every node's `input` (prompts, messages, tool arguments, MCP params); streamed tool-argument deltas are emptied |
| `GRAPHMIND_HIDE_OUTPUTS` / `hideOutputs` | every node's `output`; every streamed token delta is emptied (`v: ""`, a `chars` length survives) |
| `GRAPHMIND_HIDE_TOOL_ARGS` / `hideToolArgs` | only tool nodes' `input` |
| `GRAPHMIND_HIDE_TOOL_RESULTS` / `hideToolResults` | only tool nodes' `output` |

> **What the tool-only switches do not cover.** The tool-only switches hide the tool node's own `input` / `output`. In an agent loop the same values also travel through the model: its `tool_use` blocks (LLM output) and the `tool_result` messages of the next request (LLM input). To keep tool arguments and results out of the recording entirely, set `GRAPHMIND_HIDE_INPUTS` (and `GRAPHMIND_HIDE_OUTPUTS`). Error messages are never redacted.

Any value except empty, `0`, `false`, `off` and `no`, case-insensitive (as options: `true`, `1`, or those strings — a privacy switch fails closed, so a misspelling hides rather than records). Redaction runs inside the session
before the ring buffer, so late-attaching debuggers, SQLite, exports,
`graphmind mcp-proxy` recordings and the read-only MCP tools only ever see the
placeholder; run names, node names, kinds, ids, timings and token counts are
always recorded (`graphmind mcp-proxy` additionally drops the server's command-line arguments from the run's label and metadata under `GRAPHMIND_HIDE_INPUTS`). Affected events carry `redaction: {count, keys}`. `node.error`
is never redacted — an error message can echo data, so `HIDE_OUTPUTS` is not a
guarantee against error text. The Python SDK and the Ruby gem implement the same switches, env names, placeholder and wire fields (0.5), held to the same conformance fixtures.

## Gating model

`session.gate(point, node)` — `point` is `before | after | error`, `node` is
`{nodeId, kind: agent|llm|tool|custom, name}`. The decision is:

| decision | adapter's obligation |
|---|---|
| `{action:'continue'}` | proceed normally |
| `{action:'inject', output}` | skip execution (or replace the failed result) and use `output` (an `output` holding `"__REDACTED__"` or a truncated preview is never handed over: the session answers `exec.refused` and the gate stays held) |
| `{action:'retry'}` | re-run the node's execution (typically after an `error` gate) |
| `{action:'abort'}` | stop the run — see below |

Pauses happen when a viewer is attached **and** a breakpoint matcher hits
(`kind?`/`name?`/`point?`, `point` defaults to `before`) — or on every
`before`/`error` gate in step mode (`mode.set: step`). While held, the
session emits `exec.paused`; on release (viewer resume, `pauseTimeoutMs`
auto-continue, disconnect fail-open, dispose) it emits `exec.resumed`.

Parallel gates are independent: two concurrent tool calls hold two pauses,
each resumable on its own (spike assertions b.1–b.4).

### Edited input (0.6.0)

An adapter that can run a call with different arguments says so per gate:

```ts
const decision = await session.gate('before', node, {
  editable: true,
  // for tools: merge the edit onto the LIVE arguments, then check your schema
  validateInput: (proposed, context) => {
    const merged = mergeToolInput(liveArgs, proposed, context);
    return merged.ok ? mySchemaCheck(merged.value) : merged;
  },
});
if (decision.action === 'continue' && 'input' in decision) liveArgs = decision.input;
```

The pause is offered as `editable` only when the app announced `edit-input`
(`GRAPHMIND_DISABLE_EDIT_INPUT` turns it off, same spellings as the other
switches) and the debugger lists it in `hello.ack.hubCapabilities` (and never
when `validateInput` is given but is not a function). An edit is valid as
`continue` at `before` or `retry` at `after`/`error`; anything else, an input
holding `"__REDACTED__"`, a truncation marker, a `__proto__` key or a
`constructor.prototype` path, or a validator that refuses, throws or takes
longer than 4 s is answered with `exec.refused` and the gate **stays held**
under the same pause id. The 4 s run from the moment the resume arrives and
cover synchronous work too: a synchronous validator (or the synchronous start
of an async one) cannot be interrupted and blocks your app while it runs, but
a verdict it reaches after 4 s is refused, so keep validators quick. A
disconnect or pause timeout while validating continues with the original
input. `exec.resumed.edited.after` records the input that ran, redacted like
the node's input (`HIDE_INPUTS`, or `HIDE_TOOL_ARGS` on a tool). Under those
switches the debugger never saw the live input, so `context.inputHidden` is
true and `mergeToolInput` takes the edit as a **full replacement** — a partial
edit merged onto hidden values would make the answer to a guess reveal them.
The validator, and a promise (any thenable) it returns, run in the gated
call's async context. `exec.resume.requestId` is echoed on `exec.resumed` /
`exec.refused` as it came.

`gate('after', node, { result })` hands the call's result to the session's
after-gate detectors — the smart holds below (`error-result` for a tool,
`truncated-tool-call` for an LLM step), which hold the gate while a debugger is
attached even with no breakpoint armed; the result itself is never sent
through this option.

Tool wrappers build these options with `toolGateOptions(session, edit, {result})`
(undefined while detached, so the detached path is untouched), read an accepted
edit with `editedArgs(decision)` (`args`: what runs — the schema's parsed
output; `input`: the merged arguments as the schema takes them), and check the merged arguments with
`toolSchemaCheck(schema)` — zod `safeParseAsync`/`safeParse`, any Standard
Schema, or a plain JSON Schema through `checkJsonSchemaLite`, a conservative
checker that refuses only what the schema clearly forbids and never evaluates
`pattern`. Refusal messages come from `describeIssues`: the field and the
problem, never the value (a validator's own message is never used).

A schema's transforms must never run twice on arguments the user did not
touch (a `dollars -> cents` transform applied again is a charge 100 times too
large). So a `ToolEdit` says how its arguments relate to the schema: `parsed`
when the host already parsed the model's arguments before the tool got them
(AI SDK `execute`, an McpServer callback, a LangChain `tool()` func) — the edit
is then merged into `input`, the raw arguments, when the host still has them,
and otherwise accepted only when the schema leaves the parsed arguments
unchanged or every argument is given (else `unsupported`, gate held); and
`runMerged` when the code that receives the arguments parses them itself (an
OpenAI loop's function), so the merged arguments run and the schema only
judges them.

### Smart holds and loop kinds (0.6.0)

While a debugger is attached, the session holds on failures that do not throw.
Every hold carries a `reason`: `loop`, `breakpoint` (with `smart` for a smart
hold), `step`, or `error`.

| hold | where | fires when |
|---|---|---|
| `smart.rule: 'error-result'` | tool `after` gate with `{ result }` (and a tool `error` gate with `{ result }`, which is how `graphmind mcp-proxy` gates `isError`: there only a RETURNED shape counts, and an `{error}`-only result — the proxy's JSON-RPC error — stays `reason: 'error'`; one gate, one hold) | strict shape only: `isError === true`, `success === false`, a non-zero numeric `exit_code`/`exitCode`/`exitStatus`, or a plain object whose **only** key is `error` (not `null`/`false`). No substring matching. |
| `smart.rule: 'truncated-tool-call'` | LLM `after` gate with `{ result }` | the normalized output's `finishReason` is `length` or `content-filter` and it requested at least one tool call (or a call's arguments did not parse: `inputText`). |
| `loop.kind: 'cycle'` | `before` gate | 2–4 calls repeated in 3 identical laps: same node, same arguments **and** same result at each position, at least 2 distinct calls per lap. Holds the first call of lap 4. |
| `loop.kind: 'error-repeat'` | `before` gate | the same tool's last 3 calls failed with the same error (arguments may vary; other tools' calls between them do not matter). A failure is a thrown error (name + message, whitespace collapsed, first 512 chars) or an error-shaped result. A success of that tool ends the streak. Holds the 4th call. |

Smart holds travel as `reason: 'breakpoint'` and loop kinds fill the four 0.5
loop fields (`repeats`, `firstSeq`, `lastSeq`, `fingerprint`), so 0.5 hubs and
viewers still show them. `smart.detail` never quotes a value and is dropped
under any HIDE switch that covers the node. Loop-kind fingerprints are HMAC
digests keyed with a random per-process salt that never leaves the process.
Output digests are computed locally before redaction and are never sent.
Under any HIDE switch covering the node, the fingerprint becomes
`"__REDACTED__"`. The v3 identical-repeat rule keeps its behaviour and wins
when both apply. For a cycle `firstSeq` is the start of the first identical
lap's first call (`period`, `laps` say how long and how many), for an
error-repeat the first counted failure's start; `lastSeq` is always the held
call's start.

The AI SDK, Anthropic, OpenAI and LangChain/LangGraph adapters' LLM `after`
gates pass `resultGateOptions(session, normalizedOutput)` — `{result}` while
attached, nothing while detached — so a detached gate call is exactly a 0.5
one. See each adapter's README for where that gate sits (a streamed AI SDK
step is held at its `finish` part, an Anthropic stream before `message_stop`;
a streamed OpenAI response is not held).

Switches: `GRAPHMIND_BREAK_ON_ERROR_RESULT` and `GRAPHMIND_BREAK_ON_TRUNCATED`
are on by default. `0`, `false`, `off` and `no` turn them off, and the session
options `breakOnErrorResult` / `breakOnTruncated` override the env.
`GRAPHMIND_ON_LOOP`, `GRAPHMIND_LOOP_ALLOW` and `loopGuard` apply to the new
loop kinds too. `GRAPHMIND_LOOP_THRESHOLD` governs only the identical-repeat
rule: cycle laps and the error-repeat count are fixed at 3 in 0.6.0. Detached
(or with `GRAPHMIND_ON_LOOP=warn`) a loop kind prints a rate-limited warning
that names the tool and the counts — never an argument, a result or an error
message. `GRAPHMIND_LOOP_THRESHOLD=0` (or `GRAPHMIND_ON_LOOP=off`) turns every
loop kind off. Memory is bounded: the last 64 completed
watched calls per run and kind, 256 open calls per run, 64 runs (LRU).

## Abort (why there is an AbortController)

Spike RESULTS.md, risk #4: throwing a plain `Error` out of SDK middleware
lands in the SDK's **retry logic** — an "abort" would be retried
`maxRetries` times before surfacing. So the abort path is cooperative
cancellation instead:

- Every `session.run` context carries an `AbortController`;
  `ctx.signal` must be passed into SDK calls by the adapter.
- When a gate resolves `{action:'abort'}`, the session aborts that run's
  controller with an `AbortError`-named reason **before** the gate promise
  resolves. The adapter then throws `ctx.signal.reason` (or simply lets the
  SDK observe the signal). AI SDKs treat `AbortError` as terminal — no
  retries — and `session.run` records the run as `status: 'aborted'`.

## Options reference

```ts
createSession({
  url,                 // default GRAPHMIND_URL ?? ws://127.0.0.1:4747/ingest
  appName, sdk, meta,  // reported in hello / run.started
  enabled,             // override kill-switch logic (GRAPHMIND_DISABLED still wins)
  connectTimeoutMs,    // 300
  handshakeTimeoutMs,  // 1000
  retryIntervalMs,     // 10_000 steady state (200/400/800ms burst after a blip)
  bufferSize,          // 5000 events, drop-oldest
  maxBufferBytes,      // 8 MiB — second, byte-wise bound on the same buffer
  pauseTimeoutMs,      // auto-continue held gates after N ms (default: hold forever)
  loopGuard,           // loop holds: { threshold, mode, allowNodes, kinds, ignoreKeys } | false
  breakOnErrorResult,  // smart hold on an error-shaped tool result (default true)
  breakOnTruncated,    // smart hold on a truncated tool call (default true)
  webSocket,           // WebSocket constructor override (default: global WebSocket, Node >= 22)
  logger, warnIntervalMs, env, // testing / embedding hooks
})
```

`session.stats()` returns `{enabled, attached, buffered, dropped, lost,
pendingGaps, heldGates, seq}` for diagnostics. `lost` counts events that were
evicted **before ever reaching the debugger** — real holes in the recorded
run; `dropped` is the blunter lifetime eviction count and includes frames that
were delivered first.

## Scripts

- `pnpm typecheck` — `tsc` over src + tests (schema resolved from source)
- `pnpm test` — vitest: gate hold/resume/inject/retry/abort, parallel
  independence, disconnect fail-open < 100ms, detached overhead < 1ms,
  ring-buffer replay + overflow, gap markers + loss accounting + fast
  reconnect, handshake + version-mismatch detachment, kill switches,
  host-crash immunity
- `pnpm build` — emit `dist/` (ESM + `.d.ts`; requires `@graphmind-ai/schema`
  built first, which pnpm's topological ordering does for you)
