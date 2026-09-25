"""The engine's ``validating`` state (contract C2), Python port of
``packages/client/test/gate-engine-validating.test.ts``.

A gate checking an edited input keeps its pause id, its pause-timeout timer and
its opening time across a refusal (``reopen``); a timeout or ``release_all()``
while validating continues with the ORIGINAL input, and the late verdict lands
nowhere. The Python engine adds the MAILBOX: the transport hands the waiting
host a :class:`ValidationRequest`, the host presents the verdict and waits
again on the same gate.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from graphmind.gate import (
    CONTINUE,
    GateDecision,
    GateEngine,
    GateNode,
    HeldGateView,
    ResumeInfo,
    ValidationRequest,
)

NODE = GateNode("tool:search", "tool", "search")


class Rig:
    def __init__(self, pause_timeout: float | None = None) -> None:
        self.now = 1000.0
        self.ids = 0
        self.paused: list[str] = []
        self.resumed: list[tuple[str, str, ResumeInfo | None]] = []
        self.engine = GateEngine(
            on_paused=lambda pause_id, *_: self.paused.append(pause_id),
            on_resumed=lambda pause_id, _node, action, _run, info: self.resumed.append(
                (pause_id, action, info)
            ),
            new_pause_id=self._next_id,
            pause_timeout=pause_timeout,
            clock=lambda: self.now,
        )

    def _next_id(self) -> str:
        self.ids += 1
        return f"pause_{self.ids}"

    def request(self, pause_id: str) -> ValidationRequest:
        view = self.engine.peek(pause_id)
        assert isinstance(view, HeldGateView)
        return ValidationRequest(view, "continue", {"q": 1}, "rq", self.now, None)


def test_begin_validation_hands_the_request_to_the_waiting_host() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    request = rig.request(hold.pause_id)
    ticket = rig.engine.begin_validation(hold.pause_id, request)
    assert ticket is not None and request.ticket is ticket
    assert rig.engine.mailbox(hold).result(0) is request
    view = rig.engine.peek(hold.pause_id)
    assert view is not None and view.state == "validating"
    # A second edit while validating is refused (the debugger answers it itself).
    assert rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id)) is None


def test_a_plain_resume_is_ignored_while_validating() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert rig.engine.resume(hold.pause_id, "abort") is False
    assert rig.resumed == [] and rig.engine.held_count == 1


def test_complete_validation_releases_with_the_edit_and_the_info_exactly_once() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    request = rig.request(hold.pause_id)
    ticket = rig.engine.begin_validation(hold.pause_id, request)
    assert ticket is not None
    info = ResumeInfo("rq", {"after": {"q": 2}})
    decision = GateDecision("continue", input={"q": 2})
    assert rig.engine.complete_validation(ticket, decision, info) is True
    assert rig.engine.mailbox(hold).result(0) == decision
    assert rig.resumed == [(hold.pause_id, "continue", info)]
    # Stale now: nothing else happens.
    assert rig.engine.complete_validation(ticket, decision, info) is False
    assert rig.engine.reopen(ticket) is False
    assert len(rig.resumed) == 1


def test_reopen_keeps_the_pause_id_and_gives_the_host_a_fresh_mailbox() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    for _ in range(3):
        ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
        assert ticket is not None
        assert rig.engine.reopen(ticket) is True
        mailbox = rig.engine.mailbox(hold)
        assert not mailbox.done()
        view = rig.engine.peek(hold.pause_id)
        assert view is not None and view.state == "held"
    assert rig.paused == [hold.pause_id] and rig.resumed == []
    assert rig.engine.resume(hold.pause_id, "continue", info=ResumeInfo("last")) is True
    assert rig.engine.mailbox(hold).result(0) == CONTINUE
    assert [(p, a, i.request_id if i else None) for p, a, i in rig.resumed] == [
        (hold.pause_id, "continue", "last")
    ]


def test_release_all_while_validating_continues_and_the_late_verdict_is_dropped() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert ticket is not None
    assert rig.engine.release_all() == 1
    # The host was holding the request: it reads the gate's mailbox again.
    assert rig.engine.mailbox(hold).result(0) == CONTINUE
    assert rig.engine.complete_validation(ticket, GateDecision("continue", input={})) is False
    assert rig.engine.reopen(ticket) is False
    assert rig.resumed == [(hold.pause_id, "continue", None)]


def test_on_resumed_raising_never_strands_the_host() -> None:
    def boom(*_args: Any) -> None:
        raise RuntimeError("callback")

    engine = GateEngine(lambda *a: None, boom, lambda: "pause_1")
    hold = engine.hold("before", NODE, "run_1")
    assert engine.resume(hold.pause_id, "retry") is True
    assert engine.mailbox(hold).result(0) == GateDecision("retry")


def test_a_verdict_after_the_pause_deadline_continues_with_the_original_input() -> None:
    rig = Rig(pause_timeout=60.0)  # the timer never fires in this test
    hold = rig.engine.hold("before", NODE, "run_1")
    ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert ticket is not None
    rig.now += 60_000  # synchronous validator work outran the deadline
    assert rig.engine.complete_validation(ticket, GateDecision("continue", input={"q": 9})) is False
    assert rig.engine.mailbox(hold).result(0) == CONTINUE
    assert rig.resumed == [(hold.pause_id, "continue", None)]


def test_reopen_after_the_deadline_continues_instead_of_holding_again() -> None:
    rig = Rig(pause_timeout=60.0)
    hold = rig.engine.hold("before", NODE, "run_1")
    ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert ticket is not None
    rig.now += 60_001
    assert rig.engine.reopen(ticket) is False
    assert rig.engine.held_count == 0
    assert rig.engine.mailbox(hold).result(0) == CONTINUE


def test_just_inside_the_deadline_the_verdict_is_applied() -> None:
    rig = Rig(pause_timeout=60.0)
    hold = rig.engine.hold("before", NODE, "run_1")
    ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert ticket is not None
    rig.now += 59_999
    decision = GateDecision("continue", input={"q": 9})
    assert rig.engine.complete_validation(ticket, decision) is True
    assert rig.engine.mailbox(hold).result(0) == decision


def test_with_no_pause_timeout_there_is_no_deadline() -> None:
    rig = Rig()
    hold = rig.engine.hold("before", NODE, "run_1")
    ticket = rig.engine.begin_validation(hold.pause_id, rig.request(hold.pause_id))
    assert ticket is not None
    rig.now += 10**9
    assert rig.engine.reopen(ticket) is True


def test_the_timer_fires_while_validating_continue_and_the_verdict_is_dropped() -> None:
    engine = GateEngine(lambda *a: None, lambda *a: None, lambda: "pause_1", pause_timeout=0.05)
    hold = engine.hold("before", NODE, "run_1")
    view = engine.peek(hold.pause_id)
    assert view is not None
    ticket = engine.begin_validation(
        hold.pause_id, ValidationRequest(view, "continue", {}, None, None, None)
    )
    assert ticket is not None
    time.sleep(0.15)
    assert engine.held_count == 0
    assert engine.mailbox(hold).result(1) == CONTINUE
    assert engine.complete_validation(ticket, GateDecision("continue", input={})) is False


def test_a_refusal_does_not_restart_the_timer() -> None:
    engine = GateEngine(lambda *a: None, lambda *a: None, lambda: "pause_1", pause_timeout=0.3)
    hold = engine.hold("before", NODE, "run_1")
    opened = time.monotonic()
    time.sleep(0.15)
    view = engine.peek(hold.pause_id)
    assert view is not None
    ticket = engine.begin_validation(
        hold.pause_id, ValidationRequest(view, "continue", {}, None, None, None)
    )
    assert ticket is not None and engine.reopen(ticket) is True
    assert engine.mailbox(hold).result(2) == CONTINUE
    assert time.monotonic() - opened < 0.45


def test_a_settle_racing_the_hand_off_never_loses_the_final_decision() -> None:
    """The mailbox swap is atomic with the release: whichever of the hand-off
    and a concurrent release wins, the host always ends with a decision."""
    for _ in range(200):
        engine = GateEngine(lambda *a: None, lambda *a: None, lambda: "pause_1")
        hold = engine.hold("before", NODE, "run_1")
        view = engine.peek(hold.pause_id)
        assert view is not None
        request = ValidationRequest(view, "continue", {}, None, None, None)
        racer = threading.Thread(target=engine.release_all)
        racer.start()
        engine.begin_validation(hold.pause_id, request)
        racer.join()
        message = engine.mailbox(hold).result(1)
        if isinstance(message, ValidationRequest):
            # The hand-off won; the release replaced the mailbox after it.
            assert message.ticket is not None
            assert engine.complete_validation(message.ticket, CONTINUE) is False
            message = engine.mailbox(hold).result(1)
        assert message == CONTINUE
