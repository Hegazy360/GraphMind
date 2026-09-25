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

`.with_raw_response.create(...)` and `.with_streaming_response.create(...)` are
covered too, whether you touched them before or after instrumenting: one node
per call, and your code still gets the SDK's own raw response object. With
`stream=True`, the event stream that `.parse()` returns is teed, so text and
final usage land on the node. For `with_streaming_response` the request (and the
`before` gate) happens in `__enter__`.

An `inject` comes back as the type the call returns — `ChatCompletion`,
`ParsedChatCompletion` or `Response` — not a dict. In the viewer, type either a
bare string (it becomes a one-message assistant reply) or an object with that
type's fields; missing ids, timestamps and the `model` are filled in. For
`chat.completions` a bare message such as `{"content": "..."}` or
`{"tool_calls": [...]}` works too. A payload that cannot be rebuilt is handed
back unchanged, with one warning.

### Anthropic

```python
import graphmind as gm
from anthropic import Anthropic

client = gm.instrument_anthropic(Anthropic())

with client.messages.stream(model="claude-sonnet-4-5", max_tokens=1024, messages=[...]) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

Patches `messages.create` (including `stream=True`), `messages.parse` and
`messages.stream`, and the same three on `beta.messages`. For `.stream` the HTTP
request happens in `__enter__`, so that is where the gate holds. The stream
proxy observes **both** consumption styles — raw event iteration and
`.text_stream` — and recovers final token usage from the SDK's own message
snapshot either way. An `inject` comes back as a `Message` (`BetaMessage` on
`beta.messages`, the `Parsed*` type from `.parse`), built from a string or an
object with the type's fields; its `usage` is zero unless you give one.

### Agent frameworks: OpenAI Agents SDK, Pydantic AI

These frameworks build on the provider SDKs, so you instrument the client and
hand it to the framework.

```python
import graphmind as gm
from agents import set_default_openai_client
from openai import AsyncOpenAI

# OpenAI Agents SDK: it builds its own AsyncOpenAI unless you set a default.
set_default_openai_client(gm.instrument_openai(AsyncOpenAI()))
```

```python
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.openai import OpenAIProvider

# Pydantic AI: pass an instrumented client to the provider, and the provider
# to your model as usual.
openai_provider = OpenAIProvider(openai_client=gm.instrument_openai(AsyncOpenAI()))
anthropic_provider = AnthropicProvider(anthropic_client=gm.instrument_anthropic(AsyncAnthropic()))
```

What GraphMind's test suite proves is the client side, not the frameworks, which
it does not install. The calls these frameworks make are recorded and gated,
and an `inject` returns the type they read:

| Framework path | Client call | Tested |
|---|---|---|
| Agents SDK `Runner.run` | `responses.create` | node, gates, typed `Response` inject |
| Agents SDK `Runner.run_streamed` | `responses.with_streaming_response.create(stream=True)`, read via `.parse()` | node with text + usage, `before` gate in `__enter__`, one node per call in either access order |
| Pydantic AI, OpenAI models | `responses.create` / `chat.completions.create` | node, gates, typed `Response` / `ChatCompletion` inject |
| Pydantic AI, Anthropic models | `beta.messages.create`, with and without `stream=True` | node, gates, typed `BetaMessage` inject |

Inject into non-streamed runs (`Runner.run`, `agent.run`); see
[Limitations](#limitations) for streamed ones. Tool calls these frameworks make
are not nodes by themselves.

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
from functools import partial


@gm.tool
def search_flights(origin: str, destination: str) -> list[dict]: ...


@gm.tool  # async functions stay async
async def fetch(url: str) -> str: ...


tools = gm.wrap_tools({"search": search, "book": book})  # or a list, or one callable

# functools.partial is a normal way to bind per-run state, and it works:
# the node is named after the function underneath -> `tool:load_region`.
load_eu = gm.tool(partial(load_region, "eu"))
load_us = gm.tool(partial(load_region, "us"), name="load_us")  # ...unless you say otherwise
```

The node name is the callable's `__name__`. A `functools.partial` has none, so
the name comes from the function it wraps; an instance of a class with
`__call__` is named after its class. Two partials of the same function are
therefore *one* node — same code location — which is usually what you want; pass
`name=` (or a key in `wrap_tools({...})`) when you want them apart.

#### Edit the arguments and run the real call (0.6)

