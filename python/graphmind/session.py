"""The GraphMind session: the one object every integration talks to.

Port of ``packages/client/src/session.ts``, with the dual sync/async surface
Python needs.

Guarantees:

* **Never raises into the host app.** Internal failures no-op with a
  rate-limited warning. (Errors raised by the host's own code inside a run
  propagate untouched — they are the host's errors.)
* **Zero-cost when detached.** ``gate`` returns a shared ``CONTINUE`` on the
  fast path: three attribute reads and no allocation.
* **Fail-open.** Disconnect, dispose and interpreter exit auto-continue every
  held gate.
* **Kill switches.** ``GRAPHMIND_DISABLED=1`` always disables; a
  production-looking environment disables unless ``GRAPHMIND=1`` (see
  :mod:`graphmind.env`). Disabled sessions never touch the network.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import threading
import time
from collections.abc import Iterable
from typing import Any

from ._version import __version__
from .env import EnvLike, resolve_enabled, resolve_url
from .errors import GraphMindAbortError, is_abort_error, to_error_info
from .gate import CONTINUE, GateDecision, GateEngine, GateNode
from .ids import agent_node_id, new_id, next_id
from .protocol import (
    KNOWN_CAPABILITIES,
    PROTOCOL_VERSION,
    WILDCARD_RUN_ID,
    create_envelope,
    serialize_envelope,
)
from .ring_buffer import RingBuffer
from .runtime import register_shutdown_hook, unregister_shutdown_hook
from .safe import RateLimitedWarner, WarnSink
from .tokens import TokenBatcher
from .transport import Transport, TransportHooks

CLIENT_VERSION = __version__

DEFAULT_CONNECT_TIMEOUT = 0.3
DEFAULT_HANDSHAKE_TIMEOUT = 1.0
DEFAULT_RETRY_INTERVAL = 10.0
DEFAULT_BUFFER_SIZE = 2000
DEFAULT_READY_TIMEOUT = 2.0
DEFAULT_TOKEN_INTERVAL = 0.034

#: How often a blocked sync gate re-checks fail-open conditions. The primary
#: release path is the disconnect callback (sub-millisecond); this poll only
#: exists so a blocked thread stays interruptible by Ctrl-C and can never
#: outlive the debugger even if a callback is missed.
_GATE_POLL = 0.25


class RunContext:
    """One top-level agent invocation.

    ``abort_event`` is set when the debugger resolves a gate with ``abort``.
    Pass it into your own cancellation plumbing (``event.is_set()`` checks,
    ``requests`` timeouts, provider ``timeout``/cancel hooks) so an abort
    reaches work GraphMind does not wrap.
    """

    __slots__ = ("_reason", "abort_event", "name", "run_id")

    def __init__(self, run_id: str, name: str) -> None:
        self.run_id = run_id
        self.name = name
        self.abort_event = threading.Event()
        self._reason: BaseException | None = None

    @property
    def aborted(self) -> bool:
        return self.abort_event.is_set()

    @property
    def reason(self) -> BaseException | None:
        return self._reason

    def abort(self, reason: BaseException | None = None) -> None:
        if self._reason is None:
            self._reason = reason if reason is not None else GraphMindAbortError()
        self.abort_event.set()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"RunContext({self.name!r}, run_id={self.run_id!r}, aborted={self.aborted})"


_current_run: contextvars.ContextVar[RunContext | None] = contextvars.ContextVar(
    "graphmind_current_run", default=None
)


class SessionStats:
    __slots__ = ("attached", "buffered", "dropped", "enabled", "held_gates", "seq")

    def __init__(
        self,
        enabled: bool,
        attached: bool,
        buffered: int,
        dropped: int,
        held_gates: int,
        seq: int,
    ) -> None:
        self.enabled = enabled
        self.attached = attached
        self.buffered = buffered
        self.dropped = dropped
        self.held_gates = held_gates
        self.seq = seq

    def as_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "attached": self.attached,
            "buffered": self.buffered,
            "dropped": self.dropped,
            "heldGates": self.held_gates,
            "seq": self.seq,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"SessionStats({self.as_dict()})"


class Session:
    """The GraphMind client session. Create one per process (see
    :func:`graphmind.configure`); integrations share it."""

    def __init__(
        self,
        *,
        url: str | None = None,
        app_name: str = "python",
        sdk: dict[str, str] | None = None,
        meta: dict[str, Any] | None = None,
        enabled: bool | None = None,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
        handshake_timeout: float = DEFAULT_HANDSHAKE_TIMEOUT,
        retry_interval: float = DEFAULT_RETRY_INTERVAL,
        buffer_size: int = DEFAULT_BUFFER_SIZE,
        pause_timeout: float | None = None,
        token_interval: float = DEFAULT_TOKEN_INTERVAL,
        env: EnvLike | None = None,
        logger: WarnSink | None = None,
        warn_interval: float = 60.0,
    ) -> None:
        self.enabled = resolve_enabled(enabled, env)
        self.app_name = app_name
        self.sdk = sdk if sdk is not None else {"name": "python", "version": "0.0.0"}
        self.meta = dict(meta) if meta else None

        self._warner = RateLimitedWarner(warn_interval, logger)
        self._lock = threading.RLock()
        self._buffer: RingBuffer[str] = RingBuffer(buffer_size)
        self._seq = 0
        #: Identity handed out by the debugger in ``hello.ack``; see _build_hello.
        self._session_token: str | None = None
        self._started = False
        self._disposed = False
        self._attached_mirror = False
        self._implicit_run: RunContext | None = None
        self._ready_waiters: list[concurrent.futures.Future[bool]] = []

        self._engine = GateEngine(
            on_paused=self._on_paused,
            on_resumed=self._on_resumed,
            new_pause_id=lambda: next_id("pause"),
            pause_timeout=pause_timeout,
        )
        self._batcher = TokenBatcher(
            lambda node_id, deltas: self.emit("node.token", {"nodeId": node_id, "deltas": deltas}),
            token_interval,
        )
        self._transport = Transport(
            url=resolve_url(url, env),
            hooks=TransportHooks(
                build_hello=self._build_hello,
                on_attached=self._handle_attached,
                on_detached=self._handle_detached,
                on_control=self._handle_control,
            ),
            warner=self._warner,
            connect_timeout=connect_timeout,
            handshake_timeout=handshake_timeout,
            retry_interval=retry_interval,
        )
        self._shutdown_hook = self._fail_open_now
        register_shutdown_hook(self._shutdown_hook)

    # -- state ----------------------------------------------------------------

    @property
    def attached(self) -> bool:
        return self._transport.attached

    @property
    def disposed(self) -> bool:
        return self._disposed

    @property
    def url(self) -> str:
        return self._transport._url

    def stats(self) -> SessionStats:
        return SessionStats(
            enabled=self.enabled,
            attached=self.attached,
            buffered=self._buffer.size,
            dropped=self._buffer.dropped,
            held_gates=self._engine.held_count,
            seq=self._seq,
        )

    def _active(self) -> bool:
        return self.enabled and not self._disposed

    # -- attach ---------------------------------------------------------------

    def ready(self, timeout: float = DEFAULT_READY_TIMEOUT) -> bool:
        """Block until attached (handshake complete, breakpoints armed).

        Returns ``False`` on timeout or when GraphMind is disabled. Never
        raises: ``False`` means "carry on detached", not an error.
        """
        waiter = self._begin_ready()
        if waiter is None:
            return self.attached and self._active()
        try:
            return bool(waiter.result(timeout=timeout))
        except Exception:
            self._drop_ready_waiter(waiter)
            return False

    async def ready_async(self, timeout: float = DEFAULT_READY_TIMEOUT) -> bool:
        """Async twin of :meth:`ready`; never blocks the caller's event loop."""
        import asyncio

        waiter = self._begin_ready()
        if waiter is None:
            return self.attached and self._active()
        try:
            wrapped = asyncio.wrap_future(waiter)  # type: ignore[arg-type]
            return bool(await asyncio.wait_for(wrapped, timeout=timeout))
        except Exception:
            self._drop_ready_waiter(waiter)
            return False

    def _begin_ready(self) -> concurrent.futures.Future[bool] | None:
        """Start connecting; ``None`` means "answer immediately"."""
        try:
            if not self._active():
                return None
            self._ensure_started()
            # Re-arm: after a failure or disconnect, don't sit out the retry
            # interval — connect now.
            self._transport.kick()
            if self._transport.attached:
                return None
            waiter: concurrent.futures.Future[bool] = concurrent.futures.Future()
            with self._lock:
                self._ready_waiters.append(waiter)
            # Re-check: attaching between the check and the append would
            # otherwise leave this waiter hanging until the next event.
            if self._transport.attached:
                self._settle_ready(True)
            return waiter
        except Exception as exc:
            self._warner.warn("ready", "internal error in ready(); resolving detached", exc)
            return None

    def _drop_ready_waiter(self, waiter: concurrent.futures.Future[bool]) -> None:
        with self._lock:
            try:
                self._ready_waiters.remove(waiter)
            except ValueError:
                pass

    def _settle_ready(self, attached: bool) -> None:
        with self._lock:
            waiters = self._ready_waiters
            self._ready_waiters = []
        for waiter in waiters:
            try:
                waiter.set_result(attached)
            except Exception:
                pass

    # -- runs -----------------------------------------------------------------

    def current_run(self) -> RunContext | None:
        return _current_run.get()

    def run(self, name: str, meta: dict[str, Any] | None = None) -> RunScope:
        """A run boundary usable as ``with`` **and** ``async with``."""
        return RunScope(self, name, meta)

    def _make_run_context(self, name: str) -> RunContext:
        return RunContext(new_id("run"), name)

    def _resolve_run_id(self) -> str:
        ctx = _current_run.get()
        if ctx is not None:
            return ctx.run_id
        with self._lock:
            if self._implicit_run is None:
                self._implicit_run = self._make_run_context("implicit")
                meta: dict[str, Any] = {"name": "implicit", "implicit": True}
                if self.meta:
                    meta.update(self.meta)
                self._emit_internal(
                    "run.started",
                    {"app": self.app_name, "sdk": self.sdk, "meta": meta},
                    self._implicit_run.run_id,
                )
            return self._implicit_run.run_id

    # -- events ---------------------------------------------------------------

    def emit(self, type: str, payload: dict[str, Any]) -> None:
        """Emit one event, attributed to the current run (or an implicit one)."""
        if not self.enabled or self._disposed:
            return
        try:
            self._ensure_started()
            self._emit_internal(type, payload, self._resolve_run_id())
        except Exception as exc:
            self._warner.warn("emit", "internal error in emit(); GraphMind degrading", exc)

    def start_node(
        self,
        node_id: str,
        kind: str,
        name: str,
        instance_id: str,
        parent_id: str | None = None,
        input: Any = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "nodeId": node_id,
            "kind": kind,
            "name": name,
            "instanceId": instance_id,
        }
        if parent_id is not None:
            payload["parentId"] = parent_id
        if input is not None:
            payload["input"] = input
        if extra:
            payload.update(extra)
        self.emit("node.started", payload)

    def finish_node(
        self,
        node_id: str,
        instance_id: str,
        duration_ms: float,
        status: str = "ok",
        output: Any = None,
        usage: dict[str, int] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self._batcher.flush_node(node_id)
        payload: dict[str, Any] = {
            "nodeId": node_id,
            "instanceId": instance_id,
            "durationMs": max(0.0, duration_ms),
            "status": status,
        }
        if output is not None:
            payload["output"] = output
        if usage is not None:
            payload["usage"] = usage
        if extra:
            payload.update(extra)
        self.emit("node.finished", payload)

    def error_node(self, node_id: str, instance_id: str, error: Any) -> None:
        self.emit(
            "node.error",
            {"nodeId": node_id, "instanceId": instance_id, "error": to_error_info(error)},
        )

    def graph_hint(self, nodes: Iterable[dict[str, Any]]) -> None:
        node_list = [n for n in nodes if isinstance(n, dict)]
        if node_list:
            self.emit("graph.hint", {"nodes": node_list})

    def push_token(self, node_id: str, channel: str, value: str) -> None:
        """Queue one streamed delta (batched into ``node.token``)."""
        if not self.enabled or self._disposed or not value:
            return
        try:
            self._batcher.push(node_id, channel, value)
        except Exception:
            pass

    def flush(self) -> None:
        """Flush any pending token batches immediately."""
        try:
            self._batcher.flush_all()
        except Exception:
            pass

    # -- gates ----------------------------------------------------------------

    def gate(self, point: str, node: GateNode) -> GateDecision:
        """Hold the **calling thread** until the debugger resumes.

        Fast path (detached, or attached with nothing matching) returns the
        shared ``CONTINUE`` without allocating.
        """
        if not self.enabled or self._disposed:
            return CONTINUE
        try:
            self._ensure_started()
            if not self._transport.attached or not self._engine.should_pause(point, node):
                return CONTINUE
            hold = self._engine.hold(point, node, self._resolve_run_id())
            while True:
                try:
                    decision = hold.future.result(timeout=_GATE_POLL)
                    break
                except concurrent.futures.TimeoutError:
                    if self._disposed or not self._transport.attached:
                        # Belt and braces: the disconnect callback normally
                        # releases held gates within a millisecond.
                        self._engine.discard(hold.pause_id)
                        return CONTINUE
                except BaseException:
                    self._engine.discard(hold.pause_id)
                    raise
            return self._apply_decision(decision)
        except GraphMindAbortError:
            raise
        except BaseException as exc:
            if isinstance(exc, KeyboardInterrupt):
                raise
            self._warner.warn("gate", "internal gate error; continuing", exc)
            return CONTINUE

    async def gate_async(self, point: str, node: GateNode) -> GateDecision:
        """Hold the **calling task** until the debugger resumes."""
        if not self.enabled or self._disposed:
            return CONTINUE
        import asyncio

        try:
            self._ensure_started()
            if not self._transport.attached or not self._engine.should_pause(point, node):
                return CONTINUE
            hold = self._engine.hold(point, node, self._resolve_run_id())
            try:
                decision = await asyncio.wrap_future(hold.future)
            except asyncio.CancelledError:
                self._engine.discard(hold.pause_id)
                raise
            return self._apply_decision(decision)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._warner.warn("gate", "internal gate error; continuing", exc)
            return CONTINUE

    def _apply_decision(self, decision: GateDecision) -> GateDecision:
        if decision.action == "abort":
            ctx = _current_run.get()
            if ctx is not None:
                try:
                    ctx.abort(GraphMindAbortError())
                except Exception:
                    pass
        return decision

    def abort_error(self, ctx: RunContext | None = None) -> BaseException:
        """The exception to raise after an ``abort`` decision."""
        if ctx is None:
            ctx = _current_run.get()
        if ctx is not None and ctx.reason is not None:
            return ctx.reason
        return GraphMindAbortError()

    # -- lifecycle ------------------------------------------------------------

    def dispose(self) -> None:
        """Release held gates, flush events, close the socket. Idempotent."""
        if self._disposed:
            return
        self._disposed = True
        unregister_shutdown_hook(self._shutdown_hook)
        try:
            self._batcher.dispose()
        except Exception:
            pass
        try:
            self._engine.release_all()
            self._engine.disarm()
        except Exception:
            pass
        try:
            if self._implicit_run is not None and self.enabled:
                self._emit_internal("run.finished", {"status": "ok"}, self._implicit_run.run_id)
        except Exception:
            pass
        # Give the writer a moment to drain the final frames before the socket
        # goes away; bounded so dispose() is never a hang.
        self._drain(0.2)
        try:
            self._transport.dispose()
        except Exception:
            pass
        self._settle_ready(False)

    def _drain(self, timeout: float) -> None:
        if not self._attached_mirror:
            return
        deadline = time.monotonic() + timeout
        outbox = self._transport._outbox
        while outbox and time.monotonic() < deadline:
            time.sleep(0.005)

    def _fail_open_now(self) -> None:
        """atexit hook: never leave a host process blocked on a held gate."""
        try:
            self._engine.release_all()
        except Exception:
            pass

    # -- internals ------------------------------------------------------------

    def _ensure_started(self) -> None:
        if self._started:
            return
        with self._lock:
            if self._started:
                return
            self._started = True
        self._transport.start()

    def _emit_internal(self, type: str, payload: dict[str, Any], run_id: str) -> None:
        with self._lock:
            seq = self._seq
            self._seq += 1
            frame = serialize_envelope(create_envelope(type, payload, seq, run_id))
            self._buffer.push(frame)
            if self._attached_mirror:
                self._transport.enqueue(frame)

    def _build_hello(self) -> str:
        with self._lock:
            seq = self._seq
            self._seq += 1
            token = self._session_token
        payload: dict[str, Any] = {
            "versions": {"protocol": PROTOCOL_VERSION, "client": CLIENT_VERSION},
            "capabilities": list(KNOWN_CAPABILITIES),
            "app": self.app_name,
            "sdk": self.sdk,
        }
        # Echoing the token from the last ``hello.ack`` is what lets the
        # debugger recognise a reconnect as the SAME app, and so refuse writes
        # to our runs from any other local process. Absent on first connect.
        if token is not None:
            payload["resumeToken"] = token
        return serialize_envelope(
            create_envelope("hello", payload, seq, WILDCARD_RUN_ID)
        )

    def _handle_attached(self, ack: dict[str, Any]) -> None:
        try:
            # Kept across reconnects on purpose (see _build_hello). Only ever
            # replaced, never cleared on detach: surviving the drop is the point.
            token = ack.get("sessionToken")
            if isinstance(token, str) and token:
                with self._lock:
                    self._session_token = token
            breakpoints = ack.get("breakpoints")
            mode = ack.get("mode")
            self._engine.arm(
                breakpoints if isinstance(breakpoints, list) else [],
                mode if isinstance(mode, str) else "run",
            )
            with self._lock:
                self._attached_mirror = True
                # Replay-on-attach, oldest first. Envelopes keep their original
                # `seq`, so the viewer deduplicates (decisions.md #5).
                for frame in self._buffer.to_list():
                    self._transport.enqueue(frame)
        except Exception as exc:
            self._warner.warn("attach", "internal error while attaching", exc)
        # Only after arming: a resolved ready() guarantees gates can pause.
        self._settle_ready(True)

    def _handle_detached(self) -> None:
        with self._lock:
            self._attached_mirror = False
        try:
            # FAIL-OPEN: no debugger, no holds. Forget its breakpoints/mode too;
            # the next hello.ack re-arms them.
            self._engine.disarm()
            self._engine.release_all()
        except Exception as exc:
            self._warner.warn("detach", "internal error while detaching", exc)

    def _handle_control(self, envelope: dict[str, Any]) -> None:
        try:
            type_ = envelope.get("type")
            payload = envelope.get("payload") or {}
            if type_ == "exec.resume":
                pause_id = payload.get("pauseId")
                action = payload.get("action")
                if isinstance(pause_id, str) and isinstance(action, str):
                    self._engine.resume(pause_id, action, payload.get("output"))
            elif type_ == "breakpoint.set":
                matcher = payload.get("matcher")
                if isinstance(matcher, dict):
                    self._engine.add_breakpoint(matcher)
            elif type_ == "breakpoint.clear":
                matcher = payload.get("matcher")
                if isinstance(matcher, dict):
                    self._engine.remove_breakpoint(matcher)
            elif type_ == "mode.set":
                mode = payload.get("mode")
                if isinstance(mode, str):
                    self._engine.set_mode(mode)
            # Events echoed back, duplicate handshakes, future additions: ignore.
        except Exception as exc:
            self._warner.warn("control", "internal error handling a control frame", exc)

    def _on_paused(self, pause_id: str, node: GateNode, point: str, run_id: str) -> None:
        self._emit_or_warn(
            "exec.paused", {"pauseId": pause_id, "nodeId": node.node_id, "point": point}, run_id
        )

    def _on_resumed(self, pause_id: str, node: GateNode, action: str, run_id: str) -> None:
        self._emit_or_warn("exec.resumed", {"pauseId": pause_id, "action": action}, run_id)

    def _emit_or_warn(self, type: str, payload: dict[str, Any], run_id: str) -> None:
        if not self.enabled or self._disposed:
            return
        try:
            self._emit_internal(type, payload, run_id)
        except Exception as exc:
            self._warner.warn("emit", "internal error emitting a gate event", exc)


class RunScope:
    """Run boundary usable as both ``with`` and ``async with``.

    Emits ``run.started`` / ``run.finished`` plus an ``agent:<name>`` node, and
    carries the :class:`RunContext` the debugger's ``abort`` action targets.
    """

    __slots__ = ("_ctx", "_meta", "_name", "_node_id", "_session", "_started_at", "_token")

    def __init__(self, session: Session, name: str, meta: dict[str, Any] | None = None) -> None:
        self._session = session
        self._name = name
        self._meta = meta
        self._ctx: RunContext | None = None
        self._token: Any = None
        self._started_at = 0.0
        self._node_id = agent_node_id(name)

    @property
    def context(self) -> RunContext | None:
        return self._ctx

    # -- sync -----------------------------------------------------------------

    def __enter__(self) -> RunContext:
        return self._begin()

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._end(exc)

    # -- async ----------------------------------------------------------------

    async def __aenter__(self) -> RunContext:
        return self._begin()

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._end(exc)

    # -- shared ---------------------------------------------------------------

    def _begin(self) -> RunContext:
        session = self._session
        ctx = session._make_run_context(self._name)
        self._ctx = ctx
        self._token = _current_run.set(ctx)
        self._started_at = time.monotonic()
        if not session._active():
            return ctx
        try:
            session._ensure_started()
            meta: dict[str, Any] = {"name": self._name}
            if session.meta:
                meta.update(session.meta)
            if self._meta:
                meta.update(self._meta)
            session._emit_internal(
                "run.started",
                {"app": session.app_name, "sdk": session.sdk, "meta": meta},
                ctx.run_id,
            )
            session.start_node(
                node_id=self._node_id,
                kind="agent",
                name=self._name,
                instance_id=ctx.run_id,
            )
        except Exception as exc:
            session._warner.warn("run-start", "internal error starting a run", exc)
        return ctx

    def _end(self, error: BaseException | None) -> None:
        session = self._session
        ctx = self._ctx
        try:
            if self._token is not None:
                _current_run.reset(self._token)
        except Exception:
            pass
        self._token = None
        if ctx is None or not session._active():
            return
        aborted = ctx.aborted or is_abort_error(error)
        status = "aborted" if aborted else ("error" if error is not None else "ok")
        duration_ms = (time.monotonic() - self._started_at) * 1000.0
        try:
            if error is not None and not aborted:
                # `_emit_internal` with the explicit run id: the context var is
                # already reset, so `emit` would attribute this to the implicit run.
                session._emit_internal(
                    "node.error",
                    {
                        "nodeId": self._node_id,
                        "instanceId": ctx.run_id,
                        "error": to_error_info(error),
                    },
                    ctx.run_id,
                )
            session._batcher.flush_all()
            session._emit_internal(
                "node.finished",
                {
                    "nodeId": self._node_id,
                    "instanceId": ctx.run_id,
                    "durationMs": duration_ms,
                    "status": status,
                },
                ctx.run_id,
            )
            payload: dict[str, Any] = {"status": status}
            if error is not None and not aborted:
                payload["error"] = to_error_info(error)
            session._emit_internal("run.finished", payload, ctx.run_id)
        except Exception as exc:
            session._warner.warn("run-finish", "internal error finishing a run", exc)
