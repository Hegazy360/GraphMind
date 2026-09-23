# Changelog

All notable changes to GraphMind. Versions are shared across every package in
this repo (`graphmind-ai`, `@graphmind-ai/sdk`, `@graphmind-ai/client`,
`@graphmind-ai/schema`, `@graphmind-ai/anthropic`, `@graphmind-ai/openai`,
`@graphmind-ai/langgraph`, `@graphmind-ai/mcp`, the Python `graphmind-ai`
distribution, and the Ruby `graphmind` gem).

## 0.6.0 (unreleased)

<!-- PHASE7-PENDING: headline + the sections for detectors, argument editing,
control plane, usage truth and the context view are written when each lands. -->

### Added — drive a paused agent from your coding agent (control plane)

- **`graphmind pauses`, `graphmind wait`, `graphmind resume`.** `wait` blocks
  until a pause opens and prints it compactly — the held call's input (large
  values go to a private temp file), whether it is editable, and the exact
  `resume` commands that apply. `resume <pauseId> --run <id> --action
  continue|retry|inject|abort [--output …] [--input …]` waits for the app's
  answer. `--json` everywhere; documented exit codes (0 ok, 2 timeout, 3 no
  server, 4 nothing to act on, 5 not authorized, 6 refused, 7 taken).
- **`graphmind serve --json`** prints `{port, url, pid, version}` — never a
  token — for running the debugger headless.
- **`graphmind skill [--install]`**: a Claude Code Agent Skill
  (`skills/graphmind/SKILL.md`, shipped in the package) covering setup per
  framework, headless serve and the pause/wait/resume loop.
- **HTTP**: `GET /api/pauses[?runId=][&wait=]`, `GET
  /api/runs/:runId/pauses/:pauseId`, `GET /api/session`, `POST
  /api/runs/:runId/pauses/:pauseId/resume` (Bearer + JSON only, no CORS,
  long-poll ≤ 120 s, ≤ 16 at once).
- **First writer wins.** The server keeps a registry of held pauses (per run)
  and referees every resume — from any viewer tab, the CLI or HTTP: the first
  is forwarded with a `requestId`, others get `pause-taken`, a pause known to be
  closed gets `no-such-pause`. An app's refusal, or 5 s without an answer,
  reopens it.
- **Audit.** The stored `exec.resumed` records who released it (`principal`:
  `viewer`, `agent` or `anonymous`, from the credential — never from the app)
  and an optional sanitized `operator` label. The viewer shows "resumed by
  agent" and, in the run bar, its own control level and the agent's.

### Changed — control needs a credential (security)

- At start the server mints a **viewer** token (full control; reaches the
  browser only in the `#token=` URL fragment, through a private redirect file
  the CLI opens — never a command-line URL; printed only to a terminal) and an
  **agent** token (`~/.graphmind/run/serve-<port>.json`, 0600) that
  **`serve --allow-control=off|resume|inject|edit`** limits in the server.
  Default `off`: a coding agent can do nothing until you allow it.
- **Input edits** and **every non-GET `/api` route** (including `POST
  /api/demo/start`) need a token. `?token=` and cookies are never accepted.
  `serve --no-edit-input` refuses all edits. The server also refuses edited
  inputs and injected values that still contain `__REDACTED__` or a truncation
  marker, using the client's own marker list.
- **Deprecated:** a viewer socket without a token still continues, retries,
  injects and aborts as in 0.5 (never edits); the server logs a one-time note.
  Reading runs still needs no credential — any local process can read them over
  loopback.
- Every response now carries `Content-Security-Policy: frame-ancestors
  'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff` (`/api` adds `Cache-Control: no-store`): the
  viewer can no longer be framed.
- `graphmind mcp` is unchanged and still read-only; its instructions now say
  where control lives and that recorded payloads are untrusted data.

### Fixed — a privacy switch no longer fails open on spelling

`GRAPHMIND_HIDE_INPUTS=yes` recorded everything: only `1` and `true` counted,
and `GRAPHMIND_DISABLED` counted only the exact string `1`, so
`GRAPHMIND_DISABLED=true` left instrumentation on. Every kill switch and
privacy switch — `GRAPHMIND_HIDE_INPUTS/OUTPUTS/TOOL_ARGS/TOOL_RESULTS`,
`GRAPHMIND_DISABLED`, and `DO_NOT_TRACK` in the CLI — is now **on for any value
except unset, empty, `0`, `false`, `off` and `no`** (any case, surrounding
spaces ignored), identically in TypeScript, Python and Ruby. A typo hides
rather than records. If you set one of these to an unusual value meaning
"off", change it to `0`.

### Fixed — Python SDK: framework calls that were invisible or broke on inject

- **Streamed and raw-response calls are recorded.** The OpenAI Agents SDK's
  `Runner.run_streamed` goes through `with_streaming_response`, which reached
  the instrumented method with a raw-response header; the node was created
  but its output was empty. The wrapper now recognises raw responses, tees
  streamed bodies without changing what the caller reads, and records text
  and usage. It no longer matters whether `with_streaming_response` was
  touched before or after `instrument_openai`, and each call is one node.
- **`client.beta.messages.create` / `.parse` / `.stream`** (and
  `messages.parse`) are gated like `messages.create` — Pydantic AI's
  Anthropic model and Anthropic's own tool runner use them.
- **Injected replies come back as the SDK's own types** (`ChatCompletion`,
  `Response`, `Message`, `BetaMessage` and their `Parsed*` variants) instead
  of a raw dict, so frameworks that read `.output`, `.usage` or `.id` keep
  working. A bare string becomes a minimal assistant reply; a value that does
  not validate is passed through unchanged with one warning naming the field.
  A streaming call cannot be injected into: it continues, with a warning.
