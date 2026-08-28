# Changelog — graphmind (Ruby)

All notable changes to the Ruby SDK. The wire protocol version is tracked
separately (`gm: 1`) and is shared with the TypeScript and Python SDKs.

## 0.1.0 — unreleased

First release of the Ruby SDK.

### Core

- WebSocket transport to `ws://127.0.0.1:4747/ingest` (`GRAPHMIND_URL` to
  override): lazy connect, `hello` / `hello.ack` handshake carrying breakpoints
  and mode, background reconnect with a fast burst after an established
  attachment drops.
- Hand-rolled RFC 6455 client over `TCPSocket` — the gem has **no runtime
  dependencies**.
- Gate engine that genuinely holds the calling thread, and resumes with
  `continue` / `retry` / `inject` / `abort`.
- Bounded ring buffer (count + bytes, drop-oldest) with replay-on-attach.
- Fail-open everywhere: disconnect, `dispose`, and interpreter exit release
  every held gate. Optional `pause_timeout:`.
- Kill switches: `GRAPHMIND_DISABLED=1`, production-environment detection,
  explicit `enabled:`.

### Instrumentation

- `Graphmind.run`, `Graphmind.span`, `Graphmind.tool`, `Graphmind.wrap_tools`,
  `Graphmind.wrap_method`, and the `Graphmind::Instrument` class macro.
- `ruby-openai`: `chat` and `responses.create` gated as `llm:step`, with token
  usage and streamed deltas.
- `ruby_llm`: one `llm:step` per provider round-trip, plus gated
  `RubyLLM::Tool#call` with working `inject`.
- Injected values are coerced into the type each call site expects.

### Rails

- A Railtie that names the app, clears the per-thread run context on
  `executor.to_complete`, and disposes at exit.
