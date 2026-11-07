# support-desk — the realistic example

A customer-support agent for a fictional home-goods shop, built the way real
ones are: a Vercel AI SDK loop, five tools over "backend" services, a system
prompt with one well-meaning rule that backfires. Each of its five ticket
scenarios is engineered so a specific GraphMind feature has something real to
catch — run them one by one and you have exercised the whole debugger, old
features and new.

Where [`demo-agent`](../demo-agent) is the scripted, keyless demo the CLI
ships, **this** is the example to read and run when you want to see GraphMind
on a lifelike agent: real model, real loop, failures that look like the ones
in production.

## Run it (two commands)

You need Node >= 22.13, pnpm, and an Anthropic API key. From the repo root,
once: `pnpm install && pnpm build:packages`.

```sh
# 1. your key — this is the whole configuration
cd examples/support-desk
cp .env.example .env         # then paste your ANTHROPIC_API_KEY into .env

# 2. a debugger to attach to (new terminal, leave it running)
npx graphmind-ai             # opens the viewer at http://127.0.0.1:4747
```

Then run tickets:

```sh
pnpm start happy       # baseline: everything works
pnpm start refund      # pause-on-error + edit-and-retry + inject
pnpm start stock       # the failure that never throws (smart hold)
pnpm start loop        # the retry loop + the behaviour report
pnpm start research    # context growth, step over step
pnpm start all         # the whole shift
```

Each ticket prints *what to watch for* before it runs. Scenarios that hold
will **wait in the viewer for you** — that is the product, not a hang.
(Without a server running, everything still completes, unobserved:
instrumentation fails open.)

The default model is `claude-sonnet-5-5` (override with `SUPPORT_DESK_MODEL`
in `.env`). A full five-ticket shift costs a few cents.

## The five tickets, and how to verify GraphMind is telling the truth

Every scenario's failure is **planted and deterministic** (see
`src/tools.ts` — each trap is documented where it lives), so you can check
the debugger's claims against known ground truth:

### 1. `happy` — the baseline

"Where is order #1042?" Everything works.

**Verify:** the graph shows `lookupOrder` then `trackShipment`, all green,
nothing held. The Behaviour strip under the summary reads **"No wasted work
detected…"**. `graphmind runs --behavior last` prints the same sentence —
the viewer, CLI and MCP share one implementation, so if they ever disagree,
that is a bug worth filing.

### 2. `refund` — pause-on-error, then prove the fix

"Refund my broken keyboard ($89)." `refundPayment` has the classic planted
bug: a dollars→cents conversion applied twice, so the gateway sees **$8,900**
and throws. Pause-on-error (armed by default) freezes the run *at the throw,
before the SDK sees the error*.

**Verify, in order:**
- The run holds on `refundPayment`; the inspector shows the exact input the
  tool received: `amountUsd: 89`. The error says the gateway saw `$8,900.00`.
  Input right, outcome 100× — the bug is *inside* the tool. That diagnosis
  took one look, not one print-statement redeploy.
- Prove it: **Retry with edited arguments**, change `amountUsd` to `0.89`.
  The real call runs and *succeeds* (0.89 × 100 × 100 = $89). A 100×
  hypothesis confirmed from the debugger, no code change.
- Or **Inject** `{"success": true, "refundId": "rf_1042_01", "amountUsd": 89,
  "status": "approved"}` — the agent confirms the refund warmly, never
  knowing the tool is broken.
- Or **Continue** — the error goes through and the agent apologizes.
  Run it again and pick a different ending; the bug reproduces every time.

### 3. `stock` — the failure that doesn't throw

"Is SKU PLW-SLP-01 in stock?" The inventory service is mid-sync and
**returns** `{success: false, error: "upstream 503…"}`. Nothing throws; an
unwatched agent reads that as data.

**Verify:** the run holds anyway — the `error-result` smart breakpoint
caught the shape (`success: false`), with a banner saying exactly that.
Continue, and the agent follows its rules and tells the customer to check
back. Then `graphmind runs --behavior last`: the tool table shows
`checkInventory` with **silent: 1** and failed: 0 — a distinction no
error-based monitoring would surface.

### 4. `loop` — the retry that can't help

"Where is order #1041?" Its carrier lane is down: `trackShipment` times out
with the *same* error, *every* time. The system prompt says carrier timeouts
are usually transient, retry them — a line many production agents contain —
so the agent retries.

**Verify:** the loop guard holds the **third identical failure** with the
streak named on the card (same tool, same error, 3×). Continue a couple of
times and watch it hold again, then abort or let the step cap end it. Now
`graphmind runs --behavior last`:

- a **repeat** incident naming `trackShipment` ×3 — the retries used
  identical arguments, so they are literally the same call re-done (if the
  model varies the arguments between failures, the same streak surfaces as
  an **error-repeat** instead; either way it is one incident, no double
  counting),
- the tool table showing `trackShipment` failed 3 of 3,
- **the LLM steps and tokens spent inside the loop** — what the retry rule
  actually cost (a real smoke run of this scenario burned ~3,400 tokens
  inside the streak). In the viewer's Behaviour strip the same line carries
  a dollar estimate.

### 5. `research` — context pressure before it hurts

A warranty question that takes three knowledge-base lookups, each returning
a deliberately long article.

**Verify:** nothing fails — and that is the lesson. The Behaviour strip's
LLM line shows the input-token curve with its growth factor; in a real smoke
run this jumped `1,364 → 13,120 (×9.6)` in one step, because the model asked
for all three articles in parallel. Open an LLM step's **Context & cost** to
see which tool's output is doing the swallowing. This is the curve to watch
in your own agents before a `length` stop ever happens.

## Replay any of them, with no key

Once a ticket has run, you can run it again against its own recording — no
API key, no token spend, the same result every time:

```sh
graphmind replay last -- pnpm start happy          # from the local database
graphmind replay last --assert -- pnpm start happy # ...and fail on a divergence
graphmind replay last --dry                        # what would a replay cover?
```

**Verify it is really hermetic:** unset your key for the replay and watch it
still work.

```sh
env -u ANTHROPIC_API_KEY graphmind replay last --assert -- \
  env -u ANTHROPIC_API_KEY pnpm start happy
```

It prints `Trajectory: 5/5 call(s) matched the recording` and exits 0, and
the agent's reply is the recorded one, word for word. The AI SDK itself
warns on every step that the response was replayed rather than produced.

Then break something and watch `--assert` catch it: lower `maxSteps` for the
`happy` scenario in `src/scenarios.ts` from 6 to 2 and replay again. The
agent makes the same tool calls, then stops without its final answer, and
the assertion fails with `regression  step 5: the recording called step
here; the replay stopped first` and exit code 1.

### Ask "what if the refund had gone through?"

The `refund` ticket ends with an apology because the gateway rejected the
100× amount. Replay it with that one call answered differently and watch
the agent take the other path — no code changed:

```sh
pnpm start refund     # record the failure first

graphmind replay last \
  --substitute 'tool:refundPayment={"success":true,"refundId":"rf_1042_01","orderId":"1042","amountUsd":89,"status":"approved"}' \
  -- pnpm start refund
```

The reply becomes *"I've refunded the full $89 to your original payment
method (refund ID rf_1042_01)."* Everything up to `refundPayment` replays;
everything after runs for real, so this one needs your key and costs a few
tokens — the CLI says so before it starts.

In the viewer, open the `refundPayment` node and click the copy button in
its header: it puts that whole command on your clipboard, pre-filled with
what the call actually returned, so you edit a diff against reality.

### Did my prompt change help?

```sh
graphmind replay last --live-model -- pnpm start refund
```

Tool calls stay exactly as recorded; the model runs for real. Reword a tool
description or the system prompt in `src/scenarios.ts`, replay, and any
difference is down to your edit rather than to a tool answering differently.

Note the two-line guard at the top of `src/main.ts`: it skips the
API-key check when `GRAPHMIND_REPLAY` is set. Any agent that validates
credentials at startup needs that, or it cannot be replayed in CI where
there is no key to give. A copy-paste GitHub Actions workflow is in
[`.github-workflow-example.yml`](./.github-workflow-example.yml).

## Then try the rest of the loop

- **Your coding agent as the debugger:** `claude mcp add graphmind -- npx
  graphmind-ai mcp`, then ask *"why was my last support-desk run slow?"* —
  it should reach for `get_behavior` and cite the loop with a viewer link.
- **Drive a hold from the terminal:** with the server started as
  `graphmind serve --allow-control=resume`, run the `loop` ticket and
  release the hold with `graphmind wait` + `graphmind resume`.
- **Export the evidence:** `graphmind record <runId> --html` produces a
  single file you can attach to an issue — open it and the whole run, holds
  included, replays without a server.

## Troubleshooting

- **"no GraphMind server found — running undebugged"** — start
  `npx graphmind-ai` first (or check `GRAPHMIND_URL` if you changed ports).
- **A scenario "hangs"** — it is held; look at the viewer (or the terminal
  band at the top of any page). Continue/abort from there.
- **The loop scenario only failed once or twice** — models occasionally give
  up early despite the retry rule; run it again, it is cheap. Everything
  else is fully deterministic.
- **No dollar figures** — expected for unknown model ids; the bundled price
  table prices the default models.
