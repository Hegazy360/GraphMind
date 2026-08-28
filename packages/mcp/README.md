# @graphmind-ai/mcp

In-process instrumentation for **MCP servers written in TypeScript**, for the
[GraphMind](https://graphmind.ai) live agent debugger.

Wrap your `McpServer`; every incoming `tools/call`, `resources/read` and
`prompts/get` — and every `sampling/createMessage` your handlers issue —
becomes a node on a live graph that the debugger can **hold**: pause before the
handler body runs, step, pause on error, and resume with
`continue` / `retry` / `inject` / `abort`.

`inject` is the one to reach for first. Hold a request, type a different
result, and your client receives it — a tool that returns nothing, a resource
that 404s, a model that hallucinates — without editing the server or
redeploying anything.

Everything fails open: with no debugger attached the adapter is a
near-zero-cost no-op, and a debugger that disconnects mid-hold auto-continues
every held gate. It writes **nothing to stdout**, so a stdio server stays a
valid stdio server.

Built by **wrapping**, not patching: `wrapServer` returns a Proxy and your
server object is never mutated, never re-created, and never has a property of
ours written onto it.

## Install

```sh
npm i -D @graphmind-ai/mcp graphmind-ai
```

`@modelcontextprotocol/sdk` is a peer dependency (`>=1.20.0 <2`; the suite runs
against both 1.20.0 and 1.30.0). Run the debugger with `npx graphmind-ai` and
open the viewer at http://127.0.0.1:4747.

## Usage

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { graphmind } from '@graphmind-ai/mcp';
import { z } from 'zod';

const gm = graphmind({ app: 'my-mcp-server' });

// Register on the value wrapServer returns — that is the instrumented view.
const server = gm.wrapServer(new McpServer({ name: 'my-server', version: '1.0.0' }));

server.registerTool(
  'search',
  { description: 'Search the index', inputSchema: { q: z.string() } },
  async ({ q }) => ({ content: [{ type: 'text', text: await search(q) }] }),
);

await server.connect(new StdioServerTransport());
```

That is the whole integration. Nothing else in your server changes: the same
registration calls, the same handler signatures, the same results.

A runnable version is in [`example/stdio-server.mjs`](./example/stdio-server.mjs).

### Options

```ts
graphmind({
  app: 'my-mcp-server',   // shown in the viewer (default: "mcp-server")
  server: { name, version }, // override the `server` node label
  waitForAttach: true,    // connect() waits (<=2000ms) for the debugger, so
                          // breakpoints are armed for request #1
  url: 'ws://127.0.0.1:4747/ingest',   // or GRAPHMIND_URL
  enabled: true,          // GRAPHMIND_DISABLED=1 always wins
});
```

`gm.ready()`, `gm.session` (stats, custom events) and `gm.dispose()` behave
exactly as in the other GraphMind adapters.

### Kill switches

| | |
|---|---|
| `GRAPHMIND_DISABLED=1` | Always off. `wrapServer` becomes the identity function and nothing touches the network. |
| `NODE_ENV=production` | Off unless `GRAPHMIND=1`. |
| `enabled: false` | Off. |
| No debugger running | Detached: events are buffered for replay, gates take the fast path, your server behaves exactly as it would without the adapter. |

## Capability matrix

| MCP surface | Node | `nodeId` | Gates | `inject` substitutes |
|---|---|---|---|---|
| `tools/call` | `tool` | `tool:<name>` | before / after / error | the `CallToolResult` |
| `resources/read` | `resource` | `resource:<registration name>` | before / after / error | the `ReadResourceResult` |
| `prompts/get` | `prompt` | `prompt:<name>` | before / after / error | the `GetPromptResult` |
| `sampling/createMessage` (server → client) | `llm` | `llm:sampling` | before / after / error | the `CreateMessageResult` |
| the server session | `server` | `server:<server name>` | — (structural parent) | — |
| `tools/list`, `resources/list`, `prompts/list`, `completion/complete`, `initialize`, `ping`, logging, elicitation, progress notifications, task-augmented tools | **not instrumented** — forwarded untouched | | | |

Node identity follows the repo convention: `nodeId` is stable per *logical*
node (one node per registration, so a templated resource stays a single node
however many URIs it serves) and `instanceId` is per execution — the JSON-RPC
request id, namespaced by the connection, set on `node.started` **and** on
`node.finished` / `node.error`.

One incoming request = one run, named `tools/call:<name>` (etc.). A connecting
transport gets a small `mcp:connect <server>` run that carries a `graph.hint`
of the whole registered surface, so the viewer can draw your server grey before
any traffic arrives.

### What `inject` accepts

MCP results are typed and the SDK validates them on the way out, so a value
that already looks like the right result shape is passed through untouched, and
anything else is lifted into the smallest valid result that carries it:

| You type | The client receives |
|---|---|
| `{"content": [...]}` | exactly that |
| `"a string"` | `{ content: [{ type: "text", text: "a string" }] }` |
| `{"price": 42}` | `{ content: [text], structuredContent: { price: 42 } }` — so it also satisfies a tool that declares an `outputSchema` |
| (nothing) | `{ content: [] }` |

Resources and prompts get the same treatment against `ReadResourceResult` and
`GetPromptResult`.

### Gates and errors

* **before** — awaited *before your handler is invoked*. A held gate has
  nothing in flight: no side effect has happened and `abort` costs nothing.
* **after** — post-handler, pre-return. Fires on an explicit `after`
  breakpoint (`decisions.md` #2).
* **error** — when your handler throws, *before* the error escapes into the
  SDK. `retry` re-invokes it, `inject` recovers the request, `continue`
  rethrows and the SDK produces its usual `isError` tool result or JSON-RPC
  error. Pause-on-error is armed by default by the CLI.
* **abort** — aborts the run's `AbortController` (which is chained into your
  handler's `extra.signal`) and makes the request terminal.

## `@graphmind-ai/mcp` vs `graphmind mcp-proxy`

Two deliberately different shapes. The proxy (`graphmind mcp-proxy -- <cmd>`)
is a stdio man-in-the-middle that debugs a server in **any** language with
**zero** code changes; this package instruments a server **you own and can
edit**, in TypeScript, from the inside.

| | `@graphmind-ai/mcp` | `graphmind mcp-proxy` |
|---|---|---|
| Code changes to the server | 3 lines | none |
| Server language | TypeScript / JavaScript | any |
| Transport | any — it wraps the server, not the transport (verified on stdio, Streamable HTTP and in-memory) | stdio only |
| Extra process | none | one (the proxy) |
| Where a gate sits | inside the process, after routing/validation, **before your handler body runs** | at the protocol boundary, before the frame reaches the server |
| What it sees of a request | the *parsed, validated* arguments the handler receives | the raw JSON-RPC frame |
| Sampling issued by a handler | its own gated `llm` node, nested under the request that issued it | visible as frames, not attributable to a handler |
| Resource identity | one node per registration (templates stay one node) | one node per concrete URI |
| A server you did not write | ✗ | ✓ |
| Works with no debugger running | ✓ (fast-path no-op) | ✓ (transparent relay) |

**Use the proxy when** you did not write the server, it is not TypeScript, you
cannot or will not edit it, or you want to debug the exact bytes on the wire.
It is the higher-value tool for most people and the right first thing to try.

**Use this package when** you own the server and want handler-level detail:
gating on the validated arguments, sampling nested under the request that
issued it, resource templates as single nodes, and gates on a server that does
not speak stdio at all.

They are not exclusive — a server instrumented with this package still works
behind the proxy; you just get two views of the same traffic.

## Honest limitations

* **Only what you register on the wrapped object is instrumented.** Register on
  the value `wrapServer` returns. Anything registered directly on the original
  object (or before wrapping) runs uninstrumented.
* **Task-augmented tools** (`registerToolTask`, handlers with a `createTask`
  method) are passed through untouched.
* **`elicitInput` and `completion/complete` are not instrumented.** Sampling is
  the only server→client request this adapter models.
* **A hold can outlive the client's patience.** MCP clients cancel requests
  that exceed their timeout (the SDK default is 60s). The server resumes
  correctly and the run completes in the viewer, but the client has already
  given up on that request. No in-process debugger can change that; the adapter
  warns once the first time a gate holds for more than a second.
* **The low-level `Server` path names resources by URI.** With
  `setRequestHandler(ReadResourceRequestSchema, ...)` there is no registration
  to name the node, so `resources/read` produces one node per concrete URI.
  `McpServer`'s `registerResource` does not have this problem.
* **The `server` node's label** comes from the `{ name, version }` you gave the
  SDK's server, read defensively off the SDK object; if that ever stops working
  it falls back to your `app` name (or pass `server: { name }`).
* **Verified peers**: 1.20.0 and 1.30.0. The range in between is declared, not
  tested; the adapter never imports the SDK and only duck-types the six
  registration methods, `connect`, `.server`, `setRequestHandler` and
  `createMessage`.

## Testing

```sh
pnpm --filter @graphmind-ai/mcp test
```

The suite builds **real** MCP servers with the SDK and drives them with a
**real** MCP client over the SDK's in-memory transport pair — tools, resources,
templated resources, prompts, zero-argument tools, sampling, throwing handlers,
concurrent requests with independent gates, disconnect auto-continue, detached
overhead, stdout purity, a hand-rolled low-level `Server`, a Streamable HTTP
server over a real `node:http` listener, and the same gate-and-inject story
again on SDK 1.20.0.

There is also an end-to-end smoke that wires up the real pieces — the
`graphmind` server, a real stdio MCP server (`example/stdio-server.mjs`) and a
real MCP client — and arms breakpoints over the viewer's own WebSocket:

```sh
pnpm --filter graphmind-ai build && pnpm --filter @graphmind-ai/mcp build
pnpm --filter @graphmind-ai/mcp e2e
```

## License

MIT
