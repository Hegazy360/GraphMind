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
| `pnpm release:status` | Read-only: what npm, PyPI and RubyGems serve vs. what the repo says, plus anything that would block the next release. Exits 1 if anything is behind. |
| `pnpm release` | Guided release from your terminal: fixes blockers, runs the CI gates locally, tags and pushes (or publishes from this machine), watches the registries. Confirms every step; safe to re-run at any point. `--dry-run` shows every command without running any. |
| `pnpm build` | Build everything (packages, viewer, docs). |

Tests:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Typecheck every package (needs `pnpm build:packages` once first). |
| `pnpm test` | Unit tests for `packages/*` (the Circuit, Jack and accounts packages included), the viewer and `apps/jack-api`. |
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
  and `pnpm demo` build `packages/*` on first run, plus `apps/circuit-api`
  and `apps/jack-api`, which `packages/circuit-cli` and `packages/jack-cli`
  import. They rebuild again whenever a source file is newer than its `dist/`.
- **Edited `packages/*`?** Run `pnpm build:packages`. Everything in the repo
  (the CLI, the viewer, the examples) imports the packages' compiled `dist/`,
  and nothing rebuilds it automatically.
- **Edited `apps/circuit-api` or `apps/jack-api`?** `pnpm build:circuit` or
  `pnpm build:jack` (the `circuit:*` and `jack*` scripts run these for you).
  A stale build of either shows up as `tsc` errors in `circuit-cli` or
  `jack-cli` about options that "do not exist": the CLI is compiling against
  old types.
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

## The platform: the end-user experience, end to end

Circuit and Jack are what users reach online, behind one account. `apps/platform`
puts the whole journey on one local origin so it can be walked the way a
visitor would, from the homepage to a running dashboard:

