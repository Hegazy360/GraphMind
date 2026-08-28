# GraphMind adversarial audit

Two questions about the same product, asked by attacking it.

**1. Does a credential ever reach a recorded artifact?**

> GraphMind records what your agent **did** — prompts, tool arguments, tool
> results. It records nothing about how your app **authenticated**. An API key,
> an `Authorization` header, a token in a gateway URL, or a value in your
> environment never enters a GraphMind artifact. Everything you typed into a
> prompt does, on purpose.

**2. What can a hostile peer do to the server?**

> Everything that reaches `graphmind serve` arrives over a WebSocket from a
> process it does not control. The parser is contractually total — it *never
> throws* — and the server must never crash, never wedge, never let one bad
> frame kill a good connection, never let one peer corrupt another's run, and
> never store an event the viewer cannot parse back.

Question 1 is the secret-leak audit (canaries, six artifact surfaces, real
agents against a mock provider). Question 2 is the protocol-boundary fuzzing
(property-based generation plus a hand-written hostile corpus, driven at real
sockets). Both live here because both are adversarial and both need the same
thing: the real, shipped pipeline rather than a mock of it.

It is a private workspace package; it ships nothing.

```bash
pnpm build && pnpm --filter security-audit test
```

It deliberately imports the adapters and the CLI through their **published
entry points** (`dist/`), not through `src/`, because the question is what the
thing on npm does. Build first, or you are auditing a stale artifact. The suite
is not wired into the root `pnpm test` script — run it with
`pnpm test:security`; CI runs it on every push.

The expensive half of question 2 — *how much does an attack cost the server* —
is measured out of process by the soak harness, where the server's memory is
not mixed with the test runner's:

```bash
pnpm --filter soak start -- --scenario=adversarial
```

---

## The distinction that matters

GraphMind is a debugger. A debugger that hid your prompts would be useless, so
"never records a secret" cannot mean "never records anything sensitive". The
audit splits every canary into two classes and asserts the opposite thing about
each.

### Guaranteed: never recorded

A credential that only ever lived **outside the data path** must not appear in
any artifact. The audit plants a unique canary in each of these and greps every
surface for it:

| Where the secret lives | Example |
| --- | --- |
| the provider client's `apiKey` | `new Anthropic({ apiKey })`, `new OpenAI({ apiKey })` |
| the client's default headers | `defaultHeaders: { Authorization, 'x-org-secret' }` |
| a token in the request query string | `defaultQuery: { access_token }` |
| a token in a custom gateway `baseURL` | `baseURL: 'https://gw.example/v1/gw/<token>'` |
| a per-request header | `client.messages.create(body, { headers })`, `streamText({ headers })` |
| the process environment | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_PASSWORD`, `APP_SESSION_TOKEN`, and a PII-shaped `SUPPORT_CONTACT_EMAIL` |
| an unknown field in the provider's response | a gateway echoing your `Authorization` back as `_debug_echo` |

**Why this holds structurally, not by accident.** The adapters *field-pick* what
they report. They record `model`, `messages` / `prompt`, `system` /
`instructions`, tool **names**, tool **arguments** and tool **results** — and
nothing else. The request-options argument (where headers live) is passed
through to the SDK and never read; the response is summarised field by field
and never serialised wholesale. `tests/static-surface.test.ts` pins this: the
published builds of `@graphmind-ai/sdk`, `/anthropic`, `/openai` and
`/langgraph` do not contain the identifiers `apiKey`, `defaultHeaders`,
`defaultQuery`, `Authorization` or `baseURL` at all, and read **zero**
environment variables. The only HTTP header any adapter reads is
`x-request-id`, a correlation id.

### Recorded by design

These are recorded, must be recorded, and travel with every export:

- the user and system messages of every model call, verbatim;
- every argument the model passes to a wrapped tool;
- every value a wrapped tool returns — including a credential a tool fetched;
- error names, messages and stacks from failed steps;
- token deltas, usage counts, timings, node and run ids.

If you paste an API key into a prompt, GraphMind records the API key. That is
the product working. It is exactly why `graphmind record --html` prints:

```
It contains this run's prompts, tool inputs and outputs: check before sharing.
```

The audit asserts the by-design canaries **are** present in the HTML export.
That assertion is not decoration: it is what keeps the "no leak" assertions from
passing vacuously when an agent silently fails to run.

---

## Surfaces audited

Every one of these is collected from a real run, for each of the three
first-party adapters, and grepped:

1. **The SQLite database** — read as raw bytes, including the `-wal` and `-shm`
   files, so a value that never made it into a parsed row still gets caught.
2. **`GET /api/runs`** and **`GET /api/runs/:id/events`** — the HTTP responses,
   as text.
3. **The WebSocket frames a viewer receives** on `/ws/ui` — a real subscribing
   client, replay plus live tail.
4. **`graphmind record <id> --html`** — the self-contained shareable page,
   produced by the real CLI in a child process.
5. **`graphmind record <id>`** — the NDJSON export.
6. **Telemetry** — captured off the wire by a local endpoint. Every payload is
   asserted to have exactly the keys `event`, `installId`, `ts`, `version`, and
   to contain **no canary at all**, not even a by-design one.

Canaries are searched literally, case-folded, percent-encoded, base64 and
base64url, and byte-wise inside binary files.

---

## Why the results are trustworthy

Two guards keep this suite from becoming a green rubber stamp.

**Wire proof.** Before asserting that a credential was *not* recorded, each test
asserts it *was* genuinely on the wire. The mock provider is a real HTTP server
driven by the real Anthropic and OpenAI SDKs; it logs every request URL, header
and body. If a canary never reached the provider, the test fails as vacuous.
Environment canaries are likewise asserted to be set on the running process.

**Poisoned run.** `tests/harness-self-check.test.ts` runs an agent that
deliberately hands its own API key to a tool as an argument, and requires the
harness to find that canary on the SQLite, HTTP, WebSocket, HTML and NDJSON
surfaces. If any surface stops being collected, or the scanner stops matching,
that test goes red and the rest of the suite is known to be untrustworthy again.

---

## The protocol boundary

`parseEnvelope` had never been fuzzed. The wire contract makes an unusually
strong promise for a parser — *never throws*, total over every possible input —
and the only thing that had ever spoken to it was the SDK, which cannot
produce a malformed frame even on purpose.

Two layers of generation, because the parser has two doors (`src/fuzz.ts`):

- **`hostileTextArb`** — bytes that may not be JSON at all, or are JSON no
  `JSON.stringify` would ever emit: truncated documents, JSON5-isms, a BOM
  before the document, duplicate keys, `1e999`, `-0`, lone surrogates,
  `__proto__` and `constructor.prototype`, 1,000,000-deep nesting, 2 MB
  strings, a 1 MB run id.
- **`deformedEnvelopeArb`** — decoded values shaped like an envelope but wrong
  in one place: a missing field, a field of the wrong type, a fractional or
  negative `seq`, a foreign `gm`, a payload that violates its own schema.

Both are a mix: `fast-check` picks from a hand-written corpus as often as it
generates. Property-based generation is good at breadth and bad at the specific
pathological literal, and it is the literals (`"__proto__"`, `U+2028`, `1e999`)
that break things.

Those frames are then driven at the real thing. `src/wire.ts` boots a real
`startServer()` on an ephemeral port with a throwaway database, and `RawIngest`
/ `RawViewer` put **text** on `/ingest` and `/ws/ui` — no schema, no client, no
serializer between the test and the socket. Two further doors come at the wire
from the other end: `src/mcp-peer.ts` (a real MCP server instrumented by
`@graphmind-ai/mcp`, driven by a real MCP client, so a hostile `tools/call`
becomes a GraphMind envelope the way it would in production) and
`src/proxy-peer.ts` (the shipped `graphmind mcp-proxy` spawned as a child
process with a byte-faithful echo server behind it, so "the relay is
invisible" can be asserted as a byte comparison rather than believed). Four invariants are asserted after
every batch:

1. the server does not die and does not wedge (`/health` still answers,
   promptly — a frame that pins the event loop is a denial of service even if
   nothing throws);
2. one bad frame does not kill the connection it arrived on;
3. a bad frame never touches an unrelated run — a healthy 40-event run
   streaming on another socket keeps every event, in order;
4. everything stored is still an envelope `parseEnvelope` accepts, because an
   event the viewer rejects is an event that vanishes from the canvas on
   reload.

**Non-vacuity, again.** Every attack file opens with a plain `it(...)` proving
the attack machinery actually worked — the control run really is streaming, the
victim really did reach a gate, both peers really did send their events —
before anything asserts that the attack failed. This matters more now that the
defects are fixed than it did when they were open: without those guards, an
attack setup that silently stopped working would make every property below it
pass for the wrong reason, and the suite would report safety it never tested.

---

## Findings

### Closed in 0.4.0 — the protocol-boundary pass

Nine defects were found by fuzzing `/ingest` and by running a real attack
against a real session holding a real gate. **All nine are fixed**, and every
test that reported one now asserts the property instead of the defect — so
each is a regression test, not a note. They are kept here in full because the
reasoning is the durable part: what the boundary is for, and why each answer
is the one it is.

All of them are local-only. The server binds 127.0.0.1, so the attacker is
another process on the same machine — a postinstall script, a compromised
dependency, a second project's dev server.

**1. Any `/ingest` connection could claim any run — critical.**
`Hub.handleIngestFrame` assigned run ownership to the last writer, with no
check that the writer had anything to do with the run. One frame naming
someone else's run bought: fabricated nodes rendered inside it; the operator's
next `exec.resume` delivered to the attacker, *including the value they
injected*; the victim's gate never released (fail-open does not cover this —
the client believes the debugger is attached and simply has not answered); and
a forged `run.finished` marking a live run failed.
*Fixed:* a run is claimed by the token that first wrote to it. `hello.ack`
mints a `sessionToken`, the client echoes it as `hello.resumeToken`, and
writes from any other token are refused. The compatibility seam — a client
older than the `run-claim` capability cannot prove continuity across a
reconnect, so its claim is enforced only while it is connected — is documented
in `internal/decisions.md` and is the one place identity is assumed rather
than proven. `tests/run-isolation.test.ts` runs the whole attack and asserts
it lands nothing.

**2. `seq` squatting silently deleted a real app's events — high.**
`(runId, seq)` INSERT OR IGNORE means whoever writes a seq first owns it, so a
peer pre-claiming a run's low sequence numbers deleted the start of that run
with no error anywhere. *Fixed by the same claim check* — a run already
claimed cannot be written by anyone else. Residual and inherent: whoever names
a *never-seen* run id first owns it. Run ids are random, so that needs a
guess.

**3. The 512 KB guard destroyed fields a payload's own schema requires — high,
and no attacker needed.**
`truncateFields` replaced an oversized field with a marker *object*. When the
biggest field was one the schema requires to be a string, the stored envelope
stopped validating and the viewer dropped it on replay. The realistic case is
`node.error` with a large provider error body: a debugger silently losing
precisely the error event.
*Fixed:* truncation is type-preserving (`shrinkValue`) — a string stays a
shorter string, an array stays an array, an object keeps its own fields with
the marker merged in. `tests/ingest-fuzz.test.ts` pins five envelope shapes
where a required field is the biggest field.

**4. The wire had no protocol-appropriate frame cap — medium (availability).**
Neither `WebSocketServer` passed `maxPayload`, so the wire accepted `ws`'s
default of 100 MiB against a 512 KB storage budget, and the guard only ran
after the frame was buffered, decoded and parsed. One 64 MB frame took the
server from 95 MB RSS to ~500 MB, permanently.
*Fixed:* `MAX_FRAME_BYTES` (16 MiB) on both sockets — 32x the storage budget,
so every payload worth a preview still degrades gracefully, and anything
larger is refused during frame assembly.

**5. Every dropped frame cost the operator one log line — medium.**
Measured at exactly 1.00 lines per garbage frame, unthrottled, written
synchronously to the operator's TTY.
*Fixed:* `Hub.throttledLog` rate-limits per message kind and reports what it
suppressed. The soak now measures 0.00 lines/frame over 5,000 garbage frames.

**6. The liveness reaper killed the peer it was busiest with, silently — medium.**
A pong arrives *behind* that peer's own frames in the same TCP stream, so a
peer with a backlog was terminated **because** the server was busy with it:
26,570 of 60,000 events lost, with no error, no gap marker, and one
`app detached` line.
*Fixed:* liveness is "we read bytes from this socket recently". The soak now
drains all 60,000 with the socket intact.

**7. `subscribe` replayed a whole run, unbounded, on every frame — medium.**
Including repeats of a run the viewer was already tailing. *Fixed:* a repeat
is acknowledged with an empty replay pair.

**8. `parseEnvelope` required the `payload` key to be present — low.**
`JSON.stringify` drops a key whose value is `undefined`, so an accepted
unknown-type envelope with no payload did not survive being written down and
read back — a hole in the stated forward-compatibility contract. *Fixed:*
`payload` is optional.

**9. `ts` was unbounded, and it is what the run list sorts by — low.**
One frame with `ts: 1e300` pinned that run to the top of the operator's list
until it was pruned. *Fixed:* `ts` must be a non-negative safe integer, which
is what epoch milliseconds are.

**10. A lone surrogate in a `runId` was silently rewritten — low.**
SQLite's text binding substitutes U+FFFD, so the app streamed under one id and
the server stored another; subscribing with the original tailed an empty run.
*Fixed:* refused at the parse boundary. Nothing legitimate generates one.


### Fixed since this file was first written

The three defects this README originally reported are closed, and the tests
that reported them now assert the fix instead:

1. **Cross-origin WebSocket upgrades** and 2. **DNS rebinding on the HTTP API**
   — closed by `packages/cli/src/origin-guard.ts`, applied to every request and
   to both upgrade paths; `tests/local-server-exposure.test.ts` asserts the
   refusals.
3. **World-readable database** — `SqliteStorage` now creates `~/.graphmind`
   0700 and `graphmind.db` 0600.

### Residual risks (not GraphMind defects, worth knowing)

**A provider that echoes your credential back gets it recorded.** If an
OpenAI-compatible gateway answers `401 invalid credentials: sk-…`, the SDK puts
that message on the `Error` it throws, and GraphMind records error names,
messages and stacks. GraphMind is relaying what the provider said, but the key
still lands in the database. Pinned by the last test in
`tests/error-and-response-paths.test.ts`. If a mitigation is ever wanted, the
single place to add a redaction pass is `toErrorInfo()` in
`packages/client/src/errors.ts`.

Note that this only applies to the error *message*. An unknown *field* in a
successful response is dropped, because responses are field-picked — proven by
the `_debug_echo` test in the same file.

**Anything you put in a prompt or a tool payload is in the export.** By design.
Treat a `--html` export like a screenshot of your terminal.

**A loopback bind is not authentication.** The origin guard stops *browsers*.
Every other process on the machine can open `/ingest` and `/ws/ui`, read every
recorded run and drive a paused agent. That is the deliberate local-first
posture for *reading* — the database is readable anyway — but findings 1 and 2
show it is a far weaker posture for *writing* than it looks.

### Verified clean

Attacked and held. These are results, not assumptions.

- **The parser is total.** `parseEnvelope` and `parseEnvelopeJson` never throw,
  for any input: thousands of generated hostile frames per property plus a
  hand-written corpus of truncated JSON, JSON5-isms, BOM-prefixed documents,
  `1e999`, `-0`, duplicate keys, 1,000,000-deep nesting, 2 MB strings and every
  prototype key. An `ok` result is always a well-formed envelope of a known
  type and always survives serialize → parse again.
- **No prototype pollution**, in the parser or at either socket: `__proto__`
  and `constructor.prototype` as payload fields, type names and message types
  leave `Object.prototype` byte-for-byte unchanged.
- **One bad frame never kills a good connection.** 100 garbage frames
  interleaved with 100 valid ones: all 100 valid ones stored, socket still
  open. The one exception is deliberate — a foreign `gm` closes *that*
  connection with 1002 and touches nothing else.
- **A bad frame never touches an unrelated run.** A 40-event control run
  streaming on a second socket is identical, exactly once and in order, after
  the whole hostile corpus and 400 generated frames.
- **Everything stored is still a valid envelope**, apart from finding 3 —
  including unknown types (tolerated by contract), 250 generated JSON payloads,
  and every unicode class: NUL, lone surrogates, U+2028/9, RTL overrides,
  noncharacters, zero-width joiners, combining-mark explosions.
- **Ingest sockets are write-only for run data.** An attacker who claims a run
  reads its control traffic (finding 1), never its events.
- **Resource abuse held**: 500 simultaneous connections, a 20,000-frame flood
  with zero loss and `/health` still answering in milliseconds, 200 silent TCP
  sockets, a half-sent upgrade that stalls forever, and a peer that connects
  and never speaks. An honest run streams through all of them.
- **The viewer socket answers in-protocol under fuzzing.** Every reply to every
  hostile frame is well-formed JSON of a known UI message type, the socket
  stays open, and a second viewer and the app are unaffected. A viewer cannot
  write into a run: an event type dressed up as a control is refused by name.
- **Query parameters are validated**: non-integer, negative and out-of-range
  `afterSeq` / `limit` are 400s, and a path-traversal run id is a 404.

### The two MCP boundaries — covered, and clean

Both landed during this work, and they are different shapes.

**`@graphmind-ai/mcp` — the in-process adapter.** Not a proxy: it instruments
an MCP server from the inside, so GraphMind has no JSON-RPC parser of its own
here — the official SDK owns that. What it does own is the seam where somebody
else's agent meets GraphMind's wire, and that seam has three inputs, all
covered by `tests/mcp-boundary-fuzz.test.ts` against a real `McpServer` driven
by a real `Client` over the SDK's in-memory transport:

- **hostile request arguments.** Every string in `NASTY_STRINGS`, 120 generated
  JSON values, a 4,000-deep object, a 2 MB string, `__proto__` and
  `constructor.prototype`: all round-trip, none reach the host handler as an
  exception, none pollute `Object.prototype`, and every resulting envelope is
  still valid.
- **a hostile host result.** A 900 KB result is truncated in *storage* (still a
  valid envelope) while the MCP client receives it whole — GraphMind is on the
  path, not in the way. A handler that throws still reaches the client as a
  normal tool error; GraphMind does not swallow the host's own failure.
- **the injected value.** This is the package's reason to exist and the
  riskiest of the three: `coerceInjected` lifts whatever the operator typed
  into the MCP result shape the request must return, and the SDK validates it
  on the way out — so a bad coercion would fail a request the host never even
  ran. Twelve shapes were injected through a real gate (bare string, number,
  `null`, object, array, a hand-built `CallToolResult`, a lone surrogate,
  U+2028 + an RTL override, a NUL byte, a nested object, a 1 MB string, a
  `__proto__` key). All twelve produced a result the client accepted, the host
  handler never ran, and nothing was polluted.

**`graphmind mcp-proxy` — the man in the middle.** The only place in GraphMind
where *both* peers are untrusted, and the one whose first contract is not
"observe correctly" but *be invisible*. `tests/mcp-proxy-fuzz.test.ts` spawns
the shipped `dist/cli.js` exactly as an `mcpServers` config would, puts a
byte-faithful echo server behind it, and compares what came out with what went
in — so anything the proxy normalises shows up as a diff rather than as a
subtle behaviour change:

- **90+ hostile frames relayed byte-for-byte**, with GraphMind attached: batches,
  `id` as `null` / float / boolean / object / array, duplicate and colliding
  ids, `"1"` vs `1`, a response nobody asked for, `result` *and* `error` in one
  frame, `jsonrpc: "1.0"`, a numeric `method`, `9007199254740993`, `1e999`,
  `-0`, `__proto__` in params and in a result, plus the general corpus.
- **framing edge cases preserved**: a `\r` before the newline (the SDK's own
  `ReadBuffer` strips it; the proxy must not), an empty frame, a NUL byte, and
  a frame delivered one byte per write.
- **a 4 MB frame** unchanged, and a frame over `--max-frame-bytes` still
  delivered in full — the documented "stop observing, keep relaying"
  degradation loses nothing.
- **fail-open both ways**: perfect relay with no GraphMind running at all, and
  perfect relay after the GraphMind server is killed mid-conversation.
- **stdout carries only protocol bytes**, even when the proxy is fed garbage —
  the contract that makes it usable at all, since one stray diagnostic line
  would corrupt the client's stream.
- **every envelope the proxy reports** is valid, whatever the conversation.

**No defects found at either boundary.** One behaviour is worth a line in the
docs, and it is not a bug: pause-on-error is armed by default
(decisions.md #8), and in the proxy a held gate stops that *direction of the
conversation* (`relay.ts` pauses the source for the whole drain). So a
developer who puts `graphmind mcp-proxy` in an `mcpServers` config, leaves
`graphmind serve` running and closes the viewer tab will see their agent hang
on the first failing tool call. The proxy handles it about as well as it can —
it prints `HOLDING … at the error gate — resume it in http://127.0.0.1:<port>
(the MCP client is waiting…)` on stderr — and the hold is a pause, not a
deadlock: `tests/mcp-proxy-fuzz.test.ts` releases it from a viewer and the exact
bytes arrive. The same default has a milder version in the in-process adapter,
where the symptom is a hung tool call in someone else's agent. `pauseTimeoutMs`
opts out.

---

## Layout

```
security/
  src/
    canaries.ts        the canary registry + the forbidden / by-design split
    scan.ts            multi-encoding scanner over text and binary artifacts
    mock-provider.ts   a real HTTP server speaking Anthropic + OpenAI, logging
                       every request so "it was on the wire" is provable
    harness.ts         boots a real server + viewer socket, runs an agent,
                       collects all six artifact surfaces
    agents/            three instrumented agents, one per first-party adapter
    fuzz.ts            hostile corpora + fast-check arbitraries for the wire
    wire.ts            a real server plus raw sockets that can send anything
    mcp-peer.ts        a real MCP server instrumented by @graphmind-ai/mcp,
                       driven by a real MCP client over the SDK's transport
    proxy-peer.ts      the shipped `graphmind mcp-proxy` as a child process,
                       with a byte-faithful echo server behind it
  tests/
    adapter-leaks.test.ts           the main audit, per adapter, per surface
    harness-self-check.test.ts      proves the harness can detect a leak
    error-and-response-paths.test.ts  failure path + hostile gateway responses
    local-server-exposure.test.ts   cross-origin access and file permissions
    export-hardening.test.ts        HTML export escaping + the sharing warning
    static-surface.test.ts          structural guard on the published builds
    protocol-fuzz.test.ts           parseEnvelope: total, sound, stable, pure
    ingest-fuzz.test.ts             the server's ingest path under bad frames
    run-isolation.test.ts           can one peer reach into another's run?
    ingest-abuse.test.ts            floods, giant frames, storms, slowloris
    ui-protocol-fuzz.test.ts        the viewer socket under bad frames
    mcp-boundary-fuzz.test.ts       hostile MCP requests, results and injects
    mcp-proxy-fuzz.test.ts          byte-faithfulness of the JSON-RPC relay
