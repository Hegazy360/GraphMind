# Developing GraphMind

How to run, test and build this repository while working on it. For what to
contribute and how to get it merged, see [CONTRIBUTING.md](./CONTRIBUTING.md);
for the Python and Ruby SDKs, see the
[Python and Ruby section](./CONTRIBUTING.md#python-and-ruby) there.

## Setup

Node >= 22.13 and pnpm (`corepack enable` gives you the pinned version). Then:

```sh
pnpm install
```

That is the only required step. The dev commands below build the workspace
packages themselves the first time they run.

Don't want to memorize anything? **`pnpm start`** opens an interactive menu
of everything on this page — pick with the arrow keys, Enter runs it. Each
entry shows the direct command it stands for, so the menu doubles as a way to
learn the shortcuts. (New dev commands belong in both this file and the menu:
one entry in the `ITEMS` list in `scripts/menu.mjs`.)

## Everyday commands

All of these run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm start` | Interactive menu of all of the below — nothing to memorize. |
| `pnpm dev` | The dev loop: a GraphMind server replaying the bundled demo session, plus the viewer on Vite with hot reload. Start here. |
| `pnpm dev --serve` | Same, but an empty server instead of the demo — for attaching an agent you are working on. |
| `pnpm dev:viewer` | Viewer only, no server. Append `?fixture=1` to the URL for a canned run. |
| `pnpm dev:docs` | The documentation site (Astro/Starlight) with hot reload. |
| `pnpm demo` | The shipped first-run experience: `graphmind demo` from this checkout. |
| `pnpm cli <args>` | Any CLI command against this checkout: `pnpm cli runs`, `pnpm cli record <runId> --out bug.ndjson`, … `pnpm cli help` lists them all, and a typo gets a "did you mean" suggestion. |
| `pnpm build:packages` | Rebuild `packages/*` after editing them (the dev commands do **not** watch package sources). |
| `pnpm build:viewer` | Build the viewer and copy it into `packages/cli/viewer-dist/`, so the CLI serves the real viewer like a published install. |
| `pnpm build` | Build everything (packages, viewer, docs). |

Tests:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Typecheck every package (needs `pnpm build:packages` once first). |
| `pnpm test` | Unit tests for `packages/*` and the viewer. |
| `pnpm test:e2e` | The viewer's Playwright suite. |
| `pnpm test:security` | The security regression suite. Run `pnpm build:viewer` first — it audits the HTML export, which needs the bundled viewer (CI does the same). |
| `pnpm test:all` | `pnpm test` plus the web app's tests. |
| `pnpm --filter e2e-smoke e2e` | Full-stack smoke test against a server you already started. |

Long-running checks: `pnpm soak` (sustained-load harness) and
`pnpm live-check` (runs a real agent; needs an API key).

## What `pnpm dev` actually runs

Two processes, with prefixed output:

- **`[server]`** — the checkout's CLI (`packages/cli/dist/cli.js demo
  --no-open`) on **port 4747**: real ingest pipeline, SQLite storage, control
  protocol. The demo replay pauses on its planted bug so there is always
  something to debug. With `--serve` it starts empty instead.
- **`[viewer]`** — `apps/viewer` on Vite, **port 5199**, with hot reload. In
  dev builds the viewer connects to `ws://127.0.0.1:4747/ws/ui` by default.

The script also handles the two sharp edges of wiring these up by hand:

- **The origin guard.** The server only accepts browser connections from its
  own origin; `http://localhost:5199` is someone else. `pnpm dev` starts the
  server with `GRAPHMIND_ALLOWED_ORIGINS` covering the Vite origin, so the
  dev viewer's websocket is accepted (any value you already have in that
  variable is kept).
- **The viewer token.** A tokenless viewer may continue/retry/abort, but never
  inject results, edit inputs, or change breakpoints. `pnpm dev` prints a
  `full-control viewer:` URL (`http://localhost:5199/#token=…`) once the
  server has written its credential; open that one when you are working on
  the control surfaces.

Ports are fixed (4747 for the server, 5199 for Vite with `strictPort`) — if
one is taken, stop whatever holds it.

## When do I need which build?

- **Never built anything yet?** Don't worry about it — `pnpm dev`, `pnpm cli`
  and `pnpm demo` build `packages/*` on first run.
- **Edited `packages/*`?** Run `pnpm build:packages`. Everything in the repo
  (the CLI, the viewer, the examples) imports the packages' compiled `dist/`,
  and nothing rebuilds it automatically.
- **Edited `apps/viewer` ?** Nothing to build — `pnpm dev` hot-reloads it. You
  only need `pnpm build:viewer` to test the *CLI-served* viewer (what `npx
  graphmind-ai` users get, including the `graphmind record --html` export);
  without it the server serves a placeholder page and `pnpm cli` warns you.

## The examples

| Command | What it does |
| --- | --- |
| `pnpm --filter demo-agent start` | The trip-planner demo agent in deterministic mock mode (no key). Point it at a running server, e.g. `pnpm dev --serve`. |
| `pnpm --filter demo-agent start:live` | Same agent against a real model (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). |
| `pnpm cli demo --live` | Server + live demo agent in one command. |

## Usage telemetry report (maintainers)

The published CLI sends anonymous usage events — command name, random install
id, version, timestamp, nothing else; [packages/cli/TELEMETRY.md](./packages/cli/TELEMETRY.md)
is the full disclosure. They land in the Vercel Blob store behind
`graphmind.ai/api/telemetry`. To see the aggregates you need that store's
token, so this is maintainer-only:

```sh
cd apps/web && vercel env pull .env.local   # once; or export BLOB_READ_WRITE_TOKEN
pnpm telemetry:report                        # terminal numbers (from the repo root)
pnpm telemetry:report --html                 # + telemetry-report.html with charts
pnpm telemetry:report --html out/usage.html  # choose the output path
```

The HTML page is self-contained (inline SVG, no scripts, no external assets)
and carries only the aggregates — per-day counts by command, unique installs
per day, command totals, and the returning-installs number — so it is safe to
share. The report reads only blob *pathnames*, never bodies.

The repo's own dev commands (`pnpm dev`, `pnpm start`, …) record nothing;
telemetry is a published-CLI feature only.

## Scripting against the checkout's CLI

`pnpm cli` keeps its own chatter on stderr, so JSON output pipes cleanly; use
pnpm's `--silent` to suppress pnpm's own banner too:

```sh
pnpm --silent cli pauses --json | jq .
```
