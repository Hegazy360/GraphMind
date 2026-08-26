# Telemetry

GraphMind collects a small amount of **anonymous** usage data. This page is
the complete, honest description of what that means: exactly what is sent,
why, and how to turn it off with one environment variable.

## What is sent

One tiny JSON record per command invocation — the command's name and nothing
about what it did:

```json
{
  "event": "serve",
  "installId": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d",
  "version": "0.0.1",
  "ts": "2026-08-26T14:03:07.512Z"
}
```

- **event** — a short command name only (`serve`, `demo`, `import`, `mcp`,
  `record`, `run-ingested`). Never arguments, file paths, prompts, traces,
  run data, or payloads of any kind.
- **installId** — a random UUID generated on this machine the first time
  telemetry fires, stored in `~/.graphmind/telemetry-id`. It identifies an
  *installation*, not a person: it is not derived from your username,
  hardware, email, or anything else about you. Delete the file to get a new
  one.
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

Set one environment variable:

```sh
export GRAPHMIND_TELEMETRY=0    # "false" also works
```

When disabled, **nothing happens at all**: no request is made and no
`telemetry-id` file is created. Telemetry is also disabled automatically
whenever the `CI` environment variable is set, so build machines never
report.

To also remove the existing install id:

```sh
rm ~/.graphmind/telemetry-id
```

## Mechanics and storage

- Events are sent fire-and-forget to `https://graphmind.ai/api/telemetry`
  with a 3-second timeout. Failures are silent, and the request can never
  block, slow down, or hold open the CLI process.
- Records are stored in a private blob store (not publicly readable) and used
  only in aggregate: per-day event counts, unique installs, and returning
  installs.
- The implementation is small and open — see
  [`packages/cli/src/telemetry.ts`](https://github.com/Hegazy360/graphmind/blob/master/packages/cli/src/telemetry.ts)
  for the client and
  [`apps/web/api/telemetry.ts`](https://github.com/Hegazy360/graphmind/blob/master/apps/web/api/telemetry.ts)
  for the receiving end.
