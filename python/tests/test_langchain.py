"""LangChain / LangGraph callback handlers, driven through real runnables.

These tests also *verify the capability claims* the README makes: that a gate
in a callback genuinely holds the chain (sync and async), and that inject/retry
genuinely cannot substitute a result there.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
import time
from typing import Any

import pytest

pytest.importorskip("langchain_core")

from langchain_core.documents import Document
from langchain_core.language_models.fake_chat_models import (
    GenericFakeChatModel,
)
from langchain_core.messages import AIMessage
from langchain_core.retrievers import BaseRetriever
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool as lc_tool

from graphmind.errors import GraphMindAbortError

from .conftest import wait_until


def fake_model(text: str = "hello there") -> GenericFakeChatModel:
    return GenericFakeChatModel(messages=itertools.cycle([AIMessage(content=text)]))


class StaticRetriever(BaseRetriever):
    def _get_relevant_documents(self, query: str, **kwargs: Any) -> list[Document]:
        return [Document(page_content=f"doc about {query}", metadata={"score": 1})]


def _resume_next(viewer: Any, action: str, output: Any = None) -> threading.Thread:
    def worker() -> None:
        frame = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


def test_a_chain_becomes_a_graph_with_correct_parentage(attached: Any) -> None:
    instance, viewer = attached()
    handler = instance.callback_handler()

    inner = RunnableLambda(lambda x: {"doubled": x["n"] * 2}, name="double")
    outer = RunnableLambda(lambda x: inner.invoke(x), name="outer")

    with instance.run("pipeline"):
        assert outer.invoke({"n": 21}, config={"callbacks": [handler]}) == {"doubled": 42}

    wait_until(lambda: len([f for f in viewer.of_type("node.finished")]) >= 2, label="two nodes")
    started = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.started")}
    assert "chain:outer" in started
    assert "chain:double" in started
    assert started["chain:outer"]["kind"] == "chain"
    assert started["chain:outer"]["parentId"] == "agent:pipeline"
    assert started["chain:double"]["parentId"] == "chain:outer"
    assert started["chain:double"]["framework"] == "langchain"

    finished = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.finished")}
    assert finished["chain:double"]["output"] == {"doubled": 42}
    assert finished["chain:double"]["instanceId"] == started["chain:double"]["instanceId"]


def test_a_sync_breakpoint_actually_holds_the_chain(attached: Any) -> None:
    """The capability claim: blocking in a sync callback holds LangChain."""
    instance, viewer = attached(breakpoints=[{"kind": "chain", "name": "work"}])
    handler = instance.callback_handler()
    marks: list[str] = []

    def body(x: Any) -> str:
        marks.append("body-start")
        return "done"

    chain = RunnableLambda(body, name="work")
    result: list[Any] = []
    caller = threading.Thread(
        target=lambda: result.append(chain.invoke(1, config={"callbacks": [handler]})),
        daemon=True,
    )
    caller.start()

    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["nodeId"] == "chain:work"
    time.sleep(0.4)
    assert marks == [], "the chain body must not run while the gate is held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert result == ["done"]
    assert marks == ["body-start"]


def test_abort_terminates_the_chain(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "chain"}])
    handler = instance.callback_handler()
    marks: list[str] = []

    chain = RunnableLambda(lambda x: marks.append("ran"), name="work")
    _resume_next(viewer, "abort")
    with pytest.raises(GraphMindAbortError):
        chain.invoke(1, config={"callbacks": [handler]})
    assert marks == []


def test_inject_degrades_to_continue_with_a_warning(attached: Any) -> None:
    """Honest limitation: a callback cannot substitute a chain's result."""
    instance, viewer = attached(breakpoints=[{"kind": "chain"}])
    handler = instance.callback_handler()

    _resume_next(viewer, "inject", "not-used")
    chain = RunnableLambda(lambda x: "real", name="work")
    assert chain.invoke(1, config={"callbacks": [handler]}) == "real"

    resumed = viewer.wait_for_type("exec.resumed")
    assert resumed["payload"]["action"] == "inject"


def test_llm_nodes_capture_tokens_and_usage(attached: Any) -> None:
    instance, viewer = attached()
    handler = instance.callback_handler()
    model = fake_model("Lisbon is sunny")

    with instance.run("agent"):
        chunks = list(model.stream("weather?", config={"callbacks": [handler]}))
    text = "".join(chunk.content for chunk in chunks)
    assert text == "Lisbon is sunny"
    instance.session.flush()

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["kind"] == "llm"
    )
    assert started["payload"]["nodeId"].startswith("llm:")
    assert started["payload"]["parentId"] == "agent:agent"

    wait_until(lambda: len(viewer.of_type("node.token")) >= 1, label="tokens")
    streamed = "".join(d["v"] for f in viewer.of_type("node.token") for d in f["payload"]["deltas"])
    assert streamed.replace(" ", "") == text.replace(" ", "")

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"].startswith("llm:")
    )
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny"