- The docs show `set_default_openai_client(gm.instrument_openai(AsyncOpenAI()))`
  for the OpenAI Agents SDK and passing an instrumented client to Pydantic AI
  providers. The frameworks themselves are not in the test suite; the client
  calls they make are.

### Wire protocol (additive — every 0.5 peer accepts or ignores these)

- `exec.paused.editable`, `exec.paused.smart {rule, detail?}`,
  `exec.paused.loop.kind / period / laps`
- new event `exec.refused {pauseId, code, message?, requestId?}` — an edited
  input was refused and the gate is still held
- `exec.resume.input / requestId`; `exec.resumed.edited {after} / requestId /
  principal`
- `hello.ack.hubCapabilities`; client capability `edit-input`
- `TokenUsage.inclusive / cacheReadTokens / cacheWriteTokens / reasoningTokens`

New loop kinds keep `reason: "loop"` and still fill the four 0.5 loop fields;
smart holds travel as `reason: "breakpoint"` so a 0.5 debugger, whose reason
list is closed, still shows the pause.

## 0.5.1

A patch release, and the first GitHub Release and PyPI upload of the 0.5 line:
npm 0.5.0 shipped from the laptop, and CI on its tip then failed on Linux, so
0.5.0 was never tagged. Everything in [0.5.0](#050) below is included; Python
goes straight from 0.4.4 to 0.5.1.

### Fixed — `mcp-proxy --wait-for-attach` and a server that dies on boot

The case the early-death diagnostics exist for, and the one flag that broke it.
With `--wait-for-attach` the proxy left the server's stdout and stderr unread
until a debugger attached (or the 3 s wait ran out). Three things went wrong:

- **The server's stderr was lost.** Node's `child_process` resumes every
  unread stdio stream when the child exits and emits its bytes to no one. A
  server that crashed before the wait was over had its whole stack trace
  discarded — not mirrored to the MCP host, not quoted in the report.
- **The proxy never exited.** The stdout relay was attached after the stream
  had already ended, so it waited for an `end` that had already happened. With
  stdin held open (as every MCP host holds it) the proxy hung; with stdin
  closed it exited **0** instead of the server's code.
- **The crash reason could be cut off even when a debugger was attached.**
  stdio is a socketpair; a few hundred small unread writes fill its buffer,
  after which a Node server's writes queue in-process and die with it at
  `process.exit`. The lost lines are the last ones — the reason. On Linux this
  failed every time; a Python server's blocking writes would instead hang.

Both streams are now read from the moment the server is spawned. stderr is
mirrored to the host immediately and buffered (bounded, 256 KB, oldest out)
for the graph until the run opens; stdout is piped into a buffer the relay
reads when it starts, so nothing is dropped and a server that is already gone
still ends the session with its own exit code. A held gate still stops the
server-to-client direction (backpressure reaches the child once the buffer
fills). New test: a server logs 3,000 lines and exits while the attach wait
runs its course — every line reaches the host and the report quotes the tail.

### Fixed — ruby_llm 2.0

ruby_llm 2.0 shipped during the 0.5.0 release and changed the signatures of
the private hooks the Ruby gem patches
(`provider_completion(usage_recorder:, stream_tracker:)`,
`Tool#call(tool_call:, **arguments)`) and removed `Chat#with_tool`. The
1.x-shaped patches raised `ArgumentError` inside the user's chat — even with
no viewer attached. Every patch now forwards whatever arguments it gets; tool
input is read from either calling convention (RubyLLM's own `tool_call:`
object is left out of it); usage and model are read from either `Message`
shape; only registration methods the chat really has are patched, so
`respond_to?` never lies. CI runs the Ruby suite against the newest ruby_llm
and, in its own cell, the last 1.x. Two new tests drive a tool through the
gem's real chat loop instead of calling it directly. The docs' snippet uses
`with_tools`, which both majors have.

### Fixed — tests that only passed on macOS

- A redaction test checked a 5,000-level value with `JSON.stringify`, which
  is recursive in V8 and overflows on Linux x64 but not on macOS arm64. The
  walk under test was already iterative; the assertion is now iterative too.
- The stderr-tail test above failed on every Linux run for the reason above;
  it was a real defect, not a flaky test.

## 0.5.0

The release for the reviewer who has not decided yet: the platform engineer
who opens the repo before opening the tool. Everything here was chosen after a
research pass on the September 2026 landscape and an adversarial refutation of
each candidate; the things that did not survive that are not in here.

### Fixed — edges start and end on the cards, and never cross one

Two defects hid behind "the edges look detached". The first was the known one:
with five or more childless siblings the layout packs them into a grid, and the
parent's bezier to a row-two card went straight through the row-one card above
it (6 of 11 edges on a real MCP session). Edges are now routed orthogonally:
down from the parent to a bus line in the layer gap, across, then down the
column **gutter** to the target and in through its top handle, so a fan-out
reads as one trunk with drops. The second was the real reason they looked
loose: React Flow measures a node's handle positions once, when it mounts, and
our cards mount mid entrance animation — so every edge was anchored to a
phantom handle 60–100px from where the card ended up, for the life of the node.
The canvas now draws edges from the layout's own geometry and ignores the
measured handles. Both are guarded by a geometry harness: eleven fixtures
(demo, MCP, 5/11/30-leaf fans, three nested levels, the 300-node stress run)
must have zero edge–card crossings and zero overlapping cards, and a browser
test samples the painted SVG paths every 4px against the real card boxes.

### Changed — an MCP session shows the work and folds the protocol

`graphmind mcp-proxy` used to render a session as eleven flat siblings, six of
which were `initialize`, `notifications/initialized`, `tools/list`,
`resources/list`, `prompts/list` and `ping`. Protocol traffic — handshake,
discovery, keepalive, and any method GraphMind does not recognise — is now
parented under one node named **protocol**, emitted with a new `collapsed`
hint so the viewer opens it folded with a count ("6 protocol calls · 702ms");
the work (`tools/call`, `resources/read`, `prompts/get`,
`sampling/createMessage`, `elicitation/*`, `completion/complete`) sits directly
under the session. Every folded call is still a node: a breakpoint on `ping`
still holds, a failing `initialize` still pauses on the error gate and turns
the folded card red. Work is recognised in the direction the protocol sends
it: a `tools/call` travelling *from* the server (an echoing or hostile peer)
is protocol traffic, not a second tool call — it used to be recorded as one.

Three silent failures now speak. A server that logs to **stdout** (the MCP
wire) — a `console.log`, or a structured logger writing one JSON object per
line — gets one stderr line quoting the offending bytes with the fix, and a red
"stdout noise" node under **protocol**; the bytes are still relayed unchanged.
A command that cannot be spawned — `ENOENT`, or on Windows the synchronous
`EINVAL` a `.cmd` target used to throw as a stack trace — prints one plain
line, exits 127, and lands on the graph as a `SpawnError`. A server that exits
before its first response prints the exit reason with the tail of its stderr
(last 200 lines / 32KB kept) and puts both on the session node; Windows
NTSTATUS exit codes are named. Such a session also ends its **run** with
`status: error` — before, the node was red and the run list said `ok`.

### Changed — durations are measured, and held time is not run time

Every SDK timed nodes with the wall clock at millisecond resolution, so an MCP
handler that took 80µs read `0ms` — a debugger saying it cannot measure. All
three SDKs and the proxy now use a monotonic high-resolution clock
(`performance.now()`, `time.perf_counter()`, `CLOCK_MONOTONIC`); `durationMs`
is fractional to 0.01ms and the viewer renders `<0.1ms`, one decimal under
10ms, integer ms under a second.

And the developer's thinking time no longer counts as the agent's. While a
gate is held, the node's duration kept running, so forty seconds at a
breakpoint became a forty-second tool call that the slow filter, the stats and
the exports treated as slow. `node.finished` and `node.error` now carry
`heldMs` — the time this execution spent held at gates, including holds on
its descendants — and every place the viewer shows, filters, sums or exports
a duration uses **ran = durationMs − heldMs**: cards read `ran 2.4ms · held
38.1s`, the timeline hatches the held part of a bar, the run list subtracts it.
`durationMs` keeps its meaning (wall clock, held time included), so recorded
runs and importers see no change; the viewer also derives held time from
`exec.paused`/`exec.resumed` timestamps for streams that predate the field.

### Added — releases a security reviewer can verify

- **`publish-npm.yml`**: on a `v*` tag, builds, runs the full battery, checks
  the tag against all ten declared versions, publishes the eight packages with
  `pnpm -r publish --provenance` (npm's own `publish` does not rewrite
  `workspace:*` and would ship uninstallable manifests — the workflow opens
  every tarball to prove none survived), verifies the attestations and
  `npm audit signatures` from a clean registry install, and creates a GitHub
  Release with the tarballs, a CycloneDX 1.6 SBOM and `SHA256SUMS`. Idempotent:
  a re-run for a published version is a no-op, a partial publish fails naming
  the missing packages, a pre-release tag goes out under `next`, never
  `latest`. Uses npm Trusted Publishing (OIDC) once the maintainer configures
  it, `NPM_TOKEN` as a fallback, and a `dry_run` dispatch that does everything
  but publish. The Python workflow now builds with a hash-pinned front-end
  **and** back-end (`hatchling`), in a non-isolated environment.
- **`DO_NOT_TRACK=1`** (or `true`) disables telemetry unconditionally — it
  beats every `GRAPHMIND_TELEMETRY` value including `1`. **`GRAPHMIND_TELEMETRY=log`**
  prints the exact payload to stderr and sends nothing.
- **SECURITY.md** rewritten: supported versions, disclosure targets a solo
  maintainer can keep, how to verify a release, and a localhost threat model
  that maps CVE-2025-49596 (MCP Inspector) onto GraphMind precisely — the hub
  binds loopback, browser-originated control frames are rejected (now proven by
  a test), nothing spawns commands from network input, and any local process
  running as you can connect, which is stated rather than hidden.
- A **Security & compliance** page in the docs, written for the reviewer.

### Fixed — CI told the truth again

- The Ruby suite hung to the 15-minute limit in every run: `ruby/Gemfile.lock`
  is git-ignored, `json` 3.0 shipped on 2026-09-07, and faraday 2.14.3's JSON
  middleware still calls `JSON.parse(body, opts)` positionally, so every
  ruby-openai request raised and the retry-at-error-gate test re-sent forever.
  `json` is pinned below 3 in the test group with the reason inline, and every
  thread wait in the suite is bounded — a hang is now a named failure in 10s.
- A Python test read the frame list the instant `run.started` arrived, before
  the two `node.started` frames — a race only a slow Windows runner loses.
- A viewer e2e sampled a token stream twice and demanded a change between the
  samples; on a two-worker runner the whole stream can land in between.
- python and ruby jobs now emit their failing output as annotations, because
  job logs need a GitHub login and annotations do not.

### Wire protocol

Additive, all optional, schema major unchanged: `node.started.collapsed`,
`node.finished.heldMs` / `node.error.heldMs`, `exec.paused.reason` and
`exec.paused.loop`, and a `redaction {count, keys}` summary on events whose
payload was redacted.

### Added — MCP SDK v2

The TypeScript MCP SDK became a new package family on 2026-07-28
(`@modelcontextprotocol/server` + `core`, 2.0.0) and `@graphmind-ai/mcp` only
accepted the 1.x `sdk` package, so every server written since then was locked
out of in-process debugging. `@graphmind-ai/mcp` now takes either generation as
an **optional** peer (`/sdk >=1.26 <2` or `/server >=2 <3`), detected
structurally from the object you hand to the same `wrapServer(...)` call: the
v2 handler context (`ctx.mcpReq`) is recognised, the debugger's abort is
chained into its signal, `requestSampling` / `send('sampling/createMessage')`
are gated, and both spellings of `setRequestHandler` are wrapped. Wrap inside
the factory when you use `serveStdio`. `graphmind mcp-proxy` needed no change
and is now proven against v2 servers with both client generations, including
the opt-in 2026-07-28 era (`server/discover` instead of `initialize`,
`resultType` on every result) — the protocol fold, gates, inject, abort and
retry all hold, and an injected value is stamped for the era the peers
actually negotiated (`resultType`, plus `ttlMs`/`cacheScope` for
`resources/read`), so a bare inject is accepted by a 2026 client too. Facts
that shaped this are in the repo's internal
decisions: the v2 client's default posture is still `initialize`; only
`serveStdio` serves the 2026 era; a throwing v2 handler arrives as
`isError: true`, not a JSON-RPC error; `'auto'` negotiation probes on a
sibling process, which the proxy shows as a second, short run rather than
hiding it.

### Added — the debugger stops an agent that is repeating itself

The most-reported agent failure is the same tool called with the same arguments
again and again until a bill or a timeout ends it; every tool on the market
shows you that afterwards. GraphMind now holds it while it is happening. The
client fingerprints each tool call's arguments (canonical JSON — key order,
whitespace and number spelling do not matter; MCP's per-request `_meta`, where
clients put a fresh `progressToken`, is ignored; pagination keys are not, so
page 3 of a listing is never "the same call" as page 2) and counts identical calls made
back-to-back — any other tool call in between starts the count again, while
LLM steps between them do not; on the third (`GRAPHMIND_LOOP_THRESHOLD`, default 3, `0` off)
the before-gate holds **when a debugger is attached** — through the normal gate
path, so timeouts and fail-open apply and Continue / Retry / Inject / Abort keep
their meaning. The banner reads "Loop: 3× searchFlights with identical
arguments" and the inspector lists the identical calls with their outputs, so
you can see the model is not learning anything new; inject a different answer
and it moves on. With no debugger attached it never holds — it warns once per
streak and keeps counting, so a debugger that attaches late holds on the next
identical call (`GRAPHMIND_ON_LOOP=pause|warn|off`; also `loopGuard: {threshold,
mode, ignoreKeys, allowNodes, kinds}` on every adapter — `allowNodes`, or
`GRAPHMIND_LOOP_ALLOW=pollJob,…` where options cannot be set such as under
`graphmind mcp-proxy`, is the escape hatch for tools that legitimately poll). Detection lives in the client
session, so every adapter and `graphmind mcp-proxy` got it with no code change.
`exec.paused` carries `reason: 'loop'` and `loop: {repeats, firstSeq, lastSeq,
fingerprint}`. The fingerprint is withheld wherever the input is: under
`GRAPHMIND_HIDE_INPUTS` (or `_TOOL_ARGS` on a tool) and in every sanitised
`graphmind record` export, because a hash of an input with a password removed
is a dictionary attack away from the password. Fingerprinting costs about
0.01 ms per KB of arguments on a watched tool's start; the detached gate path
is unchanged. An input that cannot be read (a throwing getter or `toJSON`)
breaks a streak instead of counting as a repeat. `pnpm --filter demo-agent start -- --loop` shows it.

