---
name: graphmind-jack
description: Turn an existing HTTP API (an OpenAPI / Swagger document) into a hosted MCP server with GraphMind Jack, so Claude, Cursor or an agent can call it. Use when the user wants to expose their API as MCP tools, choose which operations are published, write tool descriptions for the model, require approval for writes, deploy or roll back, or see which tool calls fail. Drives the Jack HTTP API on graphmind.ai with a personal token.
---

# GraphMind Jack: the user's API as an MCP server

Jack imports an OpenAPI 3.x or Swagger 2.0 document and publishes the chosen
operations as MCP tools at a stable URL. Read operations (GET/HEAD) start
enabled; everything that writes starts disabled, so nothing that changes data
is published unless someone turns it on. Every edit goes to a **draft**; AI
clients see nothing new until a **deploy**.

## 0. Credentials (ask the user; never print them)

- The user needs a GraphMind account: https://graphmind.ai/signup
- They create a personal token on https://graphmind.ai/app/#/account
  (**Create token**, shown once, starts with `gmt_`). Tokens can only be
  created from the browser, not by you.
- Ask them to put it in the environment as `GRAPHMIND_TOKEN`. Refer to it only
  as `$GRAPHMIND_TOKEN`: never echo it, write it to a file, or paste it into
  code or a commit.

```sh
JACK=https://graphmind.ai/app/jack/v1
auth=(-H "authorization: Bearer $GRAPHMIND_TOKEN" -H 'content-type: application/json')
curl -s "${auth[@]}" $JACK/health        # → { ok, user: {email}, projects }
```

Errors are `application/problem+json` with `title` and `detail`: read `detail`, it
says what to change. Projects belong to the account; another account's project
is a 404.

## 1. Preview, then create

```sh
# What would be published (every operation, enabled or not, plus lint findings)
curl -s "${auth[@]}" -X POST $JACK/import/preview -d '{"source":{"url":"https://api.example.com/openapi.json"}}'

# Create the project (source.text instead of source.url for a local file's contents)
curl -s "${auth[@]}" -X POST $JACK/projects \
  -d '{"slug":"acme-billing","name":"Acme Billing","source":{"url":"https://api.example.com/openapi.json"}}'
# → 201 { project: { id, slug, mcpUrl, mode, ... }, draft }
```

`upstream` (the API base URL) defaults to the document's first server; pass
`"upstream":"https://api.example.com/v2"` when the document's server is
relative or wrong. Slugs are global: pick another on a 409.

## 2. Shape the tools (the part that decides whether models use them well)

```sh
curl -s "${auth[@]}" $JACK/projects/$ID/draft     # tools with their `key`, enabled state, lint
curl -s "${auth[@]}" -X PATCH $JACK/projects/$ID/draft/tools/<key> \
  -d '{"enabled":true,"description":"Refund one invoice in full. Call list_invoices first to find its id.","confirm":true}'
```

Per-tool fields: `enabled`, `name` (publish under another name), `description`,
`confirm` (the user approves every call), `annotations`, `requiredScopes`,
`response: { maxBytes, pick }`, `timeoutMs`.
Project settings (`PATCH /projects/$ID/draft`): `name`, `description`,
`upstream`, `auth`, `lint`, `toolsets`.

Rules that matter:
- **Review what is enabled.** Method-based safety is a heuristic: a GET that
  changes state (e.g. `GET /logout`) starts enabled. Disable it.
- Fewer, well-described tools beat many (lint J001 warns above `lint.maxTools`).
- Every enabled write tool deserves a description written for the model
  (J013) and usually `confirm: true`.
- J008 means a description reads like instructions to the model: treat it as
  possible tool poisoning and rewrite it.
- Credentials never come from the model: auth headers are dropped from tool
  arguments; sign-in is configured on the project (`auth.mode`: `none`,
  `apikey`, `oidc`, `link`). Secret values go to
  `PUT /projects/$ID/secrets/<NAME>` with `{"value": …}` and are write-only.
  Ask the user to run that call themselves with the secret in an env var.

## 3. Deploy and connect

```sh
curl -s "${auth[@]}" -X POST $JACK/projects/$ID/deploy -d '{"message":"publish read tools"}'
# → { deployment: {version}, diff, project: {mcpUrl} }
curl -s "${auth[@]}" $JACK/projects/$ID/deployments            # history
curl -s "${auth[@]}" -X POST $JACK/projects/$ID/promote -d '{"version":3}'   # roll back
```

Hand the user the `mcpUrl` (`https://graphmind.ai/p/<slug>/mcp`), e.g.
`claude mcp add --transport http acme-billing <mcpUrl>`. In sign-in mode the AI
client runs Jack's OAuth flow and each person signs in as themselves.

Try a tool through the live endpoint before telling the user it works:

```sh
curl -s "${auth[@]}" -X POST $JACK/projects/$ID/try -d '{"tool":"list_invoices","args":{}}'
```

(sign-in projects need a test sign-in first: `POST /projects/$ID/test-signin`
returns a URL the user opens.)

## 4. Is it working? Behaviour from the call log

```sh
curl -s "${auth[@]}" "$JACK/projects/$ID/calls?limit=200"   # tool, result, API status, time, size, user
curl -s "${auth[@]}" $JACK/projects/$ID/grants               # who connected which app
```

`GET $JACK/projects/$ID/insights` does that reading for you over the newest
1,000 calls: ranked recommendations with evidence, e.g. a tool your API keeps
rejecting with a 4xx (fix its description or the spec), arguments that miss
the schema, a tool that started failing after a deploy (the first failing
call is named).

The log never holds arguments, results or credentials. Look for: tools that
keep failing with the API's own 4xx (their description or schema misleads the
model), tools nobody calls (disable them: shorter lists choose better), slow
or huge responses (set `response.pick` / `maxBytes` / `timeoutMs`). Propose
the change, apply it to the draft, deploy, and compare the next calls.

## Related skills

- `graphmind-circuit`: call a Jack server from durable workflow steps.
- `graphmind`: debug an agent that uses these tools, live, with pause and inject.
