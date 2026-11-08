# @graphmind-ai/circuit-cli

`circuit` — the GraphMind Circuit CLI.

```
circuit dev     --workflows workflows.mjs [--mcp circuit.mcp.json]
                                            # engine + API + dashboard on 127.0.0.1:4810, SQLite in .circuit/
                                            # hot-reloads the workflows file on save
circuit runs                                # list runs
circuit show    <runId>                     # run + full journal
circuit resume  <runId> <seq> <action> [--output '<json>'] [--reason ...] [--actor you@team]
circuit record  <runId> --out circuit.fixtures/name.json
circuit test    --workflows workflows.mjs   # replay every fixture; fail on divergence/regression
circuit check   --workflows workflows.mjs   # deploy check: would this code break in-flight runs?
circuit import  n8n|pipedream export.json   # generate a Circuit skeleton from an n8n/Pipedream export
circuit mcp pull  --mcp circuit.mcp.json    # generate circuit.mcp.d.ts (typed ctx.mcp calls)
circuit mcp serve                           # expose workflows as MCP tools on stdio (protocol 2026-07-28)
```

`--workflows` takes any module exporting `workflow({...}, fn)` definitions
(TypeScript imports natively on Node ≥ 23.6). Try it:
`cd examples/circuit-onboarding && pnpm dev`.
