# GraphMind Circuit: usage guide

Circuit is GraphMind's workflow service. You write workflows as TypeScript or
JavaScript, your applications start and feed them over HTTP, and when a step
fails the run **pauses** so you can fix it and resume it instead of losing it.

## 0. What exists today, and what doesn't

Circuit is meant to be a hosted service on graphmind.ai: you sign in, deploy
workflows, get an API key, and point your apps at
`https://api.graphmind.ai/circuit/v1/...`. **That hosted part does not exist
yet.** What is built so far is the engine underneath it, which runs on your
machine:

| Piece | Status | Where |
|---|---|---|
| Workflow SDK (`workflow`, `ctx.step`, `sleep`, `waitForEvent`, `approval`, `invoke`) | built | `packages/circuit-sdk` |
| Durable engine (retries, crash recovery, pause on error, fix-and-resume, replay, deploy check, fork) | built | `packages/circuit-engine` |
| HTTP API (the same routes the hosted service will expose) | built | `apps/circuit-api` |
| CLI (`circuit dev / runs / show / resume / record / test / check`) | built | `packages/circuit-cli` |
| Web dashboard (runs list, step timeline, inspector, fix / approve / fork, events, deploy check) | built (M5) | `apps/circuit-api/ui`, served at `/` by `circuit dev` |
| Accounts (sign-up, sessions, personal API tokens) | built | `circuit dev --accounts`, `packages/accounts` |
| Hosted service: deploys, Postgres, isolated runners | **not built** | — |
| MCP connectors (`ctx.mcp`, tool pinning, per-tool policy, typed codegen, workflows as MCP tools) — on the v2 MCP SDK, protocol 2026-07-28 with fallback for older clients | built (M6) | `packages/circuit-mcp` |
| Importers: `circuit import n8n\|pipedream` → runnable Circuit skeleton | built (M7) | `packages/circuit-cli` |
| Dev conveniences: hot reload of the workflows file; "New workflow" templates in the dashboard | built | `circuit dev` |

So right now you try Circuit **locally**, in the dashboard at `http://127.0.0.1:4810/` or from a terminal. Everything you do
below goes through the same HTTP API the hosted version will serve. Moving
online changes where the server runs; the dashboard and accounts already
exist (§3a), and the workflow code and the API calls stay the same.

## 1. Setup (once)

Requirements: Node ≥ 22.13 (Node ≥ 23.6 if you want to load `.ts` workflow
files directly) and pnpm.

```sh
cd GraphMind
pnpm install
pnpm build:circuit      # compiles the five Circuit packages
```

You need `build:circuit` again after changing any Circuit package source.
`pnpm circuit:demo` and `pnpm circuit:dev` run it for you.

## 2. Fastest look: the guided demo (one command)

```sh
pnpm circuit:demo
```

This starts the real HTTP API inside one process (in-memory database, free
port) and plays the whole story, printing every HTTP call:

1. an app starts a run of `triage-invoice`;
2. the simulated ERP fails, so the run **pauses** at an error gate;
3. you retry the step, with your name and a reason recorded;
4. finance approves the large invoice;
5. a `payment.settled` event arrives and completes the run;
6. the journal shows every step, every attempt and the human fix;
7. a **fork** reruns it with a different invoice amount (the approval is skipped);
8. the **deploy check** confirms the current code wouldn't break in-flight runs.

Nothing is kept afterwards. The demo script is
`examples/circuit-onboarding/demo.mjs`.

## 3. The dashboard

```sh
pnpm circuit:dev
# open http://127.0.0.1:4810/
```

Everything the API can do, from the browser:

- **New run**: pick a workflow, edit the JSON input (pre-filled from its
  schema), start. `triage-invoice` defaults to `flaky-big-001` so the demo
  story happens.
- **Runs list** (left): newest first, refreshes every 1.5 s. Runs waiting on
  a person have an orange edge. Filter by status at the top.
- **Run page**: the steps as a timeline (green done, orange waiting on a
  person, purple sleeping/waiting, red failed), with what each one is doing
  ("retrying in 4s", "waiting for payment.settled"). Click a step to see its
  input, output, error, every attempt, and every human change.
- **Fix panel**: a paused run opens straight on the held step. Choose Retry,
  Inject result, Skip, Let it fail or Abort, add a reason, apply. The run
  continues and the page follows it to its next stop.
- **Approvals**: Approve / Deny with a comment, showing the context the
  workflow attached.
- **Fork from here…** on any completed step: run "what if this had returned
  X?" as a new run. The original isn't touched.
