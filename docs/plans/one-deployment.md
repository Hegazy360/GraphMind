# One deployment: graphmind.ai as a single Vercel project, backed by Supabase

> Status: plan, updated 2026-11-17 (Supabase chosen for Postgres and auth;
> one Supabase project, no staging). Nothing here is built yet.
> Goal: every surface a visitor or user reaches (homepage, docs, the in-browser
> debugger, sign-in, the hub, Circuit, Jack, hosted MCP) ships from one Vercel
> project, on one origin, from one `git push`. Data and user sign-in live in
> Supabase. Preview deployments get the whole product on a self-contained
> in-memory backend, so they never touch production data.

## 0. Implementation status (2026-11-17)

Steps 2–4 are implemented on this branch and verified; production goes live
when it merges to `master` (Vercel builds from the repo root). What was built,
and where it differs from the plan below:

- **No `apps/site` rename.** `apps/platform` is the deployable. `src/hosted.ts`
  builds it from environment variables (Postgres + Supabase Auth when
  `POSTGRES_URL` is set; SQLite + in-house accounts on previews), `src/vercel.ts`
  is the function entry.
- **Build Output API instead of `vercel.json` rewrites.** `pnpm build:site`
  builds the workspace, docs and `/try`, then `apps/platform/scripts/build-vercel.mjs`
  writes `.vercel/output`: static files, the platform function and the three
  homepage Blob functions (bundled with esbuild), and the routes. Root
  `vercel.json` only sets the install and build commands. Migrations run in
  that script when `POSTGRES_URL_NON_POOLING` is present (production builds).
- **Function limits.** Vercel Hobby caps prebuilt functions at 60 s, so the
  platform function has `maxDuration: 60` and the engine drains 20 s after a
  request and 45 s per tick, handing any remainder to a fresh invocation.
  Functions run in `dub1`, next to the Supabase project (eu-west-1).
- **TLS to Supabase is verified** against the pinned Supabase Root 2021 CA
  (`packages/db/src/supabase-ca.ts`); Node's trust store does not include it.
- **Auth** is server-side against Supabase Auth with PKCE email links
  (`packages/accounts/src/supabase.ts`); the browser never holds a Supabase
  token. Optional `SUPABASE_SECRET_KEY` enables per-visitor rate limits
  (`Sb-Forwarded-For`).
- **Engine tick**: `apps/platform/sql/engine-tick.sql`, run once as `postgres`.
- **Tests**: every store has a contract suite on SQLite and Postgres; CI job
  `postgres stores and site build` runs the Postgres legs and the full site
  build on each push.

Merged and live on 2026-11-17. Step 6 (decommission), repo side, done the same
day: `deploy-docs.yml`, `apps/docs/vercel.json` and the docs deploy script
removed, every reference to the old deployments updated. Account side, for the
owner: `vercel project rm graphmind-docs`, `vercel project rm graphmind-try`,
`gh secret delete VERCEL_TOKEN`. `app.graphmind.ai` stays unregistered.

## 1. Where we are

### 1.1 The deployments that exist today

| Surface | Code | Where it runs | How it deploys | State |
| --- | --- | --- | --- | --- |
| graphmind.ai (homepage + 3 Blob functions) | `apps/web` | Vercel project `graphmind`, root dir `apps/web`, git-connected (master) | Automatic on push | Healthy |
| graphmind.ai/docs | `apps/docs` (Astro) | Vercel project `graphmind-docs`, **not git-connected** | `deploy-docs.yml` pushes with a `VERCEL_TOKEN`; `graphmind` rewrites `/docs/*` to `graphmind-docs.vercel.app` | Works, fragile (fell 55 days behind once) |
| graphmind.ai/try | `apps/viewer` (`build:try`) | Vercel project `graphmind-try`, **not git-connected** | Manual `vercel deploy` from a laptop; `graphmind` rewrites `/try/*` to it | Works, 61 days stale |
| app.graphmind.ai (hub, sign-in, Circuit, Jack, `/p/<slug>/mcp`) | `apps/platform` + `apps/circuit-api` + `apps/jack-api` | **Nowhere.** No DNS record, no host. | — | Down |

