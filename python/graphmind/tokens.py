"""Batches streamed token deltas into ``node.token`` events.

At most one batch per node per ``interval`` (~30/sec by default) so a fast
provider stream cannot flood the wire. The flush timer lives on the shared
runtime loop, never on the host's thread. ``flush_node`` forces a flush before
``node.finished`` so ordering holds.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from .runtime import runtime

TokenBatchSink = Callable[[str, list[dict[str, Any]]], None]


class TokenBatcher:
    def __init__(self, sink: TokenBatchSink, interval: float = 0.034) -> None:
        self._sink = sink
        self._interval = interval
        self._pending: dict[str, list[dict[str, Any]]] = {}
        self._lock = threading.Lock()
        self._scheduled = False
        self._disposed = False

    def push(self, node_id: str, channel: str, value: str) -> None:
        if self._disposed or not value:
            return
        schedule = False
        with self._lock:
            if self._disposed:
                return
            self._pending.setdefault(node_id, []).append({"t": channel, "v": value})
            if not self._scheduled:
                self._scheduled = True
                schedule = True
        # No loop available (very early shutdown): flush inline rather than
        # lose the deltas.
        if schedule and not runtime.spawn(self._flush_later()):
            self.flush_all()

    async def _flush_later(self) -> None:
        try:
            await asyncio.sleep(self._interval)
        except asyncio.CancelledError:
            pass
        with self._lock:
            self._scheduled = False
        self.flush_all()

    def flush_node(self, node_id: str) -> None:
        with self._lock:
            deltas = self._pending.pop(node_id, None)
        if deltas:
            try:
                self._sink(node_id, deltas)
            except Exception:
                pass

    def flush_all(self) -> None:
        with self._lock:
            pending = self._pending
            self._pending = {}
        for node_id, deltas in pending.items():
            if not deltas:
                continue
            try:
                self._sink(node_id, deltas)
            except Exception:
                pass

    def dispose(self) -> None:
        if self._disposed:
            return
        self.flush_all()
        self._disposed = True
