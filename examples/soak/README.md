# soak — what happens to GraphMind at production volume

Nobody had ever run production-shaped load through GraphMind. This package
does, and writes the numbers down so a future regression is visible.

It is not a unit test. It drives the **real** pipeline end to end:

| piece | what the harness uses |
| --- | --- |
| server | the real `startServer()` from `graphmind-ai`, **in its own OS process**, ephemeral port, throwaway SQLite file |
| app | a real `@graphmind-ai/client` session over a real WebSocket (the default platform one — exactly what an instrumented app gets) |
| viewer | a headless client speaking the real `/ws/ui` subprotocol, plus the viewer's own reducer and layout imported straight from `apps/viewer/src` |
| model | a seeded generator — free, deterministic, and shaped like what the `ai-sdk` adapter emits |

The server runs out-of-process on purpose: *"memory of the server process over
time"* only means something when the driver's own allocations are somewhere
else. RSS is sampled from outside with `ps`, because a server saturated with
synchronous SQLite writes starves its own `setInterval`.

## Running it

```bash
pnpm --filter soak start                            # the default battery (~4 min)
pnpm --filter soak start -- --scenario=everything   # + the long run (~9 min)
pnpm --filter soak start -- --scenario=throughput --events=50000 --nodes=800
pnpm --filter soak start -- --scenario=longrun --gap=90 --gaps=4
pnpm --filter soak start -- --scenario=viewer,retention --json=results/today.json
pnpm --filter soak start -- --scenario=adversarial --max-frame=96
```

Scenarios: `throughput`, `concurrent`, `payloads`, `reconnect`, `retention`,
`viewer`, `adversarial`, `longrun`. `--scenario=all` runs everything except
`longrun` (which costs wall-clock minutes); `everything` includes it.
Comma-separated lists work.

Useful flags: `--events`, `--nodes`, `--rate` (cap emission, events/s),
`--sessions`, `--runs-per-session`, `--viewers`, `--runs` (retention),
`--gap` / `--gaps` / `--burst` (long run), `--max-frame` / `--connections` /
`--garbage` / `--reap-ping` (adversarial), `--verbose` (stream server logs),
`--json=<path>` (machine-readable results), `--trace` (stack traces).

The harness exits non-zero if any check fails, so it can gate a release.

## What it proves, not just measures

Every scenario asserts correctness alongside the timings:

- **exactly once, in order.** Every generated payload carries a per-run ordinal
  `i` (the wire contract preserves unknown payload fields), so the harness can
  prove the stored run contains ordinals `0..N-1` exactly once, in ascending
  `seq`, and that the derived `eventCount` / `errorCount` in `GET /api/runs`
  agree — without depending on the client's internal `seq`.
- **the same thing at the viewer.** The UI probe records arrival order, so the
  same exactly-once/ordering proof runs against what actually came down the
  socket, live and after a replay.
- **replay-on-attach.** A viewer that disconnects mid-run and comes back must
  get the whole run once, in order, no duplicates, no gaps.
- **fail-open.** `session.emit` must never throw into the host app, whatever it
  is handed — 32 MB payloads, 100,000-deep JSON, cyclic objects.
- **the server stays up and stays honest under attack.** The adversarial
  scenario asserts that `/health` still answers while a peer floods, that an
  honest run lands with 500 hostile connections attached and with 200 silent
  TCP sockets held open, and that a real app can still connect through all of
  it. Whether an attacker can *corrupt* anything is a different question,
  answered by tests in `security/` rather than by numbers here.

---

# Baseline

**Machine** MacBook Pro (M1 Pro, 8 cores, 16 GB) · macOS 26.5.2 · Node v24.19.0
· GraphMind 0.2.2 · 2026-08-27. One coherent run of
`--scenario=everything --events=12000 --nodes=300`, 39/39 checks green; raw
numbers in `results/baseline.json`. Absolute times move ±30% with machine load,
so regress against the *shapes* — ratios, curves and cliffs — more than the
milliseconds.

