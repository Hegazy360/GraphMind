# GraphMind secret-leak audit

> **The one-line version.** GraphMind records what your agent **did** — prompts,
> tool arguments, tool results. It records nothing about how your app
> **authenticated**. An API key, an `Authorization` header, a token in a
> gateway URL, or a value in your environment never enters a GraphMind
> artifact. Everything you typed into a prompt does, on purpose.

This package is an adversarial audit that proves both halves of that sentence,
on every artifact GraphMind can hand to a human. It is a private workspace
package; it ships nothing.

```bash
pnpm build && pnpm --filter security-audit test
```

It deliberately imports the adapters and the CLI through their **published
entry points** (`dist/`), not through `src/`, because the question is what the
thing on npm does. Build first, or you are auditing a stale artifact. The suite
is not wired into the root `pnpm test` script — run it explicitly, and it
belongs in CI.

---

## The distinction that matters

GraphMind is a debugger. A debugger that hid your prompts would be useless, so
"never records a secret" cannot mean "never records anything sensitive". The
audit splits every canary into two classes and asserts the opposite thing about
each.

### Guaranteed: never recorded

A credential that only ever lived **outside the data path** must not appear in
any artifact. The audit plants a unique canary in each of these and greps every
surface for it:

| Where the secret lives | Example |
| --- | --- |
| the provider client's `apiKey` | `new Anthropic({ apiKey })`, `new OpenAI({ apiKey })` |
| the client's default headers | `defaultHeaders: { Authorization, 'x-org-secret' }` |
| a token in the request query string | `defaultQuery: { access_token }` |
| a token in a custom gateway `baseURL` | `baseURL: 'https://gw.example/v1/gw/<token>'` |
| a per-request header | `client.messages.create(body, { headers })`, `streamText({ headers })` |
| the process environment | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_PASSWORD`, `APP_SESSION_TOKEN`, and a PII-shaped `SUPPORT_CONTACT_EMAIL` |
| an unknown field in the provider's response | a gateway echoing your `Authorization` back as `_debug_echo` |

**Why this holds structurally, not by accident.** The adapters *field-pick* what
they report. They record `model`, `messages` / `prompt`, `system` /
`instructions`, tool **names**, tool **arguments** and tool **results** — and
nothing else. The request-options argument (where headers live) is passed
through to the SDK and never read; the response is summarised field by field
and never serialised wholesale. `tests/static-surface.test.ts` pins this: the
published builds of `@graphmind-ai/sdk`, `/anthropic`, `/openai` and
`/langgraph` do not contain the identifiers `apiKey`, `defaultHeaders`,
`defaultQuery`, `Authorization` or `baseURL` at all, and read **zero**
environment variables. The only HTTP header any adapter reads is
`x-request-id`, a correlation id.

### Recorded by design

These are recorded, must be recorded, and travel with every export:

- the user and system messages of every model call, verbatim;
- every argument the model passes to a wrapped tool;
- every value a wrapped tool returns — including a credential a tool fetched;
- error names, messages and stacks from failed steps;
- token deltas, usage counts, timings, node and run ids.

If you paste an API key into a prompt, GraphMind records the API key. That is
the product working. It is exactly why `graphmind record --html` prints:

```
It contains this run's prompts, tool inputs and outputs: check before sharing.
```

The audit asserts the by-design canaries **are** present in the HTML export.
That assertion is not decoration: it is what keeps the "no leak" assertions from
passing vacuously when an agent silently fails to run.

---

## Surfaces audited

Every one of these is collected from a real run, for each of the three
first-party adapters, and grepped:

1. **The SQLite database** — read as raw bytes, including the `-wal` and `-shm`
   files, so a value that never made it into a parsed row still gets caught.
2. **`GET /api/runs`** and **`GET /api/runs/:id/events`** — the HTTP responses,
   as text.
3. **The WebSocket frames a viewer receives** on `/ws/ui` — a real subscribing
   client, replay plus live tail.
4. **`graphmind record <id> --html`** — the self-contained shareable page,
   produced by the real CLI in a child process.
5. **`graphmind record <id>`** — the NDJSON export.
6. **Telemetry** — captured off the wire by a local endpoint. Every payload is
   asserted to have exactly the keys `event`, `installId`, `ts`, `version`, and
   to contain **no canary at all**, not even a by-design one.

Canaries are searched literally, case-folded, percent-encoded, base64 and
base64url, and byte-wise inside binary files.

---

## Why the results are trustworthy

Two guards keep this suite from becoming a green rubber stamp.

**Wire proof.** Before asserting that a credential was *not* recorded, each test
asserts it *was* genuinely on the wire. The mock provider is a real HTTP server
driven by the real Anthropic and OpenAI SDKs; it logs every request URL, header
and body. If a canary never reached the provider, the test fails as vacuous.
Environment canaries are likewise asserted to be set on the running process.

**Poisoned run.** `tests/harness-self-check.test.ts` runs an agent that
deliberately hands its own API key to a tool as an argument, and requires the
harness to find that canary on the SQLite, HTTP, WebSocket, HTML and NDJSON
surfaces. If any surface stops being collected, or the scanner stops matching,
that test goes red and the rest of the suite is known to be untrustworthy again.

---

## Findings

### Open defects (fixes live outside this package)

**1. `WS /ws/ui` accepts upgrades from any browser `Origin` — critical.**
The WebSocket handshake is not covered by the browser same-origin policy, and
`packages/cli/src/server.ts` does not inspect `Origin` on upgrade. While
`graphmind serve` is running, **any web page the user visits** can:

- open `ws://127.0.0.1:4747/ws/ui`, `subscribe` to `*`, enumerate every run,
  subscribe to each and receive all envelopes — every prompt, tool input and
  tool output ever recorded; and
