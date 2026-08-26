# Spike results: cooperative pause/resume of an in-flight AI SDK agent loop

**Claim under test:** live pause/resume of a running `streamText` agent loop is possible
using only public extension points — `wrapLanguageModel` middleware + wrapping tool
`execute` functions. No SDK fork, no monkey-patching.

**Verdict: YES — the live-attach mechanism works as designed** (with caveats listed
below, none of which invalidate the mechanism).

## Environment tested

| Component | Version |
|---|---|
| `ai` | **7.0.79** (npm `latest` as of 2026-08-26) |
| `@ai-sdk/provider` (spec) | 4.0.8 — provider spec **V4** |
| `zod` | 4.4.3 |
| `ws` | 8.21.3 |
| Node | v24.19.0 |
| TypeScript / tsx | 7.0.2 / 4.23.12 |

Note: the plan said "current `ai` (v6.x)". **Current is v7.** The v6 line is now a
separate maintained dist-tag (`ai-v6` -> 6.0.266). We tested against 7.0.79 since that
is what new customers will install. Model mocking uses `MockLanguageModelV4` from
`ai/test` (a scripted 3-step conversation: 1 tool call, then 2 parallel tool calls,
then a final text answer that echoes the tool results found in its incoming prompt).

Run it: `pnpm spike` (alias `pnpm test`) in `examples/spike`. Headless, ~34s (30s of
that is the deliberate long-hold), exits non-zero on any failed assertion. 24/24
assertions pass; timings below are from a representative run (two full runs, identical
results).

## PASS/FAIL table

| # | Assertion | Result | Measured |
|---|---|---|---|
| a.1 | Breakpoint on `searchFlights` holds execution >= 2000ms until WS resume | **PASS** | held 2102.7ms |
| a.2 | Tool `execute` body did not start during the hold (timestamp ordering) | **PASS** | body started 0.1ms *after* resume |
| a.3 | Run completes normally after resume | **PASS** | 3 steps, total 2263.5ms |
| b.1 | Two parallel tool calls in one step gate independently and concurrently | **PASS** | both gates open 0.1ms apart, both held simultaneously |
| b.2 | Resume one; the other remains held (checked 600ms later) | **PASS** | pending=true, body not started |
| b.3 | Second tool's body runs only after its own resume | **PASS** | resumes 600.5ms apart, ordering asserted |
| b.4 | Run completes normally | **PASS** | 3 steps |
| c1.1 | Kill WS server mid-hold -> gate auto-continues within 100ms | **PASS** | lag 0.3ms (0.7ms in run 1) |
| c1.2 | Run completes fully after debugger crash (fail-open) | **PASS** | 3 steps |
| c1.3 | No further pauses after disconnect (breakpoints cleared) | **PASS** | 0 later pauses |
| c2.1 | No debugger connected: full loop, zero pauses | **PASS** | 0 pauses, 3 steps, 182.8ms total |
| c2.2 | Per-gate overhead with no debugger < 1ms | **PASS** | 6 gates, max 0.028ms, avg 0.013ms |
| d.1 | `convertCurrency` throws; on-error gate fires (wrapper catches before SDK) | **PASS** | throw -> gate 0.1ms |
| d.2 | After inject, loop continues; no error reaches the SDK stream | **PASS** | 3 steps, finish "stop", `onError` never fired |
| d.3 | Injected payload appears verbatim in the next `doStream` params (middleware-inspected prompt) | **PASS** | deep-equal on `{type:'json', value}` tool-result part |
| d.4 | Final assistant answer reflects the injected value | **PASS** | answer contains `91.3` and the injected marker |
| e.1 | before-step gate held 30s | **PASS** | 30003.3ms |
| e.2 | Nothing in flight during hold: step-2 `doStream` invoked only after resume | **PASS** | invoked 0.0ms after resume |
| e.3 | No SDK/provider timeout fires; run completes normally | **PASS** | 3 steps, finish "stop", total 30156.9ms |
| e.4 | `ai@7` timeouts are opt-in (no defaults) | **PASS** | `getTotalTimeoutMs/getStepTimeoutMs/getFirstChunkTimeoutMs/getChunkTimeoutMs(undefined)` all `undefined` |
| f.1 | Tee: middleware-observed text deltas == SDK per-step text, all 3 steps | **PASS** | exact string equality per step |
| f.2 | Tee: final answer == observed final-step deltas | **PASS** | 229 chars, exact |
| g.1 | `retry` action re-invokes the original execute | **PASS** | 2 attempts, 2 error gates |
| g.2 | `continue` (rethrow) hands the error to the SDK, which keeps looping | **PASS** | tool result becomes `error-text`, loop reaches step 3 |

## How each hold works (mechanism notes)

- **before-step** — in `wrapStream` middleware, the gate is awaited *before* calling
  `doStream()`. While held, no HTTP request/stream exists, so a 30s (or 30min) hold
  cannot hit any provider/socket timeout. Verified: the mock's `doStream` for the
  paused step was invoked 0.0ms after resume, never during the hold.
- **before-tool / on-error** — the tool wrapper decorates `execute`. `ai@7` invokes
  each tool call's `execute` concurrently within a step, so parallel calls gate
  independently for free (verified empirically, b.1-b.3).