## Ingest — one big run

12,008 events · 550 logical nodes · 9,960 token frames · 2.10 MB of payload ·
one viewer attached and tailing the whole time.

| | |
| --- | --- |
| ingest throughput | **20,963 events/s** (3.67 MB/s) |
| cost of one `session.emit` in the app | **3 µs** (12k events emitted in 54.9 ms) |
| server drain after the emit loop returned | 517.9 ms — the queue outlives the loop by 10x |
| end-to-end latency **at saturation** | p50 260 ms · p95 489 ms · p99 508 ms · max 515 ms |
| end-to-end latency **paced at 2,000 events/s** | **p50 1 ms · p95 4 ms · p99 8 ms · max 9 ms** |
| server RSS | 95.1 MB idle → 106 MB peak; 10.8 MB still resident after a forced GC |
| server heap after GC | 15.2 MB (idle baseline 14.5 MB) |
| SQLite | 7.63 MB = **666 B/event** (3.65 MB db + 3.94 MB WAL) |
| `GET /api/runs` | 1.5 ms |
| `GET /api/runs/:id/events?limit=1000` | 5.8 ms / 291 KB |
| `GET /api/runs/:id/events?limit=5000` | 21.7 ms / 1.34 MB |
| full history (3 pages, 3.22 MB) | 57.3 ms |
| correctness | 12,008/12,008 stored exactly once, in order; viewer socket identical |

The two latency rows are the headline. At saturation the number you measure is
queue depth, not the system. Paced below the ceiling, GraphMind is a live view.

## Concurrency — 4 sessions × 3 runs × 2,004 events, 3 viewers

| | |
| --- | --- |
| aggregate throughput | **17,345 events/s** across 12 concurrent runs |
| emit / drain | 93 ms emit, 1.29 s drain |
| SQLite | 11.7 MB = 509 B/event |
| server RSS | 95.1 MB → 140 MB |
| `GET /api/runs` (12 runs) | 3.5 ms |
| correctness | all 12 runs exactly once, in order, counts match; a viewer pinned to one run received nothing from the other eleven |
| viewer delivery at saturation | **0% live, 100% catch-up replay** |
| viewer delivery paced at 1,500/s per run (18k/s total) | 98% live, p50 36 ms · p95 80 ms · max 99 ms |

## Payloads — the 512 KB guard and beyond

| payload | stored | seen live | server RSS after |
| --- | --- | --- | --- |
| 64 KB / 256 KB / 511 KB | intact | intact | 95.8 → 98.5 MB |
| 513 KB | 4.15 KB, field-wise truncated, **still a valid envelope** | 513 KB in full | 99.1 MB |
| 2 MB | 4.16 KB | 2 MB in full | 103 MB |
| 8 MB | 4.16 KB | 8 MB in full | 142 MB |
| 32 MB | 4.16 KB | 32 MB in full | **303 MB** |

Repeating an 8 MB frame four times leaves RSS dead flat (173 → 173 → 173 →
173 MB, +32 KB total): the high-water mark is a **plateau, not a leak** — but it
never comes back down either, so a server that has once handled a 32 MB frame
stays a ~300 MB process.

JSON nesting: depth 4,096 round-trips fine (59 KB stored). At depth ~20,000
`JSON.stringify` throws inside `session.emit`; the client degrades to a no-op
with one rate-limited warning and **the event is silently lost**. A cyclic
payload is swallowed the same way and the run continues. In every case the host
app saw nothing — fail-open holds.

## Reconnect

