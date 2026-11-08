# Hosted Workflow Platform — Implementation Plan & Specs

> Status: v3 (M0–M4 built) · 2026-11-08 · service name **Circuit** (GraphMind Circuit)
> DECIDED: Circuit is a new **service under the GraphMind brand, in this repo**, MIT like the
> rest. GraphMind the debugger stays local-first; Circuit is the hosted workflow service.
> Name rationale: fits the graph/node brand; a circuit runs, can be traced, and has breakers —
> which is what our pause gates are. A service name, changeable later.
>
> Resolved decisions (2026-11-08): same repo/brand · TypeScript-only v1 · runner designed for
> strong isolation from day one (interface now, process isolation in-session, microVMs hosted) ·
> MIT license, with care that no credentials/infra secrets ever land in the repo.

---

## 0. Positioning (what we build and why)

**One line:** the durable workflow platform with a flight recorder — workflows are TypeScript
code, every run is recorded, and any run can be paused, inspected, patched, resumed, replayed
and turned into a test.

**For:** engineering teams who outgrew n8n (no git, no tests, fragile at scale) or bounced off
Temporal (determinism rules, workers, no connectors, no visual surface).

**The four pillars (priority order):**

| # | Pillar | Competitor weakness it exploits |
|---|---|---|
| P1 | **Live fix-and-resume** — failing steps pause durably; inspect, edit input / inject output / retry / skip / abort; audit-logged | Everyone else: "retry from scratch or dead-letter" |
| P2 | **The journal is the recording** — deterministic replay against new code, fork-from-step "what-if", recordings as CI regression tests | Temporal: deploy-time non-determinism landmines, no official TTD. Vercel and Cloudflare V2 now have replay, so **the edge is the deploy check, fixtures in git, and fork-with-substitution**, not replay alone |
| P3 | **MCP-native connectors** with brokered auth, tool pinning, per-tool policy; every workflow is itself an MCP tool | n8n/Zapier sunk cost in proprietary catalogs |
| P4 | **Behavior analysis on recordings** — loops, waste, tool health, cost per step, failure clusters | Observability tools watch but can't act |

**Non-goals (v1):** business-user no-code builder; visual canvas as source of truth; bespoke
connector catalog; multi-language SDKs (TS only, Python later); self-serve BYOC.

### 0.1 Verified market facts (fact-check pass, 2026-11-07) and what they change

| Fact | Effect on this plan |
|---|---|
| **Vercel Workflow is GA** (since Apr 16 2026: TS, open SDK, `"use workflow"`) and already advertises "pause, replay, time travel". **Cloudflare Workflows V2** (May 2026) added deterministic replay and step debugging. DBOS advertises time-travel debugging. | **"Replay" and "time travel" are no longer ours to claim.** The open lane is narrower: **changing a live production run** (inject a value, edit an input, apply one fix to many runs) and resuming it, with governance, **not tied to one cloud**, with an open core. Lead with P1 and the deploy check, not with "replay". |
| **AWS Lambda Durable Functions** (Dec 2025), Cloudflare, Vercel: durable workflows are now built into the clouds. Temporal Cloud is $50/M Actions pay-as-you-go with no minimum. | Durability alone is a commodity. Pricing must be simpler than $50/M Actions, not just competitive with it. Avoid lock-in to any one cloud. |
| **MCP spec 2026-07-28**: core is stateless (no sessions or handshake), adds `server/discover`, Multi Round-Trip Requests and extensions. Tasks is now an opt-in extension that is incompatible with the 2025-11-25 version. Sampling, Roots and DCR are deprecated. | Build the MCP layer (3.7) on 2026-07-28 only. No Sampling, no Roots, no DCR-based OAuth. Long runs go through the Tasks extension. |
| **Pipedream Workflows shuts down Mar 31 2027** (no new signups since ~Sep 30 2026). **OpenAI Agent Builder shuts down Nov 30 2026.** | **Displaced users to win now.** Add migration importers and guides to the go-to-market. Kestra, Activepieces and Sim are already publishing migration guides. |
| n8n: **€100M+ ARR**, $2.5B Series C (Oct 2025), SAP at $5.2B (May 2026). Its git sync is one-way push/pull, with no review, no conflict detection, and pulls that overwrite unpushed changes. | Confirms the "workflows as code, reviewed in PRs" wedge against n8n. |
| Temporal: $550M at $12.55B (Sep 2026). Still **no official time-travel debugger** (only a community VS Code replayer). | The deploy check (3.5) is still a gap Temporal hasn't closed. |

