---
name: graphmind-circuit
description: Run and operate durable workflows with GraphMind Circuit, where a failing step pauses the run so a person can retry it, inject a result or abort, instead of losing it. Use when the user wants to start workflow runs from their app, inspect a run's step journal, fix and resume a paused run, approve a step, send an event a run waits for, fork a what-if, or check whether a code change breaks in-flight runs. Covers the hosted Circuit HTTP API and writing workflows with the Circuit SDK.
---

# GraphMind Circuit: durable workflows with fix-and-resume

A Circuit workflow is a TypeScript/JavaScript function whose side effects go
through `ctx.*` calls. Each call becomes one **journal entry** (input, output,
error, every attempt, every human fix). When a run continues (after a sleep,
an event, an approval or a crash) the function runs again from the top and
completed steps return their recorded result. When a step runs out of
retries, the run **pauses** (`onError: 'pause'`, the default) and waits for a
person instead of failing.

## 0. Credentials (ask the user; never print them)

- A GraphMind account (https://graphmind.ai/signup) and a personal token from
  https://graphmind.ai/app/#/account (**Create token**, `gmt_…`, shown once;
  only the user can create it).
- Ask them to export it as `GRAPHMIND_TOKEN`. Use it only as
  `$GRAPHMIND_TOKEN`: never echo it, store it in a file or commit it.

```sh
CIRCUIT=https://graphmind.ai/app/circuit/v1
auth=(-H "authorization: Bearer $GRAPHMIND_TOKEN" -H 'content-type: application/json')
curl -s "${auth[@]}" $CIRCUIT/health
curl -s "${auth[@]}" $CIRCUIT/workflows     # what this server runs, with input schemas
```