def test_tools_and_retrievers_map_to_their_node_kinds(attached: Any) -> None:
    instance, viewer = attached()
    handler = instance.callback_handler()

    @lc_tool
    def lookup(city: str) -> str:
        """Look a city up."""
        return f"{city}: sunny"

    with instance.run("agent"):
        assert lookup.invoke({"city": "Lisbon"}, config={"callbacks": [handler]}) == (
            "Lisbon: sunny"
        )
        docs = StaticRetriever().invoke("flights", config={"callbacks": [handler]})
    assert docs[0].page_content == "doc about flights"

    wait_until(lambda: len(viewer.of_type("node.finished")) >= 3, label="tool + retriever + agent")
    started = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.started")}
    assert started["tool:lookup"]["kind"] == "tool"
    assert started["tool:lookup"]["input"] == {"city": "Lisbon"}
    retriever_node = next(k for k in started if k.startswith("retriever:"))
    assert started[retriever_node]["kind"] == "retriever"
    assert started[retriever_node]["input"] == {"query": "flights"}

    finished = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.finished")}
    assert finished["tool:lookup"]["output"] == "Lisbon: sunny"
    assert finished[retriever_node]["output"][0]["pageContent"] == "doc about flights"


def test_a_chain_error_is_recorded_and_gated(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "chain", "point": "error"}])
    handler = instance.callback_handler()

    def explode(x: Any) -> None:
        raise ValueError("chain broke")

    chain = RunnableLambda(explode, name="boom")
    _resume_next(viewer, "continue")
    with pytest.raises(ValueError, match="chain broke"):
        chain.invoke(1, config={"callbacks": [handler]})

    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["point"] == "error"
    errors = viewer.of_type("node.error")
    assert errors and errors[0]["payload"]["error"]["name"] == "ValueError"
    assert errors[0]["payload"]["nodeId"] == "chain:boom"


def test_a_broken_session_never_breaks_the_chain(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    handler = instance.callback_handler()
    chain = RunnableLambda(lambda x: x + 1, name="inc")
    assert chain.invoke(1, config={"callbacks": [handler]}) == 2


def test_the_handler_raises_a_helpful_error_without_langchain(monkeypatch: Any) -> None:
    from graphmind.integrations import langchain as integration

    monkeypatch.setattr(integration, "LANGCHAIN_AVAILABLE", False)
    with pytest.raises(ImportError, match="langchain-core"):
        integration.GraphMindCallbackHandler()


# -- async ---------------------------------------------------------------------


async def test_the_async_handler_holds_an_async_chain(attached: Any) -> None:
    """The capability claim: awaiting in an async callback holds LangChain."""
    instance, viewer = attached(breakpoints=[{"kind": "chain", "name": "work"}])
    handler = instance.async_callback_handler()
    marks: list[str] = []

    async def body(x: Any) -> str:
        marks.append("body-start")
        return "done"

    chain = RunnableLambda(body, name="work")
    task = asyncio.ensure_future(chain.ainvoke(1, config={"callbacks": [handler]}))

    paused = await viewer.wait_for_type_async("exec.paused")
    assert paused["payload"]["nodeId"] == "chain:work"
    await asyncio.sleep(0.3)
    assert marks == [], "the async chain body must not run while the gate is held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    assert await asyncio.wait_for(task, timeout=5) == "done"
    assert marks == ["body-start"]


async def test_the_async_handler_records_a_graph(attached: Any) -> None:
    instance, viewer = attached()
    handler = instance.async_callback_handler()

    async def double(x: int) -> int:
        return x * 2

    async def add_one(x: int) -> int:
        return x + 1

    chain = RunnableLambda(double, name="double") | RunnableLambda(add_one, name="add_one")

    async with instance.run("pipeline"):
        assert await chain.ainvoke(21, config={"callbacks": [handler]}) == 43

    await viewer.wait_for_type_async("run.finished")
    started = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.started")}
    assert started["chain:RunnableSequence"]["parentId"] == "agent:pipeline"
    assert started["chain:double"]["parentId"] == "chain:RunnableSequence"
    assert started["chain:add_one"]["parentId"] == "chain:RunnableSequence"

    finished = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.finished")}
    assert finished["chain:double"]["output"] == 42
    assert finished["chain:add_one"]["output"] == 43


async def test_a_nested_ainvoke_follows_langchain_context_propagation(attached: Any) -> None:
    """Whether a manual nested ``.ainvoke`` is traced is LangChain's call, not ours.

    Older runtimes did not propagate the run config into an ``.ainvoke`` made
    inside an async lambda body, so the child produced no callbacks; current
    langchain-core on Python 3.11+ propagates it through contextvars and the
    child *is* traced. Both are correct; what must hold either way is that the
    outer chain is traced and any child hangs off it rather than floating.
    """
    instance, viewer = attached()
    handler = instance.async_callback_handler()

    inner = RunnableLambda(lambda x: x * 2, name="inner")

    async def outer_body(x: Any) -> Any:
        return await inner.ainvoke(x)

    outer = RunnableLambda(outer_body, name="outer")

    async with instance.run("pipeline"):
        assert await outer.ainvoke(21, config={"callbacks": [handler]}) == 42

    await viewer.wait_for_type_async("run.finished")
    started = {f["payload"]["nodeId"]: f["payload"] for f in viewer.of_type("node.started")}
    assert "chain:outer" in started

    if "chain:inner" in started:
        # Propagated: the child must be parented to the outer chain, not orphaned.
        assert started["chain:inner"].get("parentId") == "chain:outer"


async def test_async_abort_terminates_the_chain(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "chain"}])
    handler = instance.async_callback_handler()
    marks: list[str] = []

    async def body(x: Any) -> str:
        marks.append("ran")
        return "done"

    chain = RunnableLambda(body, name="work")
    task = asyncio.ensure_future(chain.ainvoke(1, config={"callbacks": [handler]}))
    paused = await viewer.wait_for_type_async("exec.paused")
    viewer.resume(paused["payload"]["pauseId"], "abort")
    with pytest.raises(GraphMindAbortError):
        await asyncio.wait_for(task, timeout=5)
    assert marks == []