- **Send event** and **Deploy check** buttons in the header.
- **New workflow** (dev server only): pick a name and a template (blank,
  approval, event, mcp); it is appended to the loaded workflows file and
  hot-reloaded — then open the file and build from there.
- **abort run** link in the run header stops any active run, not just paused
  ones.
- **Your name** (top right, click it) is recorded on every fix and approval.
  It defaults to `dashboard`.

If the server was started with `--api-key`, the page asks for the key and
keeps it only for that browser tab (fixture downloads send it too). With
`--accounts` it asks you to sign in or create an account instead (§3a), and
"your name" is then your account's email, not something you type.

## 3a. Accounts

```sh
node packages/circuit-cli/dist/cli.js dev --workflows examples/circuit-onboarding/workflows.mjs --accounts
# circuit dev — … workflow(s): …
#   accounts   anyone can sign up · 0 user(s) · examples/circuit-onboarding/.circuit/accounts.db
```

`--accounts` turns on self-serve accounts from `@graphmind-ai/accounts`
(`packages/accounts`), the same code the hosted service will use:

- **Sign-up.** The dashboard opens on a sign-in overlay; the first visitor
  creates an account with an email and a password (10 characters or more).
  Registration is open and free, with no plans or quotas, by decision.
  `--no-signup` closes it while keeping existing accounts working.
- **Attribution.** Every resume, approval, fork and cancel is recorded under
  the signed-in account's email. The `x-circuit-actor` header and the `by`
  field of an approval are overridden when someone is signed in; they still
  apply to callers using a static `--api-key`.
- **Sessions** are an `HttpOnly` `SameSite=Lax` cookie, 30 days by default,
  `Secure` and `__Host-`-prefixed on https. State-changing requests from a
  session must come from the dashboard's own origin.
- **API tokens for the CLI.** `/v1` needs a session or a token, so `curl` and
  `pnpm circuit runs|show|resume|…` need a personal token: click your name in
  the dashboard header, **Create token**, copy the `gmt_…` value (it is shown
  once), then pass it as `--api-key gmt_…` or `Authorization: Bearer gmt_…`.
  Tokens are stored hashed and can be revoked from the same place, which
  also has **Sign out**.
- **A static `--api-key` still works** beside accounts, as the operator.
- **Hosting.** `--host <addr>` binds another interface and is refused unless
  `--accounts` or `--api-key` is given. `--public-origin https://…` is the
  origin the server believes it has behind a proxy: it decides the cookie
  flags and the URLs printed.

Account data lives in `accounts.db` next to the dev database. `GET /health`
(no auth) reports `accounts` and `signup`; `GET /v1/health` adds the
signed-in `user`.

## 3b. Drive it from a terminal

Terminal 1:

```sh
pnpm circuit:dev
# circuit dev — 1 workflow(s): triage-invoice
#   api   http://127.0.0.1:4810/v1
#   db    examples/circuit-onboarding/.circuit/dev.db
```

The server only listens on `127.0.0.1`. Runs are stored in that SQLite file
and survive restarts. Delete the file to start fresh.

Terminal 2: walk the invoice story by hand.

```sh
API=http://127.0.0.1:4810/v1

# 1. Start a run. A 'flaky' invoice id makes the first ERP fetch fail;
#    'big' makes the amount 25,000, which needs approval.
curl -s -X POST $API/workflows/triage-invoice/runs \
  -H 'content-type: application/json' \
  -d '{"input":{"invoiceId":"flaky-big-001"}}'
# {"runId":"run_…","status":"queued"}
RUN=run_…   # paste the id

# 2. Look at it: status "paused", pausedSeq 0, and the error on journal entry 0
curl -s $API/runs/$RUN

# 3. Fix it. Pick one:
#    retry the step for real
curl -s -X POST $API/runs/$RUN/entries/0/resume -H 'content-type: application/json' \
  -H 'x-circuit-actor: you@team' -d '{"action":"retry","reason":"ERP back up"}'
#    …or skip the call and supply the result yourself
# -d '{"action":"inject","output":{"invoiceId":"flaky-big-001","amount":25000,"customer":"acme"}}'

# 4. It now waits at the approval (journal entry 1). Approve it:
curl -s -X POST $API/runs/$RUN/approvals/1 -H 'content-type: application/json' \
  -d '{"approved":true,"by":"cfo@team"}'

# 5. It waits for payment. Send the event:
curl -s -X POST $API/events -H 'content-type: application/json' \
  -d '{"name":"payment.settled","data":{"invoiceId":"flaky-big-001"}}'

# 6. Completed, output {"status":"paid",…}
curl -s $API/runs/$RUN
```

