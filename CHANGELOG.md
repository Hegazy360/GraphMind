# Changelog

All notable changes to GraphMind. Versions are shared across every package in
this repo (`graphmind-ai`, `@graphmind-ai/sdk`, `@graphmind-ai/client`,
`@graphmind-ai/schema`, `@graphmind-ai/anthropic`, `@graphmind-ai/openai`,
`@graphmind-ai/langgraph`, `@graphmind-ai/mcp`, the Python `graphmind-ai`
distribution, and the Ruby `graphmind` gem).

## Unreleased

### Added — a behaviour verdict per run (`@graphmind-ai/analyze`, `runs --behavior`, MCP `get_behavior`, the Behaviour strip)

A run that finished `ok` can still have gone badly: the same tool called with
the same arguments four times, a tool that kept *returning* failures nothing
threw, prompts growing until a step stopped at the token limit. GraphMind now
reads exactly that out of any recording it already has — one verdict line per
run, with the evidence underneath, and only from facts the recording proves
(no scores, no judges, no guessed "dead steps").

- **One implementation, three surfaces.** The new `@graphmind-ai/analyze`
  package computes the report; the viewer (a **Behaviour** strip under the
  run's summary line, collapsed to its verdict until clicked), the terminal
  (`graphmind runs --behavior <runId|last>`, `--json` for the raw report) and
  the MCP server (new read-only `get_behavior` tool, the right first call for
  "why was this run slow / expensive / going in circles?") all show the same
  numbers, so a human and a coding agent never argue from different reports.
- **Wasted work, retrospectively.** The three behaviours the live loop guard
  holds on, found after the fact in any run: consecutive identical tool calls
  (same canonical input, `_meta` ignored — the canonicalization is pinned
  against the client's by test), 2–4-call cycles repeating identically, and
  the same tool failing the same way three or more times in a row. Each
  incident names its event span, and the report counts the LLM steps and
  tokens spent *inside* the loop — what it actually cost; the viewer adds a
  dollar estimate from the bundled price table. Overlapping incidents never
  double-count: totals come from the union of wasted calls.
- **Tool health.** Per tool: calls, thrown failures, **silent failures** (the
  `error-result` smart-breakpoint shapes — `isError: true`, `success: false`,
  a non-zero exit code, a bare `{error}` — returned with status `ok`, pinned
  against the client's rule by test), failure rate, recoveries, and p50/p95
  run time with debugger hold time subtracted.
- **Termination and context pressure.** Normalized finish reasons across LLM
  steps (the MCP server's `outputFinishReason` moved into the analyze package
  — one read everywhere), plus the input-tokens-per-step curve with its
  growth factor: the measurable signature of a context filling with tool
  output.
- The report states its own caveats: calls with unreadable inputs sit out
  duplicate matching, pre-0.6 token counts may exclude cached tokens, an
  unfinished run is a so-far. An empty run says "nothing to analyze" instead
  of pretending.
- **A realistic example to test all of it against**
  ([`examples/support-desk`](./examples/support-desk)): a support agent
  (Vercel AI SDK + Anthropic — `cp .env.example .env`, paste a key, done)
  with five ticket scenarios, each engineered so one feature has something
  real to catch — a clean baseline, a planted 100× refund bug for
  pause-on-error and edit-and-retry (retry with `amountUsd: 0.89` and watch
  it succeed), a `success: false` result for the silent-failure hold, a dead
  carrier lane plus a "retry transient errors" prompt rule for the loop
  guard and the behaviour report, and a knowledge base long enough to bend
  the context curve. The README doubles as a verification checklist: every
  failure is deterministic, so the debugger's claims can be checked against
  known ground truth.

### Added — hermetic replay (`graphmind replay`, `--assert`)

Every recorded run can now be run again, served from the recording:
`graphmind replay last -- node agent.js`. Tool calls are answered from what
they returned (or re-thrown, if they threw), model steps are served by a
replay model, and nothing reaches a provider — no API key, no token spend,
the same result every time. Your agent runs unchanged; the substitution
happens inside `@graphmind-ai/sdk`, which reads the `GRAPHMIND_REPLAY`
environment variable the command sets.

- **`--assert` turns a recording into a regression test.** It compares what
  the agent DID — which tools, in what order, with what arguments, and how
  many model turns — not the prose it produced, and classifies divergences
  rather than collapsing them: `regression` (a recorded call is gone or
  newly failed), `arguments` (same call, different arguments), `extra` (a
  call the recording never made) all fail; `alternative` (the same calls in
  a different order, which is just how parallel tool calls land) passes with
  a note.
- **CI needs no database and no key.** A recording exported with `graphmind
  record` is a plain NDJSON file; `graphmind replay fixtures/run.ndjson
  --assert -- node agent.js` reads it directly. A copy-paste workflow ships
  in `examples/support-desk/.github-workflow-example.yml`, deliberately with
  no API key configured: if a replay ever reached a provider, the job fails.
- **What is hermetic is printed before every replay**, not buried in docs:
  GraphMind serves what it gates — tool calls everywhere, model steps under
  the Vercel AI SDK adapter — and says plainly that the Anthropic, OpenAI
  and LangGraph adapters still call their provider, and that a bare `fetch`
  or a database write happens for real, again. `--dry` reports the coverage
  of a replay without running anything.
- **A divergence stops the run** rather than letting it finish as a silent
  mixture of replayed and live work: an unmatched call, or one whose
  arguments differ from the recording, is fatal by default
  (`--on-miss=live|skip` to change that). A value the recorder had to shrink
  (over the payload cap) refuses to answer rather than hand an agent a
  truncated result that looks whole (`--on-lossy=live` re-runs it).
- A new local gate decision, `throw`, replays a tool that failed as the
  failure it was. It exists only inside hermetic replay — the wire's
  `ResumeAction` has no such value, so no debugger can ever send one.

Scope, stated plainly: replay serves the model for the **Vercel AI SDK**
adapter only; the Anthropic, OpenAI, LangGraph, Python and Ruby adapters
replay their tool calls and still call their provider for model steps. What
a replay catches is therefore changes in YOUR code — a renamed tool, a
tightened schema, a lowered step cap, dropped orchestration — not a changed
tool body or a changed model, neither of which runs.

### Added — the counterfactual (`replay --substitute`, `--live-model`)

A recording says what happened; these say what *would* have happened.

- **`--substitute '<nodeId>[#n]=<json|@file>'`** replays the run up to that
  call, answers it with your value, and runs everything after it for real.
  In the bundled support-desk example, substituting a successful
  `refundPayment` turns the agent's apology into "I've refunded the full
  $89" — the same recording, a different ending, and no code changed.
  Repeatable; the cut lands at the earliest substitution, placed by
  envelope `seq` so the substituted call's parallel siblings are not
  mistaken for consequences of it.
- **A counterfactual is deliberately NOT hermetic, and says so.** Once one
  call returns something different the next model step sees a prompt that
  never existed, so the recorded reply would answer a question nobody
  asked. Past the cut the agent genuinely runs — provider calls, real
  tools, real tokens — which the CLI prints before starting and the
  adapter repeats as a warning on the model itself.
- **`--live-model`** is the mirror image: tool calls are served from the
  recording and every model step calls the provider. With the tool
  environment held identical to the recorded run, a change in behaviour is
  attributable to the change you made — a reworded tool description, a new
  system prompt, a different model.
- `--assert` is refused with either mode: asserting that a deliberate
  counterfactual did not diverge is a contradiction. The report reframes
  itself around what changed instead of passing or failing.
- **In the viewer**, a call's node place copies the whole `--substitute`
  command, pre-filled with what the call actually returned, so the edit is
  a diff against reality. The viewer composes the command and never runs
  it: executing a shell command on behalf of a web page would need a
  command-execution endpoint on the local server, which is a much larger
  security boundary than a debugger should move for a convenience.
- The Agent Skill (`graphmind skill`) teaches the loop, including which
  hypotheses each mode can and cannot prove.

### Added — the release pipeline covers all three registries

- **`.github/workflows/publish-ruby.yml`**: the `graphmind` gem now has a
  publish path — RubyGems Trusted Publishing (OIDC, no stored token), the
  gem built from the pristine checkout before any test dependency is
  installed, installed-and-loaded from the built artifact, pushed only from
  a `v*` tag, no-op on re-runs, and verified installable from the registry
  afterwards. (The gem itself ships with the first tagged release after the
  pending trusted publisher is configured on rubygems.org.)
- **`scripts/verify-published.mjs` checks PyPI and RubyGems too**, not just
  npm: `--registries npm|pypi|rubygems|all` (default `npm`, so the npm
  publish job is never blocked by a registry it does not publish to). Each
  publish workflow verifies its own registry; `pnpm verify:published` is the
  human's final check and now covers all eleven artifacts.
- **`graphmind record last`** exports the most recently started run — the
  same spelling `replay` and `runs --behavior` accept, because "export the
  run I just made" is the step right before both of them.

### Changed — one header, one section

The viewer framed its canvas on three sides — a run rail on the left, a
toolbar above, a debug bar below, an inspector docked on the right — and
asked a newcomer to work out which of the four they were supposed to be
reading. Every one of them was on screen on every screen, including the ones
with no canvas to act on.

It is now a stack of places with exactly one on screen at a time:

```text
runs  →  run  →  node
```

- **The breadcrumb in the header is the navigation.** `Runs › trip-planner ›
  currencyConvert`, every ancestor a link, <kbd>Esc</kbd> and the browser's
  back button walking the same path — each place is a hash URL, so every
  link `graphmind mcp`, `graphmind record --html` and <kbd>⇧</kbd><kbd>L</kbd>
  ever emitted still lands exactly where it says.
- **Runs is a place, not a 244px rail.** A card per run with how it ended,
  how big, how long, what it cost and the error it stopped on — enough to
  choose between two runs of the same app without opening either.
- **The runs list has a shape.** `graphmind serve` replays everything it has
  kept (two hundred runs, thirty days, by default) and the list used to be
  exactly that: one flat column, newest first. Now a strip of facets across
  the top says how the history went — **Live**, **Held**, **Failed**,
  **Done**, each a filter with its count; whatever is running or held is
  pinned in a **Live now** shelf above the history; the history is shelved
  by day (**Today**, **Yesterday**, **Earlier this week**, **Older**) or by
  app, each shelf with its own tally and long shelves folded to a preview;
  and a row is a table row, with the run's shape, time, tokens and est. cost
  in columns that line up with the row above it. The search matches the app,
  the run id and the error a run stopped on, and a header line says where
  the list comes from.
- **Connect and Build are cards, not corner buttons.** They sit in a column
  beside the runs list under **Start something**, which also keeps the table
  to a reading width instead of stretching a row across a wide window. The
  bundled demo is offered there too.
- **Connect an agent is two columns: what to do, and whether it worked.**
  The stack chooser shows every stack's recognition line rather than only
  the chosen one's — it was the only thing telling "MCP server you own" from
  "MCP server, via the proxy" apart, and you had to click to read it. Beside
  the steps, a live rail reports the three facts in the order they become
  true (a debugger on the endpoint, this tab attached, a first run recorded),
  so the page you are staring at while you edit your code is the one that
  tells you it worked, with a button into the run. A replay now says it is a
  replay instead of claiming "not connected" and "1 run recorded" at once.
- **A run card reads on its own.** The column header over the runs list
  is gone; each card carries its figures under their own small labels —
  nodes, llm, tools, errors · ran, held · tokens, est. cost — grouped by
  hairlines the way the run summary groups them above a graph.
- **The Build page says what it is building.** The bar names the project
  and its target; the "no server" banner is one quiet line (the canvas and
  the code never needed one); the rail's Node / Code / Run tabs are a
  segmented control carrying the one fact worth knowing before opening each
  — how many cards have a problem, how many files, how the run is going.
  The agent card's form splits into **Project** (name, language and
  framework as two rows of chips, provider, model, description) and
  **Agent** (steps, prompts); the Run tab is three numbered steps — create,
  credentials, run — with the reason a button is disabled written beside
  it; and the Code tab's file names get their own row instead of being cut
  to `src/main.` by the copy buttons.
### Added — component tests for the viewer

The viewer's suite was 751 pure-function tests and an end-to-end suite, with
nothing in between: every "is this button wired to that rule?" question was
answered either by a browser or by hand. There are now 85 component tests
(jsdom + Testing Library) driving the real pages against the real stores —
the runs list, Connect, Build, the header and the hold band — covering the
controls, what each one does to the state behind it, and what the page says
in each state it can be in. Every bug fixed by hand in this release is
pinned by one, so the regressions are the kind a test catches.

### Fixed

- **A project name could not contain a dash.** The Build page's name field
  slugified on every keystroke, and the slug trims a trailing dash — so
  typing "trip-bot" produced "tripbot", and the default name the page
  offers, `my-agent`, was one nobody could type. A dash is now kept while
  typing (`PROJECT_NAME_RE` allows it) and trimmed when the field is left.
- **Counts were glued to their labels for anything reading the page aloud.**
  The runs list's facet tiles and app chips are two spans, which concatenate
  to "1Failed" and "All apps3" as an accessible name. Each now carries a
  spelled-out one: "Failed, 1 run".
- **Two "Clear filters" buttons** appeared when a filter matched nothing —
  one in the "showing N of M" line and one in the empty block, identical and
  side by side. The line now yields to the block once the list is bare.
- **"Open the run" on the Build page opened the runs list instead.** It
  selected the run and then set the page to `runs`, and the second call
  undid the first — so the one button whose whole job is landing on a run
  landed on the list, with the run selected but out of sight.
- **"Group by" on the runs list offered a choice that could not act.** With
  one app on the list — the ordinary case just after building one — by-app
  and by-day draw the same single shelf, so the control looked broken. It
  now appears only when there is more than one app to group by, and
  withdraws once a filter has narrowed the list to one. Its label moved
  outside the track and the chosen option is lit, which it previously
  was not in any way you could see.
- **The app filter was easy to miss.** It was a 9px grey legend sharing a
  line with the source picker, the grouping control and the search, and it
  had no visible current value — nothing was lit when no app was chosen.
  It is now a row of its own under the facets, with an **All apps** chip,
  a count on each, and the chosen one filled; the "showing N of M" line
  names the app as well.

### Added — hermetic replay (`graphmind replay`, `--assert`)

Every recorded run can now be run again, served from the recording:
`graphmind replay last -- node agent.js`. Tool calls are answered from what
they returned (or re-thrown, if they threw), model steps are served by a
replay model, and nothing reaches a provider — no API key, no token spend,
the same result every time. Your agent runs unchanged; the substitution
happens inside `@graphmind-ai/sdk`, which reads the `GRAPHMIND_REPLAY`
environment variable the command sets.

- **`--assert` turns a recording into a regression test.** It compares what
  the agent DID — which tools, in what order, with what arguments, and how
  many model turns — not the prose it produced, and classifies divergences
  rather than collapsing them: `regression` (a recorded call is gone or
  newly failed), `arguments` (same call, different arguments), `extra` (a
  call the recording never made) all fail; `alternative` (the same calls in
  a different order, which is just how parallel tool calls land) passes with
  a note.
- **CI needs no database and no key.** A recording exported with `graphmind
  record` is a plain NDJSON file; `graphmind replay fixtures/run.ndjson
  --assert -- node agent.js` reads it directly. A copy-paste workflow ships
  in `examples/support-desk/.github-workflow-example.yml`, deliberately with
  no API key configured: if a replay ever reached a provider, the job fails.
- **What is hermetic is printed before every replay**, not buried in docs:
  GraphMind serves what it gates — tool calls everywhere, model steps under
  the Vercel AI SDK adapter — and says plainly that the Anthropic, OpenAI
  and LangGraph adapters still call their provider, and that a bare `fetch`
  or a database write happens for real, again. `--dry` reports the coverage
  of a replay without running anything.
- **A divergence stops the run** rather than letting it finish as a silent
  mixture of replayed and live work: an unmatched call, or one whose
  arguments differ from the recording, is fatal by default
  (`--on-miss=live|skip` to change that). A value the recorder had to shrink
  (over the payload cap) refuses to answer rather than hand an agent a
  truncated result that looks whole (`--on-lossy=live` re-runs it).
- A new local gate decision, `throw`, replays a tool that failed as the
  failure it was. It exists only inside hermetic replay — the wire's
  `ResumeAction` has no such value, so no debugger can ever send one.

Scope, stated plainly: replay serves the model for the **Vercel AI SDK**
adapter only; the Anthropic, OpenAI, LangGraph, Python and Ruby adapters
replay their tool calls and still call their provider for model steps. What
a replay catches is therefore changes in YOUR code — a renamed tool, a
tightened schema, a lowered step cap, dropped orchestration — not a changed
tool body or a changed model, neither of which runs.

### Added — the counterfactual (`replay --substitute`, `--live-model`)

A recording says what happened; these say what *would* have happened.

- **`--substitute '<nodeId>[#n]=<json|@file>'`** replays the run up to that
  call, answers it with your value, and runs everything after it for real.
  In the bundled support-desk example, substituting a successful
  `refundPayment` turns the agent's apology into "I've refunded the full
  $89" — the same recording, a different ending, and no code changed.
  Repeatable; the cut lands at the earliest substitution, placed by
  envelope `seq` so the substituted call's parallel siblings are not
  mistaken for consequences of it.
- **A counterfactual is deliberately NOT hermetic, and says so.** Once one
  call returns something different the next model step sees a prompt that
  never existed, so the recorded reply would answer a question nobody
  asked. Past the cut the agent genuinely runs — provider calls, real
  tools, real tokens — which the CLI prints before starting and the
  adapter repeats as a warning on the model itself.
- **`--live-model`** is the mirror image: tool calls are served from the
  recording and every model step calls the provider. With the tool
  environment held identical to the recorded run, a change in behaviour is
  attributable to the change you made — a reworded tool description, a new
  system prompt, a different model.
- `--assert` is refused with either mode: asserting that a deliberate
  counterfactual did not diverge is a contradiction. The report reframes
  itself around what changed instead of passing or failing.
- **In the viewer**, a call's node place copies the whole `--substitute`
  command, pre-filled with what the call actually returned, so the edit is
  a diff against reality. The viewer composes the command and never runs
  it: executing a shell command on behalf of a web page would need a
  command-execution endpoint on the local server, which is a much larger
  security boundary than a debugger should move for a convenience.
- The Agent Skill (`graphmind skill`) teaches the loop, including which
  hypotheses each mode can and cannot prove.

### Added — the release pipeline covers all three registries

- **`.github/workflows/publish-ruby.yml`**: the `graphmind` gem now has a
  publish path — RubyGems Trusted Publishing (OIDC, no stored token), the
  gem built from the pristine checkout before any test dependency is
  installed, installed-and-loaded from the built artifact, pushed only from
  a `v*` tag, no-op on re-runs, and verified installable from the registry
  afterwards. (The gem itself ships with the first tagged release after the
  pending trusted publisher is configured on rubygems.org.)
- **`scripts/verify-published.mjs` checks PyPI and RubyGems too**, not just
  npm: `--registries npm|pypi|rubygems|all` (default `npm`, so the npm
  publish job is never blocked by a registry it does not publish to). Each
  publish workflow verifies its own registry; `pnpm verify:published` is the
  human's final check and now covers all eleven artifacts.
- **`graphmind record last`** exports the most recently started run — the
  same spelling `replay` and `runs --behavior` accept, because "export the
  run I just made" is the step right before both of them.

### Changed — one header, one section (continued)

- **The graph gets the window.** No rail, no docked panel: a seven-node run
  has room and a three-hundred-node one has all of it.
- **A call is a page.** The decision row pinned above the evidence instead of
  a footer under a scroll, payloads in a reading column instead of a 392px
  gutter, and — new — <kbd>[</kbd> and <kbd>]</kbd> to walk the run in
  execution order without going back to the graph to hunt for the next call.
- **Side trips extend the trail instead of replacing it.** Connect and Build
  are taken from somewhere and expected to return there, so the breadcrumb
  keeps describing where the stack stood — `Runs › trip-planner ›
  currencyConvert › Connect an agent` — every ancestor stays a link, and
  <kbd>Esc</kbd> comes back to the exact call you left. They had been dead
  ends: one un-clickable crumb and no way out but the back button.
- **Every place is one click from every other**, in a menu under the
  GraphMind mark. Connect and Build used to be reachable only from the runs
  list, so getting to either from inside a run meant leaving the run first.
- **A held run gets a band under the header, on every place**, naming the
  call and why, with one click into it. It does not move you: seeing *where*
  in the shape a run stopped is most of the value of stopping it, so the
  graph stays. <kbd>C</kbd>/<kbd>S</kbd>/<kbd>R</kbd> still release a hold
  from the graph without navigating; <kbd>I</kbd> and <kbd>E</kbd> step into
  the call, because injecting and editing need the payload on screen.
- **The debug bar became a Debug menu.** Run/Step, Break everywhere and the
  armed breakpoints are session state, not a bar across every screen; the
  button carries the armed count and reads `Step` when stepping. Disabled
  controls now clear 3:1 contrast inside the menu's surface, which
  `--text-faint` did not.
- **Opening the first run is an opening move, not a standing rule.** A reader
  who asked for `#/runs`, or who stepped back up to the list, is no longer
  dragged out of it by the next run to arrive — and the setup guide no longer
  fires its timer at someone who has already navigated somewhere.
- The token `graphmind serve` puts in the viewer link is no longer mistaken
  for a requested place, so the first-run guide works on the path most people
  actually arrive by.

### Changed — the run page starts small and grows

The debugger showed everything it had about a node at once: the error, its
stack, the input that caused it twice over, the siblings, the timings, the
token counts, the totals across every execution, the streamed text, the
reasoning, the node id, who released the last hold. All of it is useful to
someone. Printing all of it to everyone, on the first run they ever open, is
how a debugger reads as a wall.

- **The run page ships as `essentials`** — the graph, four figures, and an
  inspector that answers what happened, what went in, what came out and how
  long it took. Five further panels (context and cost, per-node history,
  streamed text, the node id, the connection detail) exist and start switched
  off.
- **Customize the run page** chooses them, from the View menu, from a line at
  the bottom of the inspector, or from the palette. `Essentials` and
  `Everything` are shortcuts, not modes: change one toggle and you are in
  `custom`, with nothing lost and nothing to apply. The choice is stored in
  the browser and applies to every run.
- **Nothing a preset can reach can hide a hold.** The pause banner, the hold
  evidence and the Continue / Step / Retry / Inject / Edit / Abort row are not
  panels. A debugger that could be configured into not telling you it had
  stopped would be worse than no debugger, and a browser test asserts it under
  the shipped default.
- **The input is printed once.** "Why this failed" pins the failing call's
  input directly under the error, which is the right adjacency; the standalone
  Input section used to print the same JSON again two sections later, and now
  stands down whenever Why is carrying it.
- A panel added by a later release arrives switched off, even for someone who
  once chose `Everything` — choosing every panel that existed in 0.6 is not
  consent to every panel invented afterwards.

### Changed — "now what?" is one screen

The viewer answered "I just installed this, now what?" with everything it had
at once: a canvas, a card of four replay buttons, a three-line snippet with no
install step and no choice of SDK, eight figures in the toolbar and seven ways
to redraw the graph beside them. The features were there; the order was not.

- **Connect an agent** (`#/connect`, the header menu, or the palette). A
  viewer that opens with nothing attached and no runs goes here on its own,
  once per browser — never over a deep link, never over a replay, and never
  once a run exists.
- **One screen, no wizard.** Pick the SDK your agent already uses (seven, from
  the Vercel AI SDK to the MCP proxy) and copy the install command and the two
  lines it needs. Each stack carries its own honest statement of what a gate
  can do there — LangChain callbacks can hold a node but not change what it
  returns — stated *before* you wire it up, and whether anything is currently
  listening. The choice of stack is remembered.
- It is built from the debugger's own atoms: one surface, hairline-divided
  sections, a section label heading each, a copy on the right of the head
  row — the same shape as the inspector, so the first page most people see
  does not read as a docs site that wandered in. Both themes are now under
  the contrast-and-clipping audit on this page too.
- **The top bar carries four figures, not eight.** Nodes, errors, wall and est.
  cost — the ones you want before you look at the graph. LLM steps, tool calls,
  running vs held time and the token breakdown moved into **Totals**, whole,
  where they are never shed to fit. The run id, 110px of the bar nobody read,
  is now the tooltip on the deep-link button it always belonged to.
- **Panes, folding and the theme are one View menu** instead of five buttons
  and a segmented control. The button carries the folded count, so a graph
  hiding part of itself still says so. The theme is three radios rather than a
  cycler, and <kbd>D</kbd>, <kbd>⇧</kbd><kbd>T</kbd> and <kbd>⇧</kbd><kbd>C</kbd>
  are unchanged.
- **The run bar drops what cannot act.** On the connect page and the Build page
  the Run/Step toggle, Pause all, the breakpoint chips and the endpoint are
  absent rather than dimmed; the connection state, which is still true there,
  stays.
- The empty canvas offers one way forward and one aside (replay the demo)
  instead of four replay buttons and a keyboard legend.

### Changed — the Build page runs on its own

- **The canvas and the code need no server.** The generator and the spec are
  pure TypeScript, so the page now runs them itself: draw a workflow with
  nothing attached and the project is there, file by file, instantly, and it
  is the CLI's own generator compiled into the bundle rather than a second
  implementation that could drift. Validation came with it — a reserved word
  or a provider a target cannot call is flagged as you type. **Create**,
  **Run** and **Test connection** still use the local server, because
  writing files, spawning processes and opening a stdio MCP connection are
  things a browser cannot do, and the page now says exactly that when none is
  attached instead of failing at "the debugger server is not reachable".
- **One definition of a spec.** The viewer's hand-written copy of the spec
  types, the provider table and the target table is gone; it imports the real
  ones. The two could drift, and had.
- **Arriving stops teleporting you into a run.** Opening the first run on
  the machine was meant as an opening move — "clicking the only run there is
  is ceremony" — but it fired on every mount, so each reload against a server
  with a demo replay on it landed inside `#/run/demo-…` instead of the home
  page, with no way to simply be on the list. It now happens at most once per
  browser, and never for a demo replay, which is nobody's own work.
- **`pnpm dev` rebuilds what is stale.** It only ever built the workspace
  packages when `dist/` was missing, so an edit to `packages/*` ran silently
  against the previous build — "am I supposed to rebuild something?" is not a
  question to hold in your head while debugging something else.

### Fixed — the Build page from a checkout, and a tab without a token

- **`pnpm dev` can drive the builder.** The dev viewer is served by Vite on
  another port, so every Build page request was cross-origin: the browser
  discarded each answer for want of a CORS header, and the token was withheld
  from the other origin anyway. Now `graphmind serve` answers an
  **allow-listed** origin (`GRAPHMIND_ALLOWED_ORIGINS`, which `pnpm dev`
  already sets) with that origin — never `*`, never with credentials, and
  never at all on a server that allow-listed nothing. The Vite dev server also
  hands the viewer the running server's token, so inject and edit work from
  the hot-reload viewer with nothing to copy; a token obtained that way may go
  back to the loopback server it came from and nowhere else.
- **The builder needs no token.** It had been gated behind the viewer
  token like the control plane, so a tab opened at `127.0.0.1:4747` by hand,
  or the hot-reload viewer, could draw a workflow and do nothing with it. The
  page is for trying a workflow out before it is code; nothing it does needs
  the debugger's control plane, and the gate was friction with nothing behind
  it. Every `/api/builder` route is now open to any caller the origin guard
  admits. What that leaves open is stated in the security reference: another
  process on the same machine can create or run a builder project, or spawn
  an MCP command through the probe — on your own machine, as you already can.
  `GRAPHMIND_BUILDER_REQUIRE_TOKEN=1` puts the token back for a shared one.
- **Test connection reports instead of sitting still.** It was disabled when
  the page could not act, with the reason in a tooltip, which is
  indistinguishable from a broken button; it is now always clickable and
  answers every click — with the server's tools, with the failure, or with
  what is missing and how to supply it.
- **`#/build` survives a deep link in a development build.** Two effects raced
  on the first commit: the hash writer ran with the page's pre-navigation
  state and replaced `#/build` with `#/runs`, and React's double-invoked
  effects then read that back as the place the reader had asked for. The
  address bar is now the initial state, and the writer only reports changes to
  it.

### Added — build a workflow in the viewer

- **The Build page is a canvas** (`#/build`, the "Build a workflow" button in
  the run list, or the palette). Place the nodes you want to test and wire
  them by dragging from a card's edge; the right rail carries the selected
  node's fields, the code, and Create/Run. Four kinds of node:
  - **Agent** — the run: model, system prompt, task, step cap.
  - **Tool** — a function the model can call, with typed parameters and a stub
    result you replace in your editor.
  - **MCP server** — a server the agent connects to as a client, over stdio or
    Streamable HTTP, whose tools join the agent's list as `server_tool` and
    each of which is a node the debugger can hold. A server that needs a
    bearer token names the *variable* it comes from, never the token.
    **Test connection** connects to it the way the project will — the stdio
    command spawned with the MCP SDK's default environment, not the
    debugger's — lists the tools it publishes, and disconnects; click a
    listed tool to allow only it. A bearer token typed for the test is used
    once, scrubbed from the answer, and kept nowhere.
  - **Sub-agent** — a nested agent the root delegates to with one `task`
    string, running its own loop over the tools you wired to *it*.

  An edge means "this agent can use that", so the same tool can belong to the
  root, to a sub-agent, or to both; only edges the generators can emit can be
  drawn. The server's own generator shows the project the canvas becomes, file
  by file, already instrumented with the matching GraphMind adapter — so the
  snippet on screen is byte for byte what Create writes, and usable as-is if
  you would rather paste it into your own repository.

  Adding a node wires it to the agent the selection belongs to: select a
  sub-agent, or a tool it already owns, and the next **+ Tool** lands on that
  sub-agent rather than falling back to the root.

  Nine providers: Anthropic, OpenAI, Google (Gemini), Mistral, xAI, Groq,
  DeepSeek, OpenRouter, and a local Ollama, which needs no key at all. The
  OpenAI SDK targets reach every OpenAI-compatible one through its endpoint;
  the AI SDK target through its first-party `@ai-sdk/*` package or the
  `openai-compatible` shim. Each target offers the providers its SDK can
  reach, and the Run tab asks for the matching key by name.

  Five targets: TypeScript with the Vercel AI SDK, the Anthropic SDK or the
  OpenAI SDK; Python with the OpenAI or Anthropic SDK. MCP and sub-agent nodes
  generate for the three TypeScript targets (`src/mcp.ts`, `src/agents.ts`,
  and a shared `src/loop.ts` for the raw-SDK ones); selecting a Python target
  marks those cards and says why rather than dropping them quietly. Every
  value typed into the canvas is emitted as a string literal, never as code,
  and the generated TypeScript is checked in the test suite against the real
  provider and MCP packages.
- **Create** writes the project to `$GRAPHMIND_HOME/workflows/<name>` (or an
  absolute path), with `graphmind.workflow.json` beside the code so the page
  can list it again. A non-empty directory is refused unless overwrite is
  chosen, and overwrite rewrites only the generated files.
- **Your key need never touch the disk.** The Run tab asks where it should
  rest, and defaults to **this session only**: the server holds it in memory,
  hands it to the run's child process, and forgets it when it exits, when you
  click **Forget**, or after eight hours — nothing is written anywhere.
  Choosing **Save to .env** writes it to the project's `.env`, created
  owner-only and written atomically, so the project also runs from your own
  terminal. Either way the field is a password field, the value is sent once
  over loopback with the viewer token, the server reports variable *names* and
  never a value, and neither the spec file nor any generated source carries
  one.
- **Run** installs once (`npm install`, or a virtualenv and `pip install`) and
  starts the project with `GRAPHMIND_URL` pointing at this server. Output
  streams into the page with every `.env` value, every session-only key and
  every secret-named inherited variable replaced by `__REDACTED__` before a
  line is kept; the run
  appears live in the run list, one click away. Only directories the builder
  created can be run, with commands fixed by the target.
- **Access**: no token. The routes are open to whatever the origin guard
  admits — the viewer this server serves, an allow-listed origin, a local
  process — and `GRAPHMIND_BUILDER_REQUIRE_TOKEN=1` closes them to all but the
  viewer token. These are the first server routes that spawn a process from a
  request, and the security page says so.
- Security tests plant a key through both credential paths and assert where it
  ends up: the saved one in `.env` and nothing else, the session one in no
  file at all (every file under `$GRAPHMIND_HOME` is grepped for it) — and
  neither in a response, a listing, a spec file, a source file, a job log line
  or a server log line.
- **From a checkout, generated projects install.** A CLI running from the
  repository (whose version may be unpublished) packs the built adapters
  into `$GRAPHMIND_HOME/workflows/.packages/` and generates `file:` tarball
  dependencies (with `overrides` for `@graphmind-ai/client` and `schema`)
  and `graphmind-ai @ file://<checkout>/python`; a published CLI pins the
  registry. `GRAPHMIND_BUILDER_REGISTRY=1` forces the pins. The preview and
  the generated README say which one a project got.
- **Python >= 3.10 is found, not assumed.** macOS ships 3.9 as `python3`.
  The runner uses `GRAPHMIND_PYTHON` if set, else `uv` (`uv venv --python
  '>=3.10'`, interpreters kept under uv's own directory, the system Python
  untouched), else the newest `python3.X` on PATH that qualifies; with none,
  the job fails before anything is spawned and names the fix. The Build page
  shows which Python a project will run with. The Python SDK's own `Makefile`
  follows the same rule.
- **Unscoped Anthropic keys.** An API key not scoped to a workspace must name
  one per request. Anthropic projects get an optional `ANTHROPIC_WORKSPACE_ID`
  (a field on the Build page, a commented line in `.env.example`); when set,
  the generated code sends it as the `anthropic-workspace-id` header. A
  workspace-scoped key needs nothing.
- **Errors are readable where you are.** The error on a paused node's card
  clamps at five lines instead of one (the inspector still shows it in full),
  and the Build page now states the error its run is held on — a held error
  pauses the process, so it never reaches the job log — with a pointer to the
  run.

### Added — `graphmind help`, and a hand back up after a typo

- **`graphmind help`** lists every command with its one-line summary (the same
  list as `--help`); `graphmind help <command>` shows that command alone, and
  `graphmind help mcp-proxy` prints the proxy's dedicated setup page.
- **A mistyped command suggests the real one.** `graphmind sevre` answers
  `did you mean "serve"?`; an unambiguous prefix (`rec`) counts as a match. A
  transposition costs one edit; short names tolerate one edit, longer ones
  two, and nothing close enough means no guess at all.
- `graphmind help` records a `help` telemetry event — the name alone, like
  every command; `help record` and `help` send the identical payload.
  TELEMETRY.md's event list now names all thirteen commands (and no longer
  mentions `run-ingested`, which was never implemented). The maintainers'
  report gained charts: `telemetry-report.mjs --html` writes a
  self-contained SVG dashboard of the same aggregates it prints.

## 0.6.0

The release for the failures that don't throw. GraphMind now holds an agent on
an error-shaped tool result, a tool call the token limit cut off, the same
error again and again, or a repeating cycle of calls; lets you fix a held tool
call's arguments and run the real call; records token counts you can compare
from one step to the next and shows what changed between two LLM steps and
what it cost; and your coding agent can drive a paused run from the terminal.
Editing arguments, injecting results and changing breakpoints or step mode now
need a credential; a tokenless viewer can still continue, retry and abort
(deprecated). The smart holds and the new loop
kinds are TypeScript only in 0.6.0 (every TS adapter and `graphmind
mcp-proxy`); argument editing works in TypeScript and Python.

### Added — the debugger stops on the failures that don't throw (smart holds, loop kinds)

- **A tool that returned its failure holds** (`smart.rule: 'error-result'`).
  While a debugger is attached, an error-shaped result holds the call at its
  `after` gate: `isError: true`, `success: false`, a non-zero numeric
  `exit_code` / `exitCode` / `exitStatus`, or a plain object whose only key is
  `error`. Nothing else counts; no text is searched for "error". Under
  `graphmind mcp-proxy` an `isError: true` result is still gated at the tool's
  `error` point, as one hold carrying this rule whether or not the error
  breakpoint is armed; a JSON-RPC error stays an ordinary error hold.
- **A tool call the model could not finish holds** (`smart.rule:
  'truncated-tool-call'`): an LLM step the token limit or a content filter
  stopped (normalized `finishReason` `length` / `content-filter`) while it was
  requesting a tool call, whose arguments are then very likely cut off. It
  holds before your code has the result for AI SDK `generateText` steps,
  non-streaming OpenAI requests and Anthropic `messages.create`; a `streamText`
  step waits at its `finish` part, an Anthropic stream (`messages.stream()`
  too) before `message_stop`, LangChain and LangGraph at the end of the model
  run. A streamed OpenAI response is recorded but not held. The AI SDK,
  Anthropic and LangChain adapters gained these LLM `after` gates; detached,
  they are called with no options (a streamed AI SDK step is not gated at all).
- Both are **on by default** and hold only while attached.
  `GRAPHMIND_BREAK_ON_ERROR_RESULT` / `GRAPHMIND_BREAK_ON_TRUNCATED` set to `0`,
  `false`, `off` or `no` turn them off (any other value leaves them on), and the
  session options `breakOnErrorResult` / `breakOnTruncated` beat the
  environment. `smart.detail` is GraphMind's own sentence, never a quote of the
  result, and is left out under any HIDE switch that covers the node.
- **Two new loop kinds** under `reason: 'loop'`. `cycle`: 2 to 4 calls repeated
  in 3 identical laps — same tool, same arguments **and** same result at each
  position, at least two distinct calls per lap — held at the first call of the
  fourth lap. `error-repeat`: the same tool failed 3 times in a row with the
  same error (name and message; the arguments may differ), thrown or
  error-shaped, held before the 4th call; a success of that tool ends the
  streak. Both fill the four 0.5 loop fields, and `loop.kind` / `period` /
  `laps` say which. Their fingerprints are HMAC digests keyed with a random
  per-process salt that never leaves the process, and `"__REDACTED__"` under a
  covering HIDE switch.
  `GRAPHMIND_LOOP_ALLOW`, `GRAPHMIND_ON_LOOP` and `GRAPHMIND_LOOP_THRESHOLD=0`
  apply to them; the threshold itself still governs only the identical-repeat
  rule.
- **Every hold carries a `reason`**: `loop`, `breakpoint` (with `smart` for a
  smart hold), `step` or `error` — four values a 0.5 server already accepts.
- **The viewer says what held**: "Loop: search → fetch, 3 identical rounds
  (same arguments, same results). Holding round 4 at search.", "Repeated error:
  run_sql failed 3× in a row with the same error (arguments varied).", a
  sentence per smart rule, the cycle's laps outlined on the canvas and the
  evidence in the inspector.

### Added — fix a held tool call's arguments, and the real call runs (edit arguments)

- **Edit arguments…** (key `e`) on a held tool call the app marked `editable`.
  The editor opens on the call's live arguments (after an accepted edit, the
  ones it last ran with), lists the keys you changed and sends **only those**:
  every other key keeps its live value, so a long argument you never touched is
  never replaced by its recorded preview. **Run with N changes** at a `before`
  gate (`continue` + `input`), **Retry with N changes** at an `after` or `error`
  gate (`retry` + `input`). The real tool runs, and the agent carries on with
  its result.
