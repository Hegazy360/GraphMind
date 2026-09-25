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

Edited input (0.6.0, contract C2) adds one state. A gate is ``held`` until a
resume arrives; a resume that carries an edited input first moves it to
``validating`` (:meth:`GateEngine.begin_validation`) while the session checks
the edit. The verdict either releases it with the edit
(:meth:`GateEngine.complete_validation`) or puts it back to ``held``
(:meth:`GateEngine.reopen`) — SAME pause id, same pause-timeout timer, same
opening time, so held time is one interval from the first pause to the final
release, however many edits were refused in between. While validating, plain
resumes are ignored (the debugger answers a second resumer itself), and a
pause timeout or :meth:`GateEngine.release_all` still releases the gate with
a plain ``continue`` — the ORIGINAL input — and the late verdict lands nowhere
(fail-open). A verdict presented after the pause deadline gets the same
outcome even when the timer has not fired yet.

The validator is host code, so it runs on the HOST's thread or task — the
one blocked in the gate — never on the transport's thread. Each gate
therefore has a MAILBOX (a future) rather than a one-shot result: the
transport hands the waiting host a :class:`ValidationRequest` through it
(``begin_validation``); the host runs the validator, presents the verdict, and
waits again on the same gate — a reopened gate gets a fresh mailbox, a
released one a mailbox holding its final :class:`GateDecision`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from concurrent.futures import Future
from typing import Any

from .clock import monotonic_ms

_NO_INPUT: Any = object()


class GateDecision:
    """How a gate was released.

    ``input`` is present (``has_input``) only when the debugger edited the
    call's input and the edit was accepted (``continue`` at a ``before`` gate,
    ``retry`` at an ``after`` / ``error`` gate): run the call with it instead
    of the live input.
    """

    __slots__ = ("_input", "action", "output")

    def __init__(self, action: str, output: Any = None, *, input: Any = _NO_INPUT) -> None:
        self.action = action
        self.output = output
        self._input = input

    @property
    def has_input(self) -> bool:
        """True when the call must run with :attr:`input` (an accepted edit)."""
        return self._input is not _NO_INPUT

    @property
    def input(self) -> Any:
        """The accepted edited input, or ``None`` when there is none."""
        return None if self._input is _NO_INPUT else self._input

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        if self.action == "inject":
            return f"GateDecision(inject, output={self.output!r})"
        if self.has_input:
            return f"GateDecision({self.action}, input={self._input!r})"
        return f"GateDecision({self.action})"

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, GateDecision)
            and other.action == self.action
            and other.output == self.output
            and other.has_input == self.has_input
            and (not self.has_input or other._input == self._input)
        )

    def __hash__(self) -> int:
        return hash((self.action, repr(self.output), self.has_input))


CONTINUE = GateDecision("continue")
"""Shared instance returned on every fast path (detached / no match)."""


class GateNode:
    """The logical node a gate belongs to. ``instance_id``: the execution the
    gate holds (its ``node.started`` ``instanceId``), when the integration
    knows it — sent as ``exec.paused.instanceId`` (0.6.0) so a debugger can
    tell parallel calls of one node apart. Breakpoints never match on it."""

    __slots__ = ("instance_id", "kind", "name", "node_id")

    def __init__(
        self, node_id: str, kind: str, name: str, instance_id: str | None = None
    ) -> None:
        self.node_id = node_id
        self.kind = kind
        self.name = name
        self.instance_id = instance_id

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"GateNode({self.node_id!r}, {self.kind!r}, {self.name!r})"


class ResumeInfo:
    """Extra facts about a release, carried into ``exec.resumed``."""

    __slots__ = ("edited", "request_id")

    def __init__(self, request_id: str | None = None, edited: Any = _NO_INPUT) -> None:
        #: Echo of ``exec.resume.requestId`` (absent on timeout / fail-open releases).
        self.request_id = request_id
        #: ``{"after": <wire copy>}`` when the gate runs with an edited input.
        self.edited = None if edited is _NO_INPUT else edited


class HeldGateView:
    """A held gate as the session may inspect it (a copy, never the live record)."""

    __slots__ = ("node", "pause_id", "point", "run_id", "state")

    def __init__(self, pause_id: str, node: GateNode, point: str, run_id: str, state: str) -> None:
        self.pause_id = pause_id
        self.node = node
        self.point = point
        self.run_id = run_id
        self.state = state


class ValidationTicket:
    """Names one validation of one gate. A verdict is applied only while its
    ticket is the gate's current one, so a verdict that arrives after a pause
    timeout or a detach released the gate is dropped."""

    __slots__ = ("pause_id",)

    def __init__(self, pause_id: str) -> None:
        self.pause_id = pause_id