| case | result |
| --- | --- |
| A — app dark for 300 events, ring buffer 2,000 | 1,300/1,300 stored, 0 duplicates, 0 gaps; replay-on-attach deduped correctly in storage *and* at the attached viewer |
| B — app dark for 3,000 events, ring buffer 500 | 900/3,400 stored — **2,500 events lost for good**, `session.stats().dropped = 2903` |
| C — viewer closes mid-run and reopens | 3,003 frames for 3,000 events: whole run, exactly once, in order |
| D — blip with shipped defaults, app never calls `ready()` again | **9.99 s dark** before the background retry reconnects |

## Retention and the run list

| | |
| --- | --- |
| `GET /api/runs` at 25 → 200 runs (5,100 → 40,800 events) | 1.71 → 3.49 ms — 8x the runs for 2x the time, **not** a bottleneck |
| adding one 20,000-event run on top | 3.30 → 3.77 ms, no material change |
| `prune(keepRuns=50)` deleting 151 runs / 30,804 events | 47 ms on an idle machine, up to 1.2 s under load — and it runs **synchronously in `startServer` before the listener binds** |
| database file after prune | 24.0 MB → 28.4 MB — it *grew* (deletes go to the WAL) |
| after `VACUUM` | 18.9 MB in 44 ms — and **nothing in the server ever calls it** |

## Viewer — reducer and layout, no browser

> **Stale as of the layout fix.** The `layoutGraph` numbers below are the
> pre-fix curve; the scenario now reports 2.39 ms at 3,203 nodes and no crash
> at 6,000-deep. See finding #5. The reducer numbers are unchanged in shape.

Real run (12,008 events) read back out of the server and pushed through
`ingestValue` → `runStateToFlow` → `layoutGraph`, the same path
`useLiveConnection` takes.

| | |
| --- | --- |
| apply 12,008 events | **126.7 ms** = JSON.parse 15.1 ms + validate/reduce/token-route 111.7 ms = **10.6 µs/event** |
| token buffer flush | 0.22 ms |
| `runStateToFlow` (550 nodes, 549 edges) | 0.66 ms |
| `layoutGraph` | 5.9 ms |
| **time to first frame, cold** | **133 ms** |
| viewer heap for the run | 26 MB |

Scaling:

| events | 1,545 | 3,021 | 6,038 | 12,006 | 24,010 |
| --- | --- | --- | --- | --- | --- |
| µs/event | 7.5 | 5.7 | 5.7 | 6.8 | 9.6 |

Linear — the reducer is fine. Layout is not:

| nodes | 269 | 401 | 800 | 1,604 | 3,203 |
| --- | --- | --- | --- | --- | --- |
| `layoutGraph` | 1.5 ms | 2.6 ms | 10.8 ms | 44 ms | 188 ms |

`appendLayout`, the incremental path used while a run streams, costs 53 µs per
added node at 300 nodes and 221 µs at 1,763 — it rescans every already-placed
rectangle for each arrival.

…and the recursive tree walk has a hard ceiling:

| chain depth | 500 | 1,000 | 2,000 | 4,000 | 6,000 |
| --- | --- | --- | --- | --- | --- |
| `layoutGraph` | 7.6 ms | 35 ms | 135 ms | 569 ms | **RangeError: Maximum call stack size exceeded** |

(The exact cliff moves with available stack — 4,000 threw on a busier run,
6,000 always does.)

Both of these need a graph the shipped adapters cannot produce: `ai-sdk`,
`anthropic`, `openai` and `langgraph` all use one stable `llm:step` node and one
node per distinct tool *name* (`packages/*/src/ids.ts`, `import/classify.ts`), so
node count is bounded by the code, not by the run. Custom instrumentation and
some imports can mint a node per step, and then this is reachable.

## Adversarial — what a hostile peer costs

Every other scenario measures GraphMind under load it was designed for. This
one measures it under load designed to hurt: a raw peer on `/ingest` that is
not the SDK and does not care about the protocol. Local-first with no auth
means any process on the machine can be that peer, and the origin guard
(`packages/cli/src/origin-guard.ts`) only stops *browsers*.

