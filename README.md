# GraphMind

**The debugger for AI agents. Attaches while it's happening.**

Observability tools show you what your agent did. GraphMind attaches to a run
while it executes: watch the graph light up live, pause on error, set
breakpoints, step through, inspect every input and output — then fix and resume.

- **Local-first** — `npx graphmind-ai` opens the viewer; your traces never leave your machine
- **Live attach, not post-hoc** — pause-on-error, breakpoints, step, inspect, inject-and-continue
- **The graph is a projection of your code** — GraphMind never authors your workflow, it reveals it
- **MIT licensed**

> 🚧 GraphMind is being rebuilt from the ground up. First release: Vercel AI SDK
> live integration + generic OpenTelemetry/OpenInference trace import.
> Watch this repo or join the waitlist at [graphmind.ai](https://graphmind.ai).

## Repository layout

| Path | What it is |
|---|---|
| `packages/schema` | Versioned event/trace schema (zod + JSON Schema) — the contract community adapters target |
| `packages/client` | SDK-side runtime: transport, pause/gate engine, fail-open logic |
| `packages/ai-sdk` | Vercel AI SDK adapter (model middleware + tool wrapping) |
| `packages/cli` | `graphmind` CLI: local server, storage, importer, MCP server, viewer host |
| `apps/viewer` | The graph debugger UI |
| `apps/web` | graphmind.ai |
| `examples/` | Demo agents and spikes |

## License

MIT