### 1.2 Why sign-in and sign-up are unreachable

`apps/web/vercel.json` redirects `/login` and `/signup` to
`https://app.graphmind.ai/#/signin` and `#/signup`. `app.graphmind.ai` does
not resolve, and the platform server that would answer there has never been
hosted. Every "Start free" and "Sign in" link on the homepage dead-ends.

### 1.3 What the platform server needs from a host

`graphmind-platform serve` (`apps/platform/src/cli.ts`) is one Node process
that assumes a machine:

- **Four SQLite files on local disk** via `node:sqlite`: `accounts.db`,
  `circuit.db`, `jack.db`, and one `auth.db` per Jack project. The four store
  interfaces (`AccountStore`, `JournalStore`, `JackStore`, `AuthStore`) are
  **synchronous**, ~85 methods in total.
- **A 32-byte sealing key in a file** (`jack/secret.key`).
- **A background loop**: `startEngineLoop` runs `executor.drain()` every
  100 ms. The store already has lease-based `claimDue`, so many workers are
  safe; only the trigger is process-bound.
- **A child process**: the onboarding demo's stdio `billing` MCP server.
- **No long-lived connections**: MCP Streamable HTTP and polling only.

Vercel Functions provide none of the first four. The plan below removes each
dependency.

### 1.4 The in-house accounts system, and why sign-in moves to Supabase Auth

`packages/accounts` is sound on the basics (scrypt, hashed session and API
tokens, `__Host-` HttpOnly cookies, same-origin check on mutations, timing-safe
login, login rate limit). It lacks password reset, email verification, MFA and
social sign-in, and its rate limiter is in memory, which stops working across
serverless instances. Supabase Auth provides all of these on the free plan
(50,000 MAU). No production accounts exist yet, so there is nothing to migrate.

`packages/accounts` is **kept** for local dev, tests and self-hosting
(`jack serve --accounts`, `circuit dev --accounts` are shipped CLI features).
Hosted, Supabase Auth replaces it behind one interface (Step 2).

What stays in-house even when hosted:

- **Personal API tokens** (scripts calling the Circuit/Jack APIs). Supabase
  does not issue these for an app's users; the `api_tokens` table stays,
  keyed to the Supabase user id.
- **Jack's per-project OAuth server** (`packages/jack-auth`): how *customers'*
  users sign in to their MCP servers. A product feature, not our login.

### 1.5 Facts checked (2026-11-15/16)

