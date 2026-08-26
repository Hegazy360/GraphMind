# demo-agent

The GraphMind demo: a Vercel AI SDK **trip planner** (tools: `searchFlights`,
`getWeather`, `convertCurrency`, `checkBudget`) instrumented with
`@graphmind/ai-sdk`.

## The planted bug

`convertCurrency` **inverts the exchange rate** — it divides by the rate
instead of multiplying (`src/tools.ts`). Converting the trip's ¥402,000 to USD
at 0.0067 USD/JPY yields **$60,000,000** instead of $2,693.40, so
`checkBudget` throws a `BudgetExceededError` with an absurd total. With a
GraphMind server attached, pause-on-error (default-armed) freezes the run at
that throw — the demo's hero moment. From the viewer you can:

- **inject** a corrected budget-check result → the agent finishes happily,
- **continue** → the error propagates and the agent apologizes (and points a
  finger at `convertCurrency`),
- **retry** → the same bug fails the same way,
- **abort** → the run is cancelled.

## Modes

- **mock** (default, keyless, deterministic): a scripted
  `MockLanguageModelV4` (`ai/test`) drives a four-step conversation with
  streamed tokens. The script reads its tool results out of the prompt, so an
  injected fix genuinely changes the ending.
- **live**: a real model using your key — `ANTHROPIC_API_KEY` (Claude,
  preferred; default model `claude-opus-5`) or `OPENAI_API_KEY`. Override the
  model id with `GRAPHMIND_DEMO_MODEL`.

## Running

```sh
# from the repo root, with a graphmind server up (pnpm --filter graphmind-ai …):
pnpm --filter demo-agent start        # mock mode
pnpm --filter demo-agent start:live   # live mode (needs a key)
```

`graphmind demo --live` spawns this package's `src/main.ts` (via the local
`tsx`) rather than importing it — the `ai` + provider dependencies live here,
not in the CLI. Point `GRAPHMIND_DEMO_AGENT_DIR` at this directory when
running the CLI from somewhere other than the monorepo checkout.

## Regenerating the bundled fixture

`graphmind demo` (without `--live`) replays an NDJSON recording bundled in
`packages/cli/src/demo/`. Regenerate it after changing the agent:

```sh
pnpm -r build                          # the generator imports built packages
pnpm --filter demo-agent gen:fixture
```

The generator (`scripts/gen-fixture.ts`) runs the mock agent twice against an
in-process server — once resolved with `inject`, once with `continue` — and
splices the captures into base + branch segments with relative timing.