- **inject-on-error required no fallback.** The plan's fallback ("catch inside the
  wrapper BEFORE the SDK sees the error") is in fact the primary design, and it works:
  the wrapper's try/catch sees the throw first by construction. The SDK only learns
  about whatever the wrapper returns (injected value) or rethrows. Code path in the
  SDK confirming why interception is necessary if you *don't* catch: in
  `ai/dist/index.js` the tool-call execution site wraps `execute` in try/catch and
  converts throws into `{type:'tool-error'}` parts (search for `type: "tool-error"`),
  which are then serialized to the model as `error-text` tool results — the loop
  continues either way (verified in g.2), but you no longer get to substitute a value.
- **fail-open** — the gate engine resolves all pending gates with `continue` and
  clears breakpoints on WS `close`/`error`. Auto-continue lag measured sub-millisecond
  (localhost); the 100ms budget has huge margin.
- **tee** — `ReadableStream.tee()` on the `doStream` result; SDK consumes one branch,
  the observer the other. Byte-exact text on all steps, no corruption, no reordering.

## API-surface surprises (ai@7 vs. what the plan assumed)

1. **v7 is current, not v6.** Provider spec is now **V4** (`LanguageModelV4`,
   spec version string `'v4'`). `ai/test` exports `MockLanguageModelV3` and
   `MockLanguageModelV4` — there is no `MockLanguageModelV2` anymore.
2. `LanguageModelMiddleware` in `ai@7` is `LanguageModelV4Middleware` with
   `specificationVersion` relaxed/optional (V3 middleware still accepted). Hook names
   unchanged: `transformParams` / `wrapGenerate` / `wrapStream`.
3. `stopWhen: stepCountIs(n)` still works; `stepCountIs` is now an alias of
   `isStepCount`.
4. Provider-level `finishReason` is now an **object** `{unified, raw}` (mock scripts
   must emit that shape), but the user-facing `StepResult.finishReason` is still a
   plain string (`"stop"`).
5. Stream part types: text arrives as `text-start`/`text-delta`(`.delta`)/`text-end`
   with ids; `tool-call` carries `input` as a **stringified JSON** field.
6. Tool `execute` signature: `(input, options)` where options =
   `{toolCallId, messages, abortSignal?, context, experimental_sandbox?}`. Tools may
   also return an **AsyncIterable** (preliminary/streaming results) — see risks.
7. `ai@7` grew an opt-in `timeout` option on `streamText`
   (`totalMs/stepMs/firstChunkMs/chunkMs/toolMs` + per-tool `<name>Ms`). Defaults:
   none (asserted e.4).
8. `ai@7` also has native observability callbacks (`onToolExecutionStart/End`,
   `onLanguageModelCallStart/End`, `onStepStart`). Useful as an extra event source for
   the debugger UI; they are not a substitute for gating (no way to substitute
   results, and error handling around them swallows callback errors).

## Risks discovered (honest list)

- **User-configured timeouts fight the debugger.** We proved there is no *default*
  timeout, but if an app sets `timeout: {totalMs|stepMs|toolMs}` or passes its own
  `abortSignal` (common in HTTP handlers), a held gate burns that budget and the run
  aborts mid-debug. The tool-execution duration the SDK measures *includes* our
  before-tool gate time. The product must detect these settings on attach and warn
  (or the wrapper must be installed with timeouts stripped in debug mode).
- **Platform execution limits.** A paused run keeps the process alive; serverless
  max-duration limits (e.g. function timeouts) will kill a long hold regardless of
  the SDK. Pause/resume across process death is a different feature (checkpointing),
  not covered by this mechanism.
- **Streaming tool executes are not covered.** Our wrapper is an `async` function, so
  a tool whose `execute` returns an `AsyncIterable` would come back wrapped in a
  promise; the SDK detects iterables on the direct return value. A production wrapper
  needs a non-async path for iterable-returning tools (pre-gate, then delegate and
  yield-through, gating per-yield if desired). Mechanically straightforward, but not
  proven in this spike.
- **Provider-executed / MCP-dynamic tools cannot be gated.** Anything with
  `providerExecuted: true` runs on the provider's side; our wrapper never sees it.
  The debugger can only observe those via the stream tee, not pause them.
- **`abort` action needs care.** Throwing a plain Error from `wrapStream` lands in the
  SDK's retry logic (`maxRetries` default 2) — an "abort" could be retried twice
  before surfacing, re-firing the gate each time. Abort should be implemented via an
  `AbortController`/AbortError (not asserted in this spike; `abort` is implemented but
  untested).
- **Injection bypasses tool typing.** The injected output is whatever the debugger
  sends; if a tool declares `outputSchema`, conformance of injected values was not
  tested. `repairToolCall`/`experimental_refineToolInput` interactions also untested.
- **Parallelism is an SDK behavior, not a contract.** Independent parallel gating
  works because `ai@7` executes a step's tool calls concurrently. If a future minor
  serializes execution (or `toolOrder` semantics expand), parallel pauses degrade to
  sequential pauses — still correct, different UX.
- **Tee backpressure.** `tee()` buffers for the slower branch. Our in-process observer
  is trivially fast; shipping deltas over a slow WS without local buffering could
  stall the SDK branch. Buffer/flush asynchronously in the product.
- **Middleware stacking order** with other user middlewares (`defaultSettingsMiddleware`
  etc.) untested.

## Bottom line

Cooperative pause/resume via `wrapLanguageModel` + tool-`execute` wrapping is real on
`ai@7.0.79`: holds are indefinite-by-design at step boundaries (nothing in flight),
per-call at tool boundaries, parallel-safe, fail-open in <1ms on controller loss,
zero-overhead (<0.03ms/gate) when detached, and error injection reaches both the next
model prompt and the final answer verbatim. Proceed with the plan; budget work for the
caveats above (timeout/abort interplay, streaming tools, provider-executed tools).