class ValidationRequest:
    """An edited input for the host to validate, handed over through the gate's
    mailbox. Built by the session on the transport thread; ``ticket`` is set by
    :meth:`GateEngine.begin_validation`."""

    __slots__ = ("action", "gate", "input", "request_id", "started_at", "ticket", "validate")

    def __init__(
        self,
        gate: HeldGateView,
        action: str,
        input: Any,
        request_id: str | None,
        started_at: float | None,
        validate: Any,
    ) -> None:
        self.gate = gate
        self.action = action
        self.input = input
        self.request_id = request_id
        #: Monotonic ms when the resume was handled (None: the clock failed).
        self.started_at = started_at
        #: The integration's validator (None: the proposed input is used as it is).
        self.validate = validate
        self.ticket: ValidationTicket | None = None


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


class _HeldGate:
    __slots__ = (
        "mailbox",
        "node",
        "opened_at",
        "pause_id",
        "point",
        "run_id",
        "state",
        "ticket",
        "timer",
    )

    def __init__(
        self,
        pause_id: str,
        node: GateNode,
        point: str,
        run_id: str,
        opened_at: float | None,
    ) -> None:
        self.pause_id = pause_id
        self.node = node
        self.point = point
        self.run_id = run_id
        #: Monotonic ms (the engine's clock); None when the clock failed.
        self.opened_at = opened_at
        #: Resolves with a ValidationRequest or the final GateDecision.
        self.mailbox: Future[Any] = Future()
        #: ``validating`` while an edited input is checked (module docstring).
        self.state = "held"
        self.ticket: ValidationTicket | None = None
        self.timer: threading.Timer | None = None


class Hold:
    """Handle for one held gate: the pause id plus its mailbox (see
    :meth:`GateEngine.mailbox`). ``future`` is the mailbox as it was when the
    gate opened — enough for a caller that never validates an edit."""

    __slots__ = ("_gate", "pause_id")

    def __init__(self, pause_id: str, gate: _HeldGate) -> None:
        self.pause_id = pause_id
        self._gate = gate

    @property
    def future(self) -> Future[Any]:
        return self._gate.mailbox


