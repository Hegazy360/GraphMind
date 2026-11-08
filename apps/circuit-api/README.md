# circuit-api

The GraphMind Circuit control plane: a Hono app factory (`createApi`) over an
`Executor`. Routes (v1): enqueue runs, list/inspect runs + journals, deliver
events, resume/approve/fork/cancel, breakpoints, fixture export, deploy
check. Optional bearer-key auth; `x-circuit-actor` names the human behind
every intervention for the audit trail. Errors are RFC 9457 problem+json.
Serves both `circuit dev` and (behind real auth/tenancy) the hosted service.
