"""Gate engine: cooperative pause points inside the instrumented process.

Port of ``packages/client/src/gate-engine.ts``, made thread-safe because a
Python agent may be sync (gates block the calling thread), async (gates await
on the caller's event loop), or both at once, while the transport lives on its
own background loop thread.

The unit of waiting is a :class:`concurrent.futures.Future`, which is the one
primitive both worlds can consume:

* sync caller  -> ``future.result()`` blocks the calling thread;
* async caller -> ``await asyncio.wrap_future(future)`` suspends the task and
  is resolved from the transport thread via ``call_soon_threadsafe``.

Fail-open invariants:

* :meth:`GateEngine.release_all` resolves every held gate with ``continue``
  (called on disconnect and on dispose);
* an optional per-gate pause timeout auto-continues a gate nobody resumes;
* every timer is a daemon thread timer, so held bookkeeping never keeps the
  interpreter alive.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from concurrent.futures import Future
from typing import Any


class GateDecision:
    """How a gate was released."""

    __slots__ = ("action", "output")

    def __init__(self, action: str, output: Any = None) -> None:
        self.action = action
        self.output = output

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        if self.action == "inject":
            return f"GateDecision(inject, output={self.output!r})"
        return f"GateDecision({self.action})"

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, GateDecision)
            and other.action == self.action
            and other.output == self.output
        )

    def __hash__(self) -> int:
        return hash((self.action, repr(self.output)))


CONTINUE = GateDecision("continue")
"""Shared instance returned on every fast path (detached / no match)."""


class GateNode:
    """The logical node a gate belongs to."""

    __slots__ = ("kind", "name", "node_id")

    def __init__(self, node_id: str, kind: str, name: str) -> None:
        self.node_id = node_id
        self.kind = kind
        self.name = name

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"GateNode({self.node_id!r}, {self.kind!r}, {self.name!r})"


def matcher_matches(matcher: dict[str, Any], point: str, node: GateNode) -> bool:
    """Every present matcher field must match; absent fields match anything."""
    if (matcher.get("point") or "before") != point:
        return False
    kind = matcher.get("kind")
    if kind is not None and kind != node.kind:
        return False
    name = matcher.get("name")
    return name is None or name == node.name


def matcher_equals(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (
        a.get("kind") == b.get("kind")
        and a.get("name") == b.get("name")
        and a.get("point") == b.get("point")
    )


class Hold:
    """Handle for one held gate: the pause id plus the future to wait on."""

    __slots__ = ("future", "pause_id")

    def __init__(self, pause_id: str, future: Future[GateDecision]) -> None:
        self.pause_id = pause_id
        self.future = future


class _HeldGate:
    __slots__ = ("future", "node", "pause_id", "point", "run_id", "timer")

    def __init__(
        self,
        pause_id: str,
        node: GateNode,
        point: str,
        run_id: str,
        future: Future[GateDecision],
    ) -> None:
        self.pause_id = pause_id
        self.node = node
        self.point = point
        self.run_id = run_id
        self.future = future
        self.timer: threading.Timer | None = None


class GateEngine:
    """Bookkeeping for held gates. The session decides *whether* to gate."""

    def __init__(
        self,
        on_paused: Callable[[str, GateNode, str, str], None],
        on_resumed: Callable[[str, GateNode, str, str], None],
        new_pause_id: Callable[[], str],
        pause_timeout: float | None = None,
    ) -> None:
        self._on_paused = on_paused
        self._on_resumed = on_resumed
        self._new_pause_id = new_pause_id
        self._pause_timeout = pause_timeout
        self._lock = threading.RLock()
        self._breakpoints: list[dict[str, Any]] = []
        self._mode = "run"
        self._held: dict[str, _HeldGate] = {}

    # -- viewer state ---------------------------------------------------------

    def arm(self, breakpoints: Iterable[dict[str, Any]], mode: str) -> None:
        """Adopt the viewer's full debug state (from ``hello.ack``)."""
        with self._lock:
            self._breakpoints = [dict(m) for m in breakpoints if isinstance(m, dict)]
            self._mode = mode if mode in ("run", "step") else "run"

    def disarm(self) -> None:
        """Drop viewer state (on detach). Held gates are released separately."""
        with self._lock:
            self._breakpoints = []
            self._mode = "run"

    def set_mode(self, mode: str) -> None:
        if mode in ("run", "step"):
            with self._lock:
                self._mode = mode

    def add_breakpoint(self, matcher: dict[str, Any]) -> None:
        with self._lock:
            if not any(matcher_equals(existing, matcher) for existing in self._breakpoints):
                self._breakpoints.append(dict(matcher))

    def remove_breakpoint(self, matcher: dict[str, Any]) -> None:
        with self._lock:
            self._breakpoints = [
                existing for existing in self._breakpoints if not matcher_equals(existing, matcher)
            ]

    def snapshot(self) -> tuple[list[dict[str, Any]], str]:
        with self._lock:
            return [dict(m) for m in self._breakpoints], self._mode

    # -- decisions ------------------------------------------------------------

    def should_pause(self, point: str, node: GateNode) -> bool:
        """Step mode pauses at every ``before``/``error`` point; run mode only
        on a matching breakpoint (``after`` needs an explicit one — decisions.md #2)."""
        with self._lock:
            if self._mode == "step" and point != "after":
                return True
            return any(matcher_matches(matcher, point, node) for matcher in self._breakpoints)

    # -- holds ----------------------------------------------------------------

    def hold(self, point: str, node: GateNode, run_id: str) -> Hold:
        """Register a held gate. Call only after :meth:`should_pause`."""
        future: Future[GateDecision] = Future()
        pause_id = self._new_pause_id()
        gate = _HeldGate(pause_id, node, point, run_id, future)
        with self._lock:
            self._held[pause_id] = gate
            if self._pause_timeout is not None:
                timer = threading.Timer(
                    self._pause_timeout, self._settle, (pause_id, CONTINUE, "continue")
                )
                timer.daemon = True
                gate.timer = timer
                timer.start()
        # Emitted after registration so a resume racing back finds the gate.
        self._on_paused(pause_id, node, point, run_id)
        return Hold(pause_id, future)

    def resume(self, pause_id: str, action: str, output: Any = None) -> bool:
        """Route a viewer ``exec.resume`` to its held gate. Unknown ids are ignored."""
        decision = GateDecision("inject", output) if action == "inject" else GateDecision(action)
        return self._settle(pause_id, decision, action)

    def release_all(self) -> int:
        """FAIL-OPEN: release every held gate with ``continue``. Returns the count."""
        with self._lock:
            pause_ids = list(self._held.keys())
        released = 0
        for pause_id in pause_ids:
            if self._settle(pause_id, CONTINUE, "continue"):
                released += 1
        return released

    def discard(self, pause_id: str) -> bool:
        """Drop a gate whose waiter went away (async task cancelled).

        Emits ``exec.resumed`` like any other release so the viewer's pause
        history stays reconstructable.
        """
        return self._settle(pause_id, CONTINUE, "continue")

    @property
    def held_count(self) -> int:
        with self._lock:
            return len(self._held)

    # -- internals ------------------------------------------------------------

    def _settle(self, pause_id: str, decision: GateDecision, action: str) -> bool:
        with self._lock:
            gate = self._held.pop(pause_id, None)
            if gate is None:
                return False
            if gate.timer is not None:
                gate.timer.cancel()
        # Callback + future resolution happen OUTSIDE the lock: the waiting
        # thread wakes immediately and must never contend with the transport.
        try:
            self._on_resumed(pause_id, gate.node, action, gate.run_id)
        except Exception:
            pass
        try:
            gate.future.set_result(decision)
        except Exception:
            # Already cancelled by an abandoned `asyncio.wrap_future` waiter.
            pass
        return True
