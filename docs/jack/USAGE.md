# GraphMind Jack — usage

Jack turns the HTTP API you already have into a hosted MCP server. This page
covers what exists today (milestones M0–M5). For a complete worked example, see
[`examples/jack-tasks`](../../examples/jack-tasks/README.md). The full design is in
[`docs/plans/hosted-mcp-jack.md`](../plans/hosted-mcp-jack.md).

```bash
pnpm build:jack
pnpm jack init https://petstore3.swagger.io/api/v3/openapi.json   # writes jack.yaml
pnpm jack check                                                   # every tool + every finding
pnpm jack build                                                   # writes jack.manifest.json
pnpm jack preview                                                 # serve jack.yaml as an MCP server (port: auto)
pnpm jack tools                                                   # list tools like an AI client sees them
pnpm jack call <tool> --args '{...}'                              # call one
pnpm jack serve                                                   # the dashboard (port: auto)
pnpm jack deploy                                                  # push jack.yaml to it and make it live
```

## `jack init <openapi file | url>`

Reads a Swagger 2.0, OpenAPI 3.0 or OpenAPI 3.1 document (JSON or YAML) and
writes `jack.yaml`, which lists **every** operation with an explicit
`enabled:` so the pull-request review is complete.

- **Read operations (GET/HEAD) start enabled. Everything else starts
  disabled**, so nothing that writes is published unless someone turned it on.
  Deprecated operations start disabled too.
- Tool names come from `operationId` (`findPetsByStatus` → `find_pets_by_status`),
  or from the method and path when there is none (`GET /trees/{id}` → `get_trees_by_id`).
- A relative server (`servers: [{url: /api/v3}]`) resolves against the URL the
  document came from. For a local file with a relative server, pass `--upstream`.
- Toolsets are suggested from the document's tags.
- Flags: `--out <path>`, `--upstream <url>`, `--force` (overwrite).

## `jack.yaml` reference

```yaml
name: "Acme Billing"                 # server name shown to AI clients (default: info.title)
source: "./openapi.json"             # file relative to jack.yaml, or an http(s) URL
upstream: "https://api.acme.com/v2"  # base URL; tool paths hang off it (default: first server)
auth:
  mode: none                         # oidc | link | apikey | none (sign-in lands in M3/M5)
lint:
  maxTools: 30                       # J001 fires above this
toolsets:
  billing:
    tools: [list_invoices, get_invoice, refund_invoice]
tools:
  list_invoices:
    enabled: true
  refund_invoice:
    enabled: true
    name: refund                     # publish under another name
    description: "Refund one invoice in full. Use list_invoices first to find its id."
    annotations: { destructiveHint: true, title: "Refund invoice" }
    requiredScopes: [invoices:write] # default: OAuth scopes from the operation's `security`
    confirm: true                    # the user approves every call (MCP input_required)
    response: { maxBytes: 20000 }    # cap what the model receives
    timeoutMs: 10000
```

A tool that is **not** listed follows the default rules (reads on, writes off).
That way an operation added to the spec later is never published by accident.

## What the compiler does with your document

| Input | Becomes |
|---|---|
| Path, query and header parameters | Tool arguments; `filter[status]` → argument `filter_status`, still sent as `filter[status]` |
| JSON or form object body | One argument per property; `readOnly` properties are left out |
| Array or primitive body | One `body` argument |
| Name collision (`id` in path and body) | The later one is prefixed: `body_id` |
| `Authorization`, apiKey-scheme headers, `Content-Type` | Dropped: credentials come from sign-in, never from the model |
| Optional cookie parameter | Dropped (J006) |
| Required cookie, multipart, octet-stream | Operation skipped (J006 / J005) |
| `$ref` cycles, nesting deeper than 8 | Inlined as a described open object (J011) |
| 3.0 `nullable`, Swagger `x-nullable` | `type: [T, "null"]` (and `null` added to any enum) |
| GET/HEAD · PUT · POST/PATCH · DELETE | `readOnlyHint` · `idempotentHint` · writes · `destructiveHint` |

## Lint codes

