"""Gate semantics through the public sync API.

Most production Python agent code is synchronous, so these are the load-bearing
tests: a held gate must block the calling thread *before the wrapped body runs*
and release with exactly the semantics the debugger asked for.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest

from graphmind.errors import GraphMindAbortError

from .conftest import wait_until


def resume_when_paused(viewer: Any, action: str, output: Any = None, after: float = 0.0) -> Any:
    """Background resumer: waits for the next exec.paused, then releases it."""
    box: list[Any] = []

    def worker() -> None:
        seen = len(viewer.of_type("exec.paused"))
        frame = viewer.wait_for(
            lambda f: (
                f.get("type") == "exec.paused" and viewer.of_type("exec.paused").index(f) >= seen
            )
        )
        box.append(frame)
        if after:
            time.sleep(after)
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread, box


def test_a_held_gate_blocks_before_the_body_runs(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}])
    marks: list[str] = []

    @instance.tool
    def search(query: str) -> str:
        marks.append("body-start")
        return f"results for {query}"

    result: list[Any] = []

    def call() -> None:
        with instance.run("agent"):
            result.append(search("flights"))

    caller = threading.Thread(target=call, daemon=True)
    caller.start()

    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["nodeId"] == "tool:search"
    assert paused["payload"]["point"] == "before"

    paused_at = time.monotonic()
    time.sleep(0.5)
    # The whole point of the product: the body did NOT start while held.
    assert marks == []

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert result == ["results for flights"]
    assert marks == ["body-start"]
    assert time.monotonic() - paused_at >= 0.5

    resumed = viewer.wait_for_type("exec.resumed")
    assert resumed["payload"]["action"] == "continue"
    assert resumed["payload"]["pauseId"] == paused["payload"]["pauseId"]


def test_inject_substitutes_the_result_without_running_the_body(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}])
    ran: list[int] = []

    @instance.tool
    def search(query: str) -> str:
        ran.append(1)
        return "real"

    resume_when_paused(viewer, "inject", {"substituted": True})
    with instance.run("agent"):
        assert search("x") == {"substituted": True}
    assert ran == []

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "tool:search"
    )
    assert finished["payload"]["injected"] is True
    assert finished["payload"]["status"] == "ok"


def test_retry_at_the_error_gate_re_runs_the_body(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "flaky", "point": "error"}])
    attempts: list[int] = []

    @instance.tool
    def flaky() -> str:
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError(f"attempt {len(attempts)} failed")
        return "third time lucky"

    def resumer() -> None:
        for index in range(2):
            frame = viewer.wait_for(
                lambda f, i=index: (
                    f.get("type") == "exec.paused"
                    and len(
                        [
                            x
                            for x in viewer.of_type("exec.paused")
                            if viewer.of_type("exec.paused").index(x) <= i
                        ]
                    )
                    > i
                    and viewer.of_type("exec.paused").index(f) == i
                )
            )
            viewer.resume(frame["payload"]["pauseId"], "retry")

    threading.Thread(target=resumer, daemon=True).start()

    with instance.run("agent"):
        assert flaky() == "third time lucky"
    assert len(attempts) == 3
    assert len(viewer.of_type("node.error")) == 2


def test_inject_at_the_error_gate_recovers_the_call(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "point": "error"}])

    @instance.tool
    def broken() -> str:
        raise RuntimeError("provider down")

    resume_when_paused(viewer, "inject", "patched result")
    with instance.run("agent"):
        assert broken() == "patched result"

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "tool:broken"
    )
    assert finished["payload"]["recoveredFromError"] is True


def test_continue_at_the_error_gate_re_raises_the_original(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "point": "error"}])

    @instance.tool
    def broken() -> str:
        raise RuntimeError("provider down")

    resume_when_paused(viewer, "continue")
    with pytest.raises(RuntimeError, match="provider down"), instance.run("agent"):
        broken()

    errors = viewer.of_type("node.error")
    assert errors and errors[0]["payload"]["error"]["name"] == "RuntimeError"
    assert "stack" in errors[0]["payload"]["error"]


def test_abort_raises_an_abort_error_and_marks_the_run(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}])
    ran: list[int] = []

    @instance.tool
    def search() -> str:
        ran.append(1)
        return "real"

    resume_when_paused(viewer, "abort")
    with pytest.raises(GraphMindAbortError), instance.run("agent") as ctx:
        search()
    assert ran == []
    assert ctx.aborted is True

    run_finished = viewer.wait_for(lambda f: f.get("type") == "run.finished")
    assert run_finished["payload"]["status"] == "aborted"


def test_step_mode_pauses_at_every_before_point(attached: Any) -> None:
    instance, viewer = attached(mode="step")

    @instance.tool
    def one() -> int:
        return 1

    @instance.tool
    def two() -> int:
        return 2

    def resumer() -> None:
        released = set()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            for frame in viewer.of_type("exec.paused"):
                pause_id = frame["payload"]["pauseId"]
                if pause_id not in released:
                    released.add(pause_id)
                    viewer.resume(pause_id, "continue")
            time.sleep(0.005)

    threading.Thread(target=resumer, daemon=True).start()

    with instance.run("agent"):
        assert one() == 1
        assert two() == 2

    paused_nodes = {f["payload"]["nodeId"] for f in viewer.of_type("exec.paused")}
    assert {"tool:one", "tool:two"} <= paused_nodes
    # Step mode never pauses at `after` (decisions.md #2).
    assert all(f["payload"]["point"] != "after" for f in viewer.of_type("exec.paused"))


def test_after_gate_fires_only_with_an_explicit_breakpoint(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "calc", "point": "after"}])

    @instance.tool
    def calc() -> int:
        return 7

    resume_when_paused(viewer, "inject", 99)
    with instance.run("agent"):
        assert calc() == 99

    points = [f["payload"]["point"] for f in viewer.of_type("exec.paused")]
    assert points == ["after"]


def test_breakpoints_can_be_set_and_cleared_at_runtime(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    def ping() -> str:
        return "pong"

    with instance.run("agent"):
        assert ping() == "pong"
    assert viewer.of_type("exec.paused") == []

    viewer.set_breakpoint({"kind": "tool", "name": "ping"})
    wait_until(
        lambda: any(m.get("name") == "ping" for m in instance.session._engine.snapshot()[0]),
        label="breakpoint armed",
    )
    resume_when_paused(viewer, "continue")
    with instance.run("agent"):
        assert ping() == "pong"
    assert len(viewer.of_type("exec.paused")) == 1

    viewer.clear_breakpoint({"kind": "tool", "name": "ping"})
    wait_until(lambda: not instance.session._engine.snapshot()[0], label="breakpoint cleared")
    with instance.run("agent"):
        assert ping() == "pong"
    assert len(viewer.of_type("exec.paused")) == 1


def test_concurrent_calls_of_one_logical_node_are_told_apart_by_instance_id(
    attached: Any,
) -> None:
    instance, viewer = attached()
    barrier = threading.Barrier(3, timeout=5)

    @instance.tool
    def work(n: int) -> int:
        barrier.wait()
        return n * 10

    results: list[int] = []
    with instance.run("agent"):
        threads = [
            threading.Thread(target=lambda n=n: results.append(work(n)), daemon=True)
            for n in (1, 2)
        ]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=5)

    assert sorted(results) == [10, 20]
    finished = [f for f in viewer.of_type("node.finished") if f["payload"]["nodeId"] == "tool:work"]
    wait_until(
        lambda: (
            len(
                [
                    f
                    for f in viewer.of_type("node.finished")
                    if f["payload"]["nodeId"] == "tool:work"
                ]
            )
            == 2
        ),
        label="two finishes",
    )
    finished = [f for f in viewer.of_type("node.finished") if f["payload"]["nodeId"] == "tool:work"]
    ids = {f["payload"]["instanceId"] for f in finished}
    assert len(ids) == 2, "concurrent executions must carry distinct instanceIds"
    started = [f for f in viewer.of_type("node.started") if f["payload"]["nodeId"] == "tool:work"]
    assert {f["payload"]["instanceId"] for f in started} == ids