When a `@gm.tool` / `gm.wrap_tools` call is held, the debugger can **fix its
arguments and run the real function** with them: *Edit arguments* in the viewer
on a `before` pause (then `continue`), or on an `after` / `error` pause (then
`retry`); or `graphmind resume <pauseId> --run <id> --action continue --input
'{"limit": 5}'` from a terminal (the server needs `--allow-control=edit`).

- The edit is an object whose **top-level keys replace** the call's arguments,
  as the node records them (`{parameter: value}`, defaults applied); every key it
  does not mention keeps its **live** value — the real object, not the recorded
  copy (which may be a `repr` or truncated).
- It is checked against the function's **signature**, on your own thread (or
  task, for `async def`), before anything runs: every key must be a parameter,
  every required parameter present, `*args` a list, `**kwargs` an object. A
  refused edit comes back to the debugger as `exec.refused` (a short message that
  never quotes values) and **the call stays paused** — fix it and try again.
  Types are the function's business: if it raises, the `error` gate holds.
- The accepted edit stays the call's arguments for later attempts: a plain
  `retry` re-runs it. The node's recorded input (and the loop fingerprint) keep
  what your code passed; `exec.resumed.edited.after` records what ran.
- Refused whatever they look like: a value holding `"__REDACTED__"` or a
  truncated preview (the shrink's marker, `…[truncated]`, `<N bytes>`,
  `…[N more]` — what this SDK records for long or binary values), and
  `__proto__` / `constructor.prototype` keys. The same guard applies to an
  injected result, under every debugger version.
- Under `GRAPHMIND_HIDE_INPUTS` (or `GRAPHMIND_HIDE_TOOL_ARGS`) the debugger
  never saw the live arguments, so only a **full replacement** is accepted, and
  the refusal message and the recorded edit are hidden too.
- `GRAPHMIND_DISABLE_EDIT_INPUT=1` turns edits off in this app (any value but
  empty, `0`, `false`, `off`, `no`). LLM calls are never editable.

Your own gate can take edits too — `session.gate(point, node, editable=True,
validate_input=lambda proposed, context: gm.merge_tool_input(live, proposed,
context))` — the validator runs on the thread (or task) blocked in the gate,
must answer within 4 s (synchronous work included), and gets
`context.input_hidden`, which `merge_tool_input` honours.

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

