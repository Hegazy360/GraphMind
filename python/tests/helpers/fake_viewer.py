"""A real WebSocket server that speaks the GraphMind wire protocol.

The test double for the viewer: it receives ``hello``, replies ``hello.ack``,
records every envelope, and can send control frames or crash abruptly. It runs
on its own thread + event loop so the same object can be driven from sync tests
and from async tests without either blocking the other.

Mirrors ``packages/ai-sdk/test/helpers/fake-viewer.ts``.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable
from typing import Any

from websockets.asyncio.server import serve

PROTOCOL_VERSION = 1


class FakeViewer:
    def __init__(
        self,
        breakpoints: list[dict[str, Any]] | None = None,
        mode: str = "run",
        auto_ack: bool = True,
        ack_protocol: int = PROTOCOL_VERSION,
    ) -> None:
        self.received: list[dict[str, Any]] = []
        self.connection_count = 0
        self.breakpoints = breakpoints or []
        self.mode = mode
        self.auto_ack = auto_ack
        self.ack_protocol = ack_protocol

        self._lock = threading.Lock()
        self._conns: set = set()
        self._closers: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: Any = None
        self._ready = threading.Event()
        self._seq = 0
        self.port = 0
        self._thread = threading.Thread(target=self._serve, name="fake-viewer", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=10):
            raise RuntimeError("fake viewer failed to start")

    # -- lifecycle ------------------------------------------------------------

    def _serve(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        loop.run_until_complete(self._start())
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            try:
                loop.close()
            except Exception:
                pass

    async def _start(self) -> None:
        self._server = await serve(self._handle, "127.0.0.1", 0)
        sockets = list(self._server.sockets)
        self.port = sockets[0].getsockname()[1]

    async def _handle(self, connection: Any) -> None:
        with self._lock:
            self.connection_count += 1
        self._conns.add(connection)
        try:
            async for raw in connection:
                try:
                    frame = json.loads(raw)
                except Exception:
                    continue
                with self._lock:
                    self.received.append(frame)
                if frame.get("type") == "hello" and self.auto_ack:
                    await connection.send(
                        self._envelope(
                            "hello.ack",
                            {
                                "versions": {
                                    "protocol": self.ack_protocol,
                                    "viewer": "fake-viewer/0.0.0",
                                },
                                "capabilities": ["pause", "step", "inject", "retry", "abort"],
                                "breakpoints": self.breakpoints,
                                "mode": self.mode,
                            },
                        )
                    )
        except Exception:
            pass
        finally:
            self._conns.discard(connection)

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ingest"

    def close(self) -> None:
        loop = self._loop
        if loop is None:
            return

        async def shutdown() -> None:
            for connection in list(self._conns):
                try:
                    await connection.close()
                except Exception:
                    pass
            if self._server is not None:
                self._server.close()
                try:
                    await self._server.wait_closed()
                except Exception:
                    pass

        try:
            asyncio.run_coroutine_threadsafe(shutdown(), loop).result(timeout=5)
        except Exception:
            pass
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:
            pass
        self._thread.join(timeout=5)

    def kill_abruptly(self) -> None:
        """Simulate a viewer crash: drop the sockets without a close handshake."""
        loop = self._loop
        if loop is None:
            return

        def abort() -> None:
            for connection in list(self._conns):
                transport = getattr(connection, "transport", None)
                if transport is not None:
                    try:
                        transport.abort()
                        continue
                    except Exception:
                        pass
                try:
                    self._closers.add(asyncio.ensure_future(connection.close(code=1006)))
                except Exception:
                    pass
            if self._server is not None:
                try:
                    self._server.close()
                except Exception:
                    pass

        loop.call_soon_threadsafe(abort)

    # -- inspection -----------------------------------------------------------

    def frames(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.received)

    def of_type(self, type_: str) -> list[dict[str, Any]]:
        return [f for f in self.frames() if f.get("type") == type_]

    def wait_for(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 8.0
    ) -> dict[str, Any]:
        """Block until a matching frame has been received (including past ones)."""
        deadline = time.monotonic() + timeout
        while True:
            for frame in self.frames():
                if predicate(frame):
                    return frame
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"fake viewer: timed out after {timeout}s; got "
                    f"{[f.get('type') for f in self.frames()]}"
                )
            time.sleep(0.005)

    async def wait_for_async(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 8.0
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            for frame in self.frames():
                if predicate(frame):
                    return frame
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"fake viewer: timed out after {timeout}s; got "
                    f"{[f.get('type') for f in self.frames()]}"
                )
            await asyncio.sleep(0.005)

    def wait_for_type(self, type_: str, timeout: float = 8.0) -> dict[str, Any]:
        return self.wait_for(lambda f: f.get("type") == type_, timeout)

    async def wait_for_type_async(self, type_: str, timeout: float = 8.0) -> dict[str, Any]:
        return await self.wait_for_async(lambda f: f.get("type") == type_, timeout)

    # -- control --------------------------------------------------------------

    def _envelope(self, type_: str, payload: dict[str, Any]) -> str:
        with self._lock:
            seq = self._seq
            self._seq += 1
        return json.dumps(
            {
                "gm": PROTOCOL_VERSION,
                "seq": seq,
                "ts": int(time.time() * 1000),
                "runId": "*",
                "type": type_,
                "payload": payload,
            }
        )

    def send_control(self, type_: str, payload: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None:
            return
        frame = self._envelope(type_, payload)

        async def broadcast() -> None:
            for connection in list(self._conns):
                try:
                    await connection.send(frame)
                except Exception:
                    pass

        asyncio.run_coroutine_threadsafe(broadcast(), loop).result(timeout=5)

    def resume(self, pause_id: str, action: str, output: Any = None) -> None:
        payload: dict[str, Any] = {"pauseId": pause_id, "action": action}
        if output is not None:
            payload["output"] = output
        self.send_control("exec.resume", payload)

    def set_breakpoint(self, matcher: dict[str, Any]) -> None:
        self.send_control("breakpoint.set", {"matcher": matcher})

    def clear_breakpoint(self, matcher: dict[str, Any]) -> None:
        self.send_control("breakpoint.clear", {"matcher": matcher})

    def set_mode(self, mode: str) -> None:
        self.send_control("mode.set", {"mode": mode})
