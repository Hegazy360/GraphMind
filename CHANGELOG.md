# Changelog

All notable changes to GraphMind. Versions are shared across every package in
this repo (`graphmind-ai`, `@graphmind-ai/sdk`, `@graphmind-ai/client`,
`@graphmind-ai/schema`, `@graphmind-ai/anthropic`, `@graphmind-ai/openai`,
`@graphmind-ai/langgraph`, and the Python `graphmind-ai` distribution).

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