- Vercel team `hegazy360s-projects` is on **Hobby**: non-commercial use only,
  functions up to 300 s, schedules at most every 15 minutes.
  [Terms](https://vercel.com/legal/terms), [Hobby](https://vercel.com/docs/plans/hobby.md),
  [Limits](https://vercel.com/docs/functions/limitations), [Schedules](https://vercel.com/docs/schedules/limits).
- **Supabase Free**: 500 MB database per project, 2 active free projects,
  50,000 MAU, **paused after about a week of low activity**, no automatic
  backups, no branching. Pro is $25/month.
  [Pricing](https://supabase.com/pricing), [Pausing](https://supabase.com/kb/faqs/platform/free-project-pausing).
- **Supabase API keys**: new projects have a *publishable* key
  (`sb_publishable_…`, browser-safe, RLS applies) and *secret* keys
  (`sb_secret_…`, bypass RLS, server only, several can be created and revoked
  individually). The legacy `anon`/`service_role` JWT keys are deprecated by
  end of 2026. User access tokens are signed with rotatable asymmetric
  **JWT signing keys**, verifiable through the public JWKS endpoint with no
  shared secret. [API keys](https://supabase.com/docs/guides/getting-started/api-keys),
  [Migrating keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys),
  [JWT signing keys](https://supabase.com/blog/jwt-signing-keys).
- **Supabase ↔ Vercel integration** syncs `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `POSTGRES_URL` (pooled),
  `POSTGRES_URL_NON_POOLING` and others into the Vercel project; synced vars
  cannot be edited in Vercel. [Supabase docs](https://supabase.com/docs/guides/integrations/vercel-marketplace).
  This plan uses **the same variable names** but sets them by hand (Step 1),
  so switching to the integration later changes no code.
- Hono runs as a Vercel Function via `handle(app)` from `hono/vercel`
  (Hono 4.13 in the lockfile). [Hono](https://hono.dev/docs/helpers/adapter).

## 2. Decision

- **One Vercel project, one origin.** `graphmind.ai` serves everything; the hub
  moves from `app.graphmind.ai` to **`graphmind.ai/app/`**, the shape
  `pnpm platform` already runs and tests locally.
- **Supabase for data and sign-in.** Supabase Postgres holds the Circuit,
  Jack, Jack-auth and API-token tables; Supabase Auth owns users, passwords,
  sessions, email verification, password reset and MFA. The app talks to
  Postgres directly through the transaction pooler with its own database role,
  not through Supabase's REST Data API, which is turned off.
- **Supabase `pg_cron` drives the engine tick** every minute, which works on
  Vercel Hobby (no Vercel Schedule needed).
- **One Supabase project** (`GraphMind`, ref `kgfougyikmmpmqmjnkiq`,
  eu-west-1, Postgres 17). No staging project for now. Preview deployments
  and CI get no Supabase variables at all: the site boots on SQLite in the
  function's temp directory plus the in-house accounts package, which is
  enough to review UI and flows, and loses its data when the instance goes
  away. A staging project can be added later by setting the same variables
  for the *Preview* environment.
- **Local dev needs no Supabase and no secrets.** `pnpm platform` keeps SQLite
  and `packages/accounts`.
- **Vercel Hobby until the product charges money**, then Vercel Pro and
  Supabase Pro together (Pro also brings backups and no pausing).

Rejected: Render (a second platform and a single disk-bound instance, which
this plan exists to end; it stays the fallback if a resident worker is ever
needed); Supabase Edge Functions for the app (Deno, tighter limits; the
platform is a Node workspace); Next.js (the apps are already Hono).

## 3. Target layout

```
apps/site/                      the ONE deployable (rename of apps/platform)
  api/index.ts                  Vercel Function: handle(createSite(...)) from 'hono/vercel'
  public/                       build output, git-ignored: homepage, docs/, try/
  vercel.json                   rewrites, headers, function config
  src/index.ts                  createSite(): today's createPlatform + the three Blob routes
  src/boot.ts                   builds the graph from env vars once per function instance
  src/cli.ts                    `dev` / `serve` unchanged for local and self-hosting
  scripts/build-public.mjs      assembles public/ from web, docs, viewer
  migrations/*.sql              Postgres schema (schema `graphmind`), applied at build
packages/auth-core/             AuthProvider interface: principalFor(req), routes, status
packages/accounts               AuthProvider #1: in-house (local, tests, self-host)
packages/auth-supabase/         AuthProvider #2: Supabase session cookie + JWKS verify, API tokens in Postgres
packages/circuit-engine, jack-auth, apps/jack-api
  src/store.ts                  async interfaces
  src/sqlite-store.ts           node:sqlite (local, tests)
  src/pg-store.ts               Postgres (hosted)
packages/db/                    pg pool from POSTGRES_URL, migration runner
```

`vercel.json` (sketch):

```json
{
  "cleanUrls": true,
  "rewrites": [
    { "source": "/app", "destination": "/api" },
    { "source": "/app/:path*", "destination": "/api" },
    { "source": "/p/:path*", "destination": "/api" },
    { "source": "/.well-known/:path*", "destination": "/api" },
    { "source": "/dashboard/callback", "destination": "/api" },
    { "source": "/api/:path*", "destination": "/api" }
  ],
  "redirects": [
    { "source": "/login",  "destination": "/app/#/signin", "permanent": false },
    { "source": "/signup", "destination": "/app/#/signup", "permanent": false }
  ],
  "functions": { "api/index.ts": { "maxDuration": 300 } }
}
```

Static files win over rewrites, so `/`, `/docs/*` and `/try/*` never touch the
function.

## 4. Secrets: what exists, where it lives, who can read it

Rule: a secret is copied from the dashboard that issues it straight into the
secret store that uses it. Never into the repo, a chat, an issue, a terminal
command line (shell history), or a `.env` file that is not git-ignored
(`.env*` is ignored by `.gitignore`). Nobody needs production secrets on a
laptop: local dev runs on SQLite.

| Value | Secret? | Where it is stored | Vercel env scope |
| --- | --- | --- | --- |
| Supabase project URL `https://<ref>.supabase.co` | No | Vercel env `SUPABASE_URL` | Production |
| Publishable key `sb_publishable_…` | No (public by design; served to browsers) | Vercel env `SUPABASE_PUBLISHABLE_KEY` | Production |
| Database password of the `postgres` user | **Yes, highest** | **Password manager only.** Used only to create the app role (Step 1A.6). | Never in Vercel |
| App role password (`graphmind_app`) | **Yes** | Password manager + inside the two URLs below | — |
| Transaction pooler URL (port 6543, `graphmind_app`) | **Yes** | Vercel env `POSTGRES_URL`, *Sensitive* | Production |
| Session pooler URL (port 5432, `graphmind_app`), for migrations at build | **Yes** | Vercel env `POSTGRES_URL_NON_POOLING`, *Sensitive* | Production |
| `CRON_SECRET` (tick endpoint bearer token) | **Yes** | Vercel env *Sensitive* + Supabase **Vault** secret `cron_secret` | Production |
| `JACK_SECRET_KEY` (32 bytes, seals Jack upstream credentials) | **Yes** | Vercel env *Sensitive* + a copy in the password manager (losing it makes sealed credentials unreadable) | Production |
| SMTP credential (email provider API key) | **Yes** | Supabase → Auth → SMTP settings only | Never in Vercel |
| Supabase secret key `sb_secret_…` | **Yes** | **Not created yet.** Nothing at launch needs it (session checks use public JWKS). Create a *named* key per consumer only when an admin feature needs it. | — |
| Legacy JWT secret / `anon` / `service_role` | **Yes** | Not used anywhere. Disable if present. | — |
| `BLOB_READ_WRITE_TOKEN` | **Yes** | Already in Vercel, but stored **non-sensitive** on all three environments, so it is readable in the dashboard and pulled to laptops by `vercel env pull`. Re-create it as *Sensitive*, Production only, then rotate the token in the Blob store (Section 7). | Production |

Vercel *Sensitive* variables cannot be read back in the dashboard or pulled
with `vercel env pull`; they exist only for preview and production builds and
functions. That is the property we want.

Do not run `vercel env pull` for this project on a laptop; nothing local needs
these values. Note that `vercel link` pulls the *Development* variables into
`.env.local` on its own; keep nothing in the Development environment, and
delete that file if it appears (`.env*` is git-ignored).

## 5. Steps

Each step ends green and is one PR. **YOU** marks actions only the account
owner can take.

### Step 0 — Stop the bleeding (optional, same day)

Change the two redirects in `apps/web/vercel.json` to a small `/early-access`
page with the waitlist form, so sign-in links stop dead-ending until Step 5.

### Step 1A — Supabase setup (**YOU**, about 45 minutes)

The exact CLI commands and checks are in Section 7; the dashboard-only
settings are listed here.

1. **Region.** Settings → General: note the region. It cannot change later.
   Set the Vercel function region to the nearest one (Step 1B.3) so every
   query is a short hop. Project ref and region are not secrets.
2. **Database password.** If the password set at creation is not already in
   your password manager, or was ever pasted anywhere else: Database →
   Settings → *Reset database password*, generate it there, save it straight
   to the password manager.
3. **JWT signing keys.** Settings → JWT Keys. The *current* key should be an
   asymmetric one (ECC P-256 / RS256). If the current key is *Legacy HS256*,
   create a standby asymmetric key, rotate to it, then revoke the legacy one.
4. **API keys.** Settings → API Keys. Keep the default publishable key. If a
   *Legacy API keys* tab shows `anon`/`service_role`, disable them. Do not
   create a secret key.
5. **Turn off the Data API.** Settings → Data API: disable it (or, if you
   prefer to keep it, set *Exposed schemas* to nothing but `public`, which
   stays empty). The app never uses PostgREST; disabling it means the
   publishable key reaches only the Auth API. As defence in depth, every
   table in our migrations enables RLS with no policies.
6. **Create the app's database role** (so the app never holds the `postgres`
   password). Install a client if needed (`brew install libpq`), then connect
   using the session-pooler connection string from the dashboard's *Connect*
   panel. Type the `postgres` password at psql's prompt, not on the command
   line:
   ```sql
   create role graphmind_app login;
   \password graphmind_app            -- psql prompts; only a SCRAM hash is sent
   grant graphmind_app to postgres;   -- PG16+: postgres is not a superuser on Supabase; it needs
                                      -- membership to SET ROLE / own objects for the new role
   create schema graphmind authorization graphmind_app;
   alter role graphmind_app set search_path = graphmind;
   ```
   Generate the password in your password manager. `\password` keeps it out
   of SQL history and server logs. The pooler username becomes
   `graphmind_app.<project-ref>`.
7. **Auth → URL Configuration.** Site URL `https://graphmind.ai`. Redirect
   URLs `https://graphmind.ai/app/**`.
8. **Auth → Providers → Email.** Enable *Confirm email*; minimum password
   length 10 (today's rule). Disable providers you do not use (phone,
   anonymous). Leave Google/GitHub for later; their client secrets go only
   into these provider settings.
9. **Auth → MFA.** Enable TOTP.
10. **Auth → SMTP.** The built-in sender is for testing (team addresses only,
    low rate limit). Sign up for an email provider (Resend, Postmark, SES),
    verify `graphmind.ai` there (the SPF/DKIM records go in at Namecheap),
    create an API key **in that provider's dashboard and paste it directly
    into this SMTP form**. Sender `no-reply@graphmind.ai`. Then customise the
    confirm/reset email templates' link to land on `/app/`.
11. **Optional: Auth → Attack Protection → CAPTCHA** with Cloudflare
    Turnstile. The Turnstile secret goes only into this form; the site key is
    public.
12. **Integrations → Cron and Integrations → Vault.** Enable the `pg_cron`
    and `pg_net` extensions (Database → Extensions). Generate the cron secret
    without displaying it: `openssl rand -hex 32 | tr -d '\n' | pbcopy`.
    Paste it in Vault as a new secret named `cron_secret`, then into Vercel
    (Step 1B.4), then clear the clipboard: `pbcopy < /dev/null`.
    The cron job itself is created by a migration in Step 3; it reads the
    token from Vault, so the token never appears in SQL.
13. **Connection strings for Vercel.** *Connect* panel → copy the
    **Transaction pooler** URI (port 6543) and the **Session pooler** URI
    (port 5432). Replace the user with `graphmind_app.<ref>` and the password
    placeholder with the app role's password. Paste each straight into
    Vercel (Step 1B.4). They contain a password; treat them as secrets.

### Step 1B — Vercel and GitHub setup (**YOU**, about 20 minutes)

1. **Project root.** Vercel → `graphmind` → Settings → General → Root
   Directory `.` (was `apps/web`), Node.js 24.x, preset "Other". Do this in
   the same PR window as Step 4; until then the current site keeps building
   from `apps/web`.
2. **Fluid compute** on (Settings → Functions).
3. **Function region** (Settings → Functions → Region) to the one closest to
   the Supabase production region (e.g. `fra1` for eu-central-1, `iad1` for
   us-east-1).
4. **Environment variables** (Settings → Environment Variables → Add, or the
   CLI commands in Section 7). For each secret tick **Sensitive** and choose
   **Production only**. Preview and Development get none of them.
   `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `POSTGRES_URL`,
   `POSTGRES_URL_NON_POOLING`, `CRON_SECRET`, `JACK_SECRET_KEY`
   (`openssl rand -base64 32 | tr -d '\n' | pbcopy`, paste, save a copy in the
   password manager, clear the clipboard), `PUBLIC_ORIGIN=https://graphmind.ai`.
   With the CLI, `vercel env add NAME production --sensitive` prompts for the
   value; never pass a value as an argument.
5. **GitHub → Settings → Code security**: enable *Secret scanning* and *Push
   protection* (they recognise Supabase and Vercel tokens), so an accidental
   commit is blocked before it lands.
6. CI needs no Supabase secret: the pg store tests run against a throwaway
   `postgres:16` service container.

Nothing in Step 1 changes what is live.

### Step 2 — Async stores, Postgres, and a pluggable auth provider (~1 week)

1. `packages/db`: `pg` pool from `POSTGRES_URL` (`max: 2` per instance;
   transaction pooler, so no session state and no named prepared statements),
   a small migration runner over `migrations/*.sql` recorded in
   `graphmind._migrations`, run from the build with `POSTGRES_URL_NON_POOLING`.
2. Make the store interfaces return Promises (`Executor` 52 call sites,
   Jack `projects.ts`/`index.ts` 40, `data-plane.ts`); keep the SQLite
   implementations wrapped as async so local dev and tests are unchanged.
3. `PgJournalStore`, `PgJackStore`, `PgAuthStore` in schema `graphmind`, RLS
   enabled on every table. `claimDue` becomes `UPDATE … WHERE id IN (SELECT …
   FOR UPDATE SKIP LOCKED) RETURNING *`. Jack's per-project `auth.db` files
   become tables with a `project_id` column.
4. `packages/auth-core`: the `AuthProvider` interface the hub, Circuit and
   Jack already consume implicitly (`principalFor(req)`, `require`
   middleware, `status()`, API-token routes). `packages/accounts` implements
   it unchanged.
5. `packages/auth-supabase`: the hub's sign-in/up/reset/MFA screens call
   Supabase Auth with the publishable key from the browser (`@supabase/ssr`
   keeps the session in a cookie on `graphmind.ai`). Server side, the
   principal comes from verifying the access token against the project's JWKS
   (cached; no secret). Personal API tokens: the existing hashed-token design,
   in `graphmind.api_tokens` keyed by the Supabase user id. The same-origin
   check on cookie-authenticated mutations stays.
6. `JACK_SECRET_KEY` from env when set; file fallback locally.
7. Store tests run against both backends (`sqlite`, `pg`).

### Step 3 — An engine without a resident process (2–3 days)

1. `Executor.drain({ budgetMs })` stops claiming when the budget is spent and
   reports whether work remains.
2. Mutating Circuit requests run the drain after the response with
   `waitUntil` (`@vercel/functions`); while work remains it re-kicks itself
   via `POST /api/internal/tick`.
3. `/api/internal/tick` requires `Authorization: Bearer $CRON_SECRET`
   (constant-time compare) and drains with a budget.
4. A migration creates the `pg_cron` job, every minute, calling the tick with
   `pg_net`, reading the token from Vault at run time:
   ```sql
   select cron.schedule('graphmind-tick', '* * * * *', $$
     select net.http_post(
       url := 'https://graphmind.ai/api/internal/tick',
       headers := jsonb_build_object('authorization', 'Bearer ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))
     ) $$);
   ```
   This is also the activity that keeps a free project from pausing.
5. The demo `billing` MCP server moves in-process (an `inprocess` transport in
   `packages/circuit-mcp`); stdio stays for local configs.
6. The local CLI keeps the 100 ms `startEngineLoop`.

### Step 4 — `apps/site`, the single deployable (2–3 days)

1. `git mv apps/platform apps/site`; `pnpm platform` keeps working.
2. `src/boot.ts` reads env vars once per instance and chooses the backends:
   `POSTGRES_URL` set → Postgres stores + Supabase auth; unset → SQLite +
   `packages/accounts`. Missing-but-required variables fail the boot with
   the variable *name* only, never a value.
3. Fold `apps/web/api/{waitlist,events,telemetry}.ts` into Hono routes.
4. `build-public.mjs` copies the homepage, `apps/docs/dist/docs` and
   `apps/viewer/dist-try/try` into `public/`; docs link check runs here.
5. Root `vercel.json`, `installCommand` `pnpm install --frozen-lockfile`,
   `buildCommand` `pnpm build:site && pnpm --filter site migrate`,
   `outputDirectory` `apps/site/public`.
6. Origin: `PUBLIC_ORIGIN ?? https://${VERCEL_URL}`.
7. Logging: a redaction helper strips `authorization`, `cookie`, `apikey`
   headers and connection strings from every logged error; the security
   suite gets a test for it.

### Step 5 — Cutover (half a day)

1. Merge; watch the first build (6–10 minutes).
2. Smoke: `/login` → sign-up → confirmation email arrives → hub → Circuit (a
   run pauses and an approval timeout fires via the cron) → Jack (import the
   Acme spec) → `/p/<slug>/mcp` answers → `/docs/`, `/try/?fixture=1`,
   `/api/waitlist`.
3. **YOU:** Supabase → Integrations → Cron shows successful runs; Vercel
   function logs show no boot errors.
4. `deploy-smoke.yml` runs the request-level smoke after each master deploy.

### Step 6 — Decommission (1 hour)

1. Delete `deploy-docs.yml`, `apps/docs/.vercel`, the `deploy:vercel` script,
   the `/docs` and `/try` rewrites, and stale README/DEVELOPMENT references.
2. **YOU:** delete Vercel projects `graphmind-docs` and `graphmind-try`;
   delete the `VERCEL_TOKEN` GitHub secret if nothing uses it.
3. `app.graphmind.ai` stays unregistered (or add it to the project as a
   redirect to `/app/`).

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Free Supabase project pauses after a quiet week | The per-minute cron is database activity; a pause still emails a week ahead. Move to Supabase Pro before charging money. |
| No backups on Supabase Free | Before real users: Supabase Pro (daily backups), or a nightly `pg_dump` GitHub Action to encrypted storage using a read-only role. |
| A secret leaks | Each one is rotatable on its own: reset the role password or the DB password, rotate the JWT signing key, regenerate `CRON_SECRET` (Vault + Vercel), then redeploy. `JACK_SECRET_KEY` rotation needs a re-seal migration; keep it in the password manager. |
| Built-in email limits block sign-ups | Custom SMTP is part of Step 1A, before launch. |
| Cold start of the whole platform | Fluid compute keeps instances warm; split `/p/*` into its own function later if needed. |
| Long Circuit runs | Budgeted drain + self-kick + per-minute cron; Vercel Workflows later. |
| Connection count | Transaction pooler, `max: 2` per instance. |
| Vercel Hobby terms | Upgrade to Pro before the product charges anything. |
| Previews have no durable database | By design: they boot on SQLite + in-house accounts and lose data per instance. Add a staging Supabase project to the *Preview* environment when a reviewer needs persistent data. |

## 7. CLI runbook (Supabase CLI 2.114, Vercel CLI 59)

Both CLIs are logged in on the maintainer's machine. The repo root is linked
to the Vercel project `graphmind` (`.vercel/`, git-ignored) and to the
Supabase project `kgfougyikmmpmqmjnkiq` (`supabase/.temp/`, git-ignored).
Commands below print no secret values; the ones that would are listed under
"never run".

### 7.1 Supabase

```sh
# Which project is linked (ref, region, status; no keys)
supabase projects list --output-format json | python3 -c 'import sys,json; [print(p["ref"], p["name"], p["region"], p["status"], "linked" if p["linked"] else "") for p in json.load(sys.stdin)["projects"]]'
# expected: kgfougyikmmpmqmjnkiq GraphMind eu-west-1 ACTIVE_HEALTHY linked

# Create the app role (the ONLY step that needs the postgres password; type it at the prompt)
#   host/port/user: Dashboard → Connect → "Session pooler" tab. Enter the URI without the password.
psql "postgresql://postgres.kgfougyikmmpmqmjnkiq@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require"
#   then, inside psql:
#   create role graphmind_app login;
#   \password graphmind_app          -- prompts twice; generate the value in the password manager
#   grant graphmind_app to postgres;  -- without this: ERROR: must be able to SET ROLE "graphmind_app"
#   create schema graphmind authorization graphmind_app;
#   alter role graphmind_app set search_path = graphmind;
#   grant usage on schema graphmind to graphmind_app;
#   \q

# Verify the role and schema exist (still as postgres, or re-run psql above)
#   select rolname, rolcanlogin from pg_roles where rolname = 'graphmind_app';
#   select schema_name, schema_owner from information_schema.schemata where schema_name = 'graphmind';

# Verify the app role can connect through the TRANSACTION pooler (port 6543); password at the prompt
psql "postgresql://graphmind_app.kgfougyikmmpmqmjnkiq@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require" -c 'select current_user, current_schema();'
# expected: graphmind_app | graphmind

# Extensions for the engine tick (idempotent)
#   as postgres:  create extension if not exists pg_cron; create extension if not exists pg_net;
#   verify:       select extname from pg_extension where extname in ('pg_cron','pg_net');

# Migrations, once Step 2 exists: files live in supabase/migrations/ and are applied with
supabase db push --dry-run --linked      # shows what would run; nothing is applied
supabase db push --linked                # applies; prompts for the postgres password
supabase migration list --linked         # local vs remote history must match

# Health / inspection (no secrets)
supabase inspect db table-sizes --linked
supabase inspect db role-connections --linked
```

The exact pooler hostname is shown in Dashboard → Connect; use that one if it
differs from `aws-0-eu-west-1`.

**Never run** (they print keys or write them to disk): `supabase projects
api-keys`, `supabase status -o env`, `supabase db push -p <password>` (the
password lands in shell history; let it prompt), `supabase link` with
`--password`.

`supabase config push` is not used for now: it pushes the whole
`config.toml`, and the default file generated by `supabase init` would
re-enable the Data API and reset the auth URLs to localhost. Auth settings
are made in the dashboard (Step 1A) until a `[remotes.production]` config is
captured deliberately.

### 7.2 Vercel

```sh
# Linked project and team
cat .vercel/project.json                 # projectName graphmind, orgId team_Dp8LiV7XQFRYPkyucddtu5Na
vercel whoami                            # hegazy360

# Add each secret: the command prompts for the value; paste it, press Enter.
# Nothing is passed on the command line.
vercel env add SUPABASE_URL production
vercel env add SUPABASE_PUBLISHABLE_KEY production
vercel env add PUBLIC_ORIGIN production                      # https://graphmind.ai
vercel env add POSTGRES_URL production --sensitive            # transaction pooler, 6543, graphmind_app
vercel env add POSTGRES_URL_NON_POOLING production --sensitive # session pooler, 5432, graphmind_app
vercel env add CRON_SECRET production --sensitive             # same value as Vault secret cron_secret
vercel env add JACK_SECRET_KEY production --sensitive

# Fix the Blob token: remove the non-sensitive copies, re-add as sensitive, then rotate it
vercel env rm BLOB_READ_WRITE_TOKEN development
vercel env rm BLOB_READ_WRITE_TOKEN preview
vercel env rm BLOB_READ_WRITE_TOKEN production
#   Dashboard → Storage → the Blob store → Settings → tokens: create a new read-write token
vercel env add BLOB_READ_WRITE_TOKEN production --sensitive
#   then revoke the old token in the same screen.

# Verify: names, types and environments only; sensitive values are never displayed
vercel env ls production
vercel env ls preview                     # expected: empty
vercel env ls development                 # expected: empty

# Function region next to eu-west-1 (one region on Hobby)
#   Dashboard → graphmind → Settings → Functions → Function Region → dub1 (Dublin)
# Root directory, Node 24, Fluid compute: Settings → General / Functions (Step 1B)
```

Generate the two random secrets without displaying them:

```sh
openssl rand -hex 32    | tr -d '\n' | pbcopy   # CRON_SECRET → paste into Vault, then into vercel env add
openssl rand -base64 32 | tr -d '\n' | pbcopy   # JACK_SECRET_KEY → paste into vercel env add and the password manager
pbcopy < /dev/null                               # clear the clipboard afterwards
```

**Never run** on a laptop for this project: `vercel env pull`,
`vercel env add NAME production <value>` (value in shell history), or
`vercel link` in a directory you will not clean up (it writes `.env.local`
with the Development variables).

### 7.3 End-to-end check after Step 4 ships

```sh
curl -sS https://graphmind.ai/app/health              # {"ok":true, ..., "backend":"postgres","auth":"supabase"}
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://graphmind.ai/api/internal/tick   # 401 without the bearer
# Supabase → Integrations → Cron → graphmind-tick: last runs succeeded
# Supabase → Authentication → Users: your test sign-up appears, confirmed
```
