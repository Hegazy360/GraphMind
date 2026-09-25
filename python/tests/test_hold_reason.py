"""Every hold carries a reason (0.6.0, contract C4): ``exec.paused.reason`` is
``loop`` (the built-in loop hold), ``breakpoint`` (a matched breakpoint),
``step`` (step mode) or ``error`` (a hold at an error point). 0.5 hubs already
accept all four values. Parity with ``packages/client/test/hold-reason.test.ts``;
``graphmind pauses`` / ``wait`` label a hold by it.
"""

from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any

from graphmind.gate import CONTINUE, GateNode

TOOL = GateNode("tool:search", "tool", "search")
LLM = GateNode("llm:step", "llm", "step")


def _background(fn: Any, *args: Any) -> concurrent.futures.Future[Any]:
    future: concurrent.futures.Future[Any] = concurrent.futures.Future()

    def run() -> None:
        try:
            future.set_result(fn(*args))
        except BaseException as exc:
            future.set_exception(exc)

    threading.Thread(target=run, daemon=True).start()
    return future


def _pause(view: Any, count: int, timeout: float = 8.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frames = view.of_type("exec.paused")
        if len(frames) >= count:
            return frames[count - 1]  # type: ignore[no-any-return]
        time.sleep(0.01)
    raise AssertionError(f"expected {count} exec.paused frames")


def _reason_of(view: Any, session: Any, point: str, node: GateNode, count: int) -> Any:
    """Hold one gate, read its ``exec.paused``, release it; the reason."""
    gate = _background(session.gate, point, node)
    paused = _pause(view, count)
    view.resume(paused["payload"]["pauseId"], "continue")
    assert gate.result(5) == CONTINUE
    return paused["payload"].get("reason")


def test_a_matched_breakpoint_is_breakpoint_before_and_after(
    attached: Any, validate_frame: Any
) -> None:
    instance, view = attached(breakpoints=[{"kind": "tool"}, {"kind": "llm", "point": "after"}])
    assert _reason_of(view, instance.session, "before", TOOL, 1) == "breakpoint"
    assert _reason_of(view, instance.session, "after", LLM, 2) == "breakpoint"
    for frame in view.of_type("exec.paused"):
        validate_frame(frame)


def test_pause_on_error_is_error(attached: Any) -> None:
    instance, view = attached(breakpoints=[{"point": "error"}])
    assert _reason_of(view, instance.session, "error", TOOL, 1) == "error"


def test_step_mode_is_step_at_before_and_error_at_an_error_point(attached: Any) -> None:
    instance, view = attached(mode="step")
    assert _reason_of(view, instance.session, "before", TOOL, 1) == "step"
    assert _reason_of(view, instance.session, "error", LLM, 2) == "error"


def test_step_mode_and_a_matching_breakpoint_is_breakpoint(attached: Any) -> None:
    instance, view = attached(breakpoints=[{"kind": "tool", "name": "search"}], mode="step")
    assert _reason_of(view, instance.session, "before", TOOL, 1) == "breakpoint"
    assert _reason_of(view, instance.session, "before", LLM, 2) == "step"


def test_a_breakpoint_set_live_then_step_mode_set_live(attached: Any) -> None:
    instance, view = attached()
    view.set_breakpoint({"kind": "llm"})
    view.set_mode("step")
    time.sleep(0.05)
    assert _reason_of(view, instance.session, "before", LLM, 1) == "breakpoint"
    assert _reason_of(view, instance.session, "before", TOOL, 2) == "step"


def test_a_loop_hold_is_loop_and_the_reason_comes_before_editable_and_instance_id(
    attached: Any, validate_frame: Any
) -> None:
    instance, view = attached()

    @instance.tool
    def same(n: int) -> int:
        return n

    def agent() -> list[int]:
        with instance.run("r"):
            return [same(1) for _ in range(3)]  # the 3rd identical call holds

    result = _background(agent)
    paused = _pause(view, 1)
    view.resume(paused["payload"]["pauseId"], "continue")
    assert result.result(5) == [1, 1, 1]
    payload = paused["payload"]
    assert payload["reason"] == "loop"
    keys = [k for k in payload if k not in ("editable",)]
    assert keys == ["pauseId", "nodeId", "point", "reason", "loop", "instanceId"]
    validate_frame(paused)
