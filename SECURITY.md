# Security

GraphMind is a local-first live debugger for AI agents: a server bound to
`127.0.0.1`, a viewer it serves itself, and SDKs that stream your agent's
execution to that server and hold it at gates. This page is what a security
reviewer needs before allowing it on a developer machine, and what a
researcher needs to report a problem. The longer, reviewer-oriented version
lives in the docs: [Security & compliance](https://graphmind.ai/docs/reference/security/).

## Reporting a vulnerability

- Preferred: **GitHub Private Vulnerability Reporting** on
  [Hegazy360/GraphMind](https://github.com/Hegazy360/GraphMind/security/advisories/new)
  (a private advisory the maintainer sees immediately).
- Or email **hello@graphmind.ai**. Include what you found, how to reproduce
  it, and the version (`graphmind --version`, `pip show graphmind-ai`).
- Please do not open a public issue for anything exploitable.

What to expect — this is a solo-maintained project, so these are honest
targets, not an SLA:

| Step | Target |
| --- | --- |
| Acknowledgement | within **3 business days** |
| Triage + severity (CVSS v3.1) | within 7 days of acknowledgement |
| Fix for **Critical / High** | new release targeted within **14 days** of triage |
| Fix for **Medium** | targeted for the next minor, or within 60 days |
| Fix for **Low** | next regular release |
| Disclosure | coordinated with the reporter; a GitHub Security Advisory + CHANGELOG entry ship with the fix. Credit given unless you prefer otherwise. |

There is no bug bounty.

## Supported versions

| Version | Status |
| --- | --- |
| Latest minor (`0.x` current) | Receives security fixes as patch releases |
| Previous minor | Security fixes for **90 days** after the next minor ships |
| Older | Not supported — upgrade |

Every package in this repository shares one version (npm ×8, PyPI, RubyGems),
so "the latest minor" means the same number everywhere. Fixes ship as new
releases, never as silent re-publishes of an existing version.

## Verify a release

**npm** — every release from `v0.5.0` onward is published by
[`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml)
with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
(SLSA build provenance signed via Sigstore, bound to this repository and that
workflow):

```sh
npm view graphmind-ai@<version> dist.attestations          # non-empty = attested
npm install graphmind-ai@<version> && npm audit signatures  # verifies registry signatures + attestations of everything installed
```

Releases up to and including `0.4.4` were published by hand from the
maintainer's machine and carry no provenance attestation.

**PyPI** — `graphmind-ai` is published through PyPI Trusted Publishing from
[`publish-python.yml`](./.github/workflows/publish-python.yml), which attaches
[PEP 740](https://peps.python.org/pep-0740/) attestations. `0.4.4` already has
them: PyPI links each file's provenance from the release page
(`https://pypi.org/project/graphmind-ai/0.4.4/#files`), and the raw
attestation bundles are served by the integrity API, one URL per file
(both return HTTP 200 with `predicateType:
https://docs.pypi.org/attestations/publish/v1`, checked 2026-09-14):

```text
https://pypi.org/integrity/graphmind-ai/0.4.4/graphmind_ai-0.4.4-py3-none-any.whl/provenance
https://pypi.org/integrity/graphmind-ai/0.4.4/graphmind_ai-0.4.4.tar.gz/provenance
```

To verify offline, download the files (`pip download --no-deps
graphmind-ai==0.4.4`) and check them with the `pypi-attestations` CLI
(`pip install pypi-attestations`); the sha256 of each file is in the JSON API
(`https://pypi.org/pypi/graphmind-ai/0.4.4/json`, `urls[].digests.sha256`).

**GitHub Release** — each `v*` tag gets a release carrying the eight npm
tarballs exactly as published, a CycloneDX 1.6 SBOM
(`graphmind-<version>.cdx.json`) generated from a clean `npm install` of
those tarballs, and `SHA256SUMS`. Compare `sha256sum` of what npm gave you
against that file.

**RubyGems** — the `graphmind` gem is built from `ruby/` at the same version.
It is not yet on RubyGems (see "Where things stand" below); when it is, the
gemspec already sets `rubygems_mfa_required`.

## Data residency

- **Run data never leaves your machine.** Prompts, tool arguments and results,
  errors and timings go from your process to `127.0.0.1:4747` over a local
  WebSocket and are stored in `~/.graphmind/graphmind.db`. There is no cloud
  component, no account, and no sync. The SDKs make no outbound request other
  than that loopback WebSocket.
- **The only network egress in the whole product is CLI telemetry**: one
  record per command — command name, random install id, version, timestamp —
  to `https://graphmind.ai/api/telemetry`. Never arguments, prompts or run
  data. Off with `DO_NOT_TRACK=1` or `GRAPHMIND_TELEMETRY=0`; auditable with
  `GRAPHMIND_TELEMETRY=log` (prints the exact payload, sends nothing). Full
  disclosure: [`packages/cli/TELEMETRY.md`](./packages/cli/TELEMETRY.md). The
  security suite asserts telemetry bodies contain nothing but those four
  fields ([`security/tests/adapter-leaks.test.ts`](./security/tests/adapter-leaks.test.ts)).
- `graphmind record --html` / `--ndjson` exports are files you create and
  move; treat them as containing everything the run contained.

## Localhost threat model

The reference point is **CVE-2025-49596** (MCP Inspector, CVSS 9.4, June
2025): a proxy that listened on localhost without authentication and exposed
an endpoint that spawned stdio commands, so a malicious web page could reach
it from the developer's own browser and execute code. Mapped onto GraphMind,
component by component:

| Attack step in CVE-2025-49596 | GraphMind |
| --- | --- |
| Service listens on localhost, unauthenticated | Same starting point: `graphmind serve` binds `127.0.0.1` only ([`packages/cli/src/server.ts`](./packages/cli/src/server.ts), `const host = '127.0.0.1'`) and has no auth. |
| A web page reaches it (WebSocket handshakes are exempt from the same-origin policy; DNS rebinding makes `fetch` same-origin) | **Closed.** Every HTTP request and every WebSocket upgrade passes [`packages/cli/src/origin-guard.ts`](./packages/cli/src/origin-guard.ts): the `Host` must be a loopback name (defeats rebinding) and the `Origin`, if present, must be the viewer this server serves (`http://127.0.0.1:<port>` / `http://localhost:<port>`) — anything else is a 403, including `Origin: null`, another local port, and any remote site. Non-browser clients (SDKs, curl) send no `Origin` and pass; a page cannot omit it. `GRAPHMIND_ALLOWED_ORIGINS` is an explicit opt-in for dev servers. |
| The page sends a request that does damage | **Proven against a held gate.** [`packages/cli/test/origin-guard.test.ts`](./packages/cli/test/origin-guard.test.ts): `WS /ws/ui rejects foreign origins` (random site, `null`, another loopback port), `WS /ingest rejects foreign origins`, `HTTP API rejects rebound hosts` (rebound `Host`, cross-origin `fetch` with a loopback `Host`). [`packages/cli/test/origin-guard-control.test.ts`](./packages/cli/test/origin-guard-control.test.ts): with a real app paused at a gate, five browser-originated upgrade attempts are refused and no `exec.resume` reaches the app, then the legitimate viewer resumes it (so the hold was real); browser-originated `POST`s — including to `/api/demo/start`, a rebound-`Host` variant and a no-preflight "simple" POST — are refused by the guard before any route runs; there is no HTTP resume endpoint at all (`exec.resume` is WebSocket-only, routed in [`packages/cli/src/hub.ts`](./packages/cli/src/hub.ts) `handleControl`). |
| The service spawns a command from request data | **Not present.** Nothing in the server or hub spawns a process in response to network input. The only `spawn` sites in the CLI are `open-browser.ts` (opening the viewer at startup, a CLI flag), `commands/demo.ts` (`--live`, a CLI flag), `commands/init.ts` (local scaffolding) and `mcp-proxy/proxy.ts` (the command *you* pass on the command line). `POST /api/demo/start` replays a bundled fixture through an in-process client; it executes nothing. |
| A malicious MCP server attacks the inspector | `graphmind mcp-proxy` has **no listening socket**: it is a stdio pipe between the client that spawned it and the server it spawns, and it reports to the local hub as an ordinary ingest client. It parses JSON-RPC from an untrusted client and an untrusted server and never evaluates anything it relays; that boundary is fuzzed in `security/tests/mcp-proxy-fuzz.test.ts` and `mcp-boundary-fuzz.test.ts`. |

What the loopback boundary does **not** protect against, stated plainly:

- **Any local process running as your OS user can connect.** The trust
  boundary is the OS account, exactly as it is for a local database or an
  editor's language server. Such a process can read runs, and, since Phase 5,
  can no longer hijack another process's run (`hello.ack` mints a per-client
  `sessionToken`; a run belongs to the token that first wrote to it —
  `security/tests/run-isolation.test.ts`). Do not expose the port through a
  tunnel, a reverse proxy or a `0.0.0.0` bind; reports that depend on doing
  so are not treated as vulnerabilities. A report that the server binds
  anything other than loopback would be.
- **Stored runs are unencrypted.** `~/.graphmind/graphmind.db` (and its
  `-wal`/`-shm` siblings) hold every prompt and payload you streamed. The
  storage layer creates the directory `0700` and the files `0600` and
  re-tightens the WAL pair ([`packages/cli/src/sqlite-storage.ts`](./packages/cli/src/sqlite-storage.ts):
  `DIR_MODE = 0o700`, `FILE_MODE = 0o600`, `hardenDatabaseFiles()`; only a
  directory GraphMind itself created is chmod'ed, so `--db /tmp/x.db` never
  turns `/tmp` into `0700`), and the telemetry id file is `0600`
  ([`packages/cli/src/telemetry.ts`](./packages/cli/src/telemetry.ts)).
  Asserted by [`packages/cli/test/db-permissions.test.ts`](./packages/cli/test/db-permissions.test.ts).
  POSIX modes are inert on Windows; there the protection is the user profile
  directory's ACL. Full-disk encryption is your control, not ours.
- **Instrumentation must never compromise the host app.** An adapter that can
  crash, hang, or leak data from the application it instruments is a security
  bug. The fail-open guarantees (no-op when detached, auto-continue on
  disconnect, never throw into the host) are part of the security surface.

### `node:sqlite`

Storage uses Node's built-in `node:sqlite` — no native addon to download, no
`postinstall`. Its status per the Node.js documentation, checked 2026-09-14:
on the **Node 22** line it is *Stability: 1.1 – Active development*
(available without a flag since 22.13.0, which is GraphMind's engines floor);
on the **Node 24** line it is *Stability: 1.2 – Release candidate* (since
24.15.0). The two lines have differed in behaviour before (a NUL byte in a
string round-tripped on 24 and was mangled on 22 — see `internal/decisions.md`),
which is why CI runs every suite on both lines.

## Where things stand (honest status)

- Automated, provenance-attested npm releases start with the first tag after
  this workflow lands; `0.4.4` and earlier are unattested.
- The Ruby gem is not yet published to RubyGems.
- OpenSSF Scorecard: 7.7/10 on the default branch; remaining items are
  repository settings (branch protection, code review) rather than code.
