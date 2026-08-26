"""WebSocket transport: lazy connect, handshake, background retry, fail-open.

Port of ``packages/client/src/transport.ts``. Everything here runs on the
shared :mod:`graphmind.runtime` loop thread; the only cross-thread entry points
are :meth:`Transport.start`, :meth:`Transport.kick`, :meth:`Transport.enqueue`
and :meth:`Transport.dispose`, all of which are non-blocking.

The transport never raises into callers: every failure degrades to "detached"
plus a rate-limited warning, and a background retry keeps trying every
``retry_interval`` seconds.
"""

from __future__ import annotations

import asyncio
from collections import deque
from typing import Any, Callable, Deque, Dict, Optional

from .protocol import PROTOCOL_VERSION, parse_envelope_json
from .runtime import runtime
from .safe import RateLimitedWarner

#: Hard cap on frames waiting for a slow socket. Older frames are dropped
#: first; the ring buffer is what guarantees replay-on-attach, not this queue.
MAX_OUTBOX = 10_000


def _resolve_connect() -> Optional[Callable[..., Any]]:
    """The websockets client factory, tolerating old and new package layouts."""
    try:
        from websockets.asyncio.client import connect  # websockets >= 13

        return connect
    except Exception:
        pass
    try:  # pragma: no cover - only on ancient websockets
        from websockets.client import connect as legacy_connect

        return legacy_connect
    except Exception:
        return None


class TransportHooks:
    """Callbacks the session installs. All are invoked on the loop thread."""

    __slots__ = ("build_hello", "on_attached", "on_detached", "on_control")

    def __init__(
        self,
        build_hello: Callable[[], str],
        on_attached: Callable[[Dict[str, Any]], None],
        on_detached: Callable[[], None],
        on_control: Callable[[Dict[str, Any]], None],
    ) -> None:
        self.build_hello = build_hello
        self.on_attached = on_attached
        self.on_detached = on_detached
        self.on_control = on_control