The correctness half of that question — can a peer corrupt someone else's run,
can a bad frame crash the parser — is a CI test suite, not a soak run: see
`security/` and `pnpm test:security`. What only this harness can answer is how
much an attack **costs**, because here the server is in its own process with an
external RSS sampler.

| lever | result |
| --- | --- |
| 1 MB frame | 96.3 → 105 MB |
| 8 MB frame | 157 MB |
| 32 MB frame | 261 MB |
| 64 MB frame | 563 MB peak; **486 MB after a forced GC, 390 MB above idle** |
| 64 MB frame x3 more | flat — a plateau, not a leak |
| 500 simultaneous ingest connections | +1.63 KB each, `/health` in 2.9 ms |
| 5,000 garbage frames | **exactly 1.00 log lines per frame**, drained in 78 ms, `/health` 30 ms during |
| 60,000 queued frames at a 200 ms ping | **26,610 lost** — the pinger terminated the peer it was busiest with |
| 200 silent TCP sockets + a stalled half-upgrade | +2.25 MB, `/health` 17 ms, a real app still streams |

The shape of it: **connections are cheap, frames are not.** A peer cannot
exhaust the server by connecting — 500 sockets cost less than a megabyte
between them, and an honest run still lands while they are all attached — but a
single frame three orders of magnitude larger than the storage budget moves the
process to five times its idle size, permanently. The wire has no
protocol-appropriate cap: `MAX_PAYLOAD_BYTES` is 512 KB and `ws`'s default
`maxPayload` is 100 MiB, and the 512 KB guard only runs *after* the frame has
been buffered, decoded and parsed.

Floods themselves are survivable — 20,000 frames drain in 0.65 s with nothing
lost and `/health` answering throughout — with two caveats: every dropped frame
costs the operator a synchronous `console.log`, and a peer whose backlog
outlives two ping intervals gets terminated by the liveness reaper with its
in-flight events silently discarded.

## Long run — 3.8 minutes, three 75-second idle gaps

Gaps deliberately wider than the server's reaping window (2 × the 30 s ping
interval), on the default platform WebSocket.

| | |
| --- | --- |
| detachments across three idle gaps | **0** — the platform WebSocket answers the server's pings |
| events surviving the whole session | 1,600/1,600 |
| burst latency after 75 s of silence | 32 → 45 → 51 → 49 ms, no warm-up penalty |
| gate held + resumed after minutes idle | yes |
| viewer socket across the gaps | survived |
| server RSS over 3.8 min (224 samples) | 95.1 MB start → 100 MB peak → 91.0 MB end, median 89.4 MB (drift −4 MB) |

No drift, no timer leak, no socket leak. This is the scenario that could have
gone worst and went best.

---

# The verdict

**Comfortable.** Runs up to ~25,000 events with a few hundred logical nodes,
ingest under ~2,000 events/s, a handful of concurrent runs, a database under a
few hundred MB. In that envelope GraphMind is genuinely live: 1 ms median from
`emit` to the viewer socket, a cold run opens in 133 ms, and every correctness
assertion holds — nothing lost, nothing duplicated, nothing reordered, counts
exact.

**Where it stops being pleasant — liveness goes first, and it goes quietly.**
The ingest ceiling is ~21,000 events/s on one core (one Node process,
synchronous SQLite writes). Between 2,000/s and that ceiling the viewer falls
behind: 260–515 ms at 12k events, and at full saturation with a dozen
concurrent runs it stops being a live view entirely — the subscribe is serviced
only after the backlog drains, so the viewer receives 100% of the run as
catch-up replay. Nothing errors. The product just silently becomes a log
viewer, which is the one thing it claims not to be.

**What breaks first is not volume — it is a disconnect.** The client keeps
2,000 events in its ring buffer and retries every 10 s by default. Any blip on a
run streaming faster than ~200 events/s therefore loses data, and loses it
*invisibly*: `seq` numbers simply skip, the stored run looks complete, the viewer
has no way to know, and the only witness is `session.stats().dropped`, which
nothing reports. For a debugger, a silent hole in the trace is worse than a
crash — you will debug the wrong thing. This is the number-one thing to fix
before strangers arrive.

