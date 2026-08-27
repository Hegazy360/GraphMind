# live-check — the mock-vs-reality suite

Every other test in this repo runs the adapters against **mocked HTTP and mock
models**. `live-check` runs them against the **real Anthropic and OpenAI APIs**,
a **real `graphmind-ai` server** (ephemeral port, throwaway SQLite file), and a
**real headless debugger** speaking the viewer's own `/ws/ui` subprotocol.

Private, never published, not part of `pnpm test`.

```sh
set -a; . ./.env.local; set +a          # ANTHROPIC_API_KEY / OPENAI_API_KEY
pnpm --filter live-check start

pnpm --filter live-check start -- --only=openai-chat,langgraph
pnpm --filter live-check start -- --list
```

With **no keys** it prints why and **exits 0**, so CI can run it
unconditionally. (Keys are also picked up from the repo-root `.env.local` when
they are not exported; `--no-env-file` turns that off.)

## What it covers

| suite | adapter | model | driven through |
|---|---|---|---|
| `anthropic` | `@graphmind-ai/anthropic` | `claude-haiku-4-5` | streamed `messages.create` + `tool_use` loop |
| `openai-chat` | `@graphmind-ai/openai` | `gpt-4o-mini` | streamed `chat.completions.create` + `tool_calls` loop |
| `openai-responses` | `@graphmind-ai/openai` | `gpt-4o-mini` | streamed `responses.create` + `function_call` loop |
| `ai-sdk` | `@graphmind-ai/sdk` | `gpt-4o-mini` via `@ai-sdk/openai` | `streamText` with `stopWhen: stepCountIs(4)` |
| `langgraph` | `@graphmind-ai/langgraph` | `gpt-4o-mini` via `@langchain/openai` | a real `StateGraph` + `ToolNode` loop through `gm.config()` |

Every suite runs the same five scenarios against a real model:

1. **core** — a genuine multi-turn tool-calling agent: node graph
   (agent → llm steps → tools) with parentage and instanceIds, streamed
   `node.token` deltas reconstructed **byte-for-byte** against the text the
   model really produced, real non-zero usage on `node.finished`, a
   **multi-second hold** with **zero provider HTTP requests during the hold**
   (measured out of band by a global `fetch` probe), and **parallel real tool
   calls holding their gates simultaneously**.
2. **pause-on-error + inject** — a tool that really throws, an injected value
   that must land in the **next real provider request** and in the model's
   answer.
3. **abort** — a real streaming request is cancelled mid-flight.
4. **detached overhead** — dispatch latency of a real call, wrapped-and-detached
   vs raw.
5. **fail-open** — the debugger is **killed while holding a gate** and the real
   agent still finishes.

## Why a `fetch` probe

"The gate held, so nothing was in flight" is the product's central claim, and
only an out-of-band observer can prove it. `harness/probe.ts` wraps
`globalThis.fetch` — which every adapter under test ultimately dispatches
through — and records the monotonic start time of every provider request.
A hold then has a hard assertion: *zero* requests to `api.anthropic.com` /
`api.openai.com` started inside the hold window, and the first one started after
the gate was released. GraphMind's own transport is a WebSocket, so it never
shows up in the probe.

The Anthropic and OpenAI suites sharpen this further: the request carries a
**5-second SDK timeout** and the gate is held for **6 seconds**. If the SDK's
timer started when `create()` was called, the call would fail; it does not,
because the gate is awaited before the SDK method is ever invoked
(`internal/decisions.md` #3).

## Cost

Cheap models, small `max_tokens`, ~35 real requests for a full run — well under
a cent of tokens. The run prints the token totals **GraphMind itself recorded**
(summed from the `usage` field of every `node.finished` the debugger received),
which doubles as a self-check that usage reporting works.
