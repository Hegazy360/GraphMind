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
  below). Connects get 300ms (`connectTimeoutMs`), the
  handshake 1s, then the session stays detached and retries in the
  background every 10s (`retryIntervalMs`). All timers are unref'd — the
  session never keeps your process alive.
- **Replay-on-attach.** Events are kept in a bounded ring buffer (default
  2000, drop-oldest; `bufferSize`). On attach the whole buffer is replayed
  oldest-first with original `seq` numbers, so a viewer that attaches
  mid-run still renders history (and deduplicates by `seq` on reconnects).

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

## Gating model

`session.gate(point, node)` — `point` is `before | after | error`, `node` is
`{nodeId, kind: agent|llm|tool|custom, name}`. The decision is:

| decision | adapter's obligation |
|---|---|
| `{action:'continue'}` | proceed normally |
| `{action:'inject', output}` | skip execution (or replace the failed result) and use `output` |
| `{action:'retry'}` | re-run the node's execution (typically after an `error` gate) |
| `{action:'abort'}` | stop the run — see below |

Pauses happen when a viewer is attached **and** a breakpoint matcher hits
(`kind?`/`name?`/`point?`, `point` defaults to `before`) — or on every
`before`/`error` gate in step mode (`mode.set: step`). While held, the
session emits `exec.paused`; on release (viewer resume, `pauseTimeoutMs`
auto-continue, disconnect fail-open, dispose) it emits `exec.resumed`.

Parallel gates are independent: two concurrent tool calls hold two pauses,
each resumable on its own (spike assertions b.1–b.4).

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
  retryIntervalMs,     // 10_000
  bufferSize,          // 2000 events, drop-oldest
  pauseTimeoutMs,      // auto-continue held gates after N ms (default: hold forever)
  webSocket,           // WebSocket constructor override (default: global WebSocket, Node >= 22)
  logger, warnIntervalMs, env, // testing / embedding hooks
})
```

`session.stats()` returns `{enabled, attached, buffered, dropped, heldGates,
seq}` for diagnostics.

## Scripts

- `pnpm typecheck` — `tsc` over src + tests (schema resolved from source)
- `pnpm test` — vitest: gate hold/resume/inject/retry/abort, parallel
  independence, disconnect fail-open < 100ms, detached overhead < 1ms,
  ring-buffer replay + overflow, handshake + version-mismatch detachment,
  kill switches, host-crash immunity
- `pnpm build` — emit `dist/` (ESM + `.d.ts`; requires `@graphmind-ai/schema`
  built first, which pnpm's topological ordering does for you)