**Second: one oversized payload costs the whole server.** Storage is guarded at
512 KB, but the fan-out path is not. A single 32 MB tool result is relayed in
full to every attached viewer and moves the server from a 95 MB process to a
303 MB one, permanently.

**Third, and only for unusual graphs: the canvas.** Layout is ~O(n²) and
recursive. At the node counts the shipped adapters produce this is invisible
(5.9 ms for the 550-node run above); at 3,200 nodes it is ~190 ms per structural
change, and somewhere past 4,000 tree depth the canvas throws and renders
nothing.

**Fourth, and new: a hostile peer buys memory, not much else.** Connections are
cheap — 500 of them cost 1.63 KB each and an honest run still lands through the
crowd — and floods, slowloris and half-open upgrades are all survivable. What
is not bounded is one frame: the wire accepts 100 MiB against a 512 KB storage
budget, and a single 64 MB frame leaves the process at five times its idle
size for good. That is the one lever worth closing, and it is one option
object away.

**What did not break:** long idleness, ping/pong reaping under normal load,
reconnect correctness, replay-on-attach, concurrent-run isolation, control
routing after minutes of silence, memory over time, the run list at 200 runs,
and — under deliberate attack — the parser, the connection table, and the
isolation of a healthy run from a flood of malformed frames. Those were the
likely suspects, and they held.

# Findings

Ordered by how much damage they do.

### 1. A disconnect longer than the ring buffer loses events, silently — `packages/client`
**Repro** `pnpm --filter soak start -- --scenario=reconnect`
3,000 events emitted while detached with a 500-event buffer → 900 of 3,400
stored; 2,500 gone. Nothing on the wire, in storage, or in the viewer marks the
gap. Suggested: emit a `gap` event (or a `run.gap` payload field) when
`RingBuffer.dropped` increases while detached, so the viewer can draw the hole;
and consider a shorter first retry (the current 10 s default is a whole
generation of events at production rates).

### 2. ~~The fan-out path has no payload size cap~~ — FIXED
`hub.handleIngestFrame` now fans out what it stored
(`this.fanout(stored.truncated ? { ...envelope, payload: stored.payload } :
envelope)`), so a live viewer and a reload agree and a 32 MB tool result is no
longer relayed in full. Re-measured: every size on the ladder is now identical
live and on replay, and the 32 MB case leaves the server at 264 MB rather than
303 MB. The **"Payloads"** table above still shows the pre-fix "seen live"
column; the "live vs replay" row in the scenario is the current answer.

### 3. `prune` never shrinks the database and nothing calls `vacuum()` — `packages/cli`
**Repro** `pnpm --filter soak start -- --scenario=retention`
Deleting 151 runs / 30,804 events moved the file from 24.0 MB to 28.4 MB;
`VACUUM` then took it to 18.9 MB in 44 ms. `SqliteStorage.vacuum()` exists and
has no callers. Retention also runs synchronously in `startServer` *before* the
listener binds, so a large backlog delays startup (47 ms idle, up to ~1.2 s on a
busy machine).

### 4. JSON deeper than ~20,000 is silently dropped — `packages/client`
**Repro** `pnpm --filter soak start -- --scenario=payloads`
`serializeEnvelope` throws `RangeError: Maximum call stack size exceeded`;
`session.guard('emit')` catches it and warns once (rate-limited). Fail-open
works exactly as designed and the host app is untouched — but the event is gone
with no per-event signal. Worth a documented depth limit.