```


## Adding a canary

1. Add it to `makeCanaries()` in `src/canaries.ts` with the right `kind`.
2. Plant it in the agents under `src/agents/`.
3. If it is a `forbidden` canary that rides on a real request, add its id to
   that adapter's `wireCanaries` list in `tests/adapter-leaks.test.ts`, so the
   suite proves it reached the provider before asserting it was not recorded.

Nothing else needs changing: the scanner and the six surfaces are generic.

## Adding a hostile frame

1. A specific literal that should not break anything goes in `NASTY_STRINGS`,
   `NASTY_NUMBERS` or `hostileText()` in `src/fuzz.ts`. Every corpus entry is
   sent through both the parser and the real ingest socket automatically —
   nothing else needs changing.
2. A whole new *shape* of attack gets its own `it(...)` in the file that owns
   that door: `ingest-fuzz.test.ts` for malformed input, `run-isolation.test.ts`
   for one peer reaching into another's run, `ingest-abuse.test.ts` for
   resource cost, `ui-protocol-fuzz.test.ts` for the viewer socket.
3. If it demonstrates a defect whose fix lives in `packages/**`, write the
   *wanted* behaviour as `it.fails(...)` and pair it with a plain `it(...)`
   that proves the setup ran. The `it.fails` turns red the day it is fixed;
   the plain one stops the pair from passing vacuously if the setup rots.
4. Anything whose answer is a number rather than a boolean — memory, latency,
   throughput — belongs in `examples/soak/src/scenarios/adversarial.ts`
   instead, where the server is out of process and its RSS is sampled from
   outside.