- **Checked by the tool's own schema, in the app.** The edit's top-level keys
  replace the live ones and the merged arguments go through the tool's schema —
  AI SDK `asSchema(tool.inputSchema).validate`, zod, any Standard Schema, the
  `inputSchema` from the server's last `tools/list` for `mcp-proxy`, the
  function's signature in Python — on the host's own task, within 4 s. A
  refusal comes back as `exec.refused` with a reason that never quotes your
  value, and the call **stays held** under the same pause; a disconnect or a
  pause timeout while validating continues with the original arguments. A
  schema's transforms never run twice on arguments you did not touch: the edit
  is merged into the model's raw arguments and parsed once (AI SDK, LangChain
  `tool()`), and where those cannot be recovered (a high-level McpServer tool)
  a partial edit is taken only when the schema leaves the parsed arguments
  unchanged; otherwise every argument must be given.
- **This call only.** The model still sees the arguments it asked for, and a
  later call of the same tool starts from the model's arguments again. A plain
  Retry after an accepted edit re-runs the edited arguments. The release records
  `exec.resumed.edited {after}` with what actually ran — the viewer marks the
  call **edited** and shows *asked for* next to *ran with* — and who released
  it.
- **Where:** every wrapped AI SDK tool (streaming tools at their `before`
  gate); Anthropic and OpenAI wrapped tools called with one object of arguments
  (OpenAI: or its JSON text); LangGraph `wrapStructuredTool` / `gm.tool`;
  `@graphmind-ai/mcp` tools registered with an input schema; every `tools/call`
  through `graphmind mcp-proxy` (only `arguments` can change, spliced into the
  frame's original bytes, so an id above 2^53 and `_meta` reach the server
  unchanged); Python `@gm.tool` / `gm.wrap_tools`. LLM steps are not editable in
  0.6.0, and the Ruby gem does not take edits.