| | observe | `before` hold | `error` hold | `after` hold | `inject` | `retry` | `abort` | edit arguments |
|---|---|---|---|---|---|---|---|---|
| `@gm.tool` / `gm.wrap_tools` (sync + async) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gm.span` (sync + async) | ✅ | ✅ | — | — | as span output | — | ✅ | — |
| OpenAI `chat.completions` / `responses` | ✅ | ✅ | ✅ | ✅ | ✅ typed | ✅ | ✅ | — |
| OpenAI `with_raw_response` / `with_streaming_response` | ✅ | ✅ | ✅ | ✅ | ✅ typed, via `.parse()` | ✅ | ✅ | — |
| …the same with `stream=True` | ✅ | ✅ | ✅ | — | ❌ | ✅ | ✅ | — |
| Anthropic `messages.create` / `beta.messages.create` | ✅ | ✅ | ✅ | ✅ | ✅ typed | ✅ | ✅ | — |
| Anthropic `messages.stream` / `beta.messages.stream` | ✅ | ✅ (in `__enter__`) | ❌ | — | ❌ | ❌ | ✅ | — |
| LangChain sync handler | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| LangChain async handler | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |

**Why `inject`/`retry` are ❌ for callbacks.** LangChain callbacks are
*observers*: the framework ignores their return value, so nothing in a callback
can substitute a chain's result. GraphMind accepts those actions, warns once,
and treats them as `continue`. To inject or retry a result, wrap the call site —
`@gm.tool` on the tool function, or `gm.span` around the code you want to
replace. Same story for Anthropic's `messages.stream` and for raw-response calls
made with `stream=True`: GraphMind cannot fabricate a provider stream object, so
it holds, warns and continues with the real call rather than lying.

**"typed"** means the injected value comes back as the SDK type the call
returns (`ChatCompletion`, `Response`, `Message`, ...), so a framework that
reads `.output`, `.usage` or `.content`, or checks `isinstance`, keeps working.

**Holding really holds — verified, not assumed.** Against the `langchain_core`
the suite installs (1.6 at the time of writing; the floor is 0.3):
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

## Recording less, and the loop hold (0.5)

**Recording less.** Four kill switches replace values with `"__REDACTED__"` inside the SDK, before the
event is buffered or sent, so a debugger that attaches late, the database and every export only ever
see the placeholder. Set them in the environment of the instrumented app, or as options:

```python
gm.configure(hide_inputs=True, hide_outputs=True, hide_tool_args=True, hide_tool_results=True)
```

| Switch | Replaces |
| --- | --- |
| `GRAPHMIND_HIDE_INPUTS` / `hide_inputs` | every node's `input`; streamed tool-argument deltas are emptied |
| `GRAPHMIND_HIDE_OUTPUTS` / `hide_outputs` | every node's `output`; every streamed delta is emptied (`v: ""`, `chars` kept) |
| `GRAPHMIND_HIDE_TOOL_ARGS` / `hide_tool_args` | tool nodes' `input` only |
| `GRAPHMIND_HIDE_TOOL_RESULTS` / `hide_tool_results` | tool nodes' `output` only |

Any env value except empty, `0`, `false`, `off` and `no` (any case) turns a switch on — an unexpected spelling such as `yes` errs towards hiding; options accept `True`, `1` and the same strings. Either source turning a
switch on turns it on — `hide_inputs=False` cannot switch off `GRAPHMIND_HIDE_INPUTS=1`. Affected events
carry `redaction: {count, keys}`. Works for `@gm.tool`, spans, the OpenAI/Anthropic instrumentation
(streamed tokens included) and the LangChain handler.

**The loop hold.** While a debugger is attached, the third call of the same tool with identical
arguments made **back-to-back** — no other tool call in between — is held before it runs (`exec.paused` with `reason: "loop"` and `loop: {repeats,
firstSeq, lastSeq, fingerprint}`). Continue runs it (the next identical call is held again), Inject
substitutes a result (through the LangChain callback it degrades to continue), Abort raises
`GraphMindAbortError`; a retry does not hold twice. Detached, or with `GRAPHMIND_ON_LOOP=warn`, nothing
is held and one line per streak is logged, naming the tool but never its arguments.

```python
gm.configure(loop_guard={"threshold": 5, "mode": "warn", "allow_nodes": ["poll_job"]})  # or loop_guard=False
```

Back-to-back is per run: calling any other tool, or the same tool with other arguments, starts the
count again, while LLM steps in between do not (model → tool → model → tool with identical calls is
still a loop) and tools in `allow_nodes` / `GRAPHMIND_LOOP_ALLOW` are invisible. So a constant-argument
tool called now and again across a long session is never held. Accepted limit: an agent alternating
between two tools (search, read, search, read) is not held.

Env: `GRAPHMIND_LOOP_THRESHOLD` (default 3, `0` off), `GRAPHMIND_ON_LOOP=pause|warn|off`,
`GRAPHMIND_LOOP_ALLOW=poll_job,tool:heartbeat`. Each field is option first, then env, then default;
`allow_nodes` and `ignore_keys` replace their defaults. "Identical" means canonical JSON: keys sorted,
`1.0 == 1`, MCP's `_meta` ignored, pagination keys not ignored; Pydantic models compare by
`model_dump()`, sets are order-independent, other objects by `repr()`. An argument whose conversion
raises is never counted as a repeat. Under `hide_inputs` (or `hide_tool_args` on a tool) the fingerprint
is sent as `"__REDACTED__"`. Loop holds obey `pause_timeout` and are released if the debugger disconnects.

**Limits.**
- `node.error` (exception messages and tracebacks) is never redacted — error text can echo data.
- Redaction fails closed: if a payload cannot be inspected safely while a switch is on (a mapping whose
  reads raise, a malformed payload), the event is sent with input/output/token text hidden and
  `redaction.failed: true`, or dropped with one warning if even its identity fields are unreadable. The
  raw value is never sent and nothing is raised into your app.
- The tool-only switches hide the tool node's own input/output. In an agent loop the same values also
  travel through the model's messages; set `GRAPHMIND_HIDE_INPUTS` and `GRAPHMIND_HIDE_OUTPUTS` to keep
  them out entirely.
- Hidden streamed text keeps its length (`chars`, counted in UTF-16 units like JavaScript).
- Tools that legitimately poll with byte-identical arguments need `allow_nodes` or `GRAPHMIND_LOOP_ALLOW`.
- LLM steps are not watched unless `kinds` includes `"llm"` (each kind keeps its own streak); identical
  calls made in parallel are back-to-back too, so they count.
- Cross-language equivalence is guaranteed for JSON-shaped arguments and checked against the TypeScript
  client by two shared fixtures and a generated differential file.

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
| `GRAPHMIND_DISABLE_EDIT_INPUT=1` | [Edits](#edit-the-arguments-and-run-the-real-call-06) are not announced and every edit is refused (any value but empty, `0`, `false`, `off`, `no`). |

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

Measured by `tests/test_overhead.py` — median of seven runs on an Apple-silicon
laptop, **CPython 3.13.15**, 2 000 iterations per wrapped call and 20 000 for
the bare gate check. CPython 3.12.14 lands within run-to-run noise of these
numbers; anything below 3.10 is unsupported and untested.

| state | overhead per wrapped call |
|---|---|
| disabled (kill switch) | **0.09 µs** |
| enabled but detached | **9.5 µs** (two envelopes into the replay ring buffer) |
| detached gate check | **0.12 µs** |

Reproduce them yourself: `make install && .venv/bin/python -m pytest
tests/test_overhead.py -s` prints exactly the lines above. (If your default
`python3` predates 3.10, point the venv at a supported interpreter —
`make install PY=python3.13`.)

The suite asserts budgets of 20 µs / 1 ms / 20 µs respectively — deliberately
loose, because CI runners are noisy — so a regression that puts real work on the
hot path fails CI without the budgets flapping on a slow machine.

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
- **`inject` cannot produce a stream.** On a plain `stream=True` call your
  payload is handed back as-is (code that iterates it gets no chunks); on a
  `with_raw_response` / `with_streaming_response` call with `stream=True` —
  the OpenAI Agents SDK's `Runner.run_streamed` — it is treated as `continue`.
  Both warn once. Inject on a non-streamed call.
- **A raw-response stream is observed through `.parse()`.** Read the body as
  bytes or lines instead (`iter_bytes()`, `iter_lines()`) and the node still
  starts, holds and finishes, but carries no text or usage.
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

## Not ours: the `GeneratorExit` traceback at loop shutdown

If you stream from `AsyncOpenAI`, you may see this printed *after* your program
has finished, on the way out of `asyncio.run(...)`:

```
an error occurred during closing of asynchronous generator
<async_generator object PoolByteStream.__aiter__ at 0x…>
  File ".../httpcore2/_async/http11.py", line 313, in __aiter__
    yield chunk