The same thing from the CLI, in another terminal, run from
`examples/circuit-onboarding`:

```sh
pnpm circuit runs                      # list runs
pnpm circuit show <runId>              # run + full journal as JSON
pnpm circuit resume <runId> 0 retry --reason "ERP back up" --actor you@team
pnpm circuit resume <runId> 0 inject --output '{"amount":42}'
```

## 3c. Browser tests

```sh
pnpm circuit:e2e
```

Starts a server, opens headless Chromium, and clicks through the whole story
(start → pause → inject fix → approve → send event → completed → fork →
deploy check), plus status filtering and a check that run data containing
HTML is shown as text and never executed. Set `CIRCUIT_SHOTS=<folder>` to
save a screenshot of each stage.

## 4. Concepts

**Journal.** Every `ctx.*` call in a run becomes one journal entry, with its
input, output, error, each attempt, and any human intervention. When a run
continues (after a sleep, an event, an approval or a crash), Circuit calls
your function again from the top. Steps that already completed return their
recorded result without running again.

**Rule:** step results must be JSON (no functions, class instances or
BigInt). Circuit rejects anything else loudly, because a recorded result has
to come back exactly as it was.

**Run statuses:** `queued` → `running` → `completed`, or along the way
`suspended` (sleeping, waiting for an event or a child run), `paused`
(waiting for a human), `failed`, `aborted`, `timed_out`.

**Pause on error.** By default (`onError: 'pause'`), a step that runs out of
retries pauses instead of failing the run. Set `onError: 'fail'` to let the
error reach your code (`try/catch` works as usual).

**Resume actions**, on a paused journal entry:

| action | effect |
|---|---|
| `retry` | run the step again for real (optionally with a new `input`) |
| `inject` | don't run it; use the `output` you give as its result |
| `continue` | at an error: let the original error through. Before a step: run it |
| `edit` | before a step (breakpoint): change its input, then run it |
| `skip` | the step returns `undefined` |
| `abort` | end the run as `aborted` |

Each one is recorded on the entry with the actor (`x-circuit-actor` header or
`--actor`), the time and the reason.

**Divergence.** If you change a workflow while runs of it are in flight (say
you rename a step), those runs fail with `NonDeterminismError`, naming the
recorded call and the new one, instead of quietly mixing old results into
new code. `circuit check` tells you this *before* you deploy.

## 5. Write your own workflow

Create `my-workflows.mjs` (or `.ts` on Node ≥ 23.6):

```js
import { workflow, z } from '@graphmind-ai/circuit-sdk';

export const onboardUser = workflow(
  {
    name: 'onboard-user',                     // kebab-case, used in the URL
    input: z.object({ email: z.string() }),   // validated when a run starts
    retries: 3,                               // default attempts per step
    onError: 'pause',                         // or 'fail'
    timeout: '7d',                            // whole-run limit
  },
  async (ctx, input) => {
    const user = await ctx.step('create-account', () => db.createUser(input.email));
    await ctx.step('send-welcome', { retries: 5 }, () => mail.send(input.email));
    await ctx.sleep('wait-a-day', '1d');      // no process held while sleeping
    const done = await ctx.waitForEvent('profile', {
      name: 'profile.completed', match: { userId: user.id }, timeout: '14d',
    });
    if (!done) await ctx.step('nudge', () => mail.nudge(input.email));
    return { userId: user.id, completed: Boolean(done) };
  },
);
```

Run it:

```sh
node packages/circuit-cli/dist/cli.js dev --workflows path/to/my-workflows.mjs
```

The file must be able to import `@graphmind-ai/circuit-sdk`, so keep it
inside the workspace (for example next to `examples/circuit-onboarding/workflows.mjs`).

SDK reference:

| call | what it does |
|---|---|
| `ctx.step(name, [{retries}], fn)` | runs `fn` once, durably; retries with backoff; pauses or fails when retries run out |
| `ctx.sleep(name, '10m')` | durable timer (units `ms s m h d`) |
| `ctx.waitForEvent(name, {name, match?, timeout?})` | resolves with the event data, or `null` on timeout |
| `ctx.approval(name, {approvers?, timeout?, context?})` | holds for a person; resolves `{approved, by, comment, timedOut}` |
| `ctx.invoke(name, workflowName, input)` | runs another workflow as a child and returns its output |
| `ctx.log(...)` | log line (not recorded as a step) |

Step names must be unique within a run's flow. Calling the same name twice
is allowed; they are numbered in order.

## 5b. Calling MCP servers from a workflow

Any MCP server can be a step: Stripe's, GitHub's, your own. List them in a
config file (the example has `examples/circuit-onboarding/circuit.mcp.json`):

