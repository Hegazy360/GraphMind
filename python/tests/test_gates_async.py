"""The same gate semantics through ``async def`` user code.

A held gate must suspend the awaiting *task* without blocking the caller's
event loop — other tasks keep running, which is what makes an async agent
debuggable rather than deadlocked.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from graphmind.errors import GraphMindAbortError

#: Fire-and-forget helper tasks; a strong reference keeps them off the GC.
_TASKS: set = set()


def spawn(coro: Any) -> Any:
    task = asyncio.ensure_future(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task


async def _resume_next(viewer: Any, action: str, output: Any = None) -> None:
    frame = await viewer.wait_for_type_async("exec.paused")
    viewer.resume(frame["payload"]["pauseId"], action, output)


async def test_a_held_gate_suspends_the_task_but_not_the_loop(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "fetch"}])
    marks: list[str] = []

    @instance.tool
    async def fetch(url: str) -> str:
        marks.append("body-start")
        return f"body of {url}"

    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    beat = asyncio.ensure_future(heartbeat())
    async with instance.run("agent"):
        task = asyncio.ensure_future(fetch("https://example.test"))
        paused = await viewer.wait_for_type_async("exec.paused")
        assert paused["payload"]["nodeId"] == "tool:fetch"

        before = ticks
        await asyncio.sleep(0.3)
        assert marks == [], "the wrapped body must not start while the gate is held"
        assert ticks > before, "the event loop must keep running while a gate is held"

        viewer.resume(paused["payload"]["pauseId"], "continue")
        assert await asyncio.wait_for(task, timeout=5) == "body of https://example.test"
    beat.cancel()
    assert marks == ["body-start"]


async def test_inject_substitutes_an_async_result(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool"}])
    ran: list[int] = []

    @instance.tool
    async def fetch() -> str:
        ran.append(1)
        return "real"

    spawn(_resume_next(viewer, "inject", {"fake": True}))
    async with instance.run("agent"):
        assert await fetch() == {"fake": True}
    assert ran == []


async def test_retry_re_runs_an_async_body(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "point": "error"}])
    attempts: list[int] = []

    @instance.tool
    async def flaky() -> str:
        attempts.append(1)
        if len(attempts) < 2:
            raise RuntimeError("nope")
        return "ok"

    async def resumer() -> None:
        seen = 0
        while seen < 1:
            frames = viewer.of_type("exec.paused")
            if len(frames) > seen:
                viewer.resume(frames[seen]["payload"]["pauseId"], "retry")
                seen += 1
            await asyncio.sleep(0.005)

    spawn(resumer())
    async with instance.run("agent"):
        assert await flaky() == "ok"
    assert len(attempts) == 2


async def test_abort_raises_in_async_code(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool"}])

    @instance.tool
    async def fetch() -> str:
        return "real"

    spawn(_resume_next(viewer, "abort"))
    with pytest.raises(GraphMindAbortError):
        async with instance.run("agent") as ctx:
            await fetch()
    assert ctx.aborted is True


async def test_cancelling_a_held_task_releases_the_gate(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool"}])

    @instance.tool
    async def fetch() -> str:
        return "real"

    async with instance.run("agent"):
        task = asyncio.ensure_future(fetch())
        await viewer.wait_for_type_async("exec.paused")
        assert instance.session._engine.held_count == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert instance.session._engine.held_count == 0


async def test_concurrent_async_calls_gate_independently(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "work"}])

    @instance.tool
    async def work(n: int) -> int:
        return n * 10

    async with instance.run("agent"):
        tasks = [asyncio.ensure_future(work(n)) for n in (1, 2, 3)]

        async def wait_for_three() -> None:
            deadline = time.monotonic() + 5
            while len(viewer.of_type("exec.paused")) < 3:
                if time.monotonic() > deadline:
                    raise AssertionError("expected three independent holds")
                await asyncio.sleep(0.005)

        await wait_for_three()
        assert instance.session._engine.held_count == 3
        for frame in viewer.of_type("exec.paused"):
            viewer.resume(frame["payload"]["pauseId"], "continue")
        assert sorted(await asyncio.gather(*tasks)) == [10, 20, 30]


async def test_async_run_scope_emits_agent_node_and_run_events(attached: Any) -> None:
    instance, viewer = attached()

    async with instance.run("planner", meta={"env": "test"}) as ctx:
        assert ctx.name == "planner"

    started = await viewer.wait_for_type_async("run.started")
    assert started["payload"]["meta"] == {"name": "planner", "env": "test"}
    agent = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.started" and f["payload"]["kind"] == "agent"
    )
    assert agent["payload"]["nodeId"] == "agent:planner"
    assert agent["payload"]["instanceId"] == ctx.run_id
    finished = await viewer.wait_for_type_async("run.finished")
    assert finished["payload"]["status"] == "ok"


async def test_async_span_is_gated_and_timed(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "chain", "name": "plan"}])
    spawn(_resume_next(viewer, "continue"))

    async with instance.run("agent"), instance.span("plan", kind="chain") as span:
        span.set_output({"steps": 2})

    paused = await viewer.wait_for_type_async("exec.paused")
    assert paused["payload"]["nodeId"] == "chain:plan"
    finished = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "chain:plan"
    )
    assert finished["payload"]["output"] == {"steps": 2}
    assert finished["payload"]["status"] == "ok"


async def test_a_sync_gate_from_a_worker_thread_does_not_deadlock_the_loop(
    attached: Any,
) -> None:
    """A *sync* tool called from an async app (executor hand-off) still gates.

    This is the shape LangChain uses for sync callbacks inside async chains,
    and the shape any `asyncio.to_thread` call site has. The gate blocks that
    worker thread only — the event loop keeps turning.
    """
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "blocking"}])
    marks: list[str] = []

    @instance.tool
    def blocking() -> str:
        marks.append("body-start")
        return "done"

    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    beat = spawn(heartbeat())
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(None, blocking)

    paused = await viewer.wait_for_type_async("exec.paused")
    before = ticks
    await asyncio.sleep(0.25)
    assert marks == []
    assert ticks > before, "the event loop must keep turning while a worker thread is held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert await asyncio.wait_for(future, timeout=5) == "done"
    beat.cancel()
    assert marks == ["body-start"]
