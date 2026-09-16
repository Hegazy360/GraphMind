# Telemetry

GraphMind collects a small amount of **anonymous** usage data. This page is
the complete, honest description of what that means: exactly what is sent,
why, how to see it for yourself, and how to turn it off with one environment
variable.

## What is sent

One tiny JSON record per command invocation — the command's name and nothing
about what it did:

```json
{
  "event": "serve",
  "installId": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d",
  "version": "0.5.0",
  "ts": "2026-09-14T04:03:07.512Z"
}
```

- **event** — a short command name only (`serve`, `demo`, `import`, `mcp`,
  `record`, `run-ingested`). Never arguments, file paths, prompts, traces,
  run data, or payloads of any kind.
- **installId** — a random UUID generated on this machine the first time
  telemetry fires, stored in `~/.graphmind/telemetry-id` (mode `0600`). It
  identifies an *installation*, not a person: it is not derived from your
  username, hardware, email, or anything else about you. Delete the file to
  get a new one.
- **version** — the `graphmind-ai` package version.
- **ts** — the time the event fired.

That is the entire record. There is no IP logging on our side beyond what any
HTTPS request inherently carries, no cookies, no fingerprinting, no PII, and
none of your agents' data ever leaves your machine through this channel.
(Your runs, prompts, and tool payloads stay in your local SQLite database —
the GraphMind server itself binds to `127.0.0.1` only.)

## Why

GraphMind is a solo project. Instead of asking you to fill out surveys or sit
through interview calls, product decisions are made from aggregate usage:
which commands people actually run, whether installs come back on a second
day, and which features are dead weight. Counting `serve` invocations is the
whole business model of this data — deciding what to build next.

## How to opt out

Either of these, whichever your setup already uses:

```sh
export DO_NOT_TRACK=1           # the cross-tool convention (consoledonottrack.com); "true" also works
export GRAPHMIND_TELEMETRY=0    # GraphMind's own switch; "false" also works
```

When disabled, **nothing happens at all**: no request is made and no
`telemetry-id` file is created. Telemetry is also disabled automatically
whenever the `CI` environment variable is set, so build machines never
report.

To also remove the existing install id:

```sh
rm ~/.graphmind/telemetry-id
```

## How to see exactly what would be sent

```sh
GRAPHMIND_TELEMETRY=log graphmind demo
# stderr:
# [graphmind telemetry] {"event":"demo","installId":"3f8a…","version":"0.5.0","ts":"2026-09-14T04:03:07.512Z"}
```

`log` prints the byte-for-byte payload to **stderr** (stdout stays yours) and
sends **nothing** — not a failed request, no request. It prints under `CI`
too, because printing is the safe way to audit a build machine. It uses the
real install id, creating `~/.graphmind/telemetry-id` if needed, so what you
see is exactly what a send would carry.

## Precedence

Evaluated top to bottom; the first match wins.

| Condition | Result |
| --- | --- |
| `DO_NOT_TRACK` is `1` or `true` (case-insensitive) | **Off.** Beats everything below, including `GRAPHMIND_TELEMETRY=1` and `=log`. |
| `GRAPHMIND_TELEMETRY` is `0` or `false` | **Off.** |
| `GRAPHMIND_TELEMETRY` is `log` | **Print to stderr, send nothing.** Also under `CI`. |
| `CI` is set (to anything, even empty) | **Off.** |
| Otherwise (including `GRAPHMIND_TELEMETRY=1`) | **Send.** |

Values other than `1`/`true` for `DO_NOT_TRACK` (for example `0`, `false`,
`no`) leave telemetry on — the variable is honoured only in the spellings the
convention defines. The table is implemented by one pure function,
`telemetryMode()` in `src/telemetry.ts`, and pinned by
`test/telemetry.test.ts`.

## Mechanics and storage

- Events are sent fire-and-forget to `https://graphmind.ai/api/telemetry`
  with a 3-second timeout. Failures are silent, and the request can never
  block, slow down, or hold open the CLI process.
- Records are stored in a private blob store (not publicly readable) and used
  only in aggregate: per-day event counts, unique installs, and returning
  installs.
- The implementation is small and open — see
  [`packages/cli/src/telemetry.ts`](https://github.com/Hegazy360/GraphMind/blob/master/packages/cli/src/telemetry.ts)
  for the client and
  [`apps/web/api/telemetry.ts`](https://github.com/Hegazy360/GraphMind/blob/master/apps/web/api/telemetry.ts)
  for the receiving end.
- Telemetry is a **CLI-only** feature. `@graphmind-ai/sdk`,
  `@graphmind-ai/client` and the other adapters make no outbound requests
  except the WebSocket to your own local server.
