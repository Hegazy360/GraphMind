# graphmind-ai (Python)

**A live debugger for AI agents.** Phoenix and Langfuse show you what your agent
*did*. GraphMind attaches while it's happening.

Your instrumented app streams execution events over a local WebSocket to the
GraphMind viewer, which renders the run as a live graph — and can **hold
execution**: before an LLM step, before/after a tool call, or on error. From the
viewer you then resume with `continue`, `retry`, `inject` (substitute a result)
or `abort`.

Everything fails open. With no debugger attached the instrumentation is a
no-op measured in *microseconds*; if the debugger disconnects mid-hold, every
held gate auto-continues in under 100 ms.

```
pip install graphmind-ai
```

Then run the viewer (from the [`graphmind-ai` npm CLI](https://www.npmjs.com/package/graphmind-ai)):

```
npx graphmind-ai serve
```

- **Distribution name:** `graphmind-ai` · **import name:** `graphmind`
- Python **3.10+**, one runtime dependency (`websockets`), MIT licensed.
- Wire protocol v1 — byte-identical to the TypeScript client, so Python and
  TypeScript runs render in the same viewer.

---

## 60-second quickstart

```python
import graphmind as gm
from openai import OpenAI

client = gm.instrument_openai(OpenAI())


@gm.tool
def search_flights(origin: str, destination: str) -> list[dict]:
    return [{"flight": "TP1234", "price": 218}]


with gm.run("book-trip"):
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[{"role": "user", "content": "Cheapest VIE -> LIS next Friday?"}],
        tools=[{"type": "function", "function": {"name": "search_flights"}}],
    )
    ...
```

That's it. No config file, no exporter, no collector. Set a breakpoint on
`search_flights` in the viewer, run it again, and execution stops **before the
function body runs** — nothing is in flight, so you can sit on a breakpoint for
as long as you like.

**Sync and async are both first-class.** Most production Python agent code is
synchronous, so nothing here requires an event loop:

```python
async def main():
    async with gm.run("book-trip"):  # same object, `async with`
        await client.chat.completions.create(...)
```

Under the hood the transport lives on one dedicated daemon thread with its own
event loop. Your loop is never touched — no `nest_asyncio`, no
`run_until_complete`, no hijacking — and sync code never needs a loop at all.

---

## Integrations

### OpenAI

```python
import graphmind as gm
from openai import OpenAI, AsyncOpenAI

client = gm.instrument_openai(OpenAI())  # sync
aclient = gm.instrument_openai(AsyncOpenAI())  # async
```

Patches `chat.completions.create` (and `.parse`), and `responses.create`, on the
*instance* — no library monkey-patching, no import hooks. Streaming responses
are teed: your code receives exactly the provider's stream while GraphMind
observes deltas. `tools=[...]` is pre-announced as a `graph.hint` so the viewer
renders the tool roster before anything runs.

### Anthropic

```python
import graphmind as gm
from anthropic import Anthropic

client = gm.instrument_anthropic(Anthropic())

with client.messages.stream(model="claude-sonnet-4-5", max_tokens=1024, messages=[...]) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

Patches `messages.create` (including `stream=True`) and `messages.stream`. For
`messages.stream` the HTTP request happens in `__enter__`, so that is where the
gate holds. The stream proxy observes **both** consumption styles — raw event
iteration and `.text_stream` — and recovers final token usage from the SDK's own
message snapshot either way.

### LangChain / LangGraph

```python
import graphmind as gm

handler = gm.callback_handler()  # sync chains
ahandler = gm.async_callback_handler()  # async chains / LangGraph

result = chain.invoke(payload, config={"callbacks": [handler]})
result = await graph.ainvoke(payload, config={"callbacks": [ahandler]})
```

Chains, LLMs, chat models, tools and retrievers become graph nodes, parented by
LangChain's `parent_run_id`, with token streaming from `on_llm_new_token`.

| LangChain concept | node kind | node id            |
|-------------------|-----------|--------------------|
| chain / runnable  | `chain`   | `chain:<name>`     |
| LLM / chat model  | `llm`     | `llm:<name>`       |
| tool              | `tool`    | `tool:<name>`      |
| retriever         | `retriever` | `retriever:<name>` |

### Plain functions — where `inject` and `retry` really work

```python
@gm.tool
def search_flights(origin: str, destination: str) -> list[dict]: ...


@gm.tool  # async functions stay async
async def fetch(url: str) -> str: ...


tools = gm.wrap_tools({"search": search, "book": book})  # or a list, or one callable
```

### Anything else: spans

```python
with gm.span("plan", kind="chain") as span:  # `async with` too
    plan = build_plan(state)
    span.set_output(plan)
```

Use a span for the parts of a graph GraphMind cannot see by itself — a LangGraph
node body, a hand-rolled planner loop, a retrieval step in your own framework.

---

## Capability matrix

What each attachment point can actually do. This is measured, not aspirational:
every ✅ below is covered by a test in `tests/`.

| | observe | `before` hold | `error` hold | `after` hold | `inject` | `retry` | `abort` |
|---|---|---|---|---|---|---|---|
| `@gm.tool` / `gm.wrap_tools` (sync + async) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gm.span` (sync + async) | ✅ | ✅ | — | — | as span output | — | ✅ |
| OpenAI `chat.completions` / `responses` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic `messages.create` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic `messages.stream` | ✅ | ✅ (in `__enter__`) | ✅ | — | ❌ | ❌ | ✅ |
| LangChain sync handler | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| LangChain async handler | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |

**Why `inject`/`retry` are ❌ for callbacks.** LangChain callbacks are
*observers*: the framework ignores their return value, so nothing in a callback
can substitute a chain's result. GraphMind accepts those actions, warns once,
and treats them as `continue`. To inject or retry a result, wrap the call site —
`@gm.tool` on the tool function, or `gm.span` around the code you want to
replace. Same story for Anthropic's `messages.stream`: GraphMind cannot
fabricate a provider stream object, so it holds and warns rather than lying.

**Holding really holds — verified, not assumed.** Against `langchain_core` 0.3:
sync callbacks are invoked inline by `handle_event` on the executing thread, so
blocking there holds the chain; async callbacks are `await`ed directly by
`ahandle_event`. (A *sync* handler inside an *async* chain is dispatched to the
default executor and still awaited via `asyncio.gather`, so it holds too — at
the cost of parking a thread-pool thread per concurrent run. Prefer
`gm.async_callback_handler()` there.) Both handlers set `raise_error = True` so
an `abort` can terminate the chain; every handler body is fully guarded, so the
only exception that ever escapes is GraphMind's own `GraphMindAbortError`.

---

## API at a glance

| call | what it does |
|---|---|
| `gm.configure(app=..., **opts)` — alias `gm.init` | Create/replace the process-wide instance. |
| `gm.instrument_openai(client)` — alias `wrap_openai` | Gate every OpenAI request; returns the client. |
| `gm.instrument_anthropic(client)` — alias `wrap_anthropic` | Gate every Anthropic request; returns the client. |
| `gm.callback_handler()` — alias `gm.handler` | LangChain `BaseCallbackHandler` for sync chains. |
| `gm.async_callback_handler()` — alias `gm.async_handler` | `AsyncCallbackHandler` for async chains / LangGraph. |
| `@gm.tool` | Gate a function: `tool:<name>` node with inject/retry/abort. |
| `gm.wrap_tools({...})` | Same, for a mapping / list / single callable. |
| `with gm.run("name"):` | Open a run. `async with` works on the same object. |
| `with gm.span("name", kind=...):` | A gated node for anything else. `async with` too. |
| `gm.ready(timeout=2.0)` / `gm.ready_async(...)` | Wait for the handshake. `False` means detached, not an error. |
| `gm.stats()` | Diagnostics: enabled, attached, buffered, dropped, held gates, seq. |
| `gm.dispose()` | Release held gates, flush events, close the socket. |

Every call above also exists as a method on an explicit instance
(`gm.GraphMind(app=...)`), which is what you want when one process debugs more
than one agent.

---

## Node identity

One node per *code location*; executions light it up.

| node | `nodeId` | `instanceId` |
|---|---|---|
| run / agent | `agent:<run name>` | run id |
| provider LLM call | `llm:step` | per call |
| tool call | `tool:<tool name>` | per call |
| LangChain node | `<kind>:<name>` | LangChain `run_id` |
| span | `<kind>:<name>` | per entry |

Every `node.finished` and `node.error` this package emits carries its
`instanceId`, so concurrent executions of the same logical node are never
mis-attributed.

---

## Attaching, and the kill switches

The transport is lazy: it connects on first use with a 300 ms budget, then
retries in the background every 10 s. An agent that starts instantly can
therefore run past its first gate before the handshake lands. When you want
pause guarantees from the very first event:

```python
gm.ready(timeout=2.0)  # blocks; True once breakpoints are armed
await gm.ready_async(timeout=2.0)  # async twin
```

`ready()` never raises. `False` means "carry on detached" — it is not an error.

```python
gm.configure(
    app="support-agent",  # name shown in the viewer
    url="ws://127.0.0.1:4747/ingest",
    meta={"git_sha": SHA},
)
```

| switch | effect |
|---|---|
| `GRAPHMIND_DISABLED=1` | Disabled, always. Beats an explicit `enabled=True` in code. |
| `enabled=False` | Disabled for this instance. |
| production-looking env | Disabled **unless** `GRAPHMIND=1`. |
| `GRAPHMIND_URL` | Overrides the viewer endpoint. |

"Production-looking" is a deliberately boring, documented rule: the **first**
variable that is set out of `GRAPHMIND_ENV`, `ENVIRONMENT`, `APP_ENV`,
`PYTHON_ENV`, `ENV`, `DJANGO_ENV`, `FLASK_ENV`, `NODE_ENV` decides, and it counts
as production when its value is `production` or `prod` (case-insensitive). No
hostname sniffing, no cloud metadata probes — a debugger that turns itself off
for surprising reasons is worse than one you have to switch on.

A disabled session never opens a socket, never allocates a buffer, and never
touches your objects: `instrument_openai` returns the client untouched.

---

## Overhead

Measured by `tests/test_overhead.py` on an M-series laptop (CPython 3.9, 2000
iterations, per call):

| state | overhead per wrapped call |
|---|---|
| disabled (kill switch) | **0.2 µs** |
| enabled but detached | **18 µs** (two envelopes into the replay ring buffer) |
| detached gate check | **0.37 µs** |

The suite asserts budgets of 20 µs / 1 ms / 20 µs respectively, so a regression
that puts real work on the hot path fails CI.

---

## Fail-open guarantees

- **Never raises into your app.** Internal failures degrade to a rate-limited
  warning on stderr and uninstrumented behaviour. Your own exceptions propagate
  untouched.
- **Disconnect auto-continues.** Killing the viewer mid-hold releases every held
  gate with `continue` in well under 100 ms (asserted in
  `tests/test_failopen.py`). Blocked threads also poll every 250 ms as a
  belt-and-braces backstop, so a held gate can never outlive the debugger.
- **Interpreter exit auto-continues.** An `atexit` hook releases held gates, and
  the transport thread is a daemon, so GraphMind can never keep a process alive.
- **Bounded memory.** Events emitted while detached go into a ring buffer
  (default 2000) and are replayed, oldest first with their original `seq`, when
  a viewer attaches — the viewer deduplicates.
- **Bounded payloads.** Prompts, tool arguments and results are depth-, width-
  and length-capped before serialization, so a vision agent's base64 images
  cannot melt the socket. Anything unserializable degrades to a bounded `repr`.
- **`fork()`-safe.** The loop thread is re-created in the child, so pre-forking
  servers (gunicorn, uvicorn workers, Celery) keep working.
- **Ctrl-C works** while a gate is held.

---

## Limitations

- **`inject` / `retry` are unavailable at observer-only attachment points** —
  LangChain callbacks and Anthropic's `messages.stream`. See the capability
  matrix. Wrap the call site to get them.
- **No mid-stream gates.** A streamed response is observed, not pausable, once
  it has started. The gate is at the start of the call (matching the TypeScript
  adapter's documented behaviour for streaming tools).
- **LangChain child-config propagation is LangChain's.** A manual `.ainvoke()`
  made *inside* an async lambda body inherits no run config, so that child
  produces no callbacks — for any handler, not just this one. Compose with `|`
  or pass `config=` explicitly. Pinned by a test so this note stays honest.
- **Thread hand-offs lose the run context.** Run context lives in a
  `contextvars.ContextVar`, which propagates to asyncio tasks but not across a
  bare `ThreadPoolExecutor.submit`. Use `contextvars.copy_context().run(...)`,
  or open a `gm.run(...)` inside the worker.
- **`instrument_*` patches an instance.** Clients created *after* the call are
  not instrumented; call it on each client you build. It is idempotent, so
  calling it twice is safe.
- **Streaming usage needs the provider to send it.** For OpenAI chat streams,
  pass `stream_options={"include_usage": True}` or the node shows no token
  counts.
- **No provider-side timeout neutralization yet.** The TypeScript adapter
  neutralizes SDK `timeout` configs while attached; the Python SDKs' timeouts
  are still live, so a long hold can trip a client-side timeout after the gate
  releases. Remove aggressive `timeout=` settings while debugging.
- **CrewAI / LlamaIndex** are not yet instrumented directly. Both run on top of
  provider clients, so `instrument_openai` / `instrument_anthropic` plus
  `gm.span` already give you a usable graph today.

---

## Development

```
make install     # venv + dev dependencies (editable install)
make test        # pytest
make lint        # ruff check + ruff format --check
make typecheck   # mypy
make check       # all of the above
make build       # wheel + sdist into dist/
make clean
```

The test suite needs **no API keys and no network**: provider calls run through
the real SDKs against an `httpx.MockTransport`, and the only socket is a
loopback WebSocket to a fake viewer that speaks the real protocol. Emitted
frames are validated against `packages/schema/schema.json` — the same artifact
the CLI, the viewer and the TypeScript client are built from.

## License

MIT.
