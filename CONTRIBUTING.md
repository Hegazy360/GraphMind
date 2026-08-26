# Contributing

GraphMind is a small, deliberately scoped project. The most useful
contributions are adapters for frameworks it does not cover yet, and honest bug
reports from real agent code.

## Getting set up

```sh
git clone https://github.com/Hegazy360/GraphMind.git
cd GraphMind
pnpm install
pnpm -r --filter './packages/**' build   # packages must build before typecheck
pnpm typecheck && pnpm test
```

Node >= 22.13 (SQLite is built in, so there is nothing to compile).

Useful loops:

```sh
pnpm --filter viewer dev                 # the debugger UI, with ?fixture=1 for a canned run
pnpm --filter docs dev                   # the documentation site
node packages/cli/dist/cli.js demo       # the real CLI, replaying the bundled session
pnpm --filter e2e-smoke e2e              # full-stack check against a running server
```

## Writing an adapter

This is the highest-leverage contribution, and the protocol is small on
purpose. An adapter has one job: turn a framework's execution into GraphMind
envelopes, and `await` the gate where the framework lets you hold execution.

1. Read [`packages/schema`](./packages/schema) — the versioned wire contract
   (Zod schemas plus a generated `schema.json`). Every event an adapter emits
   is defined there.
2. Read [`packages/ai-sdk`](./packages/ai-sdk) as the reference implementation,
   and [`packages/client`](./packages/client) for the runtime you build on:
   transport, ring buffer, gate engine, run context, fail-open logic. Never
   reimplement those.
3. Keep the three invariants:
   - **Fail open.** No debugger attached means a synchronous no-op. A debugger
     that disconnects mid-hold releases every gate.
   - **Never throw into the host.** An adapter bug must not break someone's
     agent. Wrap every boundary.
   - **The graph is a projection of the user's code.** One node per logical
     code location (`tool:searchFlights`, `llm:step`), one instance per
     execution. Adapters observe; they never author.
4. Tests run without API keys. Script the provider's HTTP layer (most SDKs
   accept a custom `fetch`) and point the client at a fake debugger WebSocket
   server — see `packages/ai-sdk/test/helpers/`.

Adapters in other languages are welcome: the protocol is JSON over a local
WebSocket, and [`python/`](./python) shows what a non-TypeScript port looks
like.

## Pull requests

- Keep changes small and focused; a PR that does one thing gets merged.
- Add tests that would fail without your change.
- `pnpm typecheck && pnpm test` must pass (CI runs Linux, Windows and macOS on
  Node 22 and 24).
- Match the surrounding style. Comments explain *why*, not *what*.
- Do not add dependencies without a reason that survives a second reading.

## Reporting bugs

Include the framework and version, what you expected, what happened, and
ideally a recorded run: `graphmind record <runId> --out bug.ndjson` produces a
replayable file you can attach (check it for anything sensitive first, it
contains your prompts and tool payloads).

## Scope

Things GraphMind deliberately does not do: hosted services, eval or
prompt-management platforms, visual workflow authoring, per-execution billing.
Proposals in those directions will be declined — not because they are bad
ideas, but because staying small is what keeps this maintainable.

By contributing you agree your work is licensed under the MIT License.