- **Guarded.** It needs a 0.6.0 app and server, a credential (the viewer's
  token, or the agent token at `--allow-control=edit`), and an app and server
  that did not switch it off (`GRAPHMIND_DISABLE_EDIT_INPUT`, `serve
  --no-edit-input`). Under `GRAPHMIND_HIDE_INPUTS` / `GRAPHMIND_HIDE_TOOL_ARGS`
  an edit is a full replacement, so its answer never reveals the hidden values,
  and `edited.after` is hidden too. An edit that still holds `"__REDACTED__"`, a
  truncation marker or a `graphmind mcp` preview is refused by the app and by
  the server. Parallel calls of one tool can each be edited: the pause names the
  call it holds (`exec.paused.instanceId`).
- From a terminal: `graphmind resume <pauseId> --run <id> --action retry
  --input '{"limit": 50}'` (or `--input @args.json`).

### Added — drive a paused agent from your coding agent (control plane)

- **`graphmind pauses`, `graphmind wait`, `graphmind resume`.** `wait` blocks
  until a pause opens and prints it compactly — the held call's input (large
  values go to a private temp file), whether it is editable, and the exact
  `resume` commands that apply. `resume <pauseId> --run <id> --action
  continue|retry|inject|abort [--output …] [--input …]` waits for the app's
  answer. `--json` everywhere; documented exit codes (0 ok, 2 timeout, 3 no
  0.6+ server — none, or an older version, named — 4 nothing to act on, 5 not
  authorized, 6 refused, 7 taken). Suggested commands are ready to paste (ids
  shell-quoted, `--port` named off the default port); app-written text is
  printed with control and bidi characters escaped; `wait` never polls faster
  than once a second.