### 5. ~~Viewer layout is ~O(n²) and recursive~~ — LARGELY FIXED
Originally: 188 ms per layout at 3,203 nodes and a stack overflow past ~4,000
tree depth. Re-measured on the same scenario after the layout work landed:
**2.39 ms at 3,203 nodes**, scaling 12x nodes → 12.2x time (linear or better),
and a 6,000-deep chain lays out in 6.45 ms instead of throwing. The table under
"Viewer" above predates that and is kept only for the shape of the old curve.
What remains is `appendLayout` in `incremental.ts`, still rescanning placed
rectangles per new node: 52 µs/node at 300 nodes rising to 191 µs/node at
1,763 — a 3.7x per-node increase over 6x the canvas, which the scenario now
accepts rather than flags.


### 6. The wire has no protocol-appropriate frame cap — `packages/cli/src/server.ts`
**Repro** `pnpm --filter soak start -- --scenario=adversarial`
`MAX_PAYLOAD_BYTES` is 512 KB; the socket's limit is `ws`'s default
`maxPayload`, 100 MiB. The guard runs after the frame has been buffered,
decoded to a string and JSON-parsed, so a 64 MB frame moves the server from
96 MB to 486 MB and it does not come back after a forced GC. Pass `maxPayload`
to both `WebSocketServer`s — a few MB is already generous — so an oversized
frame is refused at the socket (close 1009) instead of being materialised.

### 7. Every dropped frame costs one unthrottled log line — `packages/cli/src/hub.ts`
**Repro** `pnpm --filter soak start -- --scenario=adversarial`
Measured at exactly 1.00 log lines per garbage frame. `graphmind serve` passes
`console.log`, a synchronous write to the operator's TTY, so a peer sending
garbage at line rate spends the operator's event loop and buries the log they
were reading. Repeated `hello` frames do the same and additionally get a
`hello.ack` allocated per frame. The client's `session.guard()` already has the
rate-limited-warning shape to copy.

### 8. The liveness reaper kills the peer it is busiest with — `packages/cli/src/hub.ts`
**Repro** `pnpm --filter soak start -- --scenario=adversarial --reap-ping=200`
`Hub.pingAll` terminates any socket that has not ponged since the previous
tick. The pong arrives on the same TCP stream as that peer's own frames,
*behind* them, so the server only sees it after draining that peer's entire
backlog — a peer with more than ~two ping intervals of queued work is reaped
**because** the server is busy with it. 26,610 of 60,000 events were lost, with
no error to the app, no gap in the viewer, and one `app detached` line in the
log: the same silent-loss class as finding #1. At the shipped 30 s interval
this needs roughly a million queued events, so it is reachable on purpose
rather than by accident — and trivial for anyone who lowers `pingIntervalMs`.
Judge liveness on "have we read anything from this socket recently" instead.

### Correctness findings from the same attack surface
Not repeated here because they belong in a test suite, not a benchmark. From
`security/` (`pnpm test:security`, all pinned as tests): any `/ingest`
connection can claim any run — fabricating events into it, stealing the
operator's `exec.resume` **including the injected value**, wedging the victim's
gate forever and forging its `run.finished`; `seq` squatting silently deletes a
real app's events; and the 512 KB guard can produce stored envelopes the viewer
rejects when the oversized field is one the schema requires. See
`security/README.md` for the full list.

### Fixed while here — `packages/cli/src/storage.ts`
An oversized payload used to be replaced **wholesale** by the truncation
marker, which destroyed the fields the payload's own schema requires
(`node.finished` needs `nodeId`, `durationMs`, `status`). `parseEnvelope` then
rejected the stored envelope and `ingest.ts` dropped it: on reload, a node whose
result was over 512 KB never left the "running" state, and a node whose *input*
was over 512 KB never appeared at all. `serializePayload` now truncates the
offending **fields** and keeps the small structural ones, while still carrying
the `__graphmindTruncated` marker at the top level so every existing consumer
and test behaves the same. The harness asserts both halves: *every stored event
is still a valid envelope the viewer can parse* and *a truncated event still
carries the fields the canvas needs*.
