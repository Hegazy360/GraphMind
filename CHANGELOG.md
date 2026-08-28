# Changelog

All notable changes to GraphMind. Versions are shared across every package in
this repo (`graphmind-ai`, `@graphmind-ai/sdk`, `@graphmind-ai/client`,
`@graphmind-ai/schema`, `@graphmind-ai/anthropic`, `@graphmind-ai/openai`,
`@graphmind-ai/langgraph`, `@graphmind-ai/mcp`, the Python `graphmind-ai`
distribution, and the Ruby `graphmind` gem).

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

### Known, not fixed — edges cross the cards above them

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