- **`graphmind serve --json`** prints `{port, url, pid, version}` — never a
  token — for running the debugger headless.
- **`graphmind skill [--install]`**: a Claude Code Agent Skill
  (`skills/graphmind/SKILL.md`, shipped in the package) covering setup per
  framework, headless serve and the pause/wait/resume loop.
- **HTTP**: `GET /api/pauses[?runId=][&wait=]`, `GET
  /api/runs/:runId/pauses/:pauseId`, `GET /api/session`, `POST
  /api/runs/:runId/pauses/:pauseId/resume` (Bearer + JSON only, no CORS,
  long-poll ≤ 120 s, ≤ 16 at once).
- **First writer wins.** The server keeps a registry of held pauses (per run)
  and referees every resume — from any viewer tab, the CLI or HTTP: the first
  is forwarded with a `requestId`, others get `pause-taken`, a pause known to be
  closed gets `no-such-pause`. An app's refusal, or 5 s without an answer,
  reopens it. A resume the app answers late is still told what the app did
  (`resumed` if it ran; the others `superseded`); an answer without a
  `requestId`, from an app that says it echoes them (`request-id`), is a
  release nobody asked for, and an old client's un-echoed answer is credited
  only to a resume that asked for that action. Resumes for made-up pause ids,
  and tokenless long-polls (at most 8 of the 16 slots), cannot crowd out a real
  one; a peer cannot take over a live run by flooding fresh run ids — not
  while its app is connected, nor while it reconnects — and the flood no
  longer reopens finished or abandoned runs to another connection.
- **Audit.** The stored `exec.resumed` records who released it (`principal`:
  `viewer`, `agent` or `anonymous`, from the credential — never from the app)
  and an optional sanitized `operator` label. The viewer shows "resumed by
  agent" and, in the run bar, its own control level and the agent's.
- **The viewer says why a resume did not land.** The server's own answers —
  `pause-taken` (another tab or `graphmind resume` got there first),
  `no-such-pause`, `still-resolving`, `not-editable`, `edit-refused`,
  `forbidden` — reach the pause they are about, in plain words: in the argument
  editor (matched to its request by the `requestId` the server echoes on an
  immediate refusal, with the `outcome`) and under the pause row or card,
  instead of the editor waiting 10 s and saying the app had not answered. A tab
  offers only what the server will accept from it: without the token, Continue,
  Retry and Abort, with a note saying why.

### Added — what changed between two LLM steps, and what it cost (context view)

- **Context & cost**, at the top of an LLM step in the inspector: tokens in
  (the whole prompt, cached tokens included — or "as reported" for events
  recorded before 0.6), tokens out, cache read / cache write / reasoning when
  the provider reported them, how full the model's context window was, and
  the step's and the run's cost so far.
- **Prompt diff against the previous LLM step of the same agent**: the first
  message that differs, the messages added, removed ("trimmed?") or changed
  (open any of them), the system prompt as a line diff, tools added, removed
  or changed by schema hash (a changed tool opens as a diff of its two
  recorded definitions), changed sampling parameters and model, and where a
  provider's prompt cache stops matching (tools → system → messages). Moving a
  cache breakpoint is not a change. The diff **refuses, and says why**, when
  either side is not the prompt that was sent: shrunk to the 512 KB event
  limit, redacted, a preview, a batch, or a server-side conversation
  (`previous_response_id`).
- **"Held 8 min before this call — the provider's 5-minute prompt cache has
  likely expired"** when a gate hold (or, labelled differently, idle time)
  pushed a step past the cache lifetime.
- **Cost from a bundled price snapshot** —
  [genai-prices](https://github.com/pydantic/genai-prices) (MIT, notice
  shipped as `THIRD_PARTY_NOTICES.txt`), per model, with cache reads and
  writes at their own rates, labelled "≈ est. (prices as of 2026-09-22)". A
  model the snapshot does not know gets **no dollar figure**. This replaces
  the flat $3 / $15 per million tokens estimate in the top bar and the
  inspector. The table is a separate chunk the viewer fetches only for a run
  with token usage. A single-file export (`graphmind record --html`) of such a
  run carries the table inside the file, so it prices the run offline too, and
  loads nothing at open time: it used to look for the chunk beside the file
  (fetching and running whatever sat there when served from a folder, and
  failing with CORS errors from disk), and now a Content-Security-Policy
  forbids loading anything.

### Changed — token counts you can compare, and each LLM step recorded as it was sent (usage truth)

- **`inputTokens` is the whole prompt, cached tokens included**, marked
  `inclusive: true`, in every adapter and in Python and Ruby. Providers
  disagree — Anthropic's `input_tokens` is only the uncached tail, OpenAI's
  already includes cached tokens, ruby_llm 2.0 counts input without cache — so
  each adapter adds the cache counts back where its provider left them out
  (Anthropic's 5m / 1h cache-write split too, also when LangChain reports the
  split and zeroes `cache_creation`). `cacheReadTokens`, `cacheWriteTokens` and
  `reasoningTokens` (OpenAI's reasoning tokens; Anthropic's thinking tokens in
  TypeScript and Python) appear only when the provider reported them: a
  reported 0 stays 0, and a missing count is never filled with 0 (Python used
  to). The legacy `cacheCreationTokens` / `cachedInputTokens` stay as aliases
  through 0.6.x. A failed AI SDK or Anthropic (TypeScript) stream keeps the
  usage it had already reported. The viewer and `graphmind mcp` trust
  `inclusive` and label older events "as reported".
