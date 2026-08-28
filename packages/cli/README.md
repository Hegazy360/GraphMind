# graphmind-ai

**GraphMind — the live debugger for AI agents.** Observability tools show you
what your agent did; GraphMind attaches while it's happening: a live execution
graph, pause-on-error by default, breakpoints, step mode, and
inject-and-continue that genuinely hold execution.

This package is the `graphmind` CLI: the local server, SQLite storage, the
keyless demo, the trace importer, the MCP server, the MCP debugging proxy, and
the bundled viewer UI.

Local-first: the server binds `127.0.0.1` only and has no auth (never expose
the port). Runs are stored in a local SQLite file; your prompts and payloads
never leave your machine. Requires Node >= 22.13 (SQLite is built into Node —
no native dependencies).

```sh
npx graphmind-ai demo    # no API key needed — see it debug a planted bug
npx graphmind-ai         # start the debugger for your own agent
```

Apps instrumented with a GraphMind adapter (currently: the Vercel AI SDK
adapter, `@graphmind-ai/sdk` in the [GraphMind repo](https://github.com/Hegazy360/graphmind))
stream execution events to this server; the viewer connects to watch live,
replay history, and send control commands (pause / resume / breakpoints /
inject). Other frameworks get in via `graphmind import` (OTel / OpenInference
trace exports), and **any MCP server, in any language, needs no instrumentation
at all** — `graphmind mcp-proxy -- <your server>` debugs it from the protocol
boundary.

## Commands

`graphmind` with no command runs `serve`.

### `graphmind serve` (default)

Start the local server and open the viewer.

```
graphmind                # port 4747, open the browser
graphmind --port 4848    # different port (always binds 127.0.0.1)
graphmind --db ./x.db    # database file (default ~/.graphmind/graphmind.db)
graphmind --no-open      # do not open a browser
```

#### Pause-on-error (default on)

A fresh session arms one breakpoint, `{ point: 'error' }`: execution holds at
the first error in any node. That is the product's headline mechanic and it
stays on by default — but it is unscoped, so in a chatty agent an incidental
tool failure can hold the run before the failure you actually care about.

`--pause-on-error` narrows or removes it at startup (the viewer can still add
and remove breakpoints live):

```
graphmind                          # default: pause on every node error
graphmind --pause-on-error off     # start with no breakpoints at all
graphmind --pause-on-error tool    # pause only on tool errors
GRAPHMIND_PAUSE_ON_ERROR=off graphmind
```

Accepted values: `on` (the default), `off`, or a node kind — `agent`, `llm`,
`tool`, `chain`, `retriever`, `custom`. The flag beats the environment
variable. `graphmind serve` prints what it armed, and an unrecognised value
is refused rather than quietly falling back to the sharpest setting.

### `graphmind demo`

The keyless first-run experience: replays a bundled recording of a
trip-planner agent with a planted bug (`convertCurrency` inverts an exchange
rate; the budget check throws on the absurd total). The replay goes through
the real ingest pipeline and honors the real control protocol — the planted
error genuinely pauses, and inject / continue / retry / abort from the viewer
steer the replay onto the matching pre-recorded branch. Uses a server already
running on the target port, or starts one in-process and keeps it up until
Ctrl+C.

```
graphmind demo               # replay the recording (no API key)
graphmind demo --live        # run the real demo agent with your API key
graphmind demo --port 4848   # target a specific server port
```

`--live` needs a GraphMind monorepo checkout (or `GRAPHMIND_DEMO_AGENT_DIR`
pointing at the demo agent) plus `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### `graphmind import <trace-file>`

Convert an exported trace file into a run (stored with `source: "import"`,
rendered with the viewer's "imported" treatment — history only, no live
features). Best-effort; prints a summary (nodes, errors, duration, skipped
spans) and a viewer deep link.

```
graphmind import trace.json
graphmind import trace.json --db ./x.db
```

Accepted inputs: OTLP/JSON (OTel collector `file` exporter / SDK JSON
exporters) and flat span lists (OpenInference / Arize Phoenix-style JSON or
JSONL). Recognized span dialects: Vercel AI SDK OTel spans, OTel GenAI
semantic conventions, and OpenInference — unrecognized spans are imported as
generic nodes or skipped with a note.

### `graphmind mcp`

Serve recorded runs to MCP clients (Claude Code, Cursor, ...) over stdio.
Read-only tools: `list_runs`, `get_run`, `get_node`, `find_errors` — each
result carries a deep link into the viewer. Reads the SQLite database
directly, so it works while the server/viewer is closed.

Register it in Claude Code:

```sh
claude mcp add graphmind -- npx graphmind-ai mcp
```

`--db` selects the database; `--port` sets the port used in generated deep
links (default 4747 — pass it if you run `graphmind` on a different port).

### `graphmind mcp-proxy -- <command> [args...]`

Debug **any** MCP server, in **any** language, with **no code changes**.

```sh
graphmind mcp-proxy -- node my-server.js
graphmind mcp-proxy -- python -m my_server
graphmind mcp-proxy -- ./target/debug/my-rust-server
```

The proxy spawns your server as a child process, speaks stdio JSON-RPC to the
MCP client on one side and to the server on the other, relays every frame
**verbatim**, and reports the conversation to GraphMind as a live run. Because
it sits at the protocol boundary rather than inside your code, the server's
language is irrelevant.

**Point Claude Code at it.** Wrap a server you already have:

```sh
claude mcp add my-server-debug -- npx -y graphmind-ai mcp-proxy -- node my-server.js
```

Or wrap an entry that is already in `.mcp.json` / `claude_desktop_config.json`
by moving its command inside the proxy:

```jsonc
// before
{ "command": "node", "args": ["my-server.js"] }
// after
{ "command": "npx", "args": ["-y", "graphmind-ai", "mcp-proxy", "--", "node", "my-server.js"] }
```

Then run `graphmind` in another terminal and restart the client. Nothing else
to configure — and if GraphMind is *not* running, the proxy still relays
perfectly.

**What you see.** The session becomes a `server` node; each request hangs off
it as the right kind of node, keyed so repeated calls light up the same box:

| MCP | Node | `nodeId` |
|---|---|---|
| `tools/call` | `tool` | `tool:<name>` |
| `resources/read` | `resource` | `resource:<uri>` |
| `prompts/get` | `prompt` | `prompt:<name>` |
| `sampling/createMessage` | `llm` | `llm:sampling` |
| `initialize`, `tools/list`, `ping`, `notifications/*`, ... | `custom` | `mcp:<method>` |
| the session itself | `server` | `mcp:session` |

The server's **stderr** — the only channel a stdio MCP server can safely log
to — is mirrored to your terminal byte-for-byte *and* streamed onto the
session node, so its logs sit next to the protocol they explain.

A request that never gets a response stays **running** on the graph. That is
not a rendering bug; it is your server's bug, made visible. (When the server
process dies, still-open requests become errors, because then we know for
certain no answer is coming.)

**What you can do.** Every gate works, in both directions:

| Gate | When it fires | `continue` | `inject` | `retry` | `abort` |
|---|---|---|---|---|---|
| `before` | a request, before the peer sees it | forward it | answer the sender with the injected `result`; the peer never sees the request | same as continue (nothing has been sent yet) | answer the sender with JSON-RPC error `-32099` |
| `after` | a response, before the requester sees it | forward it | forward a rewritten frame carrying the injected `result` | re-send the original request and wait for a new answer | reply `-32099` instead |
| `error` | a JSON-RPC error, or an MCP tool result with `isError: true` | forward the failure | forward the injected result instead | re-send the request | reply `-32099` |

`error` is armed by default (see `--pause-on-error`), so a broken MCP server
holds at the failure with no setup at all. A hold is indistinguishable from a
hung server from the client's side, so the proxy says so on stderr — `HOLDING
tools/call #5 at the error gate — resume it in http://127.0.0.1:4747` — and if
you never resume, the MCP client times out on its own and the session carries
on. Start the server with `--pause-on-error off` if you want to watch without
ever stopping traffic. An injected object carrying its own
`jsonrpc` field replaces the whole frame, which is how you hand a client a
specific JSON-RPC error. On a notification (no id, no answer) `inject`
replaces the forwarded notification and `abort` swallows it.

Note: releasing a gate with `abort` marks the *run* aborted in the viewer,
because that is what `abort` means to the shared gate engine. The MCP session
itself carries on.

**Flags** (everything after `--` belongs to the wrapped command and is never
parsed by `graphmind`):

| Flag | Meaning |
|---|---|
| `--trace` | One stderr line per relayed frame — useful even with no GraphMind running |
| `--wait-for-attach` | Hold the first frame for up to 3s so `initialize` can be gated too |
| `--inherit-stderr` | Give the server the real stderr fd instead of piping it (keeps `isatty(2)` true; its log then does not reach the session node) |
| `--max-frame-bytes <n>` | Frame-assembly ceiling (default 64 MiB). Past it the proxy stops parsing and becomes a raw byte pipe — observation stops, relaying does not |
| `--port <n>` | The GraphMind port to report to (default 4747) |

`GRAPHMIND_URL` is honoured when `--port` is not given, so a proxy launched by
a client with no TTY still finds a GraphMind on a non-standard endpoint.

**Guarantees.** `stdout` carries the protocol and nothing else — every human
word goes to stderr. Frames are relayed as the exact bytes that arrived, so
key order, number formatting and unicode escaping all survive; the test suite
asserts the client sees byte-identical output to an unproxied run. If the
debugger disconnects while a gate is held, the gate releases and traffic
resumes. When the client hangs up, the server gets the EOF; if it ignores it,
the proxy asks it to stop rather than leaving a zombie behind. The proxy exits
with the server's own exit code (127 if the command does not exist).

### `graphmind record <runId> [--out <file>]`

Export a persisted run's event stream to NDJSON (one wire envelope per line —
the same shape `graphmind demo` replays and `WS /ingest` accepts). Default
output: `graphmind-run-<runId>.ndjson`. Lists recent run ids when the given
one is not found.

### Global flags

| Flag | Meaning |
|---|---|
| `--port <n>` | Port (default 4747; the server always binds `127.0.0.1`) |
| `--db <path>` | SQLite database file (default `~/.graphmind/graphmind.db`) |
| `--no-open` / `--open` | Suppress / force opening the viewer in a browser |
| `--pause-on-error <on\|off\|kind>` | Scope the default error breakpoint (default `on` = every node; `off` = none; or one node kind) |
| `--trace` | (`mcp-proxy`) log one stderr line per relayed JSON-RPC frame |
| `--wait-for-attach` | (`mcp-proxy`) hold the first frame until the debugger attaches |
| `--inherit-stderr` | (`mcp-proxy`) give the server the real stderr fd instead of piping it |
| `--max-frame-bytes <n>` | (`mcp-proxy`) frame-assembly ceiling (default 64 MiB) |
| `--live` | (`demo`) run the real demo agent instead of the replay |
| `--out <file>` | (`record`) output NDJSON path |
| `-v`, `--version` | Print the version and exit |
| `-h`, `--help` | Show help |

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `GRAPHMIND_DB` | CLI | Database path (`--db` beats it; default `~/.graphmind/graphmind.db`) |
| `GRAPHMIND_TELEMETRY` | CLI | `0` or `false` disables telemetry entirely (also auto-disabled when `CI` is set) |
| `GRAPHMIND_TELEMETRY_URL` | CLI | Override the telemetry endpoint (used by tests) |
| `GRAPHMIND_HOME` | CLI | Directory for the telemetry install id (default `~/.graphmind`) |
| `GRAPHMIND_DEMO_AGENT_DIR` | CLI | Where `demo --live` finds the demo agent outside a monorepo checkout |
| `GRAPHMIND_VIEWER_DIST` | CLI | Serve a different viewer build directory (development) |
| `GRAPHMIND_PAUSE_ON_ERROR` | CLI | `on` (default), `off`, or a node kind — scope of the default error breakpoint (`--pause-on-error` beats it) |
| `GRAPHMIND_ABANDON_GRACE_MS` | CLI | How long a run keeps `status: running` after its app disconnects before being marked `abandoned` (default 15000) |
| `GRAPHMIND_URL` | instrumented app | Ingest endpoint for adapters (default `ws://127.0.0.1:4747/ingest`) |
| `GRAPHMIND_DISABLED` | instrumented app | `1` disables instrumentation — beats everything, including explicit `enabled: true` |
| `GRAPHMIND` | instrumented app | `1` re-enables instrumentation under `NODE_ENV=production` (disabled there by default) |

## Telemetry

The CLI sends one anonymous event per command invocation: the command name, a
random install id, and the package version — never arguments, prompts,
traces, run data, or PII. Opt out with `GRAPHMIND_TELEMETRY=0`. The complete
disclosure, including the exact JSON record and delivery mechanics, is in
[TELEMETRY.md](./TELEMETRY.md).

## HTTP/WS endpoints

| Endpoint | Purpose |
| --- | --- |
| `WS /ingest` | Instrumented apps. Schema envelopes; `hello` -> `hello.ack` handshake (the ack carries current breakpoints + mode). |
| `WS /ws/ui` | Viewers. UI subprotocol (below). |
| `GET /health` | `{ ok, name, version }` |
| `GET /api/runs` | `{ runs: RunInfo[] }`, most recent first |
| `GET /api/runs/:id/events` | Paginated events (`?afterSeq=&limit=`) |
| `GET /*` | Built viewer from `viewer-dist/` (placeholder page when absent) |

### `GET /api/runs`

Each run: `{ id, app, startedAt, finishedAt, durationMs, status,
schemaVersion, source, eventCount, errorCount, live }` — `source` is
`live | import | demo`, `live` is whether the owning app socket is currently
connected. Timestamps are epoch ms; `finishedAt` and `durationMs`
(`finishedAt - startedAt`, served here so consumers need not subtract
envelope timestamps) are `null` while the run is in flight.

`status` is one of:

| Status | Meaning |
| --- | --- |
| `running` | in flight: `run.started` seen, no `run.finished` yet |
| `ok` / `error` / `aborted` | the run reported this terminal status itself |
| `abandoned` | the server's own terminal state: the connection owning this run went away without ever sending `run.finished` — the instrumented process died, often while holding a gate |

`abandoned` exists so the runs list cannot fill up with phantom rows that
claim to be in flight forever. It is deliberately not `aborted`: nobody
decided to stop the run, the server simply stopped hearing about it.
`finishedAt` is then the run's last event — the last moment it is known to
have been alive.

A run is only marked `abandoned` after `GRAPHMIND_ABANDON_GRACE_MS` (default
15s, comfortably longer than the client's reconnect burst), so a socket blip
never marks a live run dead; if the app reconnects and keeps streaming the
same run, the run goes back to `running`. Runs left `running` by a previous
server process are reconciled the same way at startup.

### `GET /api/runs/:id/events?afterSeq=N&limit=M`

Returns `{ runId, total, events, nextAfterSeq }`. `events` are full wire
envelopes (`{ gm, seq, ts, runId, type, payload }`) in ascending `seq` order
with `seq > afterSeq` (default: from the start). `limit` defaults to 1000
(max 5000). `nextAfterSeq` is the cursor for the next page, or `null` on the
last page. Unknown run: 404 `{ error }`.

## UI subprotocol (`WS /ws/ui`)

JSON text frames, each an object with a `type` discriminant. Schema wire
envelopes are never sent bare — they ride inside `event` / `control`
messages. Types are exported from this package (`UiClientMessage`,
`UiServerMessage`, `RunInfo`, `WireEnvelope`).

Server -> viewer:

| Message | When |
| --- | --- |
| `{ type: 'welcome', versions: { protocol, server }, breakpoints, mode }` | immediately on connect |
| `{ type: 'state', breakpoints, mode }` | whenever debug state changes (any viewer changed it) |
| `{ type: 'runs', runs: RunInfo[] }` | reply to `subscribe` `'*'` |
| `{ type: 'run.update', run: RunInfo }` | pushed to `'*'` subscribers on run lifecycle changes (created / finished / abandoned / app connect+disconnect) |
| `{ type: 'replay.start', runId, count }` | reply to `subscribe` of a run |
| `{ type: 'event', runId, envelope }` | one envelope — replayed history first, then live tail |
| `{ type: 'replay.end', runId }` | history done; everything after is live |
| `{ type: 'error', message, runId? }` | bad request / unroutable control |

Viewer -> server:

| Message | Meaning |
| --- | --- |
| `{ type: 'subscribe', runId }` | a run id -> replay-then-tail; `'*'` -> run-list snapshot + updates |
| `{ type: 'unsubscribe', runId }` | stop that subscription |
| `{ type: 'control', envelope }` | a full schema control envelope: `exec.resume` (routed to the app socket owning `envelope.runId`), `breakpoint.set` / `breakpoint.clear` / `mode.set` (update server state, relay to all connected apps, broadcast `state`) |

Replayed envelopes keep their original `seq`; dedupe on `(runId, seq)`.
Control envelopes can be built with `createEnvelope` from the schema package
(any `seq` — the server re-mints sequence numbers when relaying to apps).

## Storage

`node:sqlite` (built into Node >= 22.13, zero native deps), WAL mode, at
`~/.graphmind/graphmind.db` (override: `GRAPHMIND_DB` or `--db`). Events are
keyed `(run_id, seq)` with INSERT OR IGNORE — replay dedup lives in the
schema.

## Viewer bundle

The server serves the built viewer from `viewer-dist/` in the package root
(bundled in the published package). Absent, a placeholder page explains that
the viewer isn't built; the API and sockets work regardless. Override with
`GRAPHMIND_VIEWER_DIST` for development.

## License

MIT