| Code | Severity | Meaning |
|---|---|---|
| J001 | warning | More tools enabled than `lint.maxTools`; long tool lists make models choose worse |
| J002 | warning | Missing or very short description |
| J003 | warning | Description cut to 4,000 characters |
| J004 | warning | `jack.yaml` names a tool that isn't in the document (renamed `operationId`?) |
| J005 | warning | Operation skipped: unsupported body type |
| J006 | warning | Cookie parameter dropped, or operation skipped for a required cookie |
| J007 | warning | Invisible Unicode removed from text sent to the model |
| J008 | warning | Description reads like instructions to the model; review it for tool poisoning |
| J009 | note | Deprecated operation disabled by default |
| J010 | warning | External or broken `$ref` |
| J011 | note | Recursive or deeply nested schema inlined |
| J012 | warning | Toolset lists a tool that isn't in the document |
| J013 | note | A write tool is enabled with the spec's own description; write one for the model |

`jack check --strict` exits non-zero while any warning remains, which is useful in CI.

## Known limitations (M1)

- **Method-based safety is a heuristic.** A `GET` that changes state (for
  example Petstore's `GET /user/logout`) is classified as a read and starts
  enabled. Review the enabled list and set `enabled: false`.
- External `$ref`s (other files or URLs) are not followed yet.
- File uploads (multipart, octet-stream) are not supported yet.

## `jack preview`

Serves `jack.yaml` as a real MCP server at `http://127.0.0.1:<port>/mcp` (see *Ports and worktrees*)
(`--stdio` for stdio, `--port` to move it). It runs the same runtime and
authorization server as the hosted service, and reloads when `jack.yaml` or a
local `source:` changes. The **mode** comes from `auth:` and the environment:

| `auth:` | Environment | Mode | Who the API sees |
|---|---|---|---|
| `none` | — | open | nobody (no credentials sent) |
| `apikey` | `JACK_UPSTREAM_API_KEY` set | single-user | that one key, for every client |
| `apikey` | not set | **sign-in** | each user's own key, pasted on Jack's sign-in page |
| `oidc` | the client secret, e.g. `ACME_OIDC_CLIENT_SECRET` | **sign-in** | each user's own token from your login |
| `link` | `JACK_LINK_SECRET` | **sign-in** | each user, through your app's session login; calls carry a `Jack-Assertion` |
| `none` + `requireSignIn: true` | — | sign-in | nobody, but clients must sign in |

- **Protocol.** MCP 2026-07-28 only. Clients using the 2025 `initialize`
  handshake get error `-32022`, naming the supported version.
- **Egress.** `--egress any` (default) allows localhost and private addresses.
  `--egress public` refuses them, as the hosted service will. Either way, calls
  only go to the `upstream` origin.
- **Safety.** Binds 127.0.0.1 and refuses non-localhost `Host`/`Origin`. Logs
  one line per call and one per sign-in or revocation, never arguments or
  credentials. Sign-in state (grants and an encryption key, mode 0600) lives
  in `.jack/` next to `jack.yaml`, which is git-ignored.

## Sign-in (MCP authorization)

In sign-in mode every AI client that connects gets Jack's OAuth flow, and
each person signs in as themselves:

1. The client calls `/mcp` and gets `401` with a `resource_metadata` link
   (RFC 9728). That leads it to Jack's authorization server metadata (RFC 8414).
2. The client identifies itself:
   - **CIMD** (primary): a `client_id` URL pointing at its metadata document,
     which Jack fetches over https from public addresses only. The consent page
     says "Verified app from <host>".
   - **DCR** (fallback, for Cursor, older clients and `jack` itself): the
     client registers itself. The consent page warns that the app is unverified.
3. The user signs in:
   - **`oidc`**: Jack sends them to *your* login and gets their token from your
     identity provider. Jack is a confidential client; register
     `<jack origin>/oauth/upstream/callback` as its redirect URI.
   - **`apikey`**: they paste their key on Jack's page. With `whoamiTool` set,
     Jack calls it with the key first, to reject wrong keys and learn whose it is.
   - **`link`**: Jack sends them to *your app's* link route, where your normal
     session login applies; your app answers with a signed response naming the
     user. See *Account linking* below.
4. A consent screen shows the app, the user, and what the app will be able to
   do (read / change data / delete data).
5. The client gets a Jack token:
   - access tokens are ES256 JWTs bound to this MCP URL, valid for 15 minutes;
   - refresh tokens are rotating and valid for 30 days.

   The user's upstream credential stays sealed in Jack (AES-256-GCM), and
   Jack renews `oidc` tokens before they expire.

What's enforced (each has a test):
- PKCE S256 and `resource` are both required.
- Redirect URIs must match exactly (loopback may change port).
- Codes are single use, valid for 60 seconds, and a replayed code revokes the grant.
- A reused refresh token revokes the grant for everyone holding it.
- Revocation applies on the very next call.
- Tokens for one MCP URL are refused by another.
- Sign-in pages are bound to the browser that started them, refuse
  cross-site posts, and cannot be framed.
- A tool needing scopes the user didn't grant gets `403 insufficient_scope`
  naming what to ask for (step-up).

`jack.yaml` for OIDC:

```yaml
auth:
  mode: oidc
  issuer: "https://login.acme.com"         # OpenID Connect discovery must work here
  clientId: jack
  clientSecretRef: "env:ACME_OIDC_CLIENT_SECRET"   # never the secret itself
  scopes: [openid, profile, email]         # plus the tool scopes from your spec
```

Use `extends: ./jack.yaml` to keep one tool configuration with several auth
variants (as the example's `jack.oidc.yaml` does): `tools` and `toolsets` merge
per entry, and everything else is replaced.

## Account linking (`link` mode)

For apps that have a **session login and no OAuth server**, and do not want
to build one. You add one route and one middleware to your API, with
`@graphmind-ai/jack-verify` (Node, zero dependencies), `graphmind.jack`
(Python, stdlib only) or `Graphmind::Jack` (Ruby, stdlib only). Jack and your
app share one secret; every token is a standard HS256 JWT.

```yaml
auth:
  mode: link
  linkUrl: "https://api.acme.com/jack/link"   # must be on the upstream origin
  secretRef: "env:JACK_LINK_SECRET"           # ≥ 32 chars; the same value your app reads
```

How a sign-in goes:

1. Jack redirects the user's browser to `linkUrl?request=<token>`. The token
   is signed, lives 5 minutes, and names the sign-in (`jti`) and where to come
   back (`return`, always on Jack's issuer).
2. **Your link route** verifies it, finds the user in *your* session (sending
   them through your login first if needed), and redirects to
   `linkResponseUrl(token, { userId, name, email })`: Jack's return URL carrying
   a signed response bound to that sign-in.
3. Jack verifies the response (same browser, same sign-in, right signature),
   shows consent, and stores only your user id, sealed.
4. **Every call** Jack makes for that user carries `Jack-Assertion: <token>`:
   60 seconds, single-use, with `sub` (your user id), `scope` (what the user
   granted) and `grant_id`. **Your middleware** verifies it and treats the
   request as that user. No header means it is not a Jack call.

What your code looks like (Express; Hono, Flask/Django/FastAPI and Rack are
the same shape):

```js
import { createJackVerifier } from '@graphmind-ai/jack-verify';
const jack = createJackVerifier({
  secret: process.env.JACK_LINK_SECRET,     // from the project's Sign-in page
  issuer: process.env.JACK_LINK_ISSUER,     // the Jack project's issuer URL
  audience: 'https://api.acme.com',         // your API, as Jack calls it
});

app.get('/jack/link', (req, res) => {
  jack.verifyLinkRequest(req.query.request);                     // throws if bad or expired
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.redirect(jack.linkResponseUrl(req.query.request, { userId: req.user.id, name: req.user.name }));
});

app.use(jack.express());   // req.jackUser = { userId, scopes, grantId } on Jack's calls
```

What's enforced (each has a test, in all three languages): HS256 only (no
`alg: none`, no downgrade); `typ`, `iss`, `aud` and expiry on every token;
the return URL must be on Jack's issuer; a response must name the same
sign-in it answers and come back in the same browser; assertions are refused
when replayed; the secret must be at least 32 characters; the link route must
be on the upstream origin.

Why a shared secret and not keys: it is one value to copy, verification is
offline and library-free, and it is what makes the Python and Ruby ports
tiny. Rotation: set a new secret in Jack and your app at the same time.
Per-project asymmetric keys (a JWKS) are a possible later option for
customers who want them.

## `jack tools` / `jack call` / `jack login` / `jack logout`

A terminal console for any Jack server, by default the preview running in this worktree (`--url`
to point elsewhere). It uses the official MCP client pinned to 2026-07-28.

- `jack call <tool> --args '<json>'` prints the result and exits 1 if the
  tool reported an error. For `confirm: true` tools it asks
  `Approve? [y/N]`; `--yes` or `--no` answers without asking.
- When the server needs sign-in, the CLI opens your browser (it prints the URL
  too; `JACK_NO_BROWSER=1` disables opening it) and waits for the redirect
  back on a 127.0.0.1 port.
- Sign-ins are cached per server in `~/.jack/mcp-auth.json` (mode 0600;
  `JACK_HOME` moves it). The file holds Jack tokens only, never your API key
  or your identity provider's tokens.
- `jack login` signs in ahead of time. `jack logout` revokes the grant at the
  server and deletes the local copy.

## What a tool call does

1. **Scopes.** A tool whose `requiredScopes` the caller lacks is hidden from
   `tools/list`. Calling it anyway returns "unknown tool".
2. **Validation.** Arguments are validated against the tool's JSON schema.
   Errors go back to the model and never reach your API.
3. **Approval.** With `confirm: true`, the user sees the exact arguments
   and approves or declines through MCP `input_required`. The approval is
   signed (HMAC) and bound to that exact call, so it can't be reused for
   different arguments.
4. **The request.** Path values are percent-encoded, and `.`/`..` are
   refused. Arguments can't set `Authorization`, `Cookie`, `Host` and
   similar headers. Redirects are never followed. Each call has a timeout
   (`timeoutMs`) and a 5 MB download cap.
5. **The response.**
   - JSON is projected with `response.pick` (`$.data[*].{id,name}`),
     pretty-printed, and cut at `response.maxBytes` with a note telling the
     model how to narrow the request.
   - Binary content is described, not inlined.
   - API errors come back as tool errors that include the API's own
     explanation, so the model can fix its call.

## The dashboard: `jack serve`

> Running from source: `pnpm jack …` and the example's `start` / `dev` / `preview` scripts check that
> Jack's compiled code is newer than its source and rebuild it first if not (`JACK_SKIP_BUILD_CHECK=1`
> turns that off). If the dashboard ever shows "The dashboard did not load", the server is older than
> the page: stop it and run `pnpm build:jack`.

```bash
pnpm jack serve            # prints: jack serve — dashboard at http://127.0.0.1:<port>
pnpm jack serve --accounts # the same, with self-serve sign-up (see Accounts below)
```

```
jack serve [--port auto|0|<n>] [--db .jack/dev.db] [--api-key <key>] [--egress any|public]
           [--accounts] [--no-signup] [--host <addr>] [--public-origin <url>]
```

One server holds the dashboard, the control plane (`/v1`) and every project's
MCP endpoint (`/p/<slug>/mcp`, with its own sign-in at `/p/<slug>/oauth`).
State lives in `.jack/` at the worktree root (git-ignored). Add
`--api-key <key>` to require a key for the dashboard's API, and
`--egress public` for the hosted rule.

| Flag | What it does |
|---|---|
| `--accounts` | Self-serve accounts: anyone can sign up, each account sees only its own projects (below) |
| `--no-signup` | With `--accounts`: existing accounts keep working, nobody new can register |
| `--api-key <key>` | A static key for `/v1`. Beside `--accounts` it is the *operator* and sees every project |
| `--host <addr>` | Bind another interface. Refused unless `--accounts` or `--api-key` is given, so an open control plane never faces a network |
| `--public-origin <url>` | The origin the server has from outside (behind a proxy): sets cookie flags and the URLs printed |

### Accounts

Without `--accounts` the server is open to whoever reaches `127.0.0.1`, or
key-protected with `--api-key`. With it, `/v1` needs a signed-in user and
the dashboard works per account:

- **Sign-up.** The dashboard opens on a sign-in page (`#/signin`); the
  sign-up page (`#/signup`) asks for an email, a password of 10 characters
  or more, and an optional name. Registration is open and free, with no
  plans or quotas, by decision; `--no-signup` closes it. graphmind.ai's
  **Create account** and **Sign in** links land on these two pages.
- **Your projects are yours.** Every project belongs to the account that
  created it. Another account gets a 404 for it, as if it did not exist,
  and never sees it in the list. Slugs stay global, so two accounts cannot
  both own `acme-billing`. Deployments record who deployed, by email. A
  static `--api-key` acts as the operator and sees every project; projects
  created before `--accounts` was turned on have no owner and are visible
  to the operator only.
- **Account page** (`#/account`, the **Account** link at the bottom of the
  sidebar): who you are, and your **API tokens**. A personal token
  (`gmt_…`) is shown once when created, stored hashed, and can be revoked
  there at any time. **Sign out** is next to it.
- **`jack deploy` needs a token** against an accounts server:
  `jack deploy --server <url> --api-key gmt_…`. A static key is not minted
  per user, so this is how the CLI acts as you; the server prints this
  reminder when it starts with `--accounts`.
- **What is enforced** (`packages/accounts/test`, `apps/jack-api/test/accounts.test.ts`):
  scrypt password hashes; sessions as hashed random tokens in an `HttpOnly`
  `SameSite=Lax` cookie (`Secure` and `__Host-` on https), 30 days by
  default; writes from a session must come from the dashboard's own origin;
  failed sign-ins are rate-limited per address and email; tokens can be
  minted or revoked only from a browser session.

Account data is `.jack/serve/accounts.db`, next to the server's own
database. `GET /health` is public and reports `accounts` and `signup`;
`GET /v1/health` adds the signed-in `user`.

| Page | What you do there |
|---|---|
| **New project** | Paste a spec or give its URL. See every operation (reads on, writes off) and the lint, then create |
| **Tools** | Turn tools on and off. Rename them, rewrite descriptions for the model, require approval, set permissions. Lint updates as you type; an edit that would not compile is refused |
| **Sign-in** | No sign-in, personal API keys, your login (OIDC), or account linking, with the values to copy into your app shown ready. Secrets are write-only and stored encrypted |
| **Try it** | *Test sign-in* runs the real sign-in and consent pages. Then call any tool as that user, through the live `/mcp`, with the official MCP client |
| **Deploy** | The diff against what's live, deploy with a message, history with a diff per version, roll back in one click, the MCP URL and the `claude mcp add` line |
| **Users** | Everyone who connected an AI app. *Disconnect* revokes access immediately |
| **Activity** | Every call: tool, result, API status, time, size, user. Never arguments, results or credentials |
| **Settings** | Re-import the spec (your tool edits are kept), export `jack.yaml`, delete the project |
| **Account** | With `--accounts`: your email and name, your personal API tokens (create, revoke), sign out |

Nothing changes for AI clients until you deploy. Every edit goes to a
draft, and a banner shows how many changes are waiting.

## `jack deploy`

```bash
jack deploy [--config jack.yaml] [--project <slug>] [--server <url>] [--api-key <key>] [--message "…"]
```

Compiles `jack.yaml` locally first, so a broken file never reaches the server.
On the first run it creates the project; after that it replaces the spec and
the draft with what's in git, then deploys and prints the diff. It finds the
`jack serve` of this worktree on its own (`--server` points elsewhere).
Against a server started with `--accounts`, `--api-key` must be a personal
token (`gmt_…`) from the dashboard's Account page; the project then belongs
to that account.
An OIDC `clientSecretRef: "env:NAME"` is uploaded into the project's
encrypted secrets and becomes `secret:NAME`.

The dashboard and `jack.yaml` are two editors of the same configuration.
Settings → *Export jack.yaml* gives you the file; `jack deploy` sends it back.

## Ports and worktrees

Every Jack server picks its own port, so several can run at once: one per
git worktree, or a preview next to a dashboard.

| `--port` | Meaning |
|---|---|
| `auto` (default) | A port derived from the worktree's path: the same every time in that worktree (paste the URL into an AI client once), different between worktrees. If it's taken, the next free one |
| `0` | Any free port |
| `<n>` | Exactly `n`, or an error |

Services have separate ranges, so they never collide with each other:
`jack serve` 20000–20999, `jack preview` 21000–21999, the example API
22000–22999.

**Discovery.** A running server records itself in `.jack/run/<service>.json`
in its worktree. `jack tools`, `jack call`, `jack login` and `jack deploy`
read that file, so a command run in a worktree talks to *that worktree's*
server and never to a neighbour's. Run outside any worktree that has one,
they say so and ask for `--url` / `--server`. A record left behind by a
crashed server is detected (its process is gone) and removed.

**URLs in `jack.yaml`.** `${NAME}` and `${NAME:-default}` are replaced
from the environment in any value, and `$${` is a literal `${`:

```yaml
upstream: "${ACME_TASKS_URL:-http://127.0.0.1:4830}"
```

Substitution happens after parsing, so a variable's content can never add
keys to the file. A variable with no default that isn't set is an error that
names it.

**OAuth redirects.** Jack's own sign-in follows the port, because its issuer
is built from the real origin. Clients that sign in to Jack over loopback
(the `jack` CLI, Claude Code) may use any port (RFC 8252). For `oidc`, the
redirect URI you register with your identity provider contains the preview's
port. With `--port auto` that port is stable per worktree, so register it once
per worktree, or let your provider accept loopback redirects on any port, as
the example's demo login does.
