# Acme Tasks — a complete GraphMind Jack example

An ordinary multi-user REST API (projects, tasks, comments, reports) with its
own login, turned into an MCP server **without changing the API**. Use it to try Jack, and as
the pattern to copy for your own service.

```
 your AI client ──MCP 2026-07-28 + Jack token──▶ jack preview ──HTTP + that user's credential──▶ Acme Tasks
                 ◀──── sign-in: Jack's OAuth server, federated to Acme's login or Acme API keys ────┘
```

| File | What it shows |
|---|---|
| `src/routes.ts` | Endpoints declared once with Zod: validation, handler types **and** the OpenAPI spec come from the same code |
| `src/openapi.ts` | The OpenAPI 3.1 generator (≈100 lines; FastAPI, NestJS, `@hono/zod-openapi` give you this for free) |
| `openapi.json` | The generated spec, committed. A test fails if it drifts from the code |
| `src/idp.ts` | Acme's own OpenID Connect login (demo users alice / bob). Jack federates to it like it would to Auth0 or Okta |
| `jack.yaml` | The **reviewed** Jack config: which tools exist, how they're described to models, which need approval. Users sign in with their API key |
| `jack.oidc.yaml` | Six lines: `extends: ./jack.yaml` and switches sign-in to Acme's login |
| `src/link.ts` | **Account linking, the customer side:** Acme's session login, the `/jack/link` route and the assertion middleware, with `@graphmind-ai/jack-verify` |
| `jack.link.yaml` | `extends: ./jack.yaml`, sign-in through that route |
| `test/mcp.e2e.test.ts` | The whole stack under test: API ← `jack preview` ← MCP client |
| `test/signin.e2e.test.ts` | Per-user sign-in end to end, on real sockets, with a scripted browser |

## Run it

From the repo root:

```bash
pnpm install
pnpm build:jack                                  # builds Jack and this example

# everything at once — API, Acme's login and Jack's preview, on free ports, wired together:
pnpm --filter jack-tasks dev                     # users log in with Acme's login (alice / alice-password)
pnpm --filter jack-tasks dev -- --auth apikey    # users paste their Acme API key (tk_demo_alice)
pnpm --filter jack-tasks dev -- --auth link      # users log in with Acme's SESSION login; no OAuth anywhere in Acme
pnpm --filter jack-tasks dev -- --auth single    # no sign-in: acts as tk_demo_alice for everyone

# then, in another terminal in the same worktree — talk to it like an AI client would
pnpm jack tools                                  # first time: opens your browser to sign in
pnpm jack call list_tasks --args '{"status":"todo"}'
pnpm jack call delete_task --args '{"taskId":"tsk_0004"}'   # asks you to approve
pnpm jack logout                                 # revoke that sign-in
```

Or run the pieces in separate terminals: `pnpm --filter jack-tasks start` (the
API), then `preview`, `preview:oidc` or `preview:single`, which find this
worktree's API by themselves.

**Several worktrees at once** work out of the box. Each worktree gets its own
stable ports (shown at startup), and `jack tools` / `jack call` talk to the
preview of the worktree you run them in. See *Ports and worktrees* in
[docs/jack/USAGE.md](../../docs/jack/USAGE.md).

**With the dashboard:** `pnpm jack serve`, then `ACME_TASKS_URL=<the API's URL>
pnpm jack deploy --config examples/jack-tasks/jack.yaml`. Open the printed
dashboard URL.

| Demo user | Password (OIDC login) | API key |
|---|---|---|
| Alice Martin | `alice-password` | `tk_demo_alice` |
| Bob Okafor | `bob-password` | `tk_demo_bob` |

### Connect an AI client

`jack preview` prints the command. For Claude Code:

```bash
claude mcp add --transport http acme-tasks <the MCP URL the preview printed>
```

Jack speaks **only MCP 2026-07-28**. A client that connects with the
2025-era `initialize` handshake gets a clear `-32022 Unsupported protocol
version` error naming `2026-07-28`. Clients that negotiate (probe with
`server/discover` first) work. `jack tools` / `jack call` always work: they
use the official SDK pinned to 2026-07-28.

## How this example was made (do the same for your API)

1. **Get an OpenAPI document from your code.** Here: `pnpm --filter jack-tasks spec`.
2. **Generate the starting config:** `pnpm jack init openapi.json`. Reads start
   enabled, writes start disabled, and the lint flags weak descriptions (here,
   `getTask` only said "Get a task").
3. **Review it like code.** Compare `jack.yaml` with what `init` produced. Every
   change has a comment saying why:
   - writes enabled **one by one**, each with a description written for a model
     (what ids look like, which tool to call first, valid values);
   - `delete_task` enabled with `confirm: true`, so the user approves every delete;
   - the deprecated `search_tasks` left off, because `list_tasks` covers it;
   - the activity report capped at 6 KB, because the full history is too much context.
4. **Check:** `pnpm --filter jack-tasks jack check` shows 12 of 13 tools and 0 warnings.
5. **Preview and iterate:** `jack preview` reloads when `jack.yaml` changes.

## What the preview is (and isn't)

- It runs the **same runtime and authorization server** the hosted service
  will: per-user sign-in, consent, argument validation, approvals, response
  shaping and the call log.
- **Sign-in modes:** each person who connects an AI client signs in as
  themselves. Jack keeps their Acme credential sealed and the client only ever
  holds a Jack token. `preview:single` skips sign-in and acts as one key.
- **Link mode** (`--auth link`): Acme and Jack share `JACK_LINK_SECRET`
  (dev default in `dev.ts`). Acme learns Jack's issuer from `JACK_LINK_ISSUER`,
  which `dev`/`start` compute from the worktree's stable preview port.
- Acme's login knows Jack as the client `jack-preview`, whose secret defaults
  to `acme-dev-secret` (`ACME_OIDC_CLIENT_SECRET`). It accepts Jack's callback on
  any loopback port (RFC 8252), so the preview's port doesn't matter.
- It allows calls to localhost, because your API is local. `--egress public`
  applies the hosted rule.
- It binds 127.0.0.1 only and refuses non-localhost `Host`/`Origin`.

## Tests

```bash
pnpm --filter jack-tasks test
```

`app.test.ts` covers the API on its own (auth, isolation, pagination,
validation, spec drift). `mcp.e2e.test.ts` covers it through Jack: the curated
tool list, an agent-style session, approve/decline, per-user isolation, error
messages a model can act on, and the public egress rule. `signin.e2e.test.ts`
covers per-user sign-in: API-key, OIDC and link modes, two users on one
server, Acme token renewal, a wrong password, a declined consent, a replayed
assertion refused by Acme's middleware, and logout revoking the grant.
