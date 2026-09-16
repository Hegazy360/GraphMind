"""Durations: sub-millisecond, monotonic, and with the debugger's hold time
reported separately from the node's own time (``heldMs``).

Cross-SDK parity with ``packages/client/test/held-time.test.ts`` and
``ruby/test/test_durations.rb``: the same contract, the same numbers.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any

import pytest

from graphmind import clock
from graphmind.clock import elapsed_ms, monotonic_ms, normalize_duration_ms, set_clock
from graphmind.held import HeldLedger

RUN = "run-1"


def decimals(value: float) -> int:
    text = repr(value)
    return len(text.split(".")[1]) if "." in text else 0


# -- clock ----------------------------------------------------------------------


class TestClock:
    def test_normalize_rounds_to_two_decimals_and_clamps(self) -> None:
        assert normalize_duration_ms(1.23456) == 1.23
        assert normalize_duration_ms(0.004) == 0.0
        assert normalize_duration_ms(0.006) == 0.01
        assert normalize_duration_ms(38_100.004) == 38_100.0
        assert normalize_duration_ms(-1) == 0.0
        assert normalize_duration_ms(-0.001) == 0.0
        assert normalize_duration_ms(math.nan) == 0.0
        assert normalize_duration_ms(math.inf) == 0.0
        assert normalize_duration_ms(-math.inf) == 0.0
        assert normalize_duration_ms(None) == 0.0
        assert normalize_duration_ms("12") == 0.0
        assert normalize_duration_ms(True) == 0.0
        assert normalize_duration_ms(7) == 7.0

    def test_normalize_never_has_more_than_two_decimals(self) -> None:
        seed = 42
        for _ in range(2000):
            seed = (seed * 1103515245 + 12345) % 2147483648
            raw = seed / 2147483648 * 100_000
            assert decimals(normalize_duration_ms(raw)) <= 2

    def test_perf_counter_backed_and_sub_millisecond(self) -> None:
        a = monotonic_ms()
        spin = sum(i % 7 for i in range(20_000))
        b = monotonic_ms()
        assert spin > 0
        assert b >= a
        assert not (float(a).is_integer() and float(b).is_integer() and a == b)

    def test_a_real_sleep_is_a_non_zero_fractional_duration(self) -> None:
        started = monotonic_ms()
        time.sleep(0.002)
        elapsed = elapsed_ms(started)
        assert 0 < elapsed < 1000

    def test_injected_clock_and_backwards_clock(self) -> None:
        t = [100.0]
        previous = set_clock(lambda: t[0])
        try:
            started = monotonic_ms()
            t[0] = 100.123456
            assert elapsed_ms(started) == 0.12
            t[0] = 99.0
            assert elapsed_ms(started) == 0.0
        finally:
            set_clock(previous)
        assert clock.monotonic_ms() != 99.0
        assert elapsed_ms(10, 12.345) == 2.35
        assert elapsed_ms(10, 5) == 0.0


# -- ledger ---------------------------------------------------------------------


class Manual:
    def __init__(self) -> None:
        self.t = 1000.0

    def now(self) -> float:
        return self.t

    def advance(self, ms: float) -> None:
        self.t += ms


def make() -> tuple[HeldLedger, Manual]:
    manual = Manual()
    return HeldLedger(clock=manual.now), manual


class TestHeldLedger:
    def test_before_hold_credited_to_the_instance_it_precedes(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "tool:search", "c1")
        ledger.hold_opened("p1", RUN, "tool:search", "before")
        m.advance(38_100.123)
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "tool:search", "c1") == 38_100.12
        assert ledger.tracked_instances == 0

    def test_sums_holds_across_a_retry_loop_and_peek_includes_open_hold(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "tool:flaky", "c1")
        ledger.hold_opened("p1", RUN, "tool:flaky", "before")
        m.advance(1000)
        ledger.hold_closed("p1")
        ledger.errored(RUN, "tool:flaky", "c1")
        ledger.hold_opened("p2", RUN, "tool:flaky", "error")
        m.advance(2000)
        assert ledger.peek(RUN, "tool:flaky", "c1") == 3000
        ledger.hold_closed("p2")
        ledger.hold_opened("p3", RUN, "tool:flaky", "before")
        m.advance(300)
        ledger.hold_closed("p3")
        assert ledger.finished(RUN, "tool:flaky", "c1") == 3300

    def test_unheld_instance_reports_zero_and_unknown_reports_none(self) -> None:
        ledger, _ = make()
        ledger.started(RUN, "tool:a", "i1")
        assert ledger.finished(RUN, "tool:a", "i1") == 0.0
        assert ledger.finished(RUN, "tool:a", "ghost") is None
        assert ledger.peek(RUN, "tool:a", None) is None
        ledger.started(RUN, "tool:a", "i1")
        assert ledger.finished(RUN, "tool:a", "i2") is None  # named-but-unknown != newest

    def test_finished_without_instance_id_takes_the_newest(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "llm:step", "s1")
        ledger.started(RUN, "llm:step", "s2")
        ledger.hold_opened("p1", RUN, "llm:step", "before")
        m.advance(10)
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "llm:step", None) == 10
        assert ledger.finished(RUN, "llm:step", None) == 0
        assert ledger.finished(RUN, "llm:step", None) is None

    def test_hold_with_no_open_instance_is_not_attributed(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "tool:a", "i1")
        assert ledger.finished(RUN, "tool:a", "i1") == 0
        ledger.hold_opened("p1", RUN, "tool:a", "error")  # LangChain: gate after finish
        m.advance(40_000)
        ledger.hold_closed("p1")
        assert ledger.open_holds == 0
        ledger.started(RUN, "tool:a", "i2")
        assert ledger.finished(RUN, "tool:a", "i2") == 0
        ledger.hold_opened("p2", RUN, "custom:never-started", "before")
        ledger.hold_closed("p2")
        ledger.hold_closed("unknown")

    def test_open_hold_at_finish_is_credited_up_to_now(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "tool:a", "i1")
        ledger.hold_opened("p1", RUN, "tool:a", "before")
        m.advance(700)
        assert ledger.finished(RUN, "tool:a", "i1") == 700
        m.advance(9999)
        ledger.hold_closed("p1")
        ledger.started(RUN, "tool:a", "i2")
        assert ledger.finished(RUN, "tool:a", "i2") == 0

    def test_backwards_clock_never_goes_negative(self) -> None:
        m = Manual()
        ledger = HeldLedger(clock=m.now)
        ledger.started(RUN, "tool:a", "i1")
        ledger.hold_opened("p1", RUN, "tool:a", "before")
        m.t = 900.0
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "tool:a", "i1") == 0

    def test_isolation_between_runs_nodes_and_restarted_ids(self) -> None:
        ledger, m = make()
        ledger.started("a", "tool:x", "i1")
        ledger.started("b", "tool:x", "i1")
        ledger.started("a", "tool:y", "i1")
        ledger.hold_opened("p1", "a", "tool:x", "before")
        m.advance(500)
        ledger.hold_closed("p1")
        assert ledger.finished("b", "tool:x", "i1") == 0
        assert ledger.finished("a", "tool:y", "i1") == 0
        ledger.started("a", "tool:x", "i1")  # restarted id: from zero
        assert ledger.tracked_instances == 1
        assert ledger.finished("a", "tool:x", "i1") == 0

    def test_child_hold_is_credited_to_open_ancestors_as_a_union(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "agent:a", "r1")
        ledger.started(RUN, "llm:step", "s1", "agent:a")
        assert ledger.finished(RUN, "llm:step", "s1") == 0
        ledger.started(RUN, "tool:weather", "w1", "llm:step")  # step closed: walk through it
        ledger.hold_opened("pw", RUN, "tool:weather", "before")
        m.advance(1000)
        ledger.started(RUN, "tool:currency", "c1", "agent:a")
        ledger.hold_opened("pc", RUN, "tool:currency", "before")
        m.advance(2000)
        ledger.hold_closed("pw")
        m.advance(500)
        ledger.hold_closed("pc")
        assert ledger.finished(RUN, "tool:weather", "w1") == 3000
        assert ledger.finished(RUN, "tool:currency", "c1") == 2500
        assert ledger.finished(RUN, "agent:a", "r1") == 3500  # not 5500

    def test_run_root_is_credited_without_a_declared_parent(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "agent:agent", RUN)  # the agent node's instanceId IS the runId
        ledger.started(RUN, "tool:search", "c1")  # @gm.tool emits no parentId
        ledger.hold_opened("p1", RUN, "tool:search", "before")
        m.advance(38_100)
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "tool:search", "c1") == 38_100
        assert ledger.finished(RUN, "agent:agent", RUN) == 38_100
        # reached through parentId as well: still once
        ledger.started(RUN, "agent:agent", RUN)
        ledger.started(RUN, "tool:t", "t1", "agent:agent")
        ledger.hold_opened("p2", RUN, "tool:t", "before")
        m.advance(100)
        ledger.hold_closed("p2")
        assert ledger.finished(RUN, "agent:agent", RUN) == 100
        assert ledger.finished(RUN, "tool:t", "t1") == 100
        # a root that already finished is not credited
        ledger.started(RUN, "tool:u", "u1")
        ledger.hold_opened("p3", RUN, "tool:u", "before")
        m.advance(5)
        ledger.hold_closed("p3")
        assert ledger.finished(RUN, "tool:u", "u1") == 5
        assert ledger.tracked_instances == 0

    def test_hold_after_finish_still_credits_open_ancestors_and_root(self) -> None:
        # LangChain callbacks emit node.finished and THEN gate after/error: the
        # hold is outside every instance of the tool, but the chain and the
        # agent are still running while the developer looks.
        ledger, m = make()
        ledger.started(RUN, "agent:graph", RUN)
        ledger.started(RUN, "chain:node", "n1", "agent:graph")
        ledger.started(RUN, "tool:t", "t1", "chain:node")
        assert ledger.finished(RUN, "tool:t", "t1") == 0
        ledger.hold_opened("p1", RUN, "tool:t", "error")
        assert ledger.open_holds == 1
        m.advance(40_000)
        ledger.hold_closed("p1")
        assert ledger.open_holds == 0
        ledger.started(RUN, "tool:t", "t2", "chain:node")
        assert ledger.finished(RUN, "tool:t", "t2") == 0
        assert ledger.finished(RUN, "chain:node", "n1") == 40_000
        assert ledger.finished(RUN, "agent:graph", RUN) == 40_000
        # A gate for a node that never started still counts for an open root.
        ledger.started(RUN, "agent:graph", RUN)
        ledger.hold_opened("p2", RUN, "custom:raw-gate", "before")
        m.advance(250)
        ledger.hold_closed("p2")
        assert ledger.finished(RUN, "custom:raw-gate", None) is None
        assert ledger.finished(RUN, "agent:graph", RUN) == 250

    def test_parent_cycle_and_late_parent_do_not_break(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "a", "a1", "b")
        ledger.started(RUN, "b", "b1", "a")
        ledger.hold_opened("p1", RUN, "a", "before")
        m.advance(10)
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "a", "a1") == 10
        assert ledger.finished(RUN, "b", "b1") == 10
        ledger.started(RUN, "tool:t", "t1", "agent:late")
        ledger.hold_opened("p2", RUN, "tool:t", "before")
        m.advance(100)
        ledger.started(RUN, "agent:late", "r1")
        m.advance(400)
        ledger.hold_closed("p2")
        assert ledger.finished(RUN, "agent:late", "r1") == 0
        assert ledger.finished(RUN, "tool:t", "t1") == 500

    def test_overlapping_instances_heuristics(self) -> None:
        ledger, m = make()
        ledger.started(RUN, "tool:s", "A")
        ledger.hold_opened("pA", RUN, "tool:s", "before")
        ledger.started(RUN, "tool:s", "B")
        ledger.hold_opened("pB", RUN, "tool:s", "before")
        m.advance(2000)
        ledger.hold_closed("pA")
        m.advance(2000)
        ledger.hold_closed("pB")
        assert ledger.finished(RUN, "tool:s", "A") == 2000
        assert ledger.finished(RUN, "tool:s", "B") == 4000
        # error prefers the instance node.error named; after goes to the oldest
        ledger.started(RUN, "tool:t", "A")
        ledger.started(RUN, "tool:t", "B")
        ledger.errored(RUN, "tool:t", "A")
        ledger.hold_opened("pe", RUN, "tool:t", "error")
        m.advance(700)
        ledger.hold_closed("pe")
        ledger.hold_opened("pf", RUN, "tool:t", "after")
        m.advance(300)
        ledger.hold_closed("pf")
        assert ledger.finished(RUN, "tool:t", "A") == 1000
        assert ledger.finished(RUN, "tool:t", "B") == 0

    def test_bounded(self) -> None:
        m = Manual()
        ledger = HeldLedger(max_instances=3, clock=m.now)
        ledger.started(RUN, "tool:a", "i1")
        ledger.hold_opened("p1", RUN, "tool:a", "before")
        for i in (2, 3, 4):
            ledger.started(RUN, "tool:a", f"i{i}")
        assert ledger.tracked_instances == 3
        assert ledger.open_holds == 0
        assert ledger.finished(RUN, "tool:a", "i1") is None
        m.advance(1000)
        ledger.hold_closed("p1")
        assert ledger.finished(RUN, "tool:a", "i4") == 0
        big = HeldLedger(max_instances=500)
        for i in range(5000):
            big.started(RUN, f"tool:{i % 17}", f"i{i}", "agent:a")
        assert big.tracked_instances == 500

    def test_thread_safety_smoke(self) -> None:
        ledger, _ = make()
        errors: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                for i in range(500):
                    ledger.started(RUN, f"tool:{n}", f"i{i}", "agent:a")
                    ledger.hold_opened(f"p{n}-{i}", RUN, f"tool:{n}", "before")
                    ledger.hold_closed(f"p{n}-{i}")
                    ledger.finished(RUN, f"tool:{n}", f"i{i}")
            except BaseException as exc:  # pragma: no cover - the assertion below reports it
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert errors == []
        assert ledger.tracked_instances == 0


# -- through the public API -------------------------------------------------------


def _finished_for(viewer: Any, node_id: str, instance_id: str | None = None) -> dict[str, Any]:
    return viewer.wait_for(
        lambda f: (
            f.get("type") == "node.finished"
            and f["payload"]["nodeId"] == node_id
            and (instance_id is None or f["payload"].get("instanceId") == instance_id)
        )
    )


def test_a_one_millisecond_tool_reports_a_non_zero_fractional_duration(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    def blink() -> str:
        time.sleep(0.001)
        return "ok"

    with instance.run("agent"):
        assert blink() == "ok"

    finished = _finished_for(viewer, "tool:blink")
    duration = finished["payload"]["durationMs"]
    assert isinstance(duration, float)
    assert 0 < duration < 1000, duration
    assert decimals(duration) <= 2
    # Nothing was held: heldMs is present and exactly 0 (measured, not missing).
    assert finished["payload"]["heldMs"] == 0
    # The agent node is timed the same way.
    agent = _finished_for(viewer, "agent:agent")
    assert 0 < agent["payload"]["durationMs"] < 1000
    assert agent["payload"]["heldMs"] == 0


async def test_async_tool_and_span_measure_sub_millisecond(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    async def fast() -> int:
        return 1

    async with instance.run("agent"):
        assert await fast() == 1
        async with instance.span("index", kind="custom"):
            pass

    for node_id in ("tool:fast", "custom:index"):
        payload = _finished_for(viewer, node_id)["payload"]
        assert payload["durationMs"] > 0, node_id  # Date.now()-style clocks said 0 here
        assert decimals(payload["durationMs"]) <= 2
        assert payload["heldMs"] == 0


def test_held_time_is_reported_separately_from_duration(attached: Any) -> None:
    """The load-bearing product claim: a developer who thinks for 38 s at a
    breakpoint does not turn a 2 ms tool into a 38 s one."""
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}])
    manual = Manual()
    previous = set_clock(manual.now)  # every duration AND the ledger read this clock
    try:

        @instance.tool
        def search(q: str) -> str:
            manual.advance(2.4)  # the tool's own work
            return q

        result: list[str] = []

        def call() -> None:
            with instance.run("agent"):
                result.append(search("flights"))

        caller = threading.Thread(target=call, daemon=True)
        caller.start()
        paused = viewer.wait_for_type("exec.paused")
        manual.advance(38_100.123)  # thinking
        viewer.resume(paused["payload"]["pauseId"], "continue")
        caller.join(timeout=5)
        assert result == ["flights"]

        tool = _finished_for(viewer, "tool:search")["payload"]
        assert tool["durationMs"] == 38_102.52  # wall clock, hold included — unchanged meaning
        assert tool["heldMs"] == 38_100.12  # the debugger's share
        agent = _finished_for(viewer, "agent:agent")["payload"]
        assert agent["heldMs"] == 38_100.12  # the hold sits inside the agent node too
        assert agent["durationMs"] >= 38_102.52
    finally:
        set_clock(previous)


def test_node_error_carries_the_running_total_and_retry_sums(attached: Any) -> None:
    instance, viewer = attached(
        breakpoints=[
            {"kind": "tool", "name": "flaky", "point": "before"},
            {"kind": "tool", "name": "flaky", "point": "error"},
        ]
    )
    manual = Manual()
    previous = set_clock(manual.now)
    try:
        attempts: list[int] = []

        @instance.tool
        def flaky() -> str:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("boom")
            return "second time"

        holds = iter([1000.0, 2000.0, 300.0])
        actions = iter(["continue", "retry", "continue"])

        def resumer() -> None:
            for _ in range(3):
                seen = len(viewer.of_type("exec.paused"))
                viewer.wait_for(lambda _f, seen=seen: len(viewer.of_type("exec.paused")) > seen)
                frame = viewer.of_type("exec.paused")[seen]  # the NEW pause, not the first one
                manual.advance(next(holds))
                viewer.resume(frame["payload"]["pauseId"], next(actions))

        threading.Thread(target=resumer, daemon=True).start()
        with instance.run("agent"):
            assert flaky() == "second time"

        errored = viewer.wait_for_type("node.error")
        assert errored["payload"]["heldMs"] == 1000  # only the before-hold had happened
        finished = _finished_for(viewer, "tool:flaky")["payload"]
        assert finished["heldMs"] == 3300
        assert finished["durationMs"] >= 3300
    finally:
        set_clock(previous)


def test_fail_open_release_still_credits_held_time(attached: Any) -> None:
    """The debugger dies mid-hold: the gate releases (fail open) and the time it
    was held is still on the record the app keeps for the next attach."""
    import json

    instance, view = attached(breakpoints=[{"kind": "tool"}])
    manual = Manual()
    previous = set_clock(manual.now)
    try:

        @instance.tool
        def slow() -> str:
            return "done"

        result: list[str] = []

        def call() -> None:
            with instance.run("agent"):
                result.append(slow())

        caller = threading.Thread(target=call, daemon=True)
        caller.start()
        view.wait_for_type("exec.paused")
        manual.advance(1234.5)
        view.kill_abruptly()  # the debugger vanishes: fail open
        caller.join(timeout=5)
        assert result == ["done"]
        # Nobody is attached, so the frame sits in the replay buffer.
        buffered = [json.loads(frame) for frame in instance.session._buffer.to_list()]
        finished = [
            f
            for f in buffered
            if f["type"] == "node.finished" and f["payload"]["nodeId"] == "tool:slow"
        ]
        assert len(finished) == 1
        assert finished[0]["payload"]["heldMs"] == 1234.5
    finally:
        set_clock(previous)


def test_heldms_omitted_for_an_instance_never_started_and_caller_value_wins(attached: Any) -> None:
    instance, viewer = attached()
    session = instance.session
    session.emit(
        "node.finished",
        {"nodeId": "tool:x", "instanceId": "never", "durationMs": 3.14159, "status": "ok"},
    )
    frame = _finished_for(viewer, "tool:x", "never")["payload"]
    assert "heldMs" not in frame
    assert frame["durationMs"] == 3.14  # normalised on the way out
    session.emit(
        "node.started", {"nodeId": "tool:y", "kind": "tool", "name": "y", "instanceId": "i1"}
    )
    session.emit(
        "node.finished",
        {"nodeId": "tool:y", "instanceId": "i1", "durationMs": -5, "status": "ok", "heldMs": 7},
    )
    frame = _finished_for(viewer, "tool:y", "i1")["payload"]
    assert frame["heldMs"] == 7
    assert frame["durationMs"] == 0.0


@pytest.mark.parametrize("raw", [math.nan, math.inf, -1.0])
def test_bad_durations_never_reach_the_wire(attached: Any, raw: float) -> None:
    instance, viewer = attached()
    instance.session.finish_node("tool:z", "i1", duration_ms=raw)
    frame = _finished_for(viewer, "tool:z", "i1")["payload"]
    assert frame["durationMs"] == 0.0