GeneratorExit
...
RuntimeError: generator didn't stop after athrow()
```

It looks alarming and it names none of your code, so it is easy to blame the
debugger. **It is not GraphMind.** `openai>=3` ships `httpcore2`, whose
connection-pool async generator is still open when `asyncio.run` calls
`loop.shutdown_asyncgens()`; the generator re-raises while being thrown into,
and `contextlib` reports that. Verified on CPython 3.12.14 and 3.13.15 with
`openai` 3.5.0 / `httpcore2` 2.12.0: the same traceback appears, unchanged,
with GraphMind attached, with `GRAPHMIND_DISABLED=1`, and with GraphMind not
installed at all. The exit code is 0 and your response arrived in full.

The workaround is to give the pool one real tick to finalize itself before the
loop closes:

```python
async def main() -> None:
    client = gm.instrument_openai(AsyncOpenAI())
    try:
        ...
    finally:
        await client.close()
        await asyncio.sleep(0.05)   # let httpcore2 finalize its own generator

asyncio.run(main())
```

`await asyncio.sleep(0)` is **not** enough — measured; a zero-length sleep still
leaves the traceback. Any small non-zero sleep clears it (1 ms was enough here);
the `python-analyst` sample uses 0.25 s for margin.

GraphMind adds nothing to that shutdown path of its own: the stream tee is a
plain class-based proxy, never an `async def … yield` generator, so
`shutdown_asyncgens()` has nothing of ours to finalize (pinned by
`tests/test_openai.py::test_the_async_tee_adds_no_async_generator_to_your_loop`).
GraphMind's own transport lives on a separate daemon thread with its own loop
and is never touched by your loop's shutdown.

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
