# @graphmind-ai/circuit-mcp

GraphMind Circuit's MCP layer, built on the v2 MCP SDK
(`@modelcontextprotocol/client` / `server`, protocol 2026-07-28 with
negotiation fallback). Two directions:

**MCP servers as workflow steps.** `McpConnections` implements the engine's
`McpGateway`: `ctx.mcp('billing').call('refund', {...})` is a journaled,
gated step with retries, pause-on-error, replay and fork — plus per-tool
policy (`allow` / `approve` / `deny`), trust-on-first-use **tool pinning**
(a changed tool definition pauses calls until a human re-approves), and
returned-`isError` results treated as step failures. `generateDeclarations`
powers `circuit mcp pull`, which types `ctx.mcp(...)` calls from the
servers' real schemas.

**Workflows as MCP tools.** `createWorkflowMcpServer` exposes every workflow
on a Circuit server as `run_<name>` (plus `get_run`) over stdio via
`circuit mcp serve` — tool listings are dynamic, so dev-reloaded and
scaffolded workflows appear without a restart.