```json
{
  "connections": {
    "billing": {
      "transport": "stdio",
      "command": "node",
      "args": ["billing-mcp-server.mjs"],
      "policy": { "refund": "approve" }
    },
    "remote-example": { "transport": "http", "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer …" } }
  }
}
```

Then in a workflow:

```js
const charge = await ctx.mcp('billing').call('get_charge', { chargeId });
const refund = await ctx.mcp('billing').call('refund', { chargeId, amount: charge.amount });
```

and start the server with `--mcp circuit.mcp.json` (`pnpm circuit:dev` already does).

Each call is a normal journaled step (retries, pause on error, replay, fork),
plus three protections:

| protection | what happens |
|---|---|
| **Returned errors count** | a tool that returns `isError` fails the step, so it retries and then pauses, instead of passing an error message on as if it were data |
| **Policy** per tool (`allow` default, `approve`, `deny`; `"*"` sets the default for a connection) | `approve`: every call pauses *before* running, so a person can check the arguments, edit them, run it or abort. `deny`: the step fails with `PolicyDenied` without calling the tool |
| **Tool pinning** | the first time a tool is used, a hash of its name, description and input schema is stored (`.circuit/mcp-pins.json`). If the server later changes the tool, calls pause with `ToolDefinitionChanged` until a person accepts the new definition ("Run it" in the dashboard) |

**Try it** with the example billing server (`ch_big…` charges are 900 EUR,
`ch_broken…` makes the server return an error):

1. `pnpm circuit:dev`, open the dashboard.
2. New run → `refund-request` → input `{"chargeId":"ch_big_1","reason":"double charge"}`.
3. It stops at `billing.refund` with "Policy: a human must approve this MCP
   call". Pick **Edit & run**, change `amount` to `450`, apply. Completed with
   `refunded: 450`.
4. Run it with `ch_broken_1`: it pauses at `billing.get_charge` with the
   server's error. Inject `{"chargeId":"ch_broken_1","amount":10}` to continue.
5. Pinning: in `billing-mcp-server.mjs` change the description of
   `get_charge`, restart the dev server, start a run: it pauses with "This MCP
   tool changed since it was trusted". Run it to accept.

**Typed calls:** `pnpm circuit mcp pull --mcp circuit.mcp.json` (from the
example folder) writes `circuit.mcp.d.ts`. In a TypeScript workflow,
`ctx.mcp('billing').call(...)` then autocompletes tool names and checks
arguments.

The MCP layer is built on the v2 MCP SDK (`@modelcontextprotocol/client` /
`server` 2.x): connections negotiate the newest protocol a server offers, and
`circuit mcp serve` speaks the 2026-07-28 era with automatic fallback for
older clients.

**Your workflows as MCP tools:** with the dev server running,

```sh
claude mcp add circuit -- node <repo>/packages/circuit-cli/dist/cli.js mcp serve
```

gives Claude Code (or any MCP client) a `run_<workflow>` tool per workflow
and `get_run`. A run that finishes within 20 s returns its output; one that
pauses for a person returns its run id and a dashboard link. Agent-started
runs appear in the dashboard like any other.

## 5c. Importing from n8n or Pipedream

```sh
circuit import n8n my-export.json          # a workflow exported from n8n
circuit import pipedream my-export.json    # a Pipedream workflow (shuts down 2027-03-31)
```

This writes `<name>.circuit.mjs`: every node becomes a step in the original
order; triggers map to Circuit triggers; `wait` nodes become `ctx.sleep`;
HTTP-request nodes become real `fetch` steps to verify. Everything that can't
be ported mechanically becomes a step that **throws `TODO(circuit-import)`**
with the original node's parameters in a comment — so a run pauses at the
first unported step, and porting is the normal fix-and-resume loop: port the
step in the file, save (hot reload), hit **Retry** in the dashboard.

The generated file imports the Circuit SDK, so put it where the SDK resolves
(next to your other workflow files).

## 6. Tests and the deploy check

```sh
cd examples/circuit-onboarding
pnpm circuit record <runId> --out circuit.fixtures/paid-big-invoice.json
pnpm circuit test --workflows workflows.mjs     # replays every fixture
pnpm circuit check --workflows workflows.mjs    # checks in-flight runs in .circuit/dev.db
```

- `record` saves a finished run as a JSON fixture you can commit.
- `test` replays each fixture against your current code without running any
  step for real. It fails if the steps changed (with both sides named) or if
  the final output changed. Exit code 1 on failure, so it works in CI.
- `check` replays every run that is still in flight against your current code
  and lists the ones that would break.

