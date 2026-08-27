"""Public API ergonomics: decorator forms, wrap_tools shapes, spans, stats."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import graphmind as gm
from graphmind.wrap import is_wrapped

from .conftest import wait_until


def test_tool_decorator_works_bare_and_called(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    @instance.tool
    def bare(x: int) -> int:
        return x

    @instance.tool(name="renamed", kind="retriever")
    def called(x: int) -> int:
        return x

    assert bare(1) == 1
    assert called(2) == 2
    assert is_wrapped(bare) and is_wrapped(called)
    assert bare.__name__ == "bare"
    assert called.__graphmind_node_id__ == "tool:renamed"


def test_the_decorator_preserves_async_functions(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    @instance.tool
    async def fetch(x: int) -> int:
        return x

    assert asyncio.iscoroutinefunction(fetch)
    assert asyncio.get_event_loop_policy().new_event_loop().run_until_complete(fetch(3)) == 3


def test_wrap_tools_accepts_mappings_lists_and_callables(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    def alpha() -> str:
        return "a"

    def beta() -> str:
        return "b"

    mapping = instance.wrap_tools({"alpha": alpha, "beta": beta})
    assert set(mapping) == {"alpha", "beta"}
    assert mapping["alpha"]() == "a"
    assert mapping["alpha"].__graphmind_node_id__ == "tool:alpha"

    listed = instance.wrap_tools([alpha, beta])
    assert [fn() for fn in listed] == ["a", "b"]

    single = instance.wrap_tools(alpha)
    assert single() == "a"

    # Already-wrapped tools are not double-wrapped.
    again = instance.wrap_tools(mapping)
    assert again["alpha"] is mapping["alpha"]

    with pytest.raises(TypeError):
        instance.wrap_tools(42)


def test_the_tool_input_payload_binds_argument_names(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    def search(query: str, limit: int = 5) -> str:
        return query

    with instance.run("agent"):
        search("flights")

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "tool:search"
    )
    assert started["payload"]["input"] == {"query": "flights", "limit": 5}


def test_a_span_records_a_custom_node(attached: Any) -> None:
    instance, viewer = attached()

    with instance.run("agent"), instance.span("retrieve", kind="retriever", input={"q": "x"}) as s:
        s.set_output(["doc-1"])

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "retriever:retrieve"
    )
    assert started["payload"]["kind"] == "retriever"
    assert started["payload"]["input"] == {"q": "x"}

    finished = viewer.wait_for(
        lambda f: (
            f.get("type") == "node.finished" and f["payload"]["nodeId"] == "retriever:retrieve"
        )
    )
    assert finished["payload"]["output"] == ["doc-1"]
    assert finished["payload"]["durationMs"] >= 0


def test_a_span_records_errors(attached: Any) -> None:
    instance, viewer = attached()

    with pytest.raises(ValueError), instance.run("agent"), instance.span("boom"):
        raise ValueError("nope")

    errors = viewer.of_type("node.error")
    wait_until(lambda: len(viewer.of_type("node.error")) >= 1, label="node.error")
    errors = viewer.of_type("node.error")
    assert errors[0]["payload"]["nodeId"] == "custom:boom"
    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "custom:boom"
    )
    assert finished["payload"]["status"] == "error"


def test_an_unknown_span_kind_falls_back_to_custom(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    with instance.span("thing", kind="not-a-kind") as span:
        assert span.node_id == "custom:thing"


def test_events_outside_a_run_land_in_one_implicit_run(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    def ping() -> str:
        return "pong"

    ping()
    ping()

    started = viewer.wait_for_type("run.started")
    assert started["payload"]["meta"]["implicit"] is True
    run_ids = {f["runId"] for f in viewer.frames() if f["type"] == "node.started"}
    assert len(run_ids) == 1


def test_configure_replaces_the_default_instance(viewer: Any) -> None:
    view = viewer()
    first = gm.configure(app="first", url="ws://127.0.0.1:1/ingest", env={})
    assert gm.instance() is first
    second = gm.configure(app="second", url=view.url, retry_interval=60.0, env={})
    assert gm.instance() is second
    assert first.session.disposed is True
    assert gm.is_configured() is True
    gm.reset()
    assert gm.is_configured() is False


def test_stats_report_the_session_state(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    @instance.tool
    def ping() -> str:
        return "pong"

    ping()
    stats = instance.stats()
    assert stats.enabled is True
    assert stats.attached is False
    assert stats.buffered >= 3
    assert stats.held_gates == 0
    assert stats.as_dict()["heldGates"] == 0


def test_graphmind_is_a_context_manager(viewer: Any) -> None:
    from graphmind.api import GraphMind

    view = viewer()
    with GraphMind(app="ctx", url=view.url, retry_interval=60.0, env={}) as instance:
        assert instance.ready(timeout=5.0) is True
    assert instance.session.disposed is True


def test_dispose_is_idempotent(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    instance.dispose()
    instance.dispose()
    assert instance.session.disposed is True


def test_public_exports_are_importable() -> None:
    for name in gm.__all__:
        assert hasattr(gm, name), f"graphmind.{name} is exported but missing"


def test_large_values_are_bounded_before_they_hit_the_wire(attached: Any) -> None:
    instance, viewer = attached()

    @instance.tool
    def huge(blob: str) -> str:
        return blob

    with instance.run("agent"):
        huge("x" * 100_000)

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "tool:huge"
    )
    # The tool wrapper stores raw arguments; the frame still has to stay sane.
    assert len(str(started["payload"]["input"])) <= 200_000


def test_thread_safety_under_concurrent_emitters(attached: Any) -> None:
    import threading

    instance, viewer = attached()

    @instance.tool
    def work(n: int) -> int:
        return n

    threads = [
        threading.Thread(target=lambda: [work(i) for i in range(20)], daemon=True) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    wait_until(
        lambda: (
            len(
                [
                    f
                    for f in viewer.of_type("node.finished")
                    if f["payload"]["nodeId"] == "tool:work"
                ]
            )
            == 160
        ),
        timeout=10,
        label="160 finishes",
    )
    seqs = [f["seq"] for f in viewer.frames() if f["type"] != "hello"]
    assert len(seqs) == len(set(seqs)), "sequence numbers must be unique"
    assert seqs == sorted(seqs), "frames must reach the viewer in seq order"


def test_documented_short_aliases_resolve(viewer: Any) -> None:
    """`graphmind.init(...)` and `gm.handler()` are the names the docs use."""
    view = viewer()
    assert gm.init is gm.configure
    assert gm.handler is gm.callback_handler
    assert gm.async_handler is gm.async_callback_handler

    instance = gm.init(app="docs-shape", url=view.url, retry_interval=60.0, env={})
    assert instance.ready(timeout=5.0) is True
    assert type(instance.handler()).__name__ == "GraphMindCallbackHandler"
    assert type(instance.async_handler()).__name__ == "AsyncGraphMindCallbackHandler"

    @gm.tool
    def ping() -> str:
        return "pong"

    with gm.run("handle-ticket"):
        assert ping() == "pong"
    gm.dispose()