**What exists today.** Circuit is a hosted GraphMind service: your runs are
yours (another account's runs do not exist for you), and it runs the
workflows deployed on it. Deploying your own workflow code is not available
yet, and the SDK and CLI (`@graphmind-ai/circuit-sdk`, `circuit`) are not on
npm: authoring happens in a GraphMind checkout (§3). Say so to the user
instead of trying `npm install @graphmind-ai/circuit-sdk`. A local
`circuit dev` serves the same API at `http://127.0.0.1:4810/v1`.

## 1. Operate runs over HTTP

Errors are `application/problem+json`; read `detail`.

| Goal | Call |
|---|---|
| Start a run | `POST /workflows/<name>/runs` `{"input":{…},"idempotencyKey":"…"}` → `202 {runId}` (same key → same run) |
| List | `GET /runs?workflow=&status=&limit=` |
| Run + journal | `GET /runs/<id>` → `{run, journal}`; a paused run has `run.pausedSeq` |
| Fix a paused entry | `POST /runs/<id>/entries/<seq>/resume` `{"action":…, "reason":"…"}` |
| Approve | `POST /runs/<id>/approvals/<seq>` `{"approved":true,"by":"<user's email>","comment":"…"}` (`by` is required; a token's account overrides it) |
| Send an event | `POST /events` `{"name":"payment.settled","data":{…}}` |
| What-if | `POST /runs/<id>/fork` `{"uptoSeq":2,"substitute":{"seq":2,"output":{…}}}` |
| Abort | `POST /runs/<id>/cancel` |
| Save as a test | `GET /runs/<id>/fixture` |
| Deploy check | `POST /deploy-check` → `{checked, broken}` (409 if anything would break) |

Resume actions: `retry` (run it again, optionally with a new `input`),
`inject` (use the `output` you give), `continue`, `edit` (before a step:
change its input), `skip`, `abort`. Every fix is recorded under the signed-in
account. **Ask the user before** `inject`, `skip`, `abort` or approving
anything: these change what the workflow does with real data.

Statuses: `queued`, `running`, `completed`, `suspended` (sleeping or waiting:
see the journal's `wakeAt` / `waitEvent`), `paused` (waiting for a person),
`failed`, `aborted`, `timed_out`.

## 2. Diagnose a paused run

1. `GET /runs/<id>`: find the entry at `pausedSeq`, read its `error` and its
   attempts.
2. Decide: a transient failure → `retry`; a bug in the step → fix the code,
   then `retry` (in `circuit dev`, saving the file hot-reloads it); a value you
   know is right → `inject` it (with the user's OK).
3. If the same step keeps being fixed the same way across runs, that is a
   code change to propose, not a thing to keep doing by hand.

## 2b. What to change: insights

```sh
curl -s "${auth[@]}" "$CIRCUIT/insights?workflow=<name>"
# → { workflows: [{ workflow, trend: { verdict, tools, shifts, ... }, recommendations: [...] }] }
```

Computed over the account's newest runs. The rule to look for first is
`R-manual-fix`: a step people keep fixing by hand (inject, retry, skip) in
run after run. Each recommendation names the runs, the change to make in the
workflow code, and the metric that should move. Propose the change to the
user; after it ships, the next runs should make the recommendation disappear.

## 3. Write a workflow (GraphMind checkout)

```js
import { workflow, z } from '@graphmind-ai/circuit-sdk';

export const onboardUser = workflow(
  { name: 'onboard-user', input: z.object({ email: z.string() }), retries: 3, onError: 'pause', timeout: '7d' },
  async (ctx, input) => {
    const user = await ctx.step('create-account', () => db.createUser(input.email));
    await ctx.step('send-welcome', { retries: 5 }, () => mail.send(input.email));
    await ctx.sleep('wait-a-day', '1d');
    const done = await ctx.waitForEvent('profile', { name: 'profile.completed', match: { userId: user.id }, timeout: '14d' });
    if (!done) await ctx.step('nudge', () => mail.nudge(input.email));
    return { userId: user.id, completed: Boolean(done) };
  },
);
```

`ctx.step(name, [{retries}], fn)`, `ctx.sleep(name, '10m')`,
`ctx.waitForEvent(name, {name, match?, timeout?})` (null on timeout),
`ctx.approval(name, {approvers?, timeout?, context?})` →
`{approved, by, comment, timedOut}`, `ctx.invoke(name, workflow, input)`,
`ctx.mcp('<connection>').call(tool, args)`, `ctx.log(...)`.

Rules that save time:
- Side effects and anything non-deterministic (`Date.now()`, `Math.random()`,
  network) belong inside `ctx.step`. Step results must be JSON.
- Step names are part of the recorded history: renaming or reordering steps
  breaks runs in flight (`NonDeterminismError`). Run `circuit check` (or
  `POST /deploy-check`) before shipping a change.
- Keep the file inside the workspace so `@graphmind-ai/circuit-sdk` resolves;
  run it with `circuit dev --workflows <file>` (dashboard at
  `http://127.0.0.1:4810/`).
- `circuit record <runId> --out <fixture>.json` then `circuit test` replays
  fixtures against the current code without running steps: use it in CI.
- `circuit import n8n|pipedream <export.json>` gives a runnable skeleton.

## 4. Connect to MCP servers (including Jack)

List connections in `circuit.mcp.json` and start with `--mcp circuit.mcp.json`:

```json
{ "connections": {
  "billing": { "transport": "http", "url": "https://graphmind.ai/p/acme-billing/mcp", "policy": { "refund": "approve", "*": "allow" } }
} }
```

A tool that returns `isError` fails the step (it retries, then pauses).
`policy`: `approve` pauses before every call so a person can check or edit the
arguments; `deny` refuses. Tools are pinned on first use: if a server changes
a tool's definition, calls pause until someone accepts it. A Jack project in
sign-in mode needs its OAuth flow; an open project works with the URL alone
(see the `graphmind-jack` skill).

## Related skills

- `graphmind-jack`: publish the user's API as the MCP server steps call.
- `graphmind`: debug the agent inside a step live (pause, inject, replay).