Corrections to the earlier proposal: n8n ARR is €100M, not $100M. Gumloop's Series B was $50M ($70M is its total raised). Composio's Series A was about $25M ($29M total). Trigger.dev's v4 GA date is disputed (Aug 2025 or Jan 2026).

**Revised headline:** *Fix production runs live, and prove every deploy is safe.* Replay is
the mechanism behind this; it is not what we sell.

**The core architectural bet:** *one data structure — the step journal — powers durability,
debugging, replay, testing and analytics.* Competitors keep these in separate systems
(Temporal: event history vs. traces vs. tests). We never do.

---

## 1. Architecture

```
            ┌──────────── Customer app ────────────┐
            │  POST /v1/runs   POST /v1/events      │   webhooks (Stripe, GitHub…)
            └──────────────┬───────────────────────┘          │
                           ▼                                   ▼
┌────────────────────────────────────── Control plane (apps/api, Hono) ──────────────┐
│ auth (API keys, sessions) · triggers · run API · control API (pause/resume/inject)  │
│ MCP gateway (/mcp per project) · connections & OAuth broker · metering · audit log  │
└──────┬──────────────────────────────┬───────────────────────────────┬──────────────┘
       │ Postgres (journal, runs,     │ live event bus                │ object store
       │ queue via SKIP LOCKED)       │ (LISTEN/NOTIFY → WS)          │ (payloads > 64 KB)
       ▼                              ▼                               ▼
┌──────────── Executor (packages/engine) ────────────┐     ┌──── Dashboard (apps/web) ────┐
│ dequeue → load deployment bundle → invoke workflow │     │ runs list · live graph       │
│ fn in sandbox → journal each step → suspend/resume │◄───►│ inspector · fix-and-resume   │
│ gates (before/after/error) · retries · timers      │     │ diff/replay · behavior strip │
└─────────────────────────────────────────────────────┘     └──────────────────────────────┘
       ▲
       │ same engine, embedded (PGlite) — `circuit dev` locally = identical semantics
┌──────┴──── CLI (packages/cli) ────┐
│ dev · deploy · replay · test ·     │
│ runs · resume · mcp pull           │
└────────────────────────────────────┘
```

### 1.1 Execution model — step journaling (re-invocation)

Chosen over Temporal-style full deterministic replay of code. A workflow function is
re-invoked from the top on every resume; each `ctx.step()` call looks up its journal entry by
**(stepName, ordinal)**; if found and complete, it returns the recorded value without running.
The first un-journaled step runs for real, its result is journaled, and execution continues
(or suspends on sleep/wait/pause).

- Determinism is required **only for the sequence of step calls**, not for code between them.
- Divergence detection reuses GraphMind's tape contract: each entry stores
  `key = canonical([stepName, input])`; on re-invocation, ordinal is authoritative and key is
  the honesty check → mismatch = `NonDeterminismError` with a precise diff (step, expected vs.
  actual input). Port `packages/client/src/replay.ts` + `packages/analyze/src/canonical.ts`.
