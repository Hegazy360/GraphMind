# Behaviour insights and improvement recommendations

Status: approved 2026-11-18. Replaces the "AI workflow generator on the hub" idea.

Progress (2026-11-20): M1–M4 built. Skills; trends (`analyzeTrend`); recommendations
(`recommend`) for agents, Circuit and Jack; surfaces: `graphmind insights`, MCP
`get_insights` / `suggest_improvements`, the viewer's Insights page, Circuit
`GET /v1/insights` and Jack `GET /v1/projects/:id/insights` with dashboard views,
the hub's Claude Code card and a sign-in-aware homepage. Circuit runs are owned
by accounts (O2). Remaining: O3 (sync), O4 (alerts), hosted deploys of your own
Circuit workflows.

## Why

Engineers can already have Claude Code (or any coding agent) write and test an
agent or a workflow. What a coding agent cannot do is see how that agent
*behaves* once it runs: where it wastes calls, which tools fail silently, when
prompts creep toward the token limit, what regressed between versions. That is
GraphMind's job. So instead of generating workflows with our own model key, we:

1. teach coding agents how to use GraphMind's services (skills), and
2. turn recorded runs into **evidence-backed recommendations** a coding agent
   can apply, then verify the fix with the next run.

The loop we sell: **GraphMind finds it, your coding agent fixes it, GraphMind
proves the fix.** No model calls on our side; every finding is computed from
what the recording proves.

## What exists

- `packages/analyze`: one `BehaviorReport` per run (waste incidents, tool
  health incl. silent failures, finish reasons, context pressure, verdict).
  Used by the viewer, `graphmind runs --behavior` and the MCP tool
  `get_behavior`.
- `packages/cli/skills/graphmind/SKILL.md` + `graphmind skill --install`:
  a Claude Code skill for the debugger only.
- Circuit's journal (every step, attempt and human fix) and Jack's call log
  (`GET /v1/projects/:id/calls`): more behaviour data, not yet analyzed.

## Constraint found during research

`@graphmind-ai/circuit-sdk`, `@graphmind-ai/circuit-cli` and
`@graphmind-ai/jack-cli` are `private: true`, so they are not on npm. A skill
installed into an engineer's own project can therefore rely on:

- the published `graphmind-ai` CLI and adapters (debugger, analysis);
- the hosted `/v1` HTTP APIs of Circuit and Jack at `graphmind.ai/app`, with a
  personal `gmt_…` token.

Decision (2026-11-18): Circuit and Jack stay **hosted GraphMind services**
(the Sentry / Datadog model, with alerting such as Slack to follow), not npm
packages. Authoring Circuit workflows therefore lands with hosted deploys;
until then it happens in a GraphMind checkout.

## Milestones

### M1. Skills for every service (this change)

- `graphmind-circuit` and `graphmind-jack` skills next to `graphmind`, shipped
  in the `graphmind-ai` package.
- `graphmind skill [graphmind|circuit|jack|all] [--install [--force]]`;
  no argument keeps today's behaviour (the debugger skill).
- Later in M1: a "Using Claude Code?" card on the hub and, for signed-in
  visitors, on the homepage, with the copy-paste install line.

### M2. Cross-run aggregation (`packages/analyze`) — done

`analyzeTrend(samples, options)` → `BehaviorTrend` (`groupByApp` splits runs per
agent first):

- per tool: calls, failure rate (thrown and silent), p50/p95, each as a series
  over runs, with the first run where a rate moved past a threshold;
- per workflow/agent: completion rate, finish-reason mix, waste share, input
  tokens per run (max and growth), steps per run;
- a baseline-vs-recent comparison: rates (run ok rate, per-tool failure rate,
  token-limit stops) must move by 0.15 absolute AND pass a two-proportion
  z-test at |z| >= 2; per-run sizes (peak prompt, tool calls, run time)
  compare medians at 1.5x; both windows need 5 runs. Each shift names the
  first recent run that showed it. All thresholds are options.

Stays platform-neutral (no I/O), like `analyzeRun`.

### M3. Recommendations engine (rules, not an LLM) — done for agent runs

`recommend(samples, options)` → `{ trend, recommendations }`, each with:
`id` (stable, e.g. `R-tool-silent-failure`), `severity`, `title`, the
**evidence** (run ids, execution ids, counts), the **suggested change** in
words, and **how to verify** (which metric should move on the next run).

First rule set, all derived from facts the recording proves:

| Signal | Recommendation |
|---|---|
| Same tool, same error shape, many runs | Validate that argument in the tool / tighten its description and schema |
| Silent failures (`isError`, `success:false`) the agent ignores | Make the tool throw, or tell the model in the description how errors look |
| Repeat / cycle incidents | Cache the call, or add a loop guard / step cap; point at the calls |
| Rising share of `length` finishes, growing input tokens | Trim or summarize history; cap tool output size |
| One tool dominating p95 time | Timeout, parallelize, or cache that tool |
| Circuit: a step paused and was fixed by `inject`/`retry` repeatedly | Handle that case in code; the journal shows the fixes humans keep making |
| Jack: a tool erroring often with the API's own 4xx | Rewrite the tool description; consider `response.pick` / `maxBytes` |

Built rules: `R-regression`, `R-tool-error-repeat`, `R-tool-silent-failure`,
`R-wasted-calls`, `R-context-limit`, `R-slow-tool` (`packages/analyze/src/recommend.ts`).

### M3b. Circuit and Jack as data sources — done

- Circuit journal → `RunSample` (steps and `mcp` calls as tool executions,
  interventions kept) and the rule "a step keeps being fixed by hand the same way".
- Jack call log → per-tool samples and the rule "a tool keeps getting the API's 4xx".
- Exclude replay runs (`runs.source`) from trends by default: replays never
  record `run.finished` and are test re-executions, not production behaviour.

### M4. Surfaces — done

- MCP: `get_insights` (trend for a run name/window) and `suggest_improvements`
  (recommendations with evidence), so a coding agent reads and applies them.
  The skills teach the loop: get recommendations, change code, rerun, compare.
- CLI: `graphmind insights [--name <run name>] [--since …] [--json]`.
- Viewer: an Insights page (trends + recommendations, linked to the runs).
- Hosted: Circuit runs and Jack calls on `/app`, per account (needs Circuit
  runs to be owned by an account first; open item O2).

## Open items

- O1: resolved, hosted services (see the decision above). Next for Circuit:
  hosted deploys of the account's own workflows (needs the isolated runner).
- O2: done. Runs carry `accountId`; the API scopes every run route, idempotency
  keys, event delivery, breakpoints and the deploy check to the caller's
  account (another account's run is a 404); a static operator key sees all.
  Children and forks inherit the account. SQLite upgrades in place; Postgres
  migration `circuit-002-run-account`.
- O4: alerting (Slack, email) on trend shifts, once insights run hosted.
- O3: more data → better trends. Consider an opt-in way to sync local
  recordings to the user's account (separate decision: privacy, local-first).
