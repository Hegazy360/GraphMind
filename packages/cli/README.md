# graphmind-ai

**GraphMind — the live debugger for AI agents.** Observability tools show you
what your agent did; GraphMind attaches while it's happening: a live execution
graph, pause-on-error by default, breakpoints, step mode, and
inject-and-continue that genuinely hold execution.

This package is the `graphmind` CLI: the local server, SQLite storage, the
keyless demo, the trace importer, the MCP server, and the bundled viewer UI.

Local-first: the server binds `127.0.0.1` only and has no auth (never expose
the port). Runs are stored in a local SQLite file; your prompts and payloads
never leave your machine. Requires Node >= 22.13 (SQLite is built into Node —
no native dependencies).

```sh
npx graphmind-ai demo    # no API key needed — see it debug a planted bug
npx graphmind-ai         # start the debugger for your own agent
```

Apps instrumented with a GraphMind adapter (currently: the Vercel AI SDK
adapter, `@graphmind/ai-sdk` in the [GraphMind repo](https://github.com/Hegazy360/graphmind))
stream execution events to this server; the viewer connects to watch live,
replay history, and send control commands (pause / resume / breakpoints /
inject). Other frameworks get in via `graphmind import` (OTel / OpenInference
trace exports).

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

Each run: `{ id, app, startedAt, finishedAt, status, schemaVersion, source,
eventCount, errorCount, live }` — `status` is `running | ok | error |
aborted`, `source` is `live | import | demo`, `live` is whether the owning
app socket is currently connected. Timestamps are epoch ms; `finishedAt` is
`null` while running.

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
| `{ type: 'run.update', run: RunInfo }` | pushed to `'*'` subscribers on run lifecycle changes (created / finished / app connect+disconnect) |
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