- send `control` frames: `breakpoint.set`, `mode.set`, and `exec.resume` with
  action `inject`, i.e. **substitute an attacker-chosen value for a tool result
  in a live agent**.

Both are demonstrated end to end in `tests/local-server-exposure.test.ts`.

*Fix:* in the `httpServer.on('upgrade', ...)` handler in
`packages/cli/src/server.ts`, read `request.headers.origin`. Destroy the socket
unless it is absent (a non-browser client such as the SDK or a CLI) or its host
is `127.0.0.1` / `localhost` on the server's own port. Apply it to `/ingest`
too. The `it.fails(...)` tests in this package already state the wanted
behaviour and will turn red the moment the fix lands.

**2. No `Host` header check on the HTTP API — high, same class.**
`GET /api/runs` sends no CORS headers, so a plain cross-origin `fetch` cannot
read the body — but DNS rebinding makes an attacker's own origin resolve to
`127.0.0.1`, at which point the request *is* same-origin and the body is
readable. A `Host` allowlist (`127.0.0.1:<port>`, `localhost:<port>`) closes it.
Same file, same handler.

**3. The recorded database is group/world readable — medium.**
`packages/cli/src/sqlite-storage.ts` creates the database with
`mkdirSync(dirname, { recursive: true })` and lets `node:sqlite` create the
file, yielding `0755` on `~/.graphmind` and `0644` on `graphmind.db`. That file
holds every prompt and tool payload the user ever recorded. On a shared or
multi-account machine any local user can read it.

*Fix:* `mkdirSync(dir, { recursive: true, mode: 0o700 })` and `chmodSync(path,
0o600)` after opening. `packages/cli/src/telemetry.ts` already writes its
install id with `mode: 0o600`, so the convention exists — the database just
does not follow it.

### Residual risks (not GraphMind defects, worth knowing)

**A provider that echoes your credential back gets it recorded.** If an
OpenAI-compatible gateway answers `401 invalid credentials: sk-…`, the SDK puts
that message on the `Error` it throws, and GraphMind records error names,
messages and stacks. GraphMind is relaying what the provider said, but the key
still lands in the database. Pinned by the last test in
`tests/error-and-response-paths.test.ts`. If a mitigation is ever wanted, the
single place to add a redaction pass is `toErrorInfo()` in
`packages/client/src/errors.ts`.

Note that this only applies to the error *message*. An unknown *field* in a
successful response is dropped, because responses are field-picked — proven by
the `_debug_echo` test in the same file.

**Anything you put in a prompt or a tool payload is in the export.** By design.
Treat a `--html` export like a screenshot of your terminal.

### Verified clean

- Telemetry sends `{ event, installId, version, ts }` and nothing else, over a
  fire-and-forget request; it is disabled whenever `CI` is set and by
  `GRAPHMIND_TELEMETRY=0`.
- The HTML export escapes `<`, `>`, U+2028 and U+2029, so a tool result
  containing `</script><img onerror=…>` cannot become script in whoever opens
  the shared file (`tests/export-hardening.test.ts`).
- Failed provider requests record `Connection error.` / the provider's own
  message; neither the SDK error message nor its stack carries the request URL,
  so a token in a gateway `baseURL` does not leak through the error path.
- No adapter reads any environment variable. The CLI copies the parent
  environment into exactly one place — the child process spawned by
  `graphmind demo --live` — and nowhere else.

---

## Layout

```
security/
  src/
    canaries.ts        the canary registry + the forbidden / by-design split
    scan.ts            multi-encoding scanner over text and binary artifacts
    mock-provider.ts   a real HTTP server speaking Anthropic + OpenAI, logging
                       every request so "it was on the wire" is provable
    harness.ts         boots a real server + viewer socket, runs an agent,
                       collects all six artifact surfaces
    agents/            three instrumented agents, one per first-party adapter
  tests/
    adapter-leaks.test.ts           the main audit, per adapter, per surface
    harness-self-check.test.ts      proves the harness can detect a leak
    error-and-response-paths.test.ts  failure path + hostile gateway responses
    local-server-exposure.test.ts   cross-origin access and file permissions
    export-hardening.test.ts        HTML export escaping + the sharing warning
    static-surface.test.ts          structural guard on the published builds
```

## Adding a canary

1. Add it to `makeCanaries()` in `src/canaries.ts` with the right `kind`.
2. Plant it in the agents under `src/agents/`.
3. If it is a `forbidden` canary that rides on a real request, add its id to
   that adapter's `wireCanaries` list in `tests/adapter-leaks.test.ts`, so the
   suite proves it reached the provider before asserting it was not recorded.

Nothing else needs changing: the scanner and the six surfaces are generic.