- **Every LLM step's output says why it stopped and what it asked for**:
  `finishReason` normalized to `stop`, `length`, `tool-calls`,
  `content-filter`, `error` or `other` (an OpenAI refusal is `content-filter`,
  Anthropic's `pause_turn` is `other`), the provider's own `rawFinishReason`,
  and `toolCalls: [{id?, name, input, inputText?}]`, where `inputText` holds
  arguments that did not parse, such as a call cut off mid-stream (from a
  Python Anthropic `messages.stream()` too, which used to report the SDK's
  partial parse as a complete call — whichever way the host reads the stream,
  and on older `anthropic` releases as well as current ones). An OpenAI Responses stream that ends early
  (TypeScript) still lists the calls requested so far, and streamed custom tool
  calls are recorded. The Python OpenAI Responses output no longer carries the
  raw `output` items next to `toolCalls`, so the tool switches cover those
  arguments. `toolCalls` fall under `GRAPHMIND_HIDE_OUTPUTS`, and their
  arguments also under `GRAPHMIND_HIDE_TOOL_ARGS` and `GRAPHMIND_HIDE_INPUTS`.
- **Each step's input is the request as sent**: the prompt in full (the
  LangGraph 20,000-character preview is opt-in only, the Ruby 12-message /
  2,000-character trim and the Python caps are gone; the 512 KB event limit is
  the one bound), the sampling parameters from an allow-list under the SDK's
  own names (headers and provider options, which can carry credentials, are
  never recorded), and `tools: [{name, schemaHash}]` with each tool's full
  definition sent once per run as `toolSchemas`. A definition the 512 KB limit
  shrank is sent again, intact, on the run's next step.
- **A tool definition never records a credential.** Outside its schema, keys
  that look like an authorization, header, token, secret, password, key,
  cookie, credential or bearer are dropped, and any `*url` value loses its
  user:password, query and fragment — which the OpenAI `mcp` tool and the AI
  SDK's `openai.mcp` can carry — in TypeScript, Python and Ruby alike, before
  the definition is hashed.
- One shared fixture (`packages/client/test/fixtures/llm.json`) holds the
  TypeScript, Python and Ruby adapters to the same usage mappings, finish
  reasons, tool calls, schema hashes, parameter allow-list and credential
  scrubbing.

### Changed — control needs a credential (security)

- At start the server mints a **viewer** token (full control; reaches the
  browser only in the `#token=` URL fragment, through a private redirect file
  the CLI opens — never a command-line URL; printed only to a terminal) and an
  **agent** token (`~/.graphmind/run/serve-<port>.json`, 0600) that
  **`serve --allow-control=off|resume|inject|edit`** limits in the server.
  Default `off`: the agent token can do nothing until you allow it (not even
  start the demo).
- **Input edits**, **injected results**, **breakpoints and step mode**, and
  **every non-GET `/api` route** (including `POST /api/demo/start`) need a
  token. An injected LLM completion picks the next tool call and its
  arguments, so it is guarded like an edit. `?token=` and cookies are never accepted.
  `serve --no-edit-input` refuses all edits. The server also refuses edited
  inputs and injected values that still contain `__REDACTED__` or a truncation
  marker, using the client's own marker list.
- **Deprecated:** a viewer socket without a token still continues, retries
  and aborts as in 0.5 — whatever `--allow-control` says — but never injects,
  edits, or changes breakpoints or step mode; the server logs a one-time note.
  Reading runs still needs no credential — any local process can read them over
  loopback.
- Every response now carries `Content-Security-Policy: frame-ancestors
  'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff` (`/api` adds `Cache-Control: no-store`): the
  viewer can no longer be framed.
- `graphmind mcp` is unchanged and still read-only; its instructions now say
  where control lives and that recorded payloads are untrusted data.

### Fixed — security, found reviewing this release before it shipped

- **The viewer's token goes only to the page's own server.** It is checked
  against the server that served the page, never a `?server=` target; a failed
  check drops only the token that failed; a tab picks up a newer token another
  tab stored; and a `#token=` link replaces a working token only after the
  server confirms it.
- **A tokenless viewer socket could steer the run.** It could inject a result —
  an injected LLM completion chooses the next tool call and its arguments — and
  arm breakpoints. It is now limited to continue, retry and abort (see above).
- **A resumer's `requestId` never carries control characters, and app-written
  ids and text are escaped wherever they are printed.** The server forwards a
  `requestId` only when it is 1 to 128 of `A-Z a-z 0-9 . _ : -` (otherwise it
  mints a UUID). Run, node and pause ids an app writes are stored as sent; the
  server's log and the CLI print them, and any app-written text, with control
  and bidi characters escaped.
- **Tool definitions and Python Responses output** could record credentials
  and hidden tool arguments (see *usage truth* above).

### Fixed — a privacy switch no longer fails open on spelling

`GRAPHMIND_HIDE_INPUTS=yes` recorded everything: only `1` and `true` counted,
and `GRAPHMIND_DISABLED` counted only the exact string `1`, so
`GRAPHMIND_DISABLED=true` left instrumentation on. Every kill switch and
privacy switch — `GRAPHMIND_HIDE_INPUTS/OUTPUTS/TOOL_ARGS/TOOL_RESULTS`,
`GRAPHMIND_DISABLED`, and `DO_NOT_TRACK` in the CLI — is now **on for any value
except unset, empty, `0`, `false`, `off` and `no`** (any case, surrounding
spaces ignored), identically in TypeScript, Python and Ruby. A typo hides
rather than records. If you set one of these to an unusual value meaning
"off", change it to `0`.

### Fixed — Python SDK: framework calls that were invisible or broke on inject

- **Streamed and raw-response calls are recorded.** The OpenAI Agents SDK's
  `Runner.run_streamed` goes through `with_streaming_response`, which reached
  the instrumented method with a raw-response header; the node was created
  but its output was empty. The wrapper now recognises raw responses, tees
  streamed bodies without changing what the caller reads, and records text
  and usage. It no longer matters whether `with_streaming_response` was
  touched before or after `instrument_openai`, and each call is one node.
- **`client.beta.messages.create` / `.parse` / `.stream`** (and
  `messages.parse`) are gated like `messages.create` — Pydantic AI's
  Anthropic model and Anthropic's own tool runner use them.
- **Injected replies come back as the SDK's own types** (`ChatCompletion`,
  `Response`, `Message`, `BetaMessage` and their `Parsed*` variants) instead
  of a raw dict, so frameworks that read `.output`, `.usage` or `.id` keep
  working. A bare string becomes a minimal assistant reply; a value that does
  not validate is passed through unchanged with one warning naming the field.
  A streaming call cannot be injected into: it continues, with a warning.
- The docs show `set_default_openai_client(gm.instrument_openai(AsyncOpenAI()))`
  for the OpenAI Agents SDK and passing an instrumented client to Pydantic AI
  providers. The frameworks themselves are not in the test suite; the client
  calls they make are.

### Fixed — the viewer

- **Parallel calls of one tool that hold at once are all shown.** The card
  showed the newest hold while `c` released another one, `e` opened nothing,
  and releasing the shown hold dropped the node back to running while the
  other call was still held. The card now shows one hold and counts the rest
  ("+1 held"), the inspector's footer has one row per held call, named, and
  every key acts on the hold on screen; releasing one falls back to the next.
- **"Why this failed" belongs to the call that failed.** With parallel calls
  an error was pinned on whichever call was still running (a sibling that went
  on to succeed kept it for good), and the inspector opened on the latest call
  instead of the held one. A call held before it ran (an error-repeat hold)
  no longer shows the previous call's error as its own, and a call that failed
  and then succeeded on retry says so as history.
- **The top bar counts tokens once.** An agent that reports the sum of its
  steps (the bundled demo; an AI SDK OpenTelemetry import) was added to the
  steps themselves.
- **A tab without the token** is no longer offered run/step mode, "Break
  everywhere", breakpoint dots or their palette actions, which the server
  refuses: they are disabled and say why.

### Added — Python and Ruby speak the 0.6.0 pause protocol

- **Python: edit a held tool call's arguments.** `@gm.tool` / `gm.wrap_tools`
  offer every gate of a call whose arguments bind to the signature as
  editable; `continue` + input at `before`, `retry` + input at `after` /
  `error` run the real function with the edit merged into the live arguments
  and checked against the signature — on the host's own thread or task, never
  the transport's, within 4 s (synchronous work included). A refused edit
  (`exec.refused`) keeps the call held under the same pause id; a disconnect or
  pause timeout during validation continues with the original input. Hidden
  inputs take only full replacements; `GRAPHMIND_DISABLE_EDIT_INPUT` turns it
  off; the redactor covers `exec.resumed.edited` and `exec.refused.message`.
  `session.gate()` / `gate_async()` take `editable=`, `validate_input=` and
  `result=`; `gm.merge_tool_input` is the default rule. Its pauses name the
  held execution (`exec.paused.instanceId`).
- **Python and Ruby** echo `requestId` and say so in their handshake
  (`request-id`, whatever `GRAPHMIND_DISABLE_EDIT_INPUT` says), read
  `hello.ack.hubCapabilities`, and refuse an injected value that still holds
  `__REDACTED__` or a truncated preview under every debugger (the gate stays
  held; a 0.5 debugger also gets a log line). Ruby does not announce
  `edit-input`; an edit that reaches it is refused (`disabled`) rather than
  dropped.
- Not ported yet: the smart holds and the `cycle` / `error-repeat` loop kinds.
  The Python and Ruby identical-repeat loop hold is unchanged.
- The marker list gained the Python SDK's own recording bounds (`…[truncated]`,
  `<N bytes>`, `…[depth limit]`, `…[N more]`, `[N more keys]`), in the client
  and the server alike. New shared conformance fixture
  `packages/client/test/fixtures/edit-input.json` (markers, pollution keys,
  validator results, message sanitising, the merge rule), consumed by the
  TypeScript, Python and Ruby suites; `redaction.json` gained the pause answers.

### Docs

- New page: **Edit arguments and run** (the editor, what happens to an edit,
  where it works, who may use it, the CLI).
- The environment reference covers the smart holds, the loop kinds and the new
  switches; the CLI reference the control commands, their exit codes and the
  HTTP routes; *Inspecting* the usage semantics and the Context & cost view;
  the wire protocol every 0.6.0 field; `SECURITY.md` and the security page the
  control credentials and the tokenless gap that remains; *Remote development*
  the `#token=` link.

### Wire protocol (additive — every 0.5 peer accepts or ignores these)

- `exec.paused.editable`, `exec.paused.smart {rule, detail?}`,
  `exec.paused.loop.kind / period / laps`, `exec.paused.instanceId` (the held
  execution, when the sender knows it)
- new event `exec.refused {pauseId, code, message?, requestId?}` — an edited
  input was refused and the gate is still held
- `exec.resume.input / requestId`; `exec.resumed.edited {after} / requestId /
  principal`
- `hello.ack.hubCapabilities`; client capabilities `edit-input` and
  `request-id` (it echoes `requestId`; announced even with edits switched off)