| Command | What it does |
| --- | --- |
| `pnpm platform` | Builds Circuit, Jack and the platform, then serves `http://127.0.0.1:4800`: the homepage at `/` (apps/web, with `/signup` and `/login` wired as graphmind.ai's redirects are), the hub at `/app/`, Circuit at `/app/circuit/`, Jack at `/app/jack/`, every Jack project's MCP server at `/p/<slug>/mcp`. One sign-up on the hub is a session everywhere. |
| `pnpm platform:e2e` | The browser test of that journey: homepage → Create a free account → hub → Circuit (a run pauses) → Jack (import an API) → account token → sign out. |
| `pnpm --filter platform test` | Request-level tests of the composition (redirects, shared session, root MCP URLs, hosted shape). |

Every surface (the hub, Circuit, Jack) uses the shared look and shell from
`packages/ui`: edit `packages/ui/assets/graphmind.css` for the look and
`packages/ui/assets/shell.js` for the top bar, sign-in and the account page.
Account settings live in that one component; inside the platform it is shown
on the hub only.

Options: `--port`, `--workflows <module>` and `--mcp <config>` (defaults: the Circuit
onboarding example), `--data <dir>` (state, default `.platform/`, git-ignored),
`--no-signup`, `--no-site` (hub at `/`). `graphmind-platform serve --public-origin
https://app.graphmind.ai --host 0.0.0.0` is the hosted shape: the hub at `/`, no
homepage (graphmind.ai serves that and redirects `/signup` and `/login` here).

## The homepage (apps/web)

A static page, no build step. What is in it:

- **The live demo in the hero** is the viewer's own fixture run in an `<iframe>`
  (`/try/?fixture=1&tour=1&embed=1`). `tour=1` adds the small card that tells the
  visitor what to do and posts each step to the parent page (`watch → held →
  resumed → done`); `embed=1` hides the canvas controls. In production `/try` is
  graphmind.ai's rewrite to the viewer deployment; locally `pnpm platform` serves
  `apps/viewer/dist-try/try` (`pnpm --filter viewer build:try`). On narrow screens,
  under reduced motion or when WebM can't play, the short recording stands in.
- **Motion** is GSAP 3 + ScrollTrigger (free "no charge" licence), vendored into
  `apps/web/vendor/` with the three fonts (Bricolage Grotesque, Instrument Sans,
  Geist Mono — all OFL) by `pnpm --filter web vendor`; `vendor/NOTICES.txt` lists
  versions and licences. Nothing loads from a CDN. All motion is skipped under
  `prefers-reduced-motion`, and every clip has a pause control (WCAG 2.2.2).
- **The funnel**: `home.js` sends eight anonymous events (`home-view`, `demo-start`,
  `demo-inject`, `demo-done`, `cta-click{where}`, `signup-view`, `signup-done`,
  `product-open`, `activated`) to `api/events.ts` — no cookies, no IP, no user agent,
  one random session id kept in `sessionStorage`. Stored as blobs under
  `events/<event>/<day>/`, so a week's funnel is a listing. Locally the platform
  logs and drops them.
- The research and the reasoning behind the design: `docs/plans/homepage-redesign.md`.

## The homepage clips and screenshots

The clips and stills on graphmind.ai (`apps/web/media/`) are recorded from the
real products, not mocked:

```sh
pnpm media                                              # everything (builds first)
node apps/platform/scripts/capture-media.mjs --only jack,circuit   # just some scenes
```

The debugger scenes drive the built viewer (`pnpm build:viewer`): its in-browser
fixture run, the same one graphmind.ai/try plays, and the workflow builder. The
Circuit, Jack and hub scenes drive the platform with the Circuit onboarding
workflows and the Acme Tasks spec. All data is throwaway (a temp directory;
`~/.graphmind` is never touched). Each scene is a short script in
`apps/platform/scripts/capture-media.mjs` with a drawn cursor so viewers can
follow the clicks: when a dashboard changes, re-run it and commit the new files.

Output: `<scene>.webm` (VP8, 1280×800, 25 fps; encoded with the ffmpeg that
ships with Playwright, which only does VP8, hence WebM) and `<scene>.webp`
posters, plus stills. The page plays a clip only while it is on screen, gives
each one a pause button, and shows the poster under `prefers-reduced-motion` or
in a browser that cannot play WebM.

## Circuit and Jack

The two services live in the same workspace but have their own build and
test entry points, because nothing else in the repo depends on them. Both
dashboards bind `127.0.0.1` and are open by default; add `--accounts` to
either to get self-serve sign-up, sessions and personal API tokens
(`@graphmind-ai/accounts`, `packages/accounts`), `--no-signup` to close
registration, and `--host` / `--public-origin` to put one on a network
(refused without `--accounts` or `--api-key`). The guides are
[`docs/circuit/USAGE.md`](./docs/circuit/USAGE.md) and
[`docs/jack/USAGE.md`](./docs/jack/USAGE.md).

| Command | What it does |
| --- | --- |
| `pnpm circuit:demo` | Builds Circuit and plays the invoice story in one process (in-memory database, free port), printing every HTTP call. |
| `pnpm circuit:dev` | Builds Circuit and starts `circuit dev` on `examples/circuit-onboarding/workflows.mjs`, dashboard at `http://127.0.0.1:4810/`, with hot reload of the workflows file. |
| `pnpm build:circuit` | Rebuild the accounts package and the Circuit packages (`circuit-schema`, `-sdk`, `-engine`, `-mcp`, `circuit-api`, `circuit-cli`). Needed after editing any of them; the two commands above run it first. |
| `pnpm circuit:e2e` | Circuit's browser suite (`apps/circuit-api/e2e/*.e2e.mjs`): the dashboard story and the accounts flow. |
| `pnpm --filter circuit-api test` | Circuit's API unit tests, including `test/accounts.test.ts`. |
| `pnpm jack serve` / `pnpm jack:dev` | The Jack dashboard from this checkout (`pnpm jack …` rebuilds first when the source is newer than `dist/`; `jack:dev` always rebuilds). `pnpm jack serve --accounts` for the sign-up flow. |
| `pnpm jack init <openapi>` / `check` / `build` / `preview` / `tools` / `call` / `deploy` | The `jack` CLI against this checkout; `docs/jack/USAGE.md` covers each. |
| `pnpm jack:example` | Builds Jack and starts the `examples/jack-tasks` API, the worked example every sign-in mode runs against. |
| `pnpm build:jack` | Rebuild the accounts package, the six Jack packages, `apps/jack-api` and the example. |
| `pnpm test:jack` | Unit tests for the accounts package, `packages/jack-*`, `apps/jack-api` and the example. |
| `pnpm test:jack:e2e` | Jack's browser suite (`apps/jack-api/e2e/*.e2e.mjs`): the dashboard and the accounts flow (sign up, own workspace, API token, a second account sees nothing of the first). |

`pnpm test` runs `apps/jack-api`'s unit tests too, so a change to the
accounts middleware shows up in the ordinary test run.

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
