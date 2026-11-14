# circuit-api

The GraphMind Circuit control plane: a Hono app factory (`createApi`) over an
`Executor`. Routes (v1): enqueue runs, list/inspect runs + journals, deliver
events, resume/approve/fork/cancel, breakpoints, fixture export, deploy
check. Optional bearer-key auth; `x-circuit-actor` names the human behind
every intervention for the audit trail. With `accounts`
(`@graphmind-ai/accounts`, `circuit dev --accounts`) `/v1` needs a session or
a personal token and the actor is the signed-in account's email, overriding
the header; `GET /health` stays public. Errors are RFC 9457 problem+json.
Serves both `circuit dev` and (behind real tenancy) the hosted service.