- `TokenUsage.inclusive / cacheReadTokens / cacheWriteTokens / reasoningTokens`
- The server's viewer socket (`/ws/ui`, not the app's wire): `welcome.control`
  (the tab's principal, the agent level, whether edits are on),
  `resume.result`, and `code` / `pauseId` / `outcome` / `requestId` on `error`

New loop kinds keep `reason: "loop"` and still fill the four 0.5 loop fields;
smart holds travel as `reason: "breakpoint"` so a 0.5 debugger, whose reason
list is closed, still shows the pause.

## 0.5.1

A patch release, and the first GitHub Release and PyPI upload of the 0.5 line:
npm 0.5.0 shipped from the laptop, and CI on its tip then failed on Linux, so
0.5.0 was never tagged. Everything in [0.5.0](#050) below is included; Python
goes straight from 0.4.4 to 0.5.1.

### Fixed — `mcp-proxy --wait-for-attach` and a server that dies on boot

The case the early-death diagnostics exist for, and the one flag that broke it.
With `--wait-for-attach` the proxy left the server's stdout and stderr unread
until a debugger attached (or the 3 s wait ran out). Three things went wrong:

- **The server's stderr was lost.** Node's `child_process` resumes every
  unread stdio stream when the child exits and emits its bytes to no one. A
  server that crashed before the wait was over had its whole stack trace
  discarded — not mirrored to the MCP host, not quoted in the report.
- **The proxy never exited.** The stdout relay was attached after the stream
  had already ended, so it waited for an `end` that had already happened. With
  stdin held open (as every MCP host holds it) the proxy hung; with stdin
  closed it exited **0** instead of the server's code.
- **The crash reason could be cut off even when a debugger was attached.**
  stdio is a socketpair; a few hundred small unread writes fill its buffer,
  after which a Node server's writes queue in-process and die with it at
  `process.exit`. The lost lines are the last ones — the reason. On Linux this
  failed every time; a Python server's blocking writes would instead hang.

Both streams are now read from the moment the server is spawned. stderr is
mirrored to the host immediately and buffered (bounded, 256 KB, oldest out)
for the graph until the run opens; stdout is piped into a buffer the relay
reads when it starts, so nothing is dropped and a server that is already gone
still ends the session with its own exit code. A held gate still stops the
server-to-client direction (backpressure reaches the child once the buffer
fills). New test: a server logs 3,000 lines and exits while the attach wait
runs its course — every line reaches the host and the report quotes the tail.

### Fixed — ruby_llm 2.0

ruby_llm 2.0 shipped during the 0.5.0 release and changed the signatures of
the private hooks the Ruby gem patches
(`provider_completion(usage_recorder:, stream_tracker:)`,
`Tool#call(tool_call:, **arguments)`) and removed `Chat#with_tool`. The
1.x-shaped patches raised `ArgumentError` inside the user's chat — even with
no viewer attached. Every patch now forwards whatever arguments it gets; tool
input is read from either calling convention (RubyLLM's own `tool_call:`
object is left out of it); usage and model are read from either `Message`
shape; only registration methods the chat really has are patched, so
`respond_to?` never lies. CI runs the Ruby suite against the newest ruby_llm
and, in its own cell, the last 1.x. Two new tests drive a tool through the
gem's real chat loop instead of calling it directly. The docs' snippet uses
`with_tools`, which both majors have.

### Fixed — tests that only passed on macOS

- A redaction test checked a 5,000-level value with `JSON.stringify`, which
  is recursive in V8 and overflows on Linux x64 but not on macOS arm64. The
  walk under test was already iterative; the assertion is now iterative too.
- The stderr-tail test above failed on every Linux run for the reason above;
  it was a real defect, not a flaky test.

## 0.5.0

The release for the reviewer who has not decided yet: the platform engineer
who opens the repo before opening the tool. Everything here was chosen after a
research pass on the September 2026 landscape and an adversarial refutation of
each candidate; the things that did not survive that are not in here.

### Fixed — edges start and end on the cards, and never cross one

Two defects hid behind "the edges look detached". The first was the known one:
with five or more childless siblings the layout packs them into a grid, and the
parent's bezier to a row-two card went straight through the row-one card above
it (6 of 11 edges on a real MCP session). Edges are now routed orthogonally:
down from the parent to a bus line in the layer gap, across, then down the
column **gutter** to the target and in through its top handle, so a fan-out
reads as one trunk with drops. The second was the real reason they looked
loose: React Flow measures a node's handle positions once, when it mounts, and
our cards mount mid entrance animation — so every edge was anchored to a
phantom handle 60–100px from where the card ended up, for the life of the node.
The canvas now draws edges from the layout's own geometry and ignores the
measured handles. Both are guarded by a geometry harness: eleven fixtures
(demo, MCP, 5/11/30-leaf fans, three nested levels, the 300-node stress run)
must have zero edge–card crossings and zero overlapping cards, and a browser
test samples the painted SVG paths every 4px against the real card boxes.

### Changed — an MCP session shows the work and folds the protocol

`graphmind mcp-proxy` used to render a session as eleven flat siblings, six of
which were `initialize`, `notifications/initialized`, `tools/list`,
`resources/list`, `prompts/list` and `ping`. Protocol traffic — handshake,
discovery, keepalive, and any method GraphMind does not recognise — is now
parented under one node named **protocol**, emitted with a new `collapsed`
hint so the viewer opens it folded with a count ("6 protocol calls · 702ms");
the work (`tools/call`, `resources/read`, `prompts/get`,
`sampling/createMessage`, `elicitation/*`, `completion/complete`) sits directly
under the session. Every folded call is still a node: a breakpoint on `ping`
still holds, a failing `initialize` still pauses on the error gate and turns
the folded card red. Work is recognised in the direction the protocol sends
it: a `tools/call` travelling *from* the server (an echoing or hostile peer)
is protocol traffic, not a second tool call — it used to be recorded as one.

Three silent failures now speak. A server that logs to **stdout** (the MCP
wire) — a `console.log`, or a structured logger writing one JSON object per
line — gets one stderr line quoting the offending bytes with the fix, and a red
"stdout noise" node under **protocol**; the bytes are still relayed unchanged.
A command that cannot be spawned — `ENOENT`, or on Windows the synchronous
`EINVAL` a `.cmd` target used to throw as a stack trace — prints one plain
line, exits 127, and lands on the graph as a `SpawnError`. A server that exits
before its first response prints the exit reason with the tail of its stderr
(last 200 lines / 32KB kept) and puts both on the session node; Windows
NTSTATUS exit codes are named. Such a session also ends its **run** with
`status: error` — before, the node was red and the run list said `ok`.

### Changed — durations are measured, and held time is not run time

Every SDK timed nodes with the wall clock at millisecond resolution, so an MCP
handler that took 80µs read `0ms` — a debugger saying it cannot measure. All
three SDKs and the proxy now use a monotonic high-resolution clock
(`performance.now()`, `time.perf_counter()`, `CLOCK_MONOTONIC`); `durationMs`
is fractional to 0.01ms and the viewer renders `<0.1ms`, one decimal under
10ms, integer ms under a second.

And the developer's thinking time no longer counts as the agent's. While a
gate is held, the node's duration kept running, so forty seconds at a
breakpoint became a forty-second tool call that the slow filter, the stats and
the exports treated as slow. `node.finished` and `node.error` now carry
`heldMs` — the time this execution spent held at gates, including holds on
its descendants — and every place the viewer shows, filters, sums or exports
a duration uses **ran = durationMs − heldMs**: cards read `ran 2.4ms · held
38.1s`, the timeline hatches the held part of a bar, the run list subtracts it.
`durationMs` keeps its meaning (wall clock, held time included), so recorded
runs and importers see no change; the viewer also derives held time from
`exec.paused`/`exec.resumed` timestamps for streams that predate the field.

### Added — releases a security reviewer can verify

- **`publish-npm.yml`**: on a `v*` tag, builds, runs the full battery, checks
  the tag against all ten declared versions, publishes the eight packages with
  `pnpm -r publish --provenance` (npm's own `publish` does not rewrite
  `workspace:*` and would ship uninstallable manifests — the workflow opens
  every tarball to prove none survived), verifies the attestations and
  `npm audit signatures` from a clean registry install, and creates a GitHub
  Release with the tarballs, a CycloneDX 1.6 SBOM and `SHA256SUMS`. Idempotent:
  a re-run for a published version is a no-op, a partial publish fails naming
  the missing packages, a pre-release tag goes out under `next`, never
  `latest`. Uses npm Trusted Publishing (OIDC) once the maintainer configures
  it, `NPM_TOKEN` as a fallback, and a `dry_run` dispatch that does everything
  but publish. The Python workflow now builds with a hash-pinned front-end
  **and** back-end (`hatchling`), in a non-isolated environment.
- **`DO_NOT_TRACK=1`** (or `true`) disables telemetry unconditionally — it
  beats every `GRAPHMIND_TELEMETRY` value including `1`. **`GRAPHMIND_TELEMETRY=log`**
  prints the exact payload to stderr and sends nothing.
- **SECURITY.md** rewritten: supported versions, disclosure targets a solo
  maintainer can keep, how to verify a release, and a localhost threat model
  that maps CVE-2025-49596 (MCP Inspector) onto GraphMind precisely — the hub
  binds loopback, browser-originated control frames are rejected (now proven by
  a test), nothing spawns commands from network input, and any local process
  running as you can connect, which is stated rather than hidden.
- A **Security & compliance** page in the docs, written for the reviewer.

### Fixed — CI told the truth again

- The Ruby suite hung to the 15-minute limit in every run: `ruby/Gemfile.lock`
  is git-ignored, `json` 3.0 shipped on 2026-09-07, and faraday 2.14.3's JSON
  middleware still calls `JSON.parse(body, opts)` positionally, so every
  ruby-openai request raised and the retry-at-error-gate test re-sent forever.
  `json` is pinned below 3 in the test group with the reason inline, and every
  thread wait in the suite is bounded — a hang is now a named failure in 10s.
- A Python test read the frame list the instant `run.started` arrived, before
  the two `node.started` frames — a race only a slow Windows runner loses.
- A viewer e2e sampled a token stream twice and demanded a change between the
  samples; on a two-worker runner the whole stream can land in between.
- python and ruby jobs now emit their failing output as annotations, because
  job logs need a GitHub login and annotations do not.

### Wire protocol

Additive, all optional, schema major unchanged: `node.started.collapsed`,
`node.finished.heldMs` / `node.error.heldMs`, `exec.paused.reason` and
`exec.paused.loop`, and a `redaction {count, keys}` summary on events whose
payload was redacted.

### Added — MCP SDK v2

The TypeScript MCP SDK became a new package family on 2026-07-28
(`@modelcontextprotocol/server` + `core`, 2.0.0) and `@graphmind-ai/mcp` only
accepted the 1.x `sdk` package, so every server written since then was locked
out of in-process debugging. `@graphmind-ai/mcp` now takes either generation as
an **optional** peer (`/sdk >=1.26 <2` or `/server >=2 <3`), detected
structurally from the object you hand to the same `wrapServer(...)` call: the
v2 handler context (`ctx.mcpReq`) is recognised, the debugger's abort is
chained into its signal, `requestSampling` / `send('sampling/createMessage')`
are gated, and both spellings of `setRequestHandler` are wrapped. Wrap inside
the factory when you use `serveStdio`. `graphmind mcp-proxy` needed no change
and is now proven against v2 servers with both client generations, including
the opt-in 2026-07-28 era (`server/discover` instead of `initialize`,
`resultType` on every result) — the protocol fold, gates, inject, abort and
retry all hold, and an injected value is stamped for the era the peers
actually negotiated (`resultType`, plus `ttlMs`/`cacheScope` for
`resources/read`), so a bare inject is accepted by a 2026 client too. Facts
that shaped this are in the repo's internal
decisions: the v2 client's default posture is still `initialize`; only
`serveStdio` serves the 2026 era; a throwing v2 handler arrives as
`isError: true`, not a JSON-RPC error; `'auto'` negotiation probes on a
sibling process, which the proxy shows as a second, short run rather than
hiding it.

### Added — the debugger stops an agent that is repeating itself

The most-reported agent failure is the same tool called with the same arguments
again and again until a bill or a timeout ends it; every tool on the market
shows you that afterwards. GraphMind now holds it while it is happening. The
client fingerprints each tool call's arguments (canonical JSON — key order,
whitespace and number spelling do not matter; MCP's per-request `_meta`, where
clients put a fresh `progressToken`, is ignored; pagination keys are not, so
page 3 of a listing is never "the same call" as page 2) and counts identical calls made
back-to-back — any other tool call in between starts the count again, while
LLM steps between them do not; on the third (`GRAPHMIND_LOOP_THRESHOLD`, default 3, `0` off)
the before-gate holds **when a debugger is attached** — through the normal gate
path, so timeouts and fail-open apply and Continue / Retry / Inject / Abort keep
their meaning. The banner reads "Loop: 3× searchFlights with identical
arguments" and the inspector lists the identical calls with their outputs, so
you can see the model is not learning anything new; inject a different answer
and it moves on. With no debugger attached it never holds — it warns once per
streak and keeps counting, so a debugger that attaches late holds on the next
identical call (`GRAPHMIND_ON_LOOP=pause|warn|off`; also `loopGuard: {threshold,
mode, ignoreKeys, allowNodes, kinds}` on every adapter — `allowNodes`, or
`GRAPHMIND_LOOP_ALLOW=pollJob,…` where options cannot be set such as under
`graphmind mcp-proxy`, is the escape hatch for tools that legitimately poll). Detection lives in the client
session, so every adapter and `graphmind mcp-proxy` got it with no code change.
`exec.paused` carries `reason: 'loop'` and `loop: {repeats, firstSeq, lastSeq,
fingerprint}`. The fingerprint is withheld wherever the input is: under
`GRAPHMIND_HIDE_INPUTS` (or `_TOOL_ARGS` on a tool) and in every sanitised
`graphmind record` export, because a hash of an input with a password removed
is a dictionary attack away from the password. Fingerprinting costs about
0.01 ms per KB of arguments on a watched tool's start; the detached gate path
is unchanged. An input that cannot be read (a throwing getter or `toJSON`)
breaks a streak instead of counting as a repeat. `pnpm --filter demo-agent start -- --loop` shows it.

Why back-to-back and not "the third identical call anywhere in the run": under
`graphmind mcp-proxy` a whole coding session is one run, and a constant-argument
tool (`list_issues({})`, `git_status({})`) called at minute 1, 20 and 45 with
dozens of other calls in between is not a loop — an early build held it. The
accepted cost: a model alternating between two tools (search, read, search,
read) is not held.

Not built, on purpose: step and token budgets (LangGraph's `recursion_limit`,
the AI SDK's `stopWhen` and their peers already cap runs) and any unattended
abort policy — the case those come from is the one a live debugger is absent
from.

### Added — two answers for the security reviewer: record less, export safely

- **Kill switches.** `GRAPHMIND_HIDE_INPUTS`, `GRAPHMIND_HIDE_OUTPUTS`,
  `GRAPHMIND_HIDE_TOOL_ARGS` and `GRAPHMIND_HIDE_TOOL_RESULTS` (`1`/`true`; also
  session options `hideInputs` … on every adapter) replace the whole field with
  `"__REDACTED__"` inside the client *before* the ring buffer, so nothing
  downstream — replay on attach, SQLite, the WebSocket, `graphmind record`, the
  HTML export, the read-only MCP tools, the proxy — ever holds the hidden field; names,
  kinds, timings, token counts and the shape of a stream (delta count, character
  lengths) survive so the graph still reads. An environment switch is a floor
  code cannot lower. Affected events carry `redaction: {count, keys}`; the
  viewer shows a "hidden by …" chip where the value would be, and refuses to
  inject a value that still contains the placeholder (the hub refuses too).
  `node.error` is deliberately never redacted — at 3am the message is the clue.
  Know the limit: the tool-only switches hide the tool node's own input and
  output, but in an agent loop the same values also pass through the model
  (`tool_use` in its output, `tool_result` in the next request) — set
  `GRAPHMIND_HIDE_INPUTS`/`_OUTPUTS` to keep them out entirely. `graphmind
  mcp-proxy` goes one step further on its own records: under
  `HIDE_TOOL_RESULTS` a failed result is not quoted into the error, and under
  `HIDE_INPUTS` the server's command-line arguments leave the run label and
  metadata. An option set to `"true"` or `1` counts as on — privacy switches
  fail closed.
- **Exports sanitise by default.** `graphmind record` (NDJSON and `--html`)
  replaces the values of secret-shaped keys — `authorization`, `cookie`,
  `api_key`/`apikey`, `password`, `secret`, `client_secret`, `private_key`,
  `access_token`, `refresh_token`, `token`, `bearer` — matched case-insensitively
  as a whole key or a `_`/`-`/camelCase-delimited segment (`x-api-key`,
  `accessToken` match; `max_tokens`, `tokenizer` do not) and prints what it
  redacted. `--no-redact-secrets` keeps them. Keys, not values: a secret typed
  into a prompt is exported as recorded; the switch above is the tool for that.
  The credential-leak audit now covers the export layer.

- **Fails closed.** If a payload cannot be read safely while a switch is on (a
  getter or Proxy that throws, a malformed payload), the event is sent with
  input, output and token text hidden and `redaction.failed: true`; if even its
  identity fields cannot be read, it is dropped with one warning. A raw value is
  never sent.

What was *not* built, on purpose: a default-on regex pack, a redaction callback
API, and cross-chunk streaming regexes — every platform ships masking already,
and two of those designs would have blanked `max_tokens`.

### Added — Python and Ruby get both, identically

The Python SDK (`graphmind-ai`) and the Ruby gem implement the four
`GRAPHMIND_HIDE_*` switches and the loop hold with the same env names
(`GRAPHMIND_LOOP_THRESHOLD`, `GRAPHMIND_ON_LOOP`, `GRAPHMIND_LOOP_ALLOW`), the
same placeholder and the same wire fields as the TypeScript client
(`gm.configure(hide_inputs=True, loop_guard={...})`,
`Graphmind.configure(hide_inputs: true, loop_guard: {...})`). "The same" is
checked, not claimed: both shared conformance fixtures reproduce byte-for-byte
in all three languages, and a differential file generated from the TypeScript
build — 406 canonical values (doubles in every exponent range, astral and
control characters, UTF-16 key order) and 120 redaction event streams — passes
in Python and, for every value a Ruby string can hold, in Ruby. The ports are
thread-safe where the TypeScript client did not need to be: loop details travel
with each hold rather than through shared state, and `firstSeq`/`lastSeq` are
taken under the session lock.

### Docs

- New pages: **Stability & versioning** (what 0.x means, the deprecation rule,
  supported runtimes exactly as CI runs them, the `gm` protocol policy),
  **Limits** (every size ceiling, buffer and timeout, read from the source), and
  **Remote development** (devcontainers, Codespaces, WSL 2, SSH).
- A gate-coverage matrix per adapter and language, and a Compatibility section
  that lists exactly what CI runs.
- Every claim was run before it was written, which found real errors: the
  TypeScript replay buffer is 5,000 events / 8 MiB (the docs said 2,000); the
  proxy lifts injected values into a proper result (a page still said verbatim);
  the Docker recipe needs `GRAPHMIND_ALLOWED_ORIGINS=http://host.docker.internal:4747`,
  and so does a port forwarded to a different local port.


## 0.4.4

Three things found by the founder using it, which is the only way some of
these get found.

### Fixed — the canvas could show you another run's results

Switching runs left every card pointing at the **previous** run. A card's
`data` is its pointer into the store (`{runId, nodeId}`) and the canvas reused
a rendered node whenever its geometry was unchanged — but two runs of the same
agent have the same node ids and the same shape, so the geometry always
matched. The header read the route directly and was correct, so the run said
`PAUSED · 1 error` while the canvas underneath showed `compute_metric DONE
injected 5ms` from a different, successful run. In a debugger that is not a
cosmetic bug. Reuse now also requires the pointer to be unchanged
(`canReuseFlowNode`, unit-tested).

### Fixed — the resume buttons overflowed their own card

`Continue / Step / Retry / Inject… / Abort` need ~341px of label; the card is
240px. `flex: 1` looks like it shrinks them, but a flex item's default
`min-width: auto` floors it at min-content and `white-space: nowrap` makes
min-content the whole label — so instead of shrinking, the row overflowed by
~100px and `Abort` rendered outside its own border. The row wraps now, and
`Abort` still never stretches to fill its line.

### Changed — the proxy says whether the debugger picked up

`graphmind mcp-proxy` printed "reporting to ws://…" whether or not anything
was listening, so running it with no debugger looked exactly like running it
with one — and produced no graph. It now reports which happened, ~1.5s in,
while the session is still alive:

```text
graphmind mcp-proxy: attached — watch it at http://127.0.0.1:4747
graphmind mcp-proxy: GraphMind is not running at ws://…, so nothing is being
  recorded yet. Start it and this session will attach: npx graphmind-ai
```

Reported during the session rather than at exit, because an MCP host does not
close the pipe on shutdown — it kills the child, so an exit-time message is
the one message that never prints when it is needed.

### Known, not fixed — edges cross the cards above them (fixed in 0.5.0)

With five or more childless siblings the layout packs them into a grid, and
the parent's edges to rows two and three are drawn straight through the cards
in row one. Measured on a real MCP session: 6 of 11 edges pass through another
card, which is why they read as floating or detached. The fix is edge routing
through the column gutters, which is a layout change worth doing deliberately
rather than in a patch release.

## 0.4.3

- **`graphmind init` told an MCP-server developer "No supported agent
  framework found".** A project with `@modelcontextprotocol/sdk` in its
  dependencies is the exact audience 0.4.0 was built for, and the first
  command they would run said GraphMind had nothing for them. It now detects
  the MCP SDK, prints the `@graphmind-ai/mcp` snippet, and — because the
  proxy needs nothing installed and works in any language — offers
  `graphmind mcp-proxy` alongside it. The not-found listing gained MCP and
  Ruby too.
- The CLI README's gate-action table described `inject` as answering with the
  value verbatim, which was true before injected values were lifted into the
  result shape the method has to return. Corrected, with both escape hatches
  (a value already shaped like a result, and a whole JSON-RPC frame) written
  down.

## 0.4.2

- **A `runId` containing a NUL byte was silently mangled on Node 22.**
  `node:sqlite` round-trips a string containing U+0000 on Node 24 and does not
  on Node 22, so the app streamed under one run id while the server stored
  another — the run looked permanently empty to anyone who subscribed with the
  id they sent. Same identity hazard as the lone surrogate closed in 0.4.0, and
  now refused the same way, at the parse boundary, on every runtime. A wire
  contract that is correct only on some patch versions of Node is not a
  contract.

  Found because CI runs Node 22 and this machine runs Node 24 — the version
  matrix earning its keep. The security suite is now also run locally on the
  CI Node version before a release.

## 0.4.1

- `@graphmind-ai/mcp` raises its `@modelcontextprotocol/sdk` peer floor from
  `>=1.20.0` to `>=1.26.0`. The adapter runs fine on older SDKs — this is a
  security floor, not a compatibility one. Every release below 1.26.0 carries
  at least one high advisory (cross-client data leak through shared transport
  reuse ≤1.25.3, DNS-rebinding protection off by default <1.24.0, ReDoS
  <1.25.2), and declaring support for them told users a vulnerable SDK was a
  supported configuration. The peer-compat suite now runs the whole gate story
  against 1.26.0 as the new floor, so the declared floor stays a *verified*
  floor.

## 0.4.0

MCP server debugging, a Ruby SDK, and the fixes a deliberate attack on the
protocol boundary turned up.

### Added — debug an MCP server while your client is driving it

The tools around MCP today are test clients: you replace your host and poke the
server by hand. Nothing could watch a server *in situ*, hold a request, or
answer one differently. Two shapes, because they see different things:

- **`graphmind mcp-proxy -- <your server command>`** — a transparent stdio
  man-in-the-middle. It spawns your real server, relays every JSON-RPC frame
  byte-for-byte, and reports the conversation as a live graph. **Any language,
  no code changes**, so it debugs a server you did not write. Gates at the
  protocol boundary: hold a request before your server sees it, hold a response
  before your host sees it, `inject` an answer, `retry` the original bytes,
  `abort` with a JSON-RPC error. Errors hold by default, so a broken server
  stops with zero configuration.
- **`@graphmind-ai/mcp`** — two lines to instrument an `McpServer` you own, for
  what only the inside can tell you: work that never reaches the wire, outbound
  sampling with the handler's own context, and `abort` that cancels the
  `AbortSignal` your handler already has.

Both map MCP onto the graph: the session is a `server` node, `tools/call` a
`tool`, `resources/read` a `resource`, `prompts/get` a `prompt`, and
`sampling/createMessage` an `llm`. `server`, `resource` and `prompt` are new
node kinds in the wire schema; the viewer draws each with its own glyph.

### Added — Ruby

`graphmind` (RubyGems), zero runtime dependencies, Ruby >= 3.1. Automatic
instrumentation for **ruby-openai** and **ruby_llm**, plus `Graphmind.tool`,
`.span` and `.wrap_method` for anything else. Fiber-local run context, so a
Rails request or a Sidekiq job is a run without any wiring.

### Fixed — security

Found by fuzzing the ingest boundary. All are local-only (the server binds
127.0.0.1), so the threat is another process on your machine — a postinstall
script, a compromised dependency:

- **Any process that could open `/ingest` could claim any other process's run
  by naming it once.** One frame bought four things, each demonstrated end to
  end against a real session holding a real gate: fabricated nodes rendered
  inside the victim's run, the operator's next `exec.resume` delivered to the
  attacker *including the value they injected*, the victim's gate never
  released (fail-open does not cover this — the client believes the debugger is
  still attached and simply has not answered), and a forged `run.finished`
  marking a live run failed. A run is now claimed by the token that created it:
  `hello.ack` mints one, and a client echoes it as `hello.resumeToken` so a
  reconnect still proves it is the same app. The same fix closes `seq`
  squatting, where a peer pre-claiming a run's low sequence numbers silently
  deleted the start of that run.
- The wire accepted 100 MiB frames against a 512 KB storage budget; one 64 MB
  frame took the server from 95 MB RSS to ~500 MB, permanently. Capped at
  16 MiB, refused during frame assembly.
- One unthrottled log line per dropped frame, written synchronously to the
  operator's terminal. Now rate-limited, with a suppressed count.
- The liveness reaper judged a peer dead on a missing pong — which arrives
  *behind* that peer's own frames — so a busy app was terminated **because**
  the server was busy with it, dropping everything in flight silently (26,570
  of 60,000 events at a 200 ms interval). Liveness is now "we read bytes from
  this socket".
- A repeated `subscribe` replayed the whole run again, every time.
- A lone surrogate in a `runId` was silently rewritten by SQLite, so the app
  streamed under one id and the server stored another. Refused now.
- `ts` was unbounded, so one frame with `ts: 1e300` pinned that run to the top
  of the run list until it was pruned.

### Fixed

- **The 512 KB payload guard destroyed fields the schema requires.** It
  replaced an oversized field with a marker *object*, so a >512 KB error
  message made `node.error` fail its own schema and the viewer dropped it on
  replay — a debugger losing precisely the error event, with no attacker
  involved. Truncation is now type-preserving: a string stays a (shorter)
  string, an array stays an array, an object keeps its own fields.
- Injecting a bare value at a proxy `tools/call` gate produced a tool result
  with **no content** — no error, just an empty answer, on the headline
  feature. Injected values are now lifted into the result shape the method has
  to return, while anything already shaped like a result (or a whole JSON-RPC
  frame) is relayed untouched.
- An envelope with no `payload` key was rejected, contradicting the stated
  forward-compatibility contract.
- Proxy runs reported `sdk: mcp@stdio` — a transport, not a version.
- Proxy run labels were full of absolute paths from the host's config;
  arguments that are bare paths are now shown by basename.

### Changed

- The viewer's camera never leaves a held gate off screen: it re-frames on a
  hold, sits above centre so the action row has room, and re-decides when the
  canvas resizes. The inspector is a docked pane rather than an overlay, so it
  can no longer cover the buttons it is explaining.
- `c` / `s` / `r` / `i` release a held gate from the keyboard; focus lands on
  Continue when one opens.
- Motion carries meaning: cards animate in from their caller, and each state
  change gets one short ring instead of a permanent pulse.

## 0.3.2

Five sample projects were built against the published packages and run against
real Anthropic and OpenAI APIs. They found these, which is exactly what a new
user would have found.

### Fixed — first-run blockers

- **`gm.ready()` never settled when no debugger was listening, and the process
  died silently** (exit 13, no output). Its timeout timer was `unref`'d, so
  when awaiting the debugger was the only pending work — a user starting their
  agent before starting GraphMind — the event loop drained first. Failing open
  means resolving `false`, which cannot happen if the process dies. The same
  path broke `waitForAttach`, where the entire run body silently never ran.
- **A published README told users to run `npx graphmind serve`.** The CLI is
  `graphmind-ai`; `graphmind` is an unrelated third-party package, so anyone
  following those instructions downloaded and executed a stranger's code.
  Corrected, and every published README swept for the same mistake.

### Fixed — correctness

- Every OpenAI-adapter run reported `sdk: openai@unknown`: the version was read
  through a subpath `openai` has never exposed. All adapters now resolve peer
  versions in a way an `exports` map cannot hide.
- A run whose app died mid-pause stayed `running` forever. Runs now reconcile
  to an explicit abandoned state after a grace period, without disturbing a
  legitimate reconnect.
- LangGraph: `inject`/`retry` at a callback-only error gate were silently
  ignored, despite the README promising a warning. And one failure produced a
  cascade of pauses, one per ancestor — now one failure, one pause, at the one
  gate that can actually act.
- Duplicate `graph.hint` when a run used two invocations.
- `graphmind --pause-on-error <on|off|kind>` (and `GRAPHMIND_PAUSE_ON_ERROR`)
  scopes the default error breakpoint, which was unscoped enough that an
  incidental tool failure could hold a run before the interesting one.

### Fixed — documentation that misled

- The OpenAI adapter README stated a narrower peer range than it supports.
- The Python README cited benchmarks from an interpreter the package no longer
  supports; re-measured on a supported one.
- Integration pages verified against the five real samples rather than specs.

## 0.3.1

Two fixes CI found on Linux that macOS hid.

- **An unserializable payload made its stored event unreadable.** A payload
  nested deeper than the JSON serializer's stack (or cyclic) was replaced
  wholesale by a truncation marker, which destroyed the fields the payload's
  own schema requires — so the viewer rejected the event on replay and the
  node hung "running" forever. Only the offending field is replaced now; the
  event still validates and still renders. The depth at which this bites is
  platform-dependent, which is why it passed locally and failed in CI.
- **The viewer's reducer copied the entire node record on every lifecycle
  event**, making a run with many nodes quadratic. Measured per-event cost
  went from 2.4x to 0.69x across a 550-node run. Nothing compared that record
  by reference — consumers key off the run's version counters — so the copy
  was pure cost.
- CI now reports which soak check failed instead of only an exit code.

## 0.3.0

A hardening release. An adversarial pass — a credential-leak audit, real
provider calls, a production-scale soak, browser tests, and an SDK version
matrix — found real defects. These are the fixes.

### Security (please upgrade)

- **The local server accepted WebSocket connections from any origin.** A
  WebSocket handshake is exempt from the same-origin policy, so while
  `graphmind serve` was running, any web page you visited could open
  `/ws/ui`, read every recorded run (prompts, tool payloads, errors), *and*
  send control frames — including resuming a paused run with an injected tool
  result. Every HTTP request and every upgrade is now origin-checked:
  no `Origin` (the SDK, curl, tests) and this server's own origin are allowed,
  everything else gets a 403. `GRAPHMIND_ALLOWED_ORIGINS` opens it explicitly.
- **DNS rebinding could reach the HTTP API** despite the loopback bind. `Host`
  must now be a loopback name; SSH tunnels still work.
- **The database was created world-readable.** `~/.graphmind` is now 0700 and
  `graphmind.db` (with its `-wal`/`-shm` siblings) 0600. A database an older
  version left at 0644 is tightened on next open. No-op on Windows.

### Correctness

- Aborting a run mid-stream was reported as success on real providers: both
  the Anthropic and OpenAI SDKs deliberately swallow `AbortError` inside their
  stream iterators, so the adapters saw a clean end. Only real API calls could
  have shown this.
- Events dropped while the debugger was unreachable are no longer silent — the
  recorded run says so instead of quietly missing a third of itself.
- Oversized payloads are trimmed field by field rather than replaced wholesale,
  so a truncated event still satisfies its own schema and still renders; the
  server also fans out exactly what it stored, so live and replay agree and one
  huge tool result can no longer inflate the server.
- `graphmind record --html` picked the JS bundle by extension and could inline
  the wrong one now that the viewer build emits two; it reads the real entry
  point from the built index.html.
- Exported runs no longer show live-looking debugger controls that do nothing.
- The agent node emitted `node.finished` without an `instanceId` in the Vercel
  AI SDK adapter, mis-attributing concurrent executions.
- LangGraph: inner wrapper runs made a chain node its own parent (a self-loop
  in the graph); tool-call argument tokens are now mapped.
- Retention deleted rows but never reclaimed disk, and startup retention
  delayed the server binding its port.

### Version support, measured rather than assumed

- `@graphmind-ai/langgraph` advertised a `langgraph`/`core` pair that is
  mathematically impossible to install; the floors are now the real ones.
- `@graphmind-ai/openai` excluded `openai@7`, the current default install,
  despite passing its whole suite there.
- The Vercel AI SDK adapter now typechecks against `ai@6`, its own floor.
- A CI matrix pins the floor and ceiling of every range, plus a weekly canary
  against the latest SDKs.

### Testing

830+ tests: a credential-leak audit (71) proving no API key, header or token
reaches the database, API, WebSocket, HTML/NDJSON export or telemetry; 54
browser tests; a live-provider suite (183 assertions against real Anthropic and
OpenAI); and a soak battery with a published baseline. Viewer layout went from
10.8ms to 0.6ms at 800 nodes and no longer overflows the stack on deep graphs.

## 0.2.2

- The Python package reported `__version__ = "0.1.0"` while shipping as 0.2.1:
  a hardcoded constant had drifted from `pyproject.toml`. It now derives from
  installed metadata, so the two cannot disagree again. The version travels on
  the wire in `run.started.sdk`, so a stale one mislabelled every recorded run.

## 0.2.1

- `graphmind record --html` exports a run as a single self-contained HTML
  file: the viewer and the run inlined, no server and no network. Attach it to
  an issue or send it to a colleague and they see exactly what you saw. It
  carries the run's prompts and payloads, so the command says so before you
  share it.
- Fixed two Python failures that only appeared on real 3.10/3.13: the test
  harness now follows whichever httpx flavour the installed `anthropic`
  expects, and a test that pinned since-changed LangChain context-propagation
  behaviour now asserts what must hold either way.

## 0.2.0

The release that makes GraphMind work with the way agents are actually
written, and stand up to real runs.

### Framework coverage

- **Anthropic SDK** (`@graphmind-ai/anthropic`) — wrap the client, gate before
  each `messages.create`, stream tokens, gate tool calls.
- **OpenAI SDK** (`@graphmind-ai/openai`) — the same, for
  `chat.completions` and the Responses API.
- **LangGraph / LangChain (JS)** (`@graphmind-ai/langgraph`) — a callback
  handler that maps the run tree onto the graph, plus tool wrapping for the
  full gate set.
- **Python** (`pip install graphmind-ai`) — the debugger for the other half of
  the ecosystem: OpenAI, Anthropic, and LangChain/LangGraph instrumentation,
  sync and async.

### Getting started

- `graphmind init` reads your project, works out which adapter you need, and
  prints the exact install command and snippet. `--install` runs it.
- A documentation site at [docs.graphmind.ai](https://docs.graphmind.ai):
  concepts, an integration guide per framework, debugging workflows, and the
  wire protocol for writing your own adapter.

### Running real workloads

- Retention: the local database prunes itself (200 runs / 30 days by default;
  `GRAPHMIND_RETENTION=off`, `GRAPHMIND_KEEP_RUNS`, `GRAPHMIND_KEEP_DAYS`).
- `graphmind runs` lists what is stored, with `--prune`, `--rm`, `--clear`.
- Oversized event payloads (over 512KB) and unserializable ones are stored as
  a marker with a preview instead of bloating the database.
- The viewer handles large graphs and long runs: collapsible groups, a
  minimap, filtering, a timeline view, and a command palette.

### Protocol

- Node kinds gained `chain` and `retriever` for LangChain-style graphs.
- `node.finished` and `node.error` carry an optional `instanceId`, so
  concurrent executions of the same logical node are attributed correctly.
  Both changes are backwards compatible: 0.1 senders and receivers still work.

## 0.1.0

First public release.

- Live attach for the Vercel AI SDK: pause before a model step, before, after
  and on error for tools, with continue / retry / inject / abort.
- Local-first server and viewer (`npx graphmind-ai`), SQLite storage, replay
  of past runs.
- `graphmind demo` — a recorded debug session with a planted bug, no API key
  required.
- `graphmind import` for OpenTelemetry / OpenInference traces.
- `graphmind mcp` so Claude Code and Cursor can query runs.
- MIT, and anonymous opt-out telemetry
  ([disclosure](./packages/cli/TELEMETRY.md)).
