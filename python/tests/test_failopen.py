"""Fail-open: a broken debugger must never become the host's problem."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest

import graphmind as gm
from graphmind.env import looks_like_production, resolve_enabled, resolve_url
from graphmind.session import Session

from .conftest import wait_until


def test_a_disconnect_auto_continues_held_gates_within_100ms(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}])
    released_at: list[float] = []

    @instance.tool
    def search() -> str:
        released_at.append(time.monotonic())
        return "ok"

    result: list[Any] = []
    caller = threading.Thread(target=lambda: result.append(search()), daemon=True)
    caller.start()
    viewer.wait_for_type("exec.paused")
    assert instance.session._engine.held_count == 1

    killed_at = time.monotonic()
    viewer.kill_abruptly()

    caller.join(timeout=5)
    assert result == ["ok"], "the gate must fail open when the debugger vanishes"
    elapsed = released_at[0] - killed_at
    assert elapsed < 0.1, f"auto-continue took {elapsed * 1000:.1f}ms, budget is 100ms"
    assert instance.session._engine.held_count == 0


#: Far longer than one gate poll, far shorter than any reconnect (make_gm sets
#: retry_interval=60 s, and there is no pause timeout by default).
_RACE_DEADLINE = 3.0


def _detach_inside_the_gate_window(instance: Any, viewer: Any) -> dict[str, Any]:
    """Open the window between a gate's ``attached`` check and ``engine.hold()``:
    the first positive ``should_pause`` (which runs inside it) drops the viewer
    and waits until the transport thread's detach handler has RUN
    ``release_all()`` — with nothing held yet — before answering True. That is
    the interleaving a socket drop on the transport thread can produce."""
    session = instance.session
    engine = session._engine
    released = threading.Event()
    seen: dict[str, Any] = {"release_all_counts": [], "fired": False}
    original_release_all = engine.release_all
    original_should_pause = engine.should_pause

    def release_all_spy() -> int:
        count = original_release_all()
        seen["release_all_counts"].append(count)
        released.set()
        return count

    def should_pause_then_detach(point: str, node: Any) -> bool:
        answer = original_should_pause(point, node)
        if answer and not seen["fired"]:
            seen["fired"] = True
            viewer.drop_connections()
            assert released.wait(5.0), "the detach handler never ran release_all"
            assert session.attached is False
        return answer

    engine.release_all = release_all_spy  # looked up per call by _handle_detached
    engine.should_pause = should_pause_then_detach
    return seen


async def test_an_async_gate_fails_open_when_the_detach_races_its_hold(attached: Any) -> None:
    """The detach releases nothing (the hold is not registered yet); the hold
    registered next must not wait for a debugger that is gone."""
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "fetch"}])
    seen = _detach_inside_the_gate_window(instance, viewer)
    ran: list[int] = []

    @instance.tool
    async def fetch() -> str:
        ran.append(1)
        return "real"

    async with instance.run("agent"):
        task = asyncio.ensure_future(fetch())
        done, _ = await asyncio.wait({task}, timeout=_RACE_DEADLINE)
        held_after = instance.session._engine.held_count
        if not done:
            task.cancel()  # cleanup only: the CancelledError path discards the hold
            try:
                await task
            except BaseException:
                pass

    assert seen["fired"] is True, "the race window was never exercised"
    assert seen["release_all_counts"] == [0], seen["release_all_counts"]
    assert done, (
        f"FAIL-OPEN broken: the async tool call is still held {_RACE_DEADLINE}s after the "
        f"debugger detached (held_count={held_after}, body ran={bool(ran)})"
    )
    assert task.result() == "real"
    assert held_after == 0


def test_a_sync_gate_fails_open_when_the_detach_races_its_hold(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "fetch"}])
    seen = _detach_inside_the_gate_window(instance, viewer)
    result: dict[str, Any] = {}

    @instance.tool
    def fetch() -> str:
        return "real"

    def call() -> None:
        with instance.run("agent"):
            result["value"] = fetch()

    worker = threading.Thread(target=call, daemon=True)
    worker.start()
    worker.join(timeout=_RACE_DEADLINE)

    assert seen["fired"] is True
    assert seen["release_all_counts"] == [0]
    assert not worker.is_alive(), "the sync gate stayed held after the debugger detached"
    assert result.get("value") == "real"
    assert instance.session._engine.held_count == 0


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
async def test_a_held_gate_continues_once_detached_even_if_nothing_released_it(
    attached: Any, is_async: bool
) -> None:
    """Belt and braces: both gates re-check ``attached`` while they wait, so a
    held gate continues even when the detach callback never reaches it."""
    instance, viewer = attached(breakpoints=[{"kind": "tool"}])
    engine = instance.session._engine
    engine.release_all = lambda: 0  # the detach handler releases nothing

    if is_async:

        @instance.tool
        async def fetch_async() -> str:
            return "real"

        task = asyncio.ensure_future(fetch_async())
        await viewer.wait_for_type_async("exec.paused")
        viewer.drop_connections()
        done, _ = await asyncio.wait({task}, timeout=_RACE_DEADLINE)
        if not done:
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        assert done, "the async gate stayed held after the debugger detached"
        assert task.result() == "real"
    else:

        @instance.tool
        def fetch() -> str:
            return "real"

        result: list[str] = []
        worker = threading.Thread(target=lambda: result.append(fetch()), daemon=True)
        worker.start()
        await viewer.wait_for_type_async("exec.paused")
        viewer.drop_connections()
        await asyncio.to_thread(worker.join, _RACE_DEADLINE)
        assert result == ["real"], "the sync gate stayed held after the debugger detached"
    assert engine.held_count == 0


def test_dispose_releases_held_gates(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool"}])
    done: list[str] = []

    @instance.tool
    def search() -> str:
        return "ok"

    caller = threading.Thread(target=lambda: done.append(search()), daemon=True)
    caller.start()
    viewer.wait_for_type("exec.paused")

    instance.dispose()
    caller.join(timeout=5)
    assert done == ["ok"]


def test_pause_timeout_auto_continues(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool"}], gm_options={"pause_timeout": 0.25})

    @instance.tool
    def search() -> str:
        return "ok"

    started = time.monotonic()
    assert search() == "ok"
    assert 0.2 < time.monotonic() - started < 3.0
    resumed = viewer.wait_for_type("exec.resumed")
    assert resumed["payload"]["action"] == "continue"


def test_no_viewer_means_no_holds_and_no_errors(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    @instance.tool
    def search(q: str) -> str:
        return f"results for {q}"

    with instance.run("agent"):
        assert search("x") == "results for x"
    assert instance.attached is False
    assert instance.stats().buffered > 0


def test_a_tool_that_raises_still_raises_when_detached(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    @instance.tool
    def broken() -> None:
        raise ValueError("host error")

    with pytest.raises(ValueError, match="host error"):
        broken()


def test_a_broken_socket_never_raises_into_the_host(make_gm: Any) -> None:
    instance = make_gm(url="ws://nonexistent.invalid:9/ingest", connect_timeout=0.05)

    @instance.tool
    def work() -> int:
        return 1

    for _ in range(50):
        assert work() == 1
    assert instance.attached is False


def test_keyboard_interrupt_style_exceptions_are_not_gated(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "point": "error"}])

    @instance.tool
    def interrupted() -> None:
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        instance and interrupted()
    # No error gate was opened for a BaseException.
    time.sleep(0.1)
    assert viewer.of_type("exec.paused") == []


def test_disabled_session_is_completely_inert(make_gm: Any, viewer: Any) -> None:
    view = viewer()
    instance = make_gm(url=view.url, enabled=False)

    @instance.tool
    def work() -> int:
        return 1

    with instance.run("agent"):
        assert work() == 1
    assert instance.ready(timeout=0.3) is False
    time.sleep(0.2)
    assert view.frames() == [], "a disabled session must never touch the network"
    assert instance.stats().buffered == 0


def test_graphmind_disabled_env_beats_an_explicit_enable() -> None:
    assert resolve_enabled(True, {"GRAPHMIND_DISABLED": "1"}) is False
    assert resolve_enabled(None, {"GRAPHMIND_DISABLED": "1"}) is False


@pytest.mark.parametrize("value", ["1", "true", "TRUE", " yes ", "on", "2"])
def test_graphmind_disabled_is_a_kill_switch_in_every_spelling(value: str) -> None:
    # Until 0.6 only the exact string "1" disabled.
    assert resolve_enabled(True, {"GRAPHMIND_DISABLED": value}) is False


@pytest.mark.parametrize("value", ["", "  ", "0", "false", "off", "NO"])
def test_graphmind_disabled_off_words_leave_it_enabled(value: str) -> None:
    assert resolve_enabled(None, {"GRAPHMIND_DISABLED": value}) is True


def test_production_disables_unless_opted_in() -> None:
    assert resolve_enabled(None, {"ENVIRONMENT": "production"}) is False
    assert resolve_enabled(None, {"ENVIRONMENT": "prod"}) is False
    assert resolve_enabled(None, {"ENVIRONMENT": "PRODUCTION"}) is False
    assert resolve_enabled(None, {"ENVIRONMENT": "production", "GRAPHMIND": "1"}) is True
    assert resolve_enabled(None, {"ENVIRONMENT": "staging"}) is True
    assert resolve_enabled(None, {}) is True
    # An explicit flag still wins over the environment heuristic.
    assert resolve_enabled(True, {"ENVIRONMENT": "production"}) is True


def test_the_first_set_env_var_decides() -> None:
    # GRAPHMIND_ENV is checked before ENVIRONMENT.
    assert looks_like_production({"GRAPHMIND_ENV": "dev", "ENVIRONMENT": "production"}) is False
    assert looks_like_production({"ENVIRONMENT": "production", "NODE_ENV": "dev"}) is True


def test_url_resolution_order() -> None:
    assert resolve_url(None, {}) == "ws://127.0.0.1:4747/ingest"
    assert resolve_url(None, {"GRAPHMIND_URL": "ws://host:1/x"}) == "ws://host:1/x"
    assert resolve_url("ws://explicit/y", {"GRAPHMIND_URL": "ws://host:1/x"}) == "ws://explicit/y"


def test_session_survives_a_hostile_logger() -> None:
    def explode(message: str) -> None:
        raise RuntimeError("logger is broken too")

    session = Session(url="ws://127.0.0.1:1/ingest", enabled=True, logger=explode, env={})
    try:
        session.emit(
            "node.started", {"nodeId": "n", "kind": "tool", "name": "n", "instanceId": "i"}
        )
        assert session.stats().buffered == 2  # implicit run.started + the node
    finally:
        session.dispose()


def test_module_level_default_instance_round_trip(viewer: Any) -> None:
    view = viewer()
    gm.configure(app="default-test", url=view.url, retry_interval=60.0, env={})
    assert gm.ready(timeout=5.0) is True

    @gm.tool
    def ping() -> str:
        return "pong"

    with gm.run("agent"):
        assert ping() == "pong"
    wait_until(lambda: len(view.of_type("node.finished")) >= 1, label="tool finished")
    hello = view.wait_for_type("hello")
    assert hello["payload"]["app"] == "default-test"
    gm.dispose()
