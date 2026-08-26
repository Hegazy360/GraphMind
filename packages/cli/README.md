# graphmind-ai

The GraphMind local server + CLI (bin: `graphmind`) — the center of the
GraphMind live agent debugger. Instrumented apps (via `@graphmind/client`
adapters) stream execution events to it; the viewer web app connects to it to
watch live, replay history, and send control commands (pause / resume /
breakpoints); runs are persisted locally.

Local-first: the server binds `127.0.0.1` only and has no auth. Never expose
the port.

## Usage

```
graphmind                # start the server on 4747, open the viewer
graphmind --port 4848    # different port
graphmind --db ./x.db    # database file (default ~/.graphmind/graphmind.db,
                         # or GRAPHMIND_DB)
graphmind --no-open      # do not open a browser
```

Subcommands (`import`, `mcp`, `record`) are planned; `serve` is the default.

## Endpoints

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

Replayed envelopes keep their original `seq`; dedupe on `(runId, seq)`
(internal/decisions.md #5). Control envelopes can be built with
`createEnvelope` from `@graphmind/schema` (any `seq` — the server re-mints
sequence numbers when relaying to apps).

## Storage

`node:sqlite` (built into Node >= 22.13, zero native deps), WAL mode, at
`~/.graphmind/graphmind.db` (override: `GRAPHMIND_DB` or `--db`). Events are
keyed `(run_id, seq)` with INSERT OR IGNORE — replay dedup lives in the
schema. The `Storage` interface in `src/storage.ts` is the hedge that lets a
JSONL fallback replace SQLite without touching the server.

## Viewer bundle

The server serves `viewer-dist/` from the package root when present (the
viewer app is built separately and copied in at publish time). Absent, a
placeholder page explains that the viewer isn't built; the API and sockets
work regardless. Override with `GRAPHMIND_VIEWER_DIST` for development.
