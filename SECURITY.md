# Security

## Reporting a vulnerability

Email **hello@graphmind.ai** with what you found and how to reproduce it.
Please do not open a public issue for anything exploitable. You will get a
reply within a few days; this is a small project, but security reports go to
the front of the queue.

## Threat model

GraphMind is local-first by design, and that shapes what is and is not a
vulnerability here.

- The server binds `127.0.0.1` only and has **no authentication**. Anything
  able to reach that port on your machine can read your runs and send control
  commands. That is the intended trade-off for a local developer tool — do not
  expose the port through a tunnel, reverse proxy, or `0.0.0.0` bind. Reports
  that depend on deliberately exposing the port are not treated as
  vulnerabilities; reports that it binds something other than loopback are.
- **Run data is developer data.** Prompts, tool inputs and outputs, and errors
  are stored unencrypted in `~/.graphmind/graphmind.db`. Treat that file, and
  any `graphmind record` export, as sensitive.
- **Instrumentation must never compromise the host app.** An adapter that can
  crash, hang, or leak data from the application it instruments is a security
  bug. The fail-open guarantees (no-op when detached, auto-continue on
  disconnect, never throw into the host) are part of the security surface.
- **Telemetry** sends only a command name, a random install id, and the
  version — never arguments, prompts, traces, or run data
  ([disclosure](./packages/cli/TELEMETRY.md)). Any leakage beyond that is a
  bug worth reporting.

## Supported versions

The latest published release. Fixes ship as a new patch release rather than
backports.
