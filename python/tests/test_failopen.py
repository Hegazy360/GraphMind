"""Fail-open: a broken debugger must never become the host's problem."""

from __future__ import annotations

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
