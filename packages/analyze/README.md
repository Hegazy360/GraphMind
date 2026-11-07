# @graphmind-ai/analyze

Behaviour analysis over recorded GraphMind runs: one `BehaviorReport` per
run, computed from facts the recording proves.

This package is the one definition of those numbers. The CLI
(`graphmind runs --behavior <runId>`), the MCP server (`get_behavior`) and
the viewer's Behaviour section all call `analyzeRun` here, so every surface
reports the same counts and the same one-line verdict. You normally consume
it *through* those surfaces; depend on it directly only if you are building
your own reader of GraphMind recordings.

## What a report contains

- **Wasted work** — the three behaviours the live loop guard holds on, found
  after the fact: consecutive identical tool calls (*repeat*), a lap of 2–4
  calls repeating identically (*cycle*), and the same tool failing the same
  way three or more times in a row (*error-repeat*). Overlapping incidents
  never double-count: totals come from the union of wasted executions.
  "Dead steps" (an output nothing used) are deliberately **not** guessed at —
  the recording cannot prove them.
- **Tool health** — per tool: calls, thrown failures, *silent* failures (a
  result that said `isError: true`, `success: false`, a non-zero exit code,
  or `{error}` — the same strict shapes as the live `error-result`
  breakpoint), failure rate, recoveries, and p50/p95 run time with debugger
  hold time subtracted.
- **Termination quality** — normalized finish reasons across LLM steps
  (`stop`, `length`, `tool-calls`, `content-filter`, `error`, `other`).
  A rising share of `length` is the measurable signature of context rot.
- **Context pressure** — the prompt-size curve: input tokens per LLM step,
  its maximum, and the first-to-last growth factor.
- **A verdict** — one line composed from the numbers above, identical on
  every surface.

Dollar figures are *not* computed here: the price table lives with the
viewer, which prices the executions an incident names. Tokens and durations
are the shared currency.

## Use

```ts
import { analyzeRun, sampleFromEvents } from '@graphmind-ai/analyze';

const sample = sampleFromEvents(storedEvents, runId); // ascending-seq envelopes
const report = analyzeRun(sample);
console.log(report.verdict);
```

Sources that already hold derived state (the viewer) can build the
`RunSample` themselves instead of replaying events; the metrics only need
executions in start order.

## Parity with the live debugger

Duplicate detection canonicalizes inputs exactly as the client's loop guard
does (ignored `_meta` keys, sorted keys, depth cap), and silent failures use
the same strict shapes as the client's `error-result` smart breakpoint. Both
are pinned by tests against `@graphmind-ai/client` (a devDependency here —
the shipped package is platform-neutral and never imports it), so a run the
live guard would hold on analyzes the same way.

MIT, part of [GraphMind](https://github.com/Hegazy360/GraphMind).
