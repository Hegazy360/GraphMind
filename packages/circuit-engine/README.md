# @graphmind-ai/circuit-engine

The durable execution engine of **GraphMind Circuit** — the hosted workflow
service. One data structure, the **step journal**, powers everything:

- **Durability** — workflow functions are re-invoked from the top; completed
  journal entries replay without executing. A crashed worker's lease expires
  and the run finishes elsewhere, losing nothing.
- **Fix-and-resume** — a failing step pauses at an error gate *before* the
  error propagates. Inspect it, then `continue | retry | inject | edit |
  skip | abort` — single run or in bulk — each change recorded as an audited
  intervention, never an erasure.
- **Replay** — `replayJournal()` re-runs code over a journal hermetically
  (nothing executes, nothing escapes). `checkDeploy()` answers "would this
  code change break runs that are in flight?" before the deploy.
  `exportFixture()` + `replayFixture()` turn any recorded run into a
  regression test. `Executor.fork()` answers "what if?" — substitute a step's
  output and run everything after it for real.
- **Divergence honesty** — changed code meeting an in-flight journal fails
  loudly as a `NonDeterminismError` naming both sides (mismatch, novel call,
  or orphaned effect). Nothing silently replays into code that asked a
  different question.

Storage is behind the `JournalStore` interface: `SqliteJournalStore`
(`node:sqlite`, zero native deps) for dev/tests/single-node; a Postgres
implementation serves the hosted multi-worker service.

See `docs/plans/hosted-workflow-platform.md` for the architecture and
`examples/circuit-onboarding` for a runnable workflow.
