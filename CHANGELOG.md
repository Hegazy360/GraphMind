# Changelog

All notable changes to GraphMind. Versions are shared across every package in
this repo (`graphmind-ai`, `@graphmind-ai/sdk`, `@graphmind-ai/client`,
`@graphmind-ai/schema`, `@graphmind-ai/anthropic`, `@graphmind-ai/openai`,
`@graphmind-ai/langgraph`, and the Python `graphmind-ai` distribution).

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
