# graphmind (Ruby)

**A live debugger for AI agents.** Phoenix and Langfuse show you what your agent
*did*. GraphMind attaches while it is happening: your instrumented app streams
execution events to a local viewer, which renders the run as a live graph and
can **hold execution** — before an LLM step, before/after a tool call, or on
error — then resume with **continue / retry / inject / abort**.

Local-first (`127.0.0.1`), **zero runtime dependencies**, and it fails open: with
no debugger attached everything is a no-op, and a debugger that disconnects
mid-hold releases every gate.

---

## Install

```ruby
# Gemfile
group :development, :test do
  gem "graphmind"
end
```

Then start the debugger (Node, from npm — the viewer and server are shared by
every language SDK):

```sh
npx graphmind-ai          # serves http://127.0.0.1:4747 and opens the viewer
```

## Quickstart

```ruby
require "graphmind"

gm = Graphmind.configure(app: "support-agent")

search = gm.tool("search_flights") do |origin:, destination:|
  Flights.search(origin, destination)
end

client = gm.instrument_openai(OpenAI::Client.new(access_token: ENV.fetch("OPENAI_API_KEY")))

gm.run("handle-ticket") do
  client.chat(parameters: {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "cheapest LHR to JFK next Tuesday?" }]
  })
  search.call(origin: "LHR", destination: "JFK")
end
```

Open the viewer and you get a live graph: an `agent:handle-ticket` node, an
`llm:step` node with the model, prompt and token usage, and a
`tool:search_flights` node with its arguments and result. Click a node to set a
breakpoint; the next run **stops there**, and you can edit the tool's result
before letting it continue.

With nothing attached, every line above is a plain method call.

### Waiting for the debugger

```ruby
Graphmind.ready(5)   # true once attached, false on timeout — never raises
```

`false` means "carry on detached". It is not an error.

---

## What you can instrument

### Tools and plain methods

Blocks:

```ruby
search = Graphmind.tool("search") { |query:| Index.query(query) }
search.call(query: "flights")           # gated: before / error / after
```

Any callable, keeping its shape:

```ruby
tools = Graphmind.wrap_tools(
  search: ->(q) { Index.query(q) },
  book:   method(:book_flight)
)
tools[:search].call("flights")
```

One method on one object, in place:

```ruby
Graphmind.wrap_method(flight_service, :search)
flight_service.search("LHR", "JFK")     # now pauses
```

Every instance of a class:

```ruby
class FlightTools
  include Graphmind::Instrument
  graphmind_tool :search, :book

  def search(origin, destination) = ...
end
```

### Anything else: spans

```ruby
Graphmind.span("plan", kind: "chain", input: { goal: goal }) do |span|
  steps = planner.plan(goal)
  span.output = steps      # what the node shows; also the span's return value
  steps
end
```

`kind` is any node kind in the wire contract: `agent`, `llm`, `tool`, `chain`,
`retriever`, `server`, `resource`, `prompt`, `custom`.

### ruby-openai

```ruby
client = Graphmind.instrument_openai(OpenAI::Client.new(access_token: ...))
client.chat(parameters: { model: "gpt-4o-mini", messages: [...] })
client.responses.create(parameters: { model: "gpt-4o-mini", input: "hi" })
```

One `llm:step` node per call, with model, trimmed messages, reply text and
token usage. Streaming (`stream:`) forwards deltas to the canvas and still
calls your own handler with the arity it declared.

The module is prepended to **that client's singleton class**: nothing global is
monkey-patched, and another client in the same process is untouched.

### ruby_llm

```ruby
chat = Graphmind.instrument_ruby_llm(RubyLLM.chat.with_tool(Weather))
chat.ask("what's the weather in Cairo?")
```

One `llm:step` node per provider round-trip (not per `ask`), plus a
`tool:<name>` node per `RubyLLM::Tool#call` — where `inject` genuinely replaces
the tool result the model sees next.

### Injecting values from the viewer

Whatever you type in the viewer arrives as JSON, so the integrations coerce it
into what the call site expects:

| Gate | Type a string and you get |
| --- | --- |
| `tool:*` (blocks, methods, `RubyLLM::Tool`) | the string, as the tool's return value |
| ruby-openai `llm:step` | a `chat.completion`-shaped Hash whose message content is your string |
| ruby_llm `llm:step` | a `RubyLLM::Message` with `role: :assistant` |

An object works too and is passed through / built as-is.

---

## Capability matrix