Why back-to-back and not "the third identical call anywhere in the run": under
`graphmind mcp-proxy` a whole coding session is one run, and a constant-argument
tool (`list_issues({})`, `git_status({})`) called at minute 1, 20 and 45 with
dozens of other calls in between is not a loop — an early build held it. The
accepted cost: a model alternating between two tools (search, read, search,
read) is not held.

Not built, on purpose: step and token budgets (LangGraph's `recursion_limit`,
the AI SDK's `stopWhen` and their peers already cap runs) and any unattended
abort policy — the case those come from is the one a live debugger is absent
from.

### Added — two answers for the security reviewer: record less, export safely

- **Kill switches.** `GRAPHMIND_HIDE_INPUTS`, `GRAPHMIND_HIDE_OUTPUTS`,
  `GRAPHMIND_HIDE_TOOL_ARGS` and `GRAPHMIND_HIDE_TOOL_RESULTS` (`1`/`true`; also
  session options `hideInputs` … on every adapter) replace the whole field with
  `"__REDACTED__"` inside the client *before* the ring buffer, so nothing
  downstream — replay on attach, SQLite, the WebSocket, `graphmind record`, the
  HTML export, the read-only MCP tools, the proxy — ever holds the hidden field; names,
  kinds, timings, token counts and the shape of a stream (delta count, character
  lengths) survive so the graph still reads. An environment switch is a floor
  code cannot lower. Affected events carry `redaction: {count, keys}`; the
  viewer shows a "hidden by …" chip where the value would be, and refuses to
  inject a value that still contains the placeholder (the hub refuses too).
  `node.error` is deliberately never redacted — at 3am the message is the clue.
  Know the limit: the tool-only switches hide the tool node's own input and
  output, but in an agent loop the same values also pass through the model
  (`tool_use` in its output, `tool_result` in the next request) — set
  `GRAPHMIND_HIDE_INPUTS`/`_OUTPUTS` to keep them out entirely. `graphmind
  mcp-proxy` goes one step further on its own records: under
  `HIDE_TOOL_RESULTS` a failed result is not quoted into the error, and under
  `HIDE_INPUTS` the server's command-line arguments leave the run label and
  metadata. An option set to `"true"` or `1` counts as on — privacy switches
  fail closed.
- **Exports sanitise by default.** `graphmind record` (NDJSON and `--html`)
  replaces the values of secret-shaped keys — `authorization`, `cookie`,
  `api_key`/`apikey`, `password`, `secret`, `client_secret`, `private_key`,
  `access_token`, `refresh_token`, `token`, `bearer` — matched case-insensitively
  as a whole key or a `_`/`-`/camelCase-delimited segment (`x-api-key`,
  `accessToken` match; `max_tokens`, `tokenizer` do not) and prints what it
  redacted. `--no-redact-secrets` keeps them. Keys, not values: a secret typed
  into a prompt is exported as recorded; the switch above is the tool for that.
  The credential-leak audit now covers the export layer.

- **Fails closed.** If a payload cannot be read safely while a switch is on (a
  getter or Proxy that throws, a malformed payload), the event is sent with
  input, output and token text hidden and `redaction.failed: true`; if even its
  identity fields cannot be read, it is dropped with one warning. A raw value is
  never sent.

What was *not* built, on purpose: a default-on regex pack, a redaction callback
API, and cross-chunk streaming regexes — every platform ships masking already,
and two of those designs would have blanked `max_tokens`.

### Added — Python and Ruby get both, identically

The Python SDK (`graphmind-ai`) and the Ruby gem implement the four
`GRAPHMIND_HIDE_*` switches and the loop hold with the same env names
(`GRAPHMIND_LOOP_THRESHOLD`, `GRAPHMIND_ON_LOOP`, `GRAPHMIND_LOOP_ALLOW`), the
same placeholder and the same wire fields as the TypeScript client
(`gm.configure(hide_inputs=True, loop_guard={...})`,
`Graphmind.configure(hide_inputs: true, loop_guard: {...})`). "The same" is
checked, not claimed: both shared conformance fixtures reproduce byte-for-byte
in all three languages, and a differential file generated from the TypeScript
build — 406 canonical values (doubles in every exponent range, astral and
control characters, UTF-16 key order) and 120 redaction event streams — passes
in Python and, for every value a Ruby string can hold, in Ruby. The ports are
thread-safe where the TypeScript client did not need to be: loop details travel
with each hold rather than through shared state, and `firstSeq`/`lastSeq` are
taken under the session lock.

### Docs

- New pages: **Stability & versioning** (what 0.x means, the deprecation rule,
  supported runtimes exactly as CI runs them, the `gm` protocol policy),
  **Limits** (every size ceiling, buffer and timeout, read from the source), and
  **Remote development** (devcontainers, Codespaces, WSL 2, SSH).
- A gate-coverage matrix per adapter and language, and a Compatibility section
  that lists exactly what CI runs.
- Every claim was run before it was written, which found real errors: the
  TypeScript replay buffer is 5,000 events / 8 MiB (the docs said 2,000); the
  proxy lifts injected values into a proper result (a page still said verbatim);
  the Docker recipe needs `GRAPHMIND_ALLOWED_ORIGINS=http://host.docker.internal:4747`,
  and so does a port forwarded to a different local port.


## 0.4.4

Three things found by the founder using it, which is the only way some of
these get found.

### Fixed — the canvas could show you another run's results

Switching runs left every card pointing at the **previous** run. A card's
`data` is its pointer into the store (`{runId, nodeId}`) and the canvas reused
a rendered node whenever its geometry was unchanged — but two runs of the same
agent have the same node ids and the same shape, so the geometry always
matched. The header read the route directly and was correct, so the run said
`PAUSED · 1 error` while the canvas underneath showed `compute_metric DONE
injected 5ms` from a different, successful run. In a debugger that is not a
cosmetic bug. Reuse now also requires the pointer to be unchanged
(`canReuseFlowNode`, unit-tested).

### Fixed — the resume buttons overflowed their own card

`Continue / Step / Retry / Inject… / Abort` need ~341px of label; the card is
240px. `flex: 1` looks like it shrinks them, but a flex item's default
`min-width: auto` floors it at min-content and `white-space: nowrap` makes
min-content the whole label — so instead of shrinking, the row overflowed by
~100px and `Abort` rendered outside its own border. The row wraps now, and
`Abort` still never stretches to fill its line.

### Changed — the proxy says whether the debugger picked up

`graphmind mcp-proxy` printed "reporting to ws://…" whether or not anything
was listening, so running it with no debugger looked exactly like running it
with one — and produced no graph. It now reports which happened, ~1.5s in,
while the session is still alive:

```text
graphmind mcp-proxy: attached — watch it at http://127.0.0.1:4747
graphmind mcp-proxy: GraphMind is not running at ws://…, so nothing is being
  recorded yet. Start it and this session will attach: npx graphmind-ai
```

Reported during the session rather than at exit, because an MCP host does not
close the pipe on shutdown — it kills the child, so an exit-time message is
the one message that never prints when it is needed.

### Known, not fixed — edges cross the cards above them (fixed in 0.5.0)

With five or more childless siblings the layout packs them into a grid, and
the parent's edges to rows two and three are drawn straight through the cards
in row one. Measured on a real MCP session: 6 of 11 edges pass through another
card, which is why they read as floating or detached. The fix is edge routing
through the column gutters, which is a layout change worth doing deliberately
rather than in a patch release.

## 0.4.3

- **`graphmind init` told an MCP-server developer "No supported agent
  framework found".** A project with `@modelcontextprotocol/sdk` in its
  dependencies is the exact audience 0.4.0 was built for, and the first
  command they would run said GraphMind had nothing for them. It now detects
  the MCP SDK, prints the `@graphmind-ai/mcp` snippet, and — because the
  proxy needs nothing installed and works in any language — offers
  `graphmind mcp-proxy` alongside it. The not-found listing gained MCP and
  Ruby too.
- The CLI README's gate-action table described `inject` as answering with the
  value verbatim, which was true before injected values were lifted into the
  result shape the method has to return. Corrected, with both escape hatches
  (a value already shaped like a result, and a whole JSON-RPC frame) written
  down.

## 0.4.2

- **A `runId` containing a NUL byte was silently mangled on Node 22.**
  `node:sqlite` round-trips a string containing U+0000 on Node 24 and does not
  on Node 22, so the app streamed under one run id while the server stored
  another — the run looked permanently empty to anyone who subscribed with the
  id they sent. Same identity hazard as the lone surrogate closed in 0.4.0, and
  now refused the same way, at the parse boundary, on every runtime. A wire
  contract that is correct only on some patch versions of Node is not a
  contract.

  Found because CI runs Node 22 and this machine runs Node 24 — the version
  matrix earning its keep. The security suite is now also run locally on the
  CI Node version before a release.

## 0.4.1

- `@graphmind-ai/mcp` raises its `@modelcontextprotocol/sdk` peer floor from
  `>=1.20.0` to `>=1.26.0`. The adapter runs fine on older SDKs — this is a
  security floor, not a compatibility one. Every release below 1.26.0 carries
  at least one high advisory (cross-client data leak through shared transport
  reuse ≤1.25.3, DNS-rebinding protection off by default <1.24.0, ReDoS
  <1.25.2), and declaring support for them told users a vulnerable SDK was a
  supported configuration. The peer-compat suite now runs the whole gate story
  against 1.26.0 as the new floor, so the declared floor stays a *verified*
  floor.

## 0.4.0

MCP server debugging, a Ruby SDK, and the fixes a deliberate attack on the
protocol boundary turned up.

### Added — debug an MCP server while your client is driving it

The tools around MCP today are test clients: you replace your host and poke the
server by hand. Nothing could watch a server *in situ*, hold a request, or
answer one differently. Two shapes, because they see different things:

- **`graphmind mcp-proxy -- <your server command>`** — a transparent stdio
  man-in-the-middle. It spawns your real server, relays every JSON-RPC frame
  byte-for-byte, and reports the conversation as a live graph. **Any language,
  no code changes**, so it debugs a server you did not write. Gates at the
  protocol boundary: hold a request before your server sees it, hold a response
  before your host sees it, `inject` an answer, `retry` the original bytes,
  `abort` with a JSON-RPC error. Errors hold by default, so a broken server
  stops with zero configuration.
- **`@graphmind-ai/mcp`** — two lines to instrument an `McpServer` you own, for
  what only the inside can tell you: work that never reaches the wire, outbound
  sampling with the handler's own context, and `abort` that cancels the
  `AbortSignal` your handler already has.

Both map MCP onto the graph: the session is a `server` node, `tools/call` a
`tool`, `resources/read` a `resource`, `prompts/get` a `prompt`, and
`sampling/createMessage` an `llm`. `server`, `resource` and `prompt` are new
node kinds in the wire schema; the viewer draws each with its own glyph.

### Added — Ruby

`graphmind` (RubyGems), zero runtime dependencies, Ruby >= 3.1. Automatic
instrumentation for **ruby-openai** and **ruby_llm**, plus `Graphmind.tool`,
`.span` and `.wrap_method` for anything else. Fiber-local run context, so a
Rails request or a Sidekiq job is a run without any wiring.

### Fixed — security

Found by fuzzing the ingest boundary. All are local-only (the server binds
127.0.0.1), so the threat is another process on your machine — a postinstall
script, a compromised dependency:

- **Any process that could open `/ingest` could claim any other process's run
  by naming it once.** One frame bought four things, each demonstrated end to
  end against a real session holding a real gate: fabricated nodes rendered
  inside the victim's run, the operator's next `exec.resume` delivered to the
  attacker *including the value they injected*, the victim's gate never
  released (fail-open does not cover this — the client believes the debugger is
  still attached and simply has not answered), and a forged `run.finished`
  marking a live run failed. A run is now claimed by the token that created it:
  `hello.ack` mints one, and a client echoes it as `hello.resumeToken` so a
  reconnect still proves it is the same app. The same fix closes `seq`
  squatting, where a peer pre-claiming a run's low sequence numbers silently
  deleted the start of that run.
- The wire accepted 100 MiB frames against a 512 KB storage budget; one 64 MB
  frame took the server from 95 MB RSS to ~500 MB, permanently. Capped at
  16 MiB, refused during frame assembly.
- One unthrottled log line per dropped frame, written synchronously to the
  operator's terminal. Now rate-limited, with a suppressed count.
- The liveness reaper judged a peer dead on a missing pong — which arrives
  *behind* that peer's own frames — so a busy app was terminated **because**
  the server was busy with it, dropping everything in flight silently (26,570
  of 60,000 events at a 200 ms interval). Liveness is now "we read bytes from
  this socket".
- A repeated `subscribe` replayed the whole run again, every time.
- A lone surrogate in a `runId` was silently rewritten by SQLite, so the app
  streamed under one id and the server stored another. Refused now.
- `ts` was unbounded, so one frame with `ts: 1e300` pinned that run to the top
  of the run list until it was pruned.

### Fixed

- **The 512 KB payload guard destroyed fields the schema requires.** It
  replaced an oversized field with a marker *object*, so a >512 KB error
  message made `node.error` fail its own schema and the viewer dropped it on
  replay — a debugger losing precisely the error event, with no attacker
  involved. Truncation is now type-preserving: a string stays a (shorter)
  string, an array stays an array, an object keeps its own fields.
- Injecting a bare value at a proxy `tools/call` gate produced a tool result
  with **no content** — no error, just an empty answer, on the headline
  feature. Injected values are now lifted into the result shape the method has
  to return, while anything already shaped like a result (or a whole JSON-RPC
  frame) is relayed untouched.
- An envelope with no `payload` key was rejected, contradicting the stated
  forward-compatibility contract.
- Proxy runs reported `sdk: mcp@stdio` — a transport, not a version.
- Proxy run labels were full of absolute paths from the host's config;
  arguments that are bare paths are now shown by basename.

### Changed

- The viewer's camera never leaves a held gate off screen: it re-frames on a
  hold, sits above centre so the action row has room, and re-decides when the
  canvas resizes. The inspector is a docked pane rather than an overlay, so it
  can no longer cover the buttons it is explaining.
- `c` / `s` / `r` / `i` release a held gate from the keyboard; focus lands on
  Continue when one opens.
- Motion carries meaning: cards animate in from their caller, and each state
  change gets one short ring instead of a permanent pulse.

## 0.3.2

Five sample projects were built against the published packages and run against
real Anthropic and OpenAI APIs. They found these, which is exactly what a new
user would have found.

### Fixed — first-run blockers

- **`gm.ready()` never settled when no debugger was listening, and the process
  died silently** (exit 13, no output). Its timeout timer was `unref`'d, so
  when awaiting the debugger was the only pending work — a user starting their
  agent before starting GraphMind — the event loop drained first. Failing open
  means resolving `false`, which cannot happen if the process dies. The same
  path broke `waitForAttach`, where the entire run body silently never ran.
- **A published README told users to run `npx graphmind serve`.** The CLI is
  `graphmind-ai`; `graphmind` is an unrelated third-party package, so anyone
  following those instructions downloaded and executed a stranger's code.
  Corrected, and every published README swept for the same mistake.

### Fixed — correctness

- Every OpenAI-adapter run reported `sdk: openai@unknown`: the version was read
  through a subpath `openai` has never exposed. All adapters now resolve peer
  versions in a way an `exports` map cannot hide.
- A run whose app died mid-pause stayed `running` forever. Runs now reconcile
  to an explicit abandoned state after a grace period, without disturbing a
  legitimate reconnect.
- LangGraph: `inject`/`retry` at a callback-only error gate were silently
  ignored, despite the README promising a warning. And one failure produced a
  cascade of pauses, one per ancestor — now one failure, one pause, at the one
  gate that can actually act.
- Duplicate `graph.hint` when a run used two invocations.
- `graphmind --pause-on-error <on|off|kind>` (and `GRAPHMIND_PAUSE_ON_ERROR`)
  scopes the default error breakpoint, which was unscoped enough that an
  incidental tool failure could hold a run before the interesting one.

### Fixed — documentation that misled

- The OpenAI adapter README stated a narrower peer range than it supports.
- The Python README cited benchmarks from an interpreter the package no longer
  supports; re-measured on a supported one.
- Integration pages verified against the five real samples rather than specs.

## 0.3.1

Two fixes CI found on Linux that macOS hid.

- **An unserializable payload made its stored event unreadable.** A payload
  nested deeper than the JSON serializer's stack (or cyclic) was replaced
  wholesale by a truncation marker, which destroyed the fields the payload's
  own schema requires — so the viewer rejected the event on replay and the
  node hung "running" forever. Only the offending field is replaced now; the
  event still validates and still renders. The depth at which this bites is
  platform-dependent, which is why it passed locally and failed in CI.
- **The viewer's reducer copied the entire node record on every lifecycle
  event**, making a run with many nodes quadratic. Measured per-event cost
  went from 2.4x to 0.69x across a 550-node run. Nothing compared that record
  by reference — consumers key off the run's version counters — so the copy
  was pure cost.
- CI now reports which soak check failed instead of only an exit code.

## 0.3.0

A hardening release. An adversarial pass — a credential-leak audit, real
provider calls, a production-scale soak, browser tests, and an SDK version
matrix — found real defects. These are the fixes.

### Security (please upgrade)

- **The local server accepted WebSocket connections from any origin.** A
  WebSocket handshake is exempt from the same-origin policy, so while
  `graphmind serve` was running, any web page you visited could open
  `/ws/ui`, read every recorded run (prompts, tool payloads, errors), *and*
  send control frames — including resuming a paused run with an injected tool
  result. Every HTTP request and every upgrade is now origin-checked:
  no `Origin` (the SDK, curl, tests) and this server's own origin are allowed,
  everything else gets a 403. `GRAPHMIND_ALLOWED_ORIGINS` opens it explicitly.
- **DNS rebinding could reach the HTTP API** despite the loopback bind. `Host`
  must now be a loopback name; SSH tunnels still work.
- **The database was created world-readable.** `~/.graphmind` is now 0700 and
  `graphmind.db` (with its `-wal`/`-shm` siblings) 0600. A database an older
  version left at 0644 is tightened on next open. No-op on Windows.

### Correctness

- Aborting a run mid-stream was reported as success on real providers: both
  the Anthropic and OpenAI SDKs deliberately swallow `AbortError` inside their
  stream iterators, so the adapters saw a clean end. Only real API calls could
  have shown this.
- Events dropped while the debugger was unreachable are no longer silent — the
  recorded run says so instead of quietly missing a third of itself.
- Oversized payloads are trimmed field by field rather than replaced wholesale,
  so a truncated event still satisfies its own schema and still renders; the
  server also fans out exactly what it stored, so live and replay agree and one
  huge tool result can no longer inflate the server.
- `graphmind record --html` picked the JS bundle by extension and could inline
  the wrong one now that the viewer build emits two; it reads the real entry
  point from the built index.html.
- Exported runs no longer show live-looking debugger controls that do nothing.
- The agent node emitted `node.finished` without an `instanceId` in the Vercel
  AI SDK adapter, mis-attributing concurrent executions.
- LangGraph: inner wrapper runs made a chain node its own parent (a self-loop
  in the graph); tool-call argument tokens are now mapped.
- Retention deleted rows but never reclaimed disk, and startup retention
  delayed the server binding its port.

### Version support, measured rather than assumed

- `@graphmind-ai/langgraph` advertised a `langgraph`/`core` pair that is
  mathematically impossible to install; the floors are now the real ones.
- `@graphmind-ai/openai` excluded `openai@7`, the current default install,
  despite passing its whole suite there.
- The Vercel AI SDK adapter now typechecks against `ai@6`, its own floor.
- A CI matrix pins the floor and ceiling of every range, plus a weekly canary
  against the latest SDKs.

### Testing

830+ tests: a credential-leak audit (71) proving no API key, header or token
reaches the database, API, WebSocket, HTML/NDJSON export or telemetry; 54
browser tests; a live-provider suite (183 assertions against real Anthropic and
OpenAI); and a soak battery with a published baseline. Viewer layout went from
10.8ms to 0.6ms at 800 nodes and no longer overflows the stack on deep graphs.

## 0.2.2

- The Python package reported `__version__ = "0.1.0"` while shipping as 0.2.1:
  a hardcoded constant had drifted from `pyproject.toml`. It now derives from
  installed metadata, so the two cannot disagree again. The version travels on
  the wire in `run.started.sdk`, so a stale one mislabelled every recorded run.

## 0.2.1

- `graphmind record --html` exports a run as a single self-contained HTML
  file: the viewer and the run inlined, no server and no network. Attach it to
  an issue or send it to a colleague and they see exactly what you saw. It
  carries the run's prompts and payloads, so the command says so before you
  share it.
- Fixed two Python failures that only appeared on real 3.10/3.13: the test
  harness now follows whichever httpx flavour the installed `anthropic`
  expects, and a test that pinned since-changed LangChain context-propagation
  behaviour now asserts what must hold either way.

## 0.2.0

The release that makes GraphMind work with the way agents are actually
written, and stand up to real runs.

### Framework coverage

- **Anthropic SDK** (`@graphmind-ai/anthropic`) — wrap the client, gate before
  each `messages.create`, stream tokens, gate tool calls.
- **OpenAI SDK** (`@graphmind-ai/openai`) — the same, for
  `chat.completions` and the Responses API.
- **LangGraph / LangChain (JS)** (`@graphmind-ai/langgraph`) — a callback
  handler that maps the run tree onto the graph, plus tool wrapping for the
  full gate set.
- **Python** (`pip install graphmind-ai`) — the debugger for the other half of
  the ecosystem: OpenAI, Anthropic, and LangChain/LangGraph instrumentation,
  sync and async.

### Getting started

- `graphmind init` reads your project, works out which adapter you need, and
  prints the exact install command and snippet. `--install` runs it.
- A documentation site at [docs.graphmind.ai](https://docs.graphmind.ai):
  concepts, an integration guide per framework, debugging workflows, and the
  wire protocol for writing your own adapter.

### Running real workloads

- Retention: the local database prunes itself (200 runs / 30 days by default;
  `GRAPHMIND_RETENTION=off`, `GRAPHMIND_KEEP_RUNS`, `GRAPHMIND_KEEP_DAYS`).
- `graphmind runs` lists what is stored, with `--prune`, `--rm`, `--clear`.
- Oversized event payloads (over 512KB) and unserializable ones are stored as
  a marker with a preview instead of bloating the database.
- The viewer handles large graphs and long runs: collapsible groups, a
  minimap, filtering, a timeline view, and a command palette.

### Protocol

- Node kinds gained `chain` and `retriever` for LangChain-style graphs.
- `node.finished` and `node.error` carry an optional `instanceId`, so
  concurrent executions of the same logical node are attributed correctly.
  Both changes are backwards compatible: 0.1 senders and receivers still work.

## 0.1.0

First public release.

- Live attach for the Vercel AI SDK: pause before a model step, before, after
  and on error for tools, with continue / retry / inject / abort.
- Local-first server and viewer (`npx graphmind-ai`), SQLite storage, replay
  of past runs.
- `graphmind demo` — a recorded debug session with a planted bug, no API key
  required.
- `graphmind import` for OpenTelemetry / OpenInference traces.
- `graphmind mcp` so Claude Code and Cursor can query runs.
- MIT, and anonymous opt-out telemetry
  ([disclosure](./packages/cli/TELEMETRY.md)).