class Transport:
    def __init__(
        self,
        url: str,
        hooks: TransportHooks,
        warner: RateLimitedWarner,
        connect_timeout: float = 0.3,
        handshake_timeout: float = 1.0,
        retry_interval: float = 10.0,
    ) -> None:
        self._url = url
        self._hooks = hooks
        self._warner = warner
        self._connect_timeout = connect_timeout
        self._handshake_timeout = handshake_timeout
        self._retry_interval = retry_interval

        self._state = "idle"  # idle | connecting | attached | disposed
        self._started = False
        self._outbox: Deque[str] = deque()
        self._wake: Optional[asyncio.Event] = None
        self._kick: Optional[asyncio.Event] = None
        self._supervisor: Optional["asyncio.Task[None]"] = None
        self._connect = _resolve_connect()

    # -- public, thread-safe --------------------------------------------------

    @property
    def attached(self) -> bool:
        return self._state == "attached"

    @property
    def state(self) -> str:
        return self._state

    def start(self) -> None:
        """Begin connecting (idempotent). Called lazily on first session use."""
        if self._started or self._state == "disposed":
            return
        self._started = True
        if self._connect is None:
            self._warner.warn(
                "transport-no-impl",
                "the `websockets` package is not importable; GraphMind stays detached "
                "(pip install graphmind-ai[all] or pip install websockets)",
            )
            return
        runtime.call_soon(self._start_supervisor)

    def kick(self) -> None:
        """Force an attempt now instead of waiting out the retry interval."""
        if self._state == "disposed":
            return
        if not self._started:
            self.start()
            return
        runtime.call_soon(self._set_kick)

    def enqueue(self, frame: str) -> None:
        """Queue one serialized frame for sending. Non-blocking, any thread."""
        if self._state != "attached":
            return
        outbox = self._outbox
        outbox.append(frame)
        while len(outbox) > MAX_OUTBOX:
            try:
                outbox.popleft()
            except IndexError:  # pragma: no cover - concurrent drain
                break
        runtime.call_soon(self._set_wake)

    def dispose(self) -> None:
        if self._state == "disposed":
            return
        self._state = "disposed"
        self._outbox.clear()
        runtime.call_soon(self._cancel_supervisor)

    # -- loop-thread internals ------------------------------------------------

    def _set_wake(self) -> None:
        if self._wake is not None:
            self._wake.set()

    def _set_kick(self) -> None:
        if self._kick is not None:
            self._kick.set()

    def _cancel_supervisor(self) -> None:
        task = self._supervisor
        self._supervisor = None
        if task is not None and not task.done():
            task.cancel()

    def _start_supervisor(self) -> None:
        if self._state == "disposed" or self._supervisor is not None:
            return
        self._wake = asyncio.Event()
        self._kick = asyncio.Event()
        loop = asyncio.get_event_loop()
        self._supervisor = loop.create_task(self._supervise())

    async def _supervise(self) -> None:
        while self._state != "disposed":
            if self._kick is not None:
                self._kick.clear()
            try:
                await self._attempt()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defence in depth
                self._warner.warn("transport-loop", "transport loop error", exc)
            if self._state == "disposed":
                return
            try:
                if self._kick is None:
                    await asyncio.sleep(self._retry_interval)
                else:
                    await asyncio.wait_for(self._kick.wait(), timeout=self._retry_interval)
            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover
                await asyncio.sleep(self._retry_interval)

    async def _attempt(self) -> None:
        if self._connect is None or self._state == "disposed":
            return
        self._state = "connecting"
        try:
            connection = await asyncio.wait_for(
                self._connect(self._url, open_timeout=None, max_queue=64),
                timeout=self._connect_timeout,
            )
        except asyncio.CancelledError:
            self._state = "idle"
            raise
        except asyncio.TimeoutError:
            self._state = "idle"
            self._warner.warn(
                "transport-timeout",
                f"viewer did not accept the connection within "
                f"{int(self._connect_timeout * 1000)}ms; staying detached",
            )
            return
        except Exception as exc:
            self._state = "idle"
            self._warner.warn("transport-connect", "failed to open WebSocket", exc)
            return

        was_attached = False
        try:
            await connection.send(self._hooks.build_hello())
            ack = await asyncio.wait_for(
                self._await_ack(connection), timeout=self._handshake_timeout
            )
            if ack is None:
                return
            self._outbox.clear()
            self._state = "attached"
            was_attached = True
            self._hooks.on_attached(ack)
            await self._pump(connection)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            self._warner.warn(
                "transport-ack-timeout",
                f"viewer did not complete the handshake within "
                f"{int(self._handshake_timeout * 1000)}ms; staying detached",
            )
        except Exception as exc:
            self._warner.warn("transport-io", "viewer connection lost", exc)
        finally:
            if self._state != "disposed":
                self._state = "idle"
            self._outbox.clear()
            try:
                await connection.close()
            except Exception:
                pass
            if was_attached:
                # FAIL-OPEN: no debugger, no holds.
                try:
                    self._hooks.on_detached()
                except Exception:
                    pass

    async def _await_ack(self, connection: Any) -> Optional[Dict[str, Any]]:
        """Read frames until ``hello.ack``; anything before it is ignored."""
        while True:
            try:
                raw = await connection.recv()
            except asyncio.CancelledError:
                raise
            except Exception:
                return None
            result = parse_envelope_json(_to_text(raw))
            if result.kind == "version-mismatch":
                self._warner.warn(
                    "transport-version",
                    f"viewer speaks protocol v{result.received}, this client speaks "
                    f"v{PROTOCOL_VERSION}; staying detached",
                )
                return None
            if result.kind != "ok" or result.envelope is None:
                continue
            envelope = result.envelope
            if envelope.get("type") != "hello.ack":
                continue
            payload = envelope.get("payload") or {}
            versions = payload.get("versions") or {}
            if versions.get("protocol") != PROTOCOL_VERSION:
                self._warner.warn(
                    "transport-version",
                    f"viewer acked protocol v{versions.get('protocol')}, this client "
                    f"speaks v{PROTOCOL_VERSION}; staying detached",
                )
                return None
            return payload

    async def _pump(self, connection: Any) -> None:
        """Read control frames while a writer task drains the outbox."""
        writer = asyncio.get_event_loop().create_task(self._write_loop(connection))
        try:
            async for raw in connection:
                if self._state != "attached":
                    break
                result = parse_envelope_json(_to_text(raw))
                if result.kind == "ok" and result.envelope is not None:
                    self._hooks.on_control(result.envelope)
                elif result.kind == "invalid":
                    self._warner.warn(
                        "transport-invalid", f"ignoring invalid frame: {result.reason}"
                    )
                # `unknown-type` and `version-mismatch` mid-stream: tolerate.
        finally:
            writer.cancel()
            try:
                await writer
            except (asyncio.CancelledError, Exception):
                pass

    async def _write_loop(self, connection: Any) -> None:
        wake = self._wake
        while True:
            if not self._outbox:
                if wake is None:
                    await asyncio.sleep(0.01)
                    continue
                await wake.wait()
                wake.clear()
                continue
            try:
                frame = self._outbox.popleft()
            except IndexError:  # pragma: no cover - drained concurrently
                continue
            await connection.send(frame)


def _to_text(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (bytes, bytearray, memoryview)):
        try:
            return bytes(raw).decode("utf-8", "replace")
        except Exception:  # pragma: no cover
            return ""
    return str(raw)