Note: hot reload updates *new* runs immediately, but runs already in flight
replay their journals against the code now loaded — that is exactly what
`circuit check` verifies, and the dashboard's **Deploy check** button runs
the same thing.

Try it: start a `big` invoice run so it waits at the approval, rename
`fetch-invoice` in `workflows.mjs`, then run `check`.

## 7. HTTP API reference (v1)

Base URL locally: `http://127.0.0.1:4810/v1`. Errors are JSON
(`application/problem+json`) with `title`, `status` and `detail`.

| method & path | body | returns |
|---|---|---|
| `GET /health` | – | `{ok, service}` |
| `POST /workflows/:name/runs` | `{input?, idempotencyKey?}` | `202 {runId, status}` (same key → same run) |
| `GET /runs?workflow=&status=&limit=` | – | `{runs}` |
| `GET /runs/:id` | – | `{run, journal}` |
| `POST /runs/:id/entries/:seq/resume` | `{action, input?, output?, reason?}` | `{run}` (409 if not paused) |
| `POST /runs/:id/approvals/:seq` | `{approved, by, comment?}` | `{run}` |
| `POST /runs/:id/fork` | `{uptoSeq?, substitute?: {seq, output}}` | `201 {runId, forkedFrom}` |
| `POST /runs/:id/cancel` | – | `{run}` — aborts any active run and defuses its pending event waits |
| `GET /runs/:id/fixture` | – | the fixture JSON |
| `POST /events` | `{name, data?}` | `202 {eventId, matchedRuns}` |
| `POST /breakpoints` | `{workflow?, step?, kind?, point?}` | `201` (pauses matching steps; `point` defaults to `before`) |
| `DELETE /breakpoints` | – | clears all |
| `POST /deploy-check` | – | `{checked, broken}` (`409` if anything would break) |
| `POST /dev/scaffold` | `{name, template}` | `201 {file, workflow}` — dev servers only (404 otherwise) |

Optional header `x-circuit-actor: <who>` names the person behind an
intervention. To require an API key locally, start with `--api-key ck_test_123`
and send `Authorization: Bearer ck_test_123`. With `--accounts` (§3a) every
`/v1` call needs a session cookie or a personal token
(`Authorization: Bearer gmt_…`), the actor is the account's email, and
`x-circuit-actor` is ignored for signed-in callers. `GET /health` without the
`/v1` prefix is public either way.

## 8. Troubleshooting

| symptom | fix |
|---|---|
| `circuit: command not found`, or `Cannot find module …/dist/…` | run `pnpm build:circuit` (the `dist/` folders aren't committed) |
| `EADDRINUSE :4810` | another dev server is running; stop it, or pass `--port 4811` |
| `400 Invalid request body` when starting a run | the input doesn't match the workflow's `input` schema (`triage-invoice` needs `{"invoiceId": "..."}`) |
| `409 Invalid resume … not paused` | check `pausedSeq` in `GET /runs/:id` and resume that entry number |
| a run sits at `suspended` | it is sleeping or waiting for an event; `journal[n].wakeAt` / `waitEvent` shows which |
| `NonDeterminismError` | you changed the workflow under an in-flight run; see §4 Divergence and use `circuit check` |
| `circuit import` output can't find the SDK | move the generated `.circuit.mjs` next to your other workflow files (inside the repo/workspace) |
| saved the workflows file but nothing happened |  check the dev terminal — a parse error prints `reload failed` and keeps the old version |
| dashboard says "disconnected" | the dev server stopped; restart `pnpm circuit:dev` and the page reconnects by itself |
| old runs cluttering the list | delete `examples/circuit-onboarding/.circuit/dev.db` |

## 9. The road to the hosted version

To make this a service users try on graphmind.ai, the remaining work (§4 of
`docs/plans/hosted-workflow-platform.md`):

1. ~~M5 dashboard~~ done.
2. ~~M6 MCP connectors~~ done.
3. ~~M7 importers~~ done (plus hot reload and dashboard scaffolding).
4. ~~Accounts~~ done 2026-11-11 (`--accounts`, §3a, `packages/accounts`).
5. **Hosted control plane**: orgs and roles, a Postgres journal store,
   `circuit deploy` uploading workflow bundles, and isolated runners per
   customer (microVMs). Then a domain for the dashboard: graphmind.ai's
   sign-in links point at a placeholder until then.
6. A public **try-it page** on the website: a sandboxed, throwaway workspace
   with the onboarding workflow preloaded, like the debugger's existing
   "Try in browser". This is the closest online equivalent of `pnpm circuit:demo`.