- Compute is **not held** during pause, sleep or waits (unlike GraphMind's in-process gate):
  the run suspends and the worker is freed. Pause can last days.

### 1.2 Runtime sandboxing

- DECIDED (2026-11-08): design for the highest isolation standard from day one. `Runner` is an
  interface with three implementations:
  - `InlineRunner` — same-process, tests and `circuit dev` fast loop only;
  - `ProcessRunner` — Node child process per invocation, IPC over stdio JSON lines,
    `--max-old-space-size` cap, kill on timeout — the in-session and self-host default;
  - `VmRunner` — Firecracker microVMs (hosted service), one tenant per VM, no shared memory,
    egress only via a policy proxy that logs every call. Built post-session, before any
    multi-tenant beta. The Runner contract (invoke → journal effects stream) is identical, so
    nothing above the engine changes.

### 1.3 Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, Node ≥ 22.13 | Same as GraphMind; reuse code |
| API | Hono | Light, typed, runs anywhere; already a (pinned ≥4.13.5) dep in this repo |
| DB | `JournalStore` interface. **`SqliteJournalStore` (node:sqlite)** for dev/tests/local — zero deps, matches the repo's philosophy. `PostgresJournalStore` (Postgres 16) for the hosted service (post-session) | One store contract, two backends; local dev needs no Docker |
| Queue | In the store: SQLite single-writer locally; Postgres `FOR UPDATE SKIP LOCKED` hosted | No Redis in MVP; revisit at ~1k runs/s |
| Live updates | `LISTEN/NOTIFY` → WebSocket fan-out | Reuse GraphMind hub/protocol concepts |
| Payload store | S3-compatible (MinIO locally) above 64 KB | Keep journal rows small |
| Dashboard | React + the GraphMind graph renderer (forked) | Proven UI |
| Validation | Zod (shared `@graphmind-ai/circuit-schema`) | Same pattern as `@graphmind-ai/schema` |
| Auth | Session cookies for UI (better-auth), hashed API keys for API | — |
| Secrets | Envelope encryption (KMS in prod, local key file in dev) | — |

---

## 2. Repository layout (this monorepo, existing workspace globs)

```
packages/
  circuit-schema/   @graphmind-ai/circuit-schema — Zod: journal entries, run states, API DTOs,
                    live events, control messages
  circuit-sdk/      @graphmind-ai/circuit-sdk — workflow(), ctx.step/sleep/waitForEvent/
                    approval/invoke (ctx.mcp lands in M6)
  circuit-engine/   @graphmind-ai/circuit-engine — executor, JournalStore, scheduler, gates,
                    retries, timers, Runner implementations, replay/compare
  circuit-cli/      circuit dev | deploy | runs | resume | replay | test | mcp pull (M3+)
apps/
  circuit-api/      control plane HTTP + WS (M3+)
  circuit-web/      dashboard (M5; forks the viewer's graph renderer)
examples/
  circuit-onboarding/  invoice-triage workflow used in docs, e2e and demo
```

All `"private": true` until launch. Shared code is **depended on** via `workspace:*` where the
contract genuinely matches (e.g. canonicalization from `@graphmind-ai/analyze`); adapted copies
only where Circuit's journal shape diverges from GraphMind's wire events. The two products
version independently; Circuit packages never import from `@graphmind-ai/client` runtime.

---

## 3. Specs

### 3.1 SDK API (`@graphmind-ai/circuit-sdk`)

```ts
import { workflow, z } from '@graphmind-ai/circuit-sdk';

export const triageInvoice = workflow({
  name: 'triage-invoice',
  input: z.object({ invoiceId: z.string() }),
  output: z.object({ status: z.enum(['paid', 'escalated']) }),
  triggers: [
    { type: 'api' },                                   // POST /v1/workflows/triage-invoice/runs
    { type: 'event', name: 'invoice.created' },
    { type: 'cron', schedule: '0 9 * * 1-5', tz: 'Europe/Berlin' },
  ],
  onError: 'pause',          // 'pause' | 'retry' | 'fail' — default: 'pause' in dev, 'retry' in prod
  retries: { max: 3, backoff: 'exponential', initialMs: 1000 },
  timeout: '7d',
}, async (ctx, input) => {
  const invoice = await ctx.step('fetch-invoice', () => api.get(input.invoiceId));

  const check = await ctx.mcp('stripe').call('retrieve_customer', { id: invoice.customer });

  const verdict = await ctx.step('classify', { retries: 5 }, () => llm.classify(invoice, check));

  if (verdict.amount > 10_000) {
    const ok = await ctx.approval('finance-signoff', {
      approvers: ['role:finance'], timeout: '48h', context: { invoice, verdict },
    });
    if (!ok.approved) return { status: 'escalated' };
  }
  await ctx.sleep('settle', '10m');
  const evt = await ctx.waitForEvent('payment', { name: 'payment.settled',
    match: { invoiceId: input.invoiceId }, timeout: '3d' });
  return { status: evt ? 'paid' : 'escalated' };
});
```

**Primitives** (each one journal entry; name must be stable; ordinal auto-assigned per name):

| Primitive | Journal kind | Suspends? | Gateable |
|---|---|---|---|
| `ctx.step(name, [opts], fn)` | `step` | no | before / after / error |
| `ctx.mcp(conn).call(tool, args)` | `mcp` | no | before / after / error + policy |
| `ctx.sleep(name, dur)` | `sleep` | yes | — |
| `ctx.waitForEvent(name, spec)` | `wait` | yes | — |
| `ctx.approval(name, spec)` | `approval` | yes | is itself a gate |
| `ctx.invoke(name, workflow, input)` | `child` | yes | before / error |
| `ctx.log(...)` | not journaled; attached to current entry | no | — |

Rules: step return values must be JSON-serializable (validated, clear error otherwise);
`Date.now()`/`Math.random()` outside steps trigger a dev-mode lint warning, not a hard ban.

### 3.2 Journal entry (`@graphmind-ai/circuit-schema`)

```ts
JournalEntry = {
  runId: string; seq: number;            // dense, per run
  kind: 'step'|'mcp'|'sleep'|'wait'|'approval'|'child';
  name: string; ordinal: number;         // (name, ordinal) = identity across re-invocations
  key: string;                           // canonical([name, input]) — divergence check
  parentSeq?: number;                    // nesting for ctx.step inside ctx.step (v2)
  status: 'running'|'completed'|'failed'|'paused'|'skipped'|'suspended';
  input: Payload; output?: Payload; error?: { name; message; stack? };
  attempts: Attempt[];                   // every try, kept — retries are visible, not erased
  intervention?: Intervention;           // who changed what, when (see 3.4)
  usage?: { inputTokens; outputTokens; costUsd? };   // filled for LLM-ish steps when reported
  startedAt; finishedAt?; durationMs?;
}
Payload = { inline: Json } | { ref: 's3://…', bytes: number, preview: string, sha256: string }
```

### 3.3 Run state machine

```
queued → running ⇄ suspended(sleep|wait|approval|child)
running → paused(gate|error)  → running   (continue | retry | inject | edit | skip)
                               → aborted
running → completed | failed | aborted | timed_out
```

Invariants (each gets a test): one active invocation per run (row lock + lease with
heartbeat); a lease that expires re-queues the run (worker crash ≠ lost run); completed
journal entries are immutable except via an audited intervention that *appends* a new attempt.

### 3.4 Gates & fix-and-resume (P1)

- **Points:** `before`, `after`, `error` per step (same vocabulary as GraphMind).
- **Triggers:** `onError: 'pause'`; breakpoints set per env from dashboard/CLI
  (`{ workflow?, step?, kind?, point }`, GraphMind matcher semantics); approval steps;
  MCP policy `approve`.
- **Actions** on a paused entry: `continue`, `retry` (optionally with edited input),
  `inject` (supply output, skip execution), `edit` (before-gate input change),
  `skip` (output `undefined`), `abort`. Edited input/injected output is validated against
  the step's schema if declared.
- **Bulk:** "apply same fix to all N runs paused at this step" (big win vs. competitors when
  a third-party API had an outage).
- **Governance:** RBAC (`runs:intervene` permission; prod env can require 2-person rule),
  every intervention stored `{ actor, action, before, after, reason, at }` and shown inline
  on the graph. Breakpoints in prod expire after 1h by default.

### 3.5 Replay, fork & test (P2)

| Command | Behavior |
|---|---|
| `circuit replay <runId>` | Pull journal, run **local working copy** in `circuit dev`, answer every step from the journal; report divergences (port `compareTrajectories`: regression / alternative / extra / arguments) |
| `circuit replay <runId> --from <step>` | Answer up to `step` from journal, run the rest live ("what-if") |
| `circuit replay <runId> --substitute step=<json>` | Fork with a substituted value at a step |
| `circuit record <runId> -o fixtures/x.json` | Export journal as a committed fixture (secrets redacted) |
| `circuit test` | Replays every fixture in `circuit.fixtures/`; fails on regression; JUnit output for CI |
| Deploy check | `circuit deploy` replays the last N in-flight runs of each changed workflow against the new bundle and **refuses** (overridable) if any would hit a non-determinism mismatch |

The deploy check is the headline answer to Temporal's worst pain — make it a launch demo.

### 3.6 Public HTTP API (v1)

```
POST   /v1/workflows/:name/runs          {input, idempotencyKey?, wait?: '30s'} → {runId, status, output?}
POST   /v1/events                        {name, data, id?} → {eventId, matchedRuns[]}
POST   /v1/webhooks/:hookId              raw passthrough, signature-verified per provider preset
GET    /v1/runs?workflow&status&cursor   list
GET    /v1/runs/:id                      run + journal (payload refs resolved lazily)
POST   /v1/runs/:id/cancel
POST   /v1/runs/:id/entries/:seq/resume  {action, input?, output?, reason?}
POST   /v1/runs/:id/replay               {fromSeq?, substitutions?} → new runId (server-side fork)
POST   /v1/approvals/:token              {approved, comment?}  (signed link for email/Slack)
GET    /v1/runs/:id/stream               WS/SSE live events
POST   /v1/deployments                   bundle upload (CLI)
*      /mcp                              project's workflows as MCP tools (Streamable HTTP)
```
Auth: `Authorization: Bearer ck_<env>_<random>` (stored as SHA-256; prefix shown in UI).
Idempotency keys honored 24h. All list endpoints cursor-paginated. Errors: RFC 9457.

### 3.7 MCP layer (P3)

- **Spec target: MCP 2026-07-28 only.** It is stateless, so there is no session to keep in a connection pool: discover through `server/discover` and handle Multi Round-Trip Requests. Do not use Sampling, Roots or Dynamic Client Registration (all deprecated). Long-running workflow tools use the opt-in Tasks extension (`io.modelcontextprotocol/tasks`, polling based). We support only this version of Tasks; the 2025-11-25 experimental version is incompatible with it. Use the official TS SDK version that implements 2026-07-28, and pin it in M6.
- **Connections:** per project/env; remote (Streamable HTTP + OAuth via our broker) or
  hosted stdio servers run inside the tenant sandbox. Tokens encrypted at rest, never in journal.
- **Typed codegen:** `circuit mcp pull stripe` lists tools and writes `circuit.mcp.d.ts` so
  `ctx.mcp('stripe').call(...)` is fully typed.
- **Tool pinning:** on connect, store `sha256(name, description, inputSchema)` per tool;
  on change → calls to that tool pause with "tool definition changed" until a human re-approves
  (rug-pull defense).
- **Policy per tool:** `allow` | `approve` | `deny`, plus arg constraints (v2).
- **Workflows as MCP tools:** `/mcp` exposes each workflow with `input` schema as a tool;
  long runs return a Tasks-extension handle. Clients without the extension get the
  fallback tool `get_run(runId)`.

### 3.8 Behavior analysis (P4)

Port `@graphmind-ai/analyze` (`scanWaste`, tool health, error shapes) to operate on
`JournalEntry[]`. Per run: verdict line + evidence. Per workflow (rolled up nightly):
failure clusters by error shape, p50/p95 per step, retries per step, cost per run,
"this step failed in 12% of runs → suggest an approval gate / onError: pause".

### 3.9 Data model (Postgres)

```
orgs(id, name, region)                       members(org_id, user_id, role)
projects(id, org_id, name)                   environments(id, project_id, name, kind: dev|staging|prod)
api_keys(id, env_id, prefix, hash, scopes, last_used_at, revoked_at)
deployments(id, env_id, version, bundle_ref, manifest jsonb, created_by, created_at)
workflows(id, env_id, name, active_deployment_id, config jsonb)
runs(id, env_id, workflow_id, deployment_id, status, input_ref, output_ref, error jsonb,
     idempotency_key, parent_run_id, forked_from jsonb, lease_owner, lease_expires_at,
     wake_at, created_at, finished_at)             -- idx (status, wake_at), (env_id, created_at)
journal(run_id, seq, kind, name, ordinal, key, status, input, output, error, attempts jsonb,
        intervention jsonb, usage jsonb, started_at, finished_at)   -- PK (run_id, seq)
waits(id, run_id, seq, event_name, match jsonb, expires_at)          -- idx (event_name)
events(id, env_id, name, data, received_at)
breakpoints(id, env_id, matcher jsonb, expires_at, created_by)
connections(id, env_id, name, transport, url, auth_ref, tool_pins jsonb, policy jsonb)
secrets(id, env_id, name, ciphertext, dek_wrapped)
audit_log(id, org_id, actor, action, target, before jsonb, after jsonb, at)
usage_counters(org_id, period, runs, compute_ms)
```
Retention: journal payloads per plan (7 / 30 / 90 days), metadata kept for analytics.

### 3.10 Security & tenancy

- Tenant id on every row; all queries go through a repository layer that requires it
  (lint rule forbids raw SQL outside `engine/store`). Postgres RLS as defense-in-depth.
- Secret redaction before journaling: port `redact-secrets.ts` + GraphMind's
  credential-leak audit approach (plant fake keys, grep DB/API/WS/exports) — **day-one CI job**.
- Egress: sandbox network only via proxy; per-env allowlist.
- EU region first (data residency is a selling point); region pinned at org creation.

### 3.11 Pricing (to validate, not build in session)

Benchmark: Temporal Cloud is $50/M Actions with no minimum, and AWS, Cloudflare and Vercel bundle durable workflows into their platforms. We compete on **simplicity**: one unit (runs), steps free, published overage, no plan cliffs.
Per run, **step count free**: Free 10k runs/mo · Team €49 (100k) · Business €399 (1M, SSO,
2-person rule, 90-day retention). Compute above 10 min/run metered per second. No seats
for execution; dashboard seats free up to 10.

---

## 4. Build plan — session milestones

> **Status 2026-11-08 (end of session build):** M0–M7 all ✅ — 76 unit tests + 4 browser (Playwright)
> tests green; `pnpm circuit:demo` / `pnpm circuit:dev` run the whole thing locally.
>
> - M0 scaffold · M1 durable engine (journal, memoized re-invocation, lease crash-recovery, retries,
>   timers, waits, approvals, children, divergence guards) · M2 fix-and-resume (6 actions, bulk,
>   audited interventions) — `circuit-schema`, `circuit-sdk`, `circuit-engine`.
> - M3 REST control plane + CLI (`dev/runs/show/resume/record/test/check`); SSE/WS streaming still
>   open (dashboard polls at 1.5 s).
> - M4 replay: fixtures (`record`/`test`), deploy check (CLI, API and dashboard button), fork /
>   substitute. Server-side `POST /runs/:id/replay` folded into `/fork` + `/deploy-check`.
> - M5 dashboard: dependency-free SPA served by circuit-api at `/` (strict CSP); runs list, timeline,
>   inspector, fix/approve/fork/cancel, events, deploy check, scaffolding. Built instead of forking
>   the viewer's React renderer — no build step, hosted service can serve it unchanged.
> - M6 MCP: on the v2 SDK (`@modelcontextprotocol/client`/`server` 2.x) — connections negotiate the
>   newest protocol; `circuit mcp serve` speaks **2026-07-28** (pinned in tests) with fallback. Tool
>   pinning (TOFU + pause on change), per-tool allow/approve/deny, `circuit mcp pull` codegen,
>   workflows-as-tools with dynamic listings. No Sampling/Roots/DCR. Deferred: hosted Streamable-HTTP
>   `/mcp` endpoint (control-plane work), per-argument policy constraints, Tasks-extension handles
>   (poll via `get_run` instead).
> - M7 importers: `circuit import n8n|pipedream` → runnable skeleton; unportable nodes throw
>   `TODO(circuit-import)` so porting = fix-and-resume. Plus dev conveniences: hot reload of the
>   workflows file, dashboard "New workflow" templates, `cancel` for any active run.
>
> Known debt (deliberate, small): engine loop is polling (no push notify); SSE run streaming unbuilt;
> fixture `tools/list` cast in `workflow-server.ts` (v2 SDK exports no TS result types); generated
> importer files must live where the SDK resolves. Next: validation track (§5), then hosted control
> plane (§ "Later").

### M0 — Scaffold (small)
- Packages `circuit-schema`, `circuit-sdk`, `circuit-engine` added to this monorepo (workspace globs already cover `packages/*`).
- pnpm workspace, TS strict, Vitest, Biome/ESLint, CI workflow skeleton.
- `@graphmind-ai/circuit-schema` with JournalEntry, RunStatus, API DTOs, live event envelope.
- **Done when:** `pnpm typecheck && pnpm test` passes on an empty-but-wired repo.

### M1 — Durable engine core (largest)
- `engine/store` on PGlite: runs, journal, waits, migrations.
- Executor loop: claim run (SKIP LOCKED + lease), invoke workflow fn in-process (`InlineRunner`
  for tests), journal steps, memoize on re-invocation, suspend on sleep/wait.
- Retries with backoff (attempts appended), timers (`wake_at` scheduler), lease expiry recovery.
- Divergence detection (ported canonical key + ordinal).
- **Tests:** crash-mid-step recovery, retry exhaustion, sleep resumes, waitForEvent match/timeout,
  non-determinism mismatch message, idempotency key.
- **Demo:** script runs `triage-invoice` (mocked deps) to completion through a forced crash.

### M2 — Gates & fix-and-resume (P1)
- `onError: 'pause'`, breakpoints, approval primitive.
- Resume actions continue/retry/inject/edit/skip/abort with schema validation and intervention log.
- Bulk resume.
- **Demo:** step throws → run `paused` → inject output → run completes; intervention visible in journal.

### M3 — API + CLI dev loop
- `apps/api` (Hono): runs, events, resume, stream (SSE first), API keys.
- `circuit dev`: runs API + engine on PGlite + file-watch reload of `workflows/*.ts`.
- `circuit runs`, `circuit resume`.
- **Demo:** `curl POST /v1/workflows/triage-invoice/runs` → watch, pause, `circuit resume --inject`.

### M4 — Replay & test (P2)
- Port tape/compare; `circuit replay`, `--from`, `--substitute`, `circuit record`, `circuit test`.
- Deploy-check function (used by M6 deploy).
- **Demo:** change workflow code → `circuit test` reports a regression with a readable diff.

### M5 — Dashboard
- Runs list, run page with live graph (fork GraphMind renderer), inspector, resume panel,
  intervention history, behavior strip (port analyze).
- **Demo:** the "paused → fix → resume" flow entirely in the browser.

### M6 — MCP layer (P3)
- Connections (remote Streamable HTTP; OAuth broker stub with static tokens in dev),
  `ctx.mcp`, tool pinning, allow/approve/deny policy, `circuit mcp pull` codegen,
  `/mcp` workflows-as-tools endpoint.
- **Demo:** workflow calls a local test MCP server; changing a tool description pauses the run.

### M7 — Migration importers (go-to-market wedge, small)
- `circuit import pipedream <export>` and `circuit import n8n <workflow.json>` generate a TS
  workflow skeleton: steps from nodes, MCP connections where a server exists, and a TODO for each
  unmapped node. They are best-effort and say so clearly. Timing: Pipedream Workflows shuts down Mar 31 2027.
- **Demo:** import a sample n8n workflow, then `circuit dev` runs the generated skeleton.

### Later (post-session, needs infra & money)
Hosted multi-tenant deploy (Postgres, S3, Firecracker runners), real OAuth broker, auth/orgs/RBAC
UI, metering & Stripe billing, SOC 2 prep, EU region, server-side deploy check, Python SDK,
canvas editor that round-trips to code, BYOC.

---

## 5. Validation track (parallel to building — founder-owned)

Before spending on hosted infra: ~20 interviews (n8n-in-prod teams; Temporal evaluators who
walked away). Signal to look for: *would pay for fix-and-resume + replay-on-deploy alone*.
Landing page + demo GIF of M2/M5 flow; waitlist conversion as the go/no-go metric.

## 6. Key risks

| Risk | Mitigation |
|---|---|
| Vercel and Cloudflare already ship replay and time travel, and could add live editing | Don't compete on replay. Compete on governed changes to production runs (bulk fix, 2-person rule, audit), the deploy check, MCP pinning, and not being tied to one cloud |
| Incumbents copy fix-and-resume (Temporal, Vercel WDK, Inngest) | Ship journal-as-recording as the unified core; depth (bulk fix, deploy check, MCP pinning) is harder to bolt on |
| Mutating prod runs scares buyers | RBAC, 2-person rule, append-only interventions, full audit |
| Sandbox escape / multi-tenant security | Firecracker before public beta; credential-leak audit in CI from M0 |
| MCP server quality & tool poisoning | Pinning + policy + approval; curated "verified" list |
| Journal storage cost | Payload offload + retention tiers |
| Segment smaller than n8n's | Validation track gates infra spend |

---

## 7. Decisions (resolved 2026-11-08)

1. **Same repo and brand**: GraphMind Circuit, packages `circuit-*` in this monorepo.
2. **TypeScript-only v1**; Python SDK deferred.
3. **Runner abstraction built for the highest standard**: Inline (tests) → Process (session,
   self-host) → Firecracker microVM (hosted multi-tenant). Both "we host" and
   "customer-hosted endpoint" modes remain possible behind the same interface.
4. **MIT, same repo.** Guardrails: no credentials, infra config, or hosted-deploy secrets in
   the repo; the existing credential-leak audit pattern extends to Circuit (CI job); hosted
   control-plane deployment config lives outside this repo when it exists.