| Surface | Node | `before` | `after` | `error` | `inject` | `retry` | `abort` | Streaming |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `Graphmind.tool` / `wrap_tools` / `wrap_method` / `Graphmind::Instrument` | `tool:<name>` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `Graphmind.span` | `<kind>:<name>` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `Graphmind.run` | `agent:<name>` | — | — | — | — | — | ✅¹ | — |
| ruby-openai `chat` / `responses.create` | `llm:step` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ observe |
| ruby_llm provider round-trip | `llm:step` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️² |
| ruby_llm `Tool#call` | `tool:<name>` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |

¹ A run has no gate of its own; `abort` at any gate inside it marks the run
aborted and raises `Graphmind::AbortError`.
² A streaming `ask` is gated like any other round-trip, but individual deltas
are not forwarded to the canvas yet (ruby-openai's are).

`after` gates fire only in step mode or with an explicit `after` breakpoint
(this matches the TypeScript and Python SDKs).

---

## Rails

Add the gem and you get a Railtie. It does three things:

1. names the app after your Rails application;
2. clears the per-thread run context via `Rails.application.executor.to_complete`
   — Puma reuses threads, so a run left behind by a request that died mid-flight
   would otherwise adopt the *next* request's events;
3. releases held gates and closes the socket at exit.

Configure it from `config/application.rb` or an initializer:

```ruby
# config/initializers/graphmind.rb
Rails.application.configure do
  config.graphmind.enabled = Rails.env.development?
  config.graphmind.app     = "support-agent"
  config.graphmind.url     = "ws://127.0.0.1:4747/ingest"   # or GRAPHMIND_URL
end
```

Every key is passed to `Graphmind.configure`. A key it does not understand is a
warning at boot, never a failed deploy. `config.graphmind.autoconfigure = false`
leaves configuration entirely to you.

Without Rails, do the same thing in one line at boot:

```ruby
Graphmind.configure(app: "my-agent", enabled: ENV["RACK_ENV"] != "production")
```

### Threads: Puma, Sidekiq, and friends

The run context lives in **fiber-local storage** (`Thread.current[:graphmind_run_context]`).
Concretely:

* **Puma / Falcon / any threaded server** — each request runs on its own thread
  (its root fiber), so `Graphmind.run` inside a controller action is scoped to
  exactly that request. Two concurrent requests get two runs and never see each
  other's context. Verified in `test/test_threading.rb`.
* **Sidekiq** — a job is a thread. Wrap `perform` in `Graphmind.run("MyJob")`
  and the whole job is one run.
* **A gate holds only the thread that hit it.** Other Puma threads keep serving
  while one request sits at a breakpoint. This is the single most important
  property to understand: pausing a request in a threaded server does *not*
  freeze the server.
* **Threads you spawn yourself do not inherit the run context** (this is how
  Ruby's fiber-locals work). Carry it explicitly:

  ```ruby
  Graphmind.run("batch") do |ctx|
    items.map { |i| Thread.new { Graphmind.with_run_context(ctx) { process(i) } } }.each(&:join)
  end
  ```

  The ruby_llm integration does this for you when ruby_llm runs tool calls on a
  thread pool.
* **Forking servers (Puma clustered, Unicorn, Resque)** — GraphMind's ids are
  re-seeded after a fork, and each worker opens its own WebSocket. Every worker
  shows up as its own client in the viewer.
* **The transport never blocks your threads.** One background thread owns the
  socket and one drains a bounded outbox; `emit` is a serialize plus an enqueue
  (~2 µs measured, see below).

---

## Kill switches and safety

| Setting | Effect |
| --- | --- |
| `GRAPHMIND_DISABLED=1` | Off, always. Beats an explicit `enabled: true` in code. |
| production-looking env | Off unless `GRAPHMIND=1`. |
| `enabled: false` | Off. |
| `GRAPHMIND_URL` | Where to dial (default `ws://127.0.0.1:4747/ingest`). |

"Production-looking" is a boring, documented rule: the first variable that is
*set* out of `GRAPHMIND_ENV`, `ENVIRONMENT`, `APP_ENV`, `RAILS_ENV`, `RACK_ENV`,
`ENV`, `NODE_ENV` decides, and it counts as production when its value is
`production` or `prod`. No hostname or cloud-metadata guessing.

The invariants, all covered by tests:

* **Never raises into your app.** Internal failures degrade to a no-op plus one
  rate-limited warning per problem per minute. Your own exceptions propagate
  untouched; the only exception GraphMind adds is `Graphmind::AbortError`, and
  only when you asked for it in the viewer.
* **Fails open.** Disconnect, dispose, or interpreter exit releases every held
  gate with `continue`. There is also an optional `pause_timeout:`.
* **Bounded memory.** Events buffer in a ring (2,000 frames / 8 MiB by default,
  drop-oldest) for replay when the debugger attaches. Anything dropped while
  detached is counted and warned about.
* **Local only.** It dials `127.0.0.1`; it never listens, and it opens no port.

---

## Measured overhead

From `test/test_overhead.rb` on the machine this gem was developed on (Apple
Silicon, Ruby 3.3.12) — run it yourself with
`GRAPHMIND_REPORT_OVERHEAD=1 rake test`:

| Path | Cost |
| --- | --- |
| Gate, GraphMind disabled | **0.07 µs** per call |
| Gate, enabled but detached | **0.12 µs** per call |
| Wrapped tool call, disabled (added over the raw call) | **1.0 µs** |
| `emit` while detached (serialize + ring buffer, no socket) | **2.0 µs** |

The tests assert loose ceilings (5 µs / 10 µs / 100 µs) so they catch a
regression in kind — a lock or an allocation creeping onto the fast path —
without failing on a noisy CI box.

---

## The WebSocket client

The gem speaks RFC 6455 itself, over `TCPSocket`, in ~350 lines
(`lib/graphmind/websocket.rb`). That is a deliberate trade:

* **Zero runtime dependencies.** A debugger that you add to someone else's
  Gemfile must not force a resolution on `faraday`, `websocket-driver` or
  `eventmachine`. Dependency conflicts are the number one reason a dev tool
  never gets installed.
* **The client half of RFC 6455 for one local link is small**: one masked text
  opcode, ping/pong, close, and fragment reassembly.
* **Scope, stated plainly**: client role, text frames, `ws://` and `wss://`, no
  `permessage-deflate`, no subprotocol negotiation, no HTTP proxy support.

Because a fake viewer built on the same codec could hide a symmetric bug,
`test/live_server_check.rb` (`rake live`) boots the real Node server
(`graphmind serve`, which uses `ws`) and drives it with this gem end to end —
handshake, ingest, a genuine hold at the server's default pause-on-error
breakpoint, and fail-open when the server is killed.

---

## Verified on

* **Ruby 3.3.12** (arm64-darwin) — the full suite (95 tests, 354 assertions,
  green on four different seeds), the ruby-openai and ruby_llm integrations, the
  Rails 8.1 Railtie, and the live cross-check against the real `graphmind serve`.
* **The built gem**, installed into a clean `GEM_HOME` containing nothing but
  Ruby's default gems, driven against the real server.
* **One real `gpt-4o-mini` call** through the instrumented `ruby-openai` client:
  the `llm:step` node recorded the reply and the provider's own token usage.
* **ruby-openai 8.3.0** and **ruby_llm 1.16.0**.
* **railties 8.1.3.1**.

The gemspec allows **Ruby >= 3.1** because that is the oldest release whose
syntax and stdlib this gem uses (endless methods, argument forwarding,
`io/wait`). **3.1 and 3.2 were not executed** — no other interpreter was
available on the build machine. If you run it there and something breaks, that
is a bug worth filing.

---

## Limitations

* **`after`-gate injection replaces the return value, not side effects.** If
  your tool already wrote to the database, `inject` changes what the caller
  sees, not what happened.
* **ruby_llm streaming deltas are not forwarded** to the canvas yet; the call is
  still gated and recorded. ruby-openai streaming *is* forwarded.
* **ruby_llm's LLM gate hooks a private method** (`provider_completion`) to get
  one node per HTTP round-trip. If a future ruby_llm renames it, the gem falls
  back to `complete_once` and then to the public `complete` (one coarser node
  per turn). The hook actually used is shown on the node as `hook`.
* **No `run.gap` marker.** Events dropped while the debugger was unreachable are
  counted and warned about, but the viewer is not told where the hole was (the
  TypeScript client does send a marker; this gem does not yet).
* **No Anthropic or LangChain.rb integration** — use `Graphmind.tool` /
  `Graphmind.span`, which gate anything.
* **No `Graphmind.ready` equivalent for "wait for a breakpoint"** — `ready`
  waits for the handshake, not for a pause.
* **Fiber-scheduler-based servers** (`async`, Falcon) are correct by
  construction because the context is fiber-local, but were not load-tested.

---

## Development

```sh
bundle install
rake test           # 95 tests, no network beyond loopback
rake live           # cross-check against a real `graphmind serve` (needs Node)
gem build graphmind.gemspec
```

The test suite validates **every emitted envelope** against
`packages/schema/schema.json`, the same wire contract the TypeScript and Python
SDKs are checked against.

## License

MIT. See [LICENSE](LICENSE).