class GateEngine:
    """Bookkeeping for held gates. The session decides *whether* to gate."""

    def __init__(
        self,
        on_paused: Callable[[str, GateNode, str, str, Any], None],
        on_resumed: Callable[[str, GateNode, str, str, ResumeInfo | None], None],
        new_pause_id: Callable[[], str],
        pause_timeout: float | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._on_paused = on_paused
        self._on_resumed = on_resumed
        self._new_pause_id = new_pause_id
        self._pause_timeout = pause_timeout
        #: Monotonic milliseconds, for the pause deadline during validation.
        self._clock = clock if clock is not None else monotonic_ms
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

    def hold(self, point: str, node: GateNode, run_id: str, reason: Any = None) -> Hold:
        """Register a held gate. Call only after :meth:`should_pause` (or for a
        built-in breakpoint such as the loop hold). ``reason`` rides to
        ``on_paused`` — handed over per call, never shared between threads."""
        pause_id = self._new_pause_id()
        gate = _HeldGate(pause_id, node, point, run_id, self._now())
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
        self._on_paused(pause_id, node, point, run_id, reason)
        return Hold(pause_id, gate)

    def mailbox(self, hold: Hold) -> Future[Any]:
        """What the host waits on now: a future resolving with a
        :class:`ValidationRequest` (validate it, then wait again) or the final
        :class:`GateDecision`."""
        with self._lock:
            return hold._gate.mailbox

    def resume(
        self, pause_id: str, action: str, output: Any = None, info: ResumeInfo | None = None
    ) -> bool:
        """Route a viewer ``exec.resume`` to its held gate. Unknown ids are
        ignored, and so is a gate that is validating an edit (its verdict decides)."""
        decision = GateDecision("inject", output) if action == "inject" else GateDecision(action)
        return self._settle(pause_id, decision, action, info, lambda gate: gate.state == "held")

    def peek(self, pause_id: str) -> HeldGateView | None:
        """The held gate with this id, if any."""
        with self._lock:
            gate = self._held.get(pause_id)
            if gate is None:
                return None
            return HeldGateView(pause_id, gate.node, gate.point, gate.run_id, gate.state)

    def begin_validation(
        self, pause_id: str, request: ValidationRequest
    ) -> ValidationTicket | None:
        """``held`` -> ``validating``: hand ``request`` to the host waiting on
        this gate. Returns the ticket the verdict must present, or ``None`` when
        the gate is unknown, already validating, or its waiter went away."""
        with self._lock:
            gate = self._held.get(pause_id)
            if gate is None or gate.state != "held" or gate.mailbox.done():
                return None
            ticket = ValidationTicket(pause_id)
            request.ticket = ticket
            gate.state = "validating"
            gate.ticket = ticket
            try:
                # Under the lock: a settle racing in must find the mailbox
                # either still pending (and resolve it) or already carrying
                # this request (and give the host a fresh one).
                gate.mailbox.set_result(request)
            except Exception:
                # Cancelled by an abandoned async waiter: its discard follows.
                gate.state = "held"
                gate.ticket = None
                return None
            return ticket

    def reopen(self, ticket: ValidationTicket) -> bool:
        """``validating`` -> ``held``: the edit was refused and the gate waits
        for the next resume, under the same pause id, timer and held interval.
        False when the ticket is stale (the gate was released meanwhile), or
        when the pause deadline passed during validation — the gate is then
        continued with its original input, as the pause-timeout timer would
        have done had the validator not kept it busy."""
        with self._lock:
            gate = self._held.get(ticket.pause_id)
            if gate is None or gate.ticket is not ticket:
                return False
            overdue = self._overdue(gate)
            if not overdue:
                gate.state = "held"
                gate.ticket = None
                gate.mailbox = Future()
                return True
        self._settle(ticket.pause_id, CONTINUE, "continue", None, lambda g: g.ticket is ticket)
        return False

    def complete_validation(
        self, ticket: ValidationTicket, decision: GateDecision, info: ResumeInfo | None = None
    ) -> bool:
        """``validating`` -> released with the accepted edit. False when the
        ticket is stale (a pause timeout or a detach already continued the gate
        with its original input), or when the pause deadline passed during
        validation (the gate is continued with its original input)."""
        with self._lock:
            gate = self._held.get(ticket.pause_id)
            if gate is None or gate.ticket is not ticket:
                return False
            overdue = self._overdue(gate)
        if overdue:
            self._settle(ticket.pause_id, CONTINUE, "continue", None, lambda g: g.ticket is ticket)
            return False
        return self._settle(
            ticket.pause_id, decision, decision.action, info, lambda g: g.ticket is ticket
        )

    def release_all(self) -> int:
        """FAIL-OPEN: release every held gate with ``continue``. Returns the count."""
        with self._lock:
            pause_ids = list(self._held.keys())
        released = 0
        for pause_id in pause_ids:
            try:
                if self._settle(pause_id, CONTINUE, "continue"):
                    released += 1
            except Exception:
                pass  # one gate's bookkeeping must never keep the others held
        return released

    def discard(self, pause_id: str) -> bool:
        """Drop a gate whose waiter went away (async task cancelled, Ctrl-C).

        Emits ``exec.resumed`` like any other release so the viewer's pause
        history stays reconstructable.
        """
        return self._settle(pause_id, CONTINUE, "continue")

    @property
    def held_count(self) -> int:
        with self._lock:
            return len(self._held)

    # -- internals ------------------------------------------------------------

    def _now(self) -> float | None:
        try:
            return float(self._clock())
        except Exception:
            return None

    def _overdue(self, gate: _HeldGate) -> bool:
        """Has this gate's pause timeout elapsed? The timer normally settles
        the gate first; a slow validator can outrun it. An unreadable clock
        leaves the decision to the timer."""
        if self._pause_timeout is None or gate.opened_at is None:
            return False
        now = self._now()
        if now is None:
            return False
        return now - gate.opened_at >= self._pause_timeout * 1000.0

    def _settle(
        self,
        pause_id: str,
        decision: GateDecision,
        action: str,
        info: ResumeInfo | None = None,
        expect: Callable[[_HeldGate], bool] | None = None,
    ) -> bool:
        with self._lock:
            gate = self._held.get(pause_id)
            if gate is None or (expect is not None and not expect(gate)):
                return False
            del self._held[pause_id]
            gate.ticket = None
            if gate.timer is not None:
                gate.timer.cancel()
            mailbox = gate.mailbox
            if mailbox.done():
                # The host holds a validation request (or its waiter was
                # cancelled): it reads the gate's mailbox again, and finds this.
                mailbox = Future()
                gate.mailbox = mailbox
        # Callback + resolution happen OUTSIDE the lock: the waiting thread
        # wakes immediately and must never contend with the transport.
        try:
            self._on_resumed(pause_id, gate.node, action, gate.run_id, info)
        except Exception:
            pass
        try:
            mailbox.set_result(decision)
        except Exception:
            # Already cancelled by an abandoned `asyncio.wrap_future` waiter.
            pass
        return True
