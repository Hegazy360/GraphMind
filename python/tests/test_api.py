"""Public API ergonomics: decorator forms, wrap_tools shapes, spans, stats."""

from __future__ import annotations

import asyncio
import functools
import inspect
import typing
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


def test_a_partial_is_named_after_the_function_it_wraps(attached: Any) -> None:
    """Binding per-run state with a partial is an ordinary pattern.

    Partials have no ``__name__``; the old fallback was ``repr(fn)``, which put
    a memory address in the node id — unreadable, and different on every run, so
    the viewer drew a new node instead of lighting up the same one.
    """
    instance, viewer = attached()

    def load_region(dataset: str, region: str) -> str:
        """Load one region out of a dataset."""
        return f"{dataset}/{region}"

    bound = instance.tool(functools.partial(load_region, "sales-2026"))

    assert bound.__graphmind_node_id__ == "tool:load_region"
    assert "0x" not in bound.__graphmind_node_id__
    assert bound.__name__ == "load_region"
    assert bound.__doc__ == "Load one region out of a dataset."
    # `wraps` targets the partial, so the reported signature stays the *bound* one.
    assert list(inspect.signature(bound).parameters) == ["region"]

    # Same code location, two constructions: one node, not two.
    twin = instance.tool(functools.partial(load_region, "sales-2026"))
    assert twin.__graphmind_node_id__ == bound.__graphmind_node_id__

    with instance.run("agent"):
        assert bound("EMEA") == "sales-2026/EMEA"

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "tool:load_region"
    )
    assert started["payload"]["name"] == "load_region"
    assert started["payload"]["input"] == {"region": "EMEA"}


def test_a_partial_can_still_be_given_an_explicit_name(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    def load_region(dataset: str, region: str) -> str:
        return f"{dataset}/{region}"

    eu = instance.tool(functools.partial(load_region, "eu"), name="load_eu")
    us = instance.wrap_tools({"load_us": functools.partial(load_region, "us")})["load_us"]

    assert eu.__graphmind_node_id__ == "tool:load_eu"
    assert us.__graphmind_node_id__ == "tool:load_us"
    assert eu("DE") == "eu/DE"


def test_an_async_partial_stays_async_and_keeps_its_name(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    async def fetch(base: str, path: str) -> str:
        return base + path

    bound = instance.tool(functools.partial(fetch, "https://api/"))

    assert asyncio.iscoroutinefunction(bound)
    assert bound.__graphmind_node_id__ == "tool:fetch"
    assert asyncio.run(bound("orders")) == "https://api/orders"


def test_a_wrapped_partial_still_reports_resolvable_type_hints(make_gm: Any) -> None:
    """A named node is no use if the tool then explodes in a schema builder.

    ``functools.wraps`` finds no ``__annotations__`` on a partial, so the wrapper
    kept its own — and ``graphmind.wrap`` uses PEP 563, so those were the strings
    ``"Any"``, resolved against the *host's* module. Anything that reads type
    hints (LangChain's ``StructuredTool.from_function``, pydantic's
    ``validate_arguments``) then died with ``NameError: name 'Any' is not
    defined``.
    """
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    def load_region(dataset: str, region: str) -> str:
        return f"{dataset}/{region}"

    bound = instance.tool(functools.partial(load_region, "sales"))

    assert typing.get_type_hints(bound) == {"region": str, "return": str}
    assert "args" not in bound.__annotations__ and "kwargs" not in bound.__annotations__


def test_a_callable_object_is_named_after_its_class(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    class Retriever:
        """A callable object — also has no ``__name__``."""

        def __call__(self, query: str) -> str:
            return query

    wrapped = instance.tool(Retriever())

    assert wrapped.__graphmind_node_id__ == "tool:Retriever"
    assert wrapped.__name__ == "Retriever"
    assert wrapped("docs") == "docs"


def test_wrapping_a_plain_function_is_exactly_functools_wraps(make_gm: Any) -> None:
    """The partial repair must not disturb the normal path."""
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    def search(query: str, limit: int = 5) -> str:
        """Search the index."""
        return query

    search.custom_attribute = "kept"  # type: ignore[attr-defined]
    wrapped = instance.tool(search)

    assert wrapped.__name__ == "search"
    assert wrapped.__qualname__ == search.__qualname__
    assert wrapped.__module__ == search.__module__
    assert wrapped.__doc__ == "Search the index."
    assert wrapped.__wrapped__ is search
    assert wrapped.custom_attribute == "kept"
    assert inspect.signature(wrapped) == inspect.signature(search)


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
