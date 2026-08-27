"""OpenAI integration, driven through the real SDK against canned HTTP bytes."""

from __future__ import annotations

import asyncio
import inspect
import threading
import time
from typing import Any

import pytest

from graphmind.errors import GraphMindAbortError

from .conftest import wait_until
from .helpers.providers import (
    CHAT_COMPLETION,
    CHAT_STREAM_CHUNKS,
    CHAT_TOOL_CALL,
    failing_then,
    json_responder,
    make_openai,
    sse,
    stream_responder,
)

MESSAGES = [{"role": "user", "content": "weather in Lisbon?"}]


def _resume_next(viewer: Any, action: str, output: Any = None) -> threading.Thread:
    def worker() -> None:
        frame = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


def test_instrumenting_is_idempotent_and_keeps_the_call_working(attached: Any) -> None:
    instance, _viewer = attached()
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))

    instance.instrument_openai(client)
    first = client.chat.completions.create
    instance.instrument_openai(client)
    assert client.chat.completions.create is first

    with instance.run("agent"):
        response = client.chat.completions.create(model="gpt-test", messages=MESSAGES)
    assert response.choices[0].message.content == "Lisbon is sunny."
    assert len(recorder) == 1


def test_a_non_streaming_call_emits_a_gated_llm_node_with_usage(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    with instance.run("agent"):
        client.chat.completions.create(model="gpt-test", messages=MESSAGES, temperature=0.2)

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "llm:step"
    )
    assert started["payload"]["kind"] == "llm"
    assert started["payload"]["parentId"] == "agent:agent"
    assert started["payload"]["input"]["model"] == "gpt-test"
    assert started["payload"]["input"]["messages"] == MESSAGES
    assert started["payload"]["sdk"] == "openai"

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["usage"] == {"inputTokens": 11, "outputTokens": 7}
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny."
    assert finished["payload"]["output"]["finishReason"] == "stop"
    assert finished["payload"]["instanceId"] == started["payload"]["instanceId"]


def test_tools_are_pre_announced_as_a_graph_hint(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(json_responder(CHAT_TOOL_CALL))
    instance.instrument_openai(client)

    tools = [
        {
            "type": "function",
            "function": {"name": "search_flights", "parameters": {"type": "object"}},
        }
    ]
    with instance.run("agent"):
        client.chat.completions.create(model="gpt-test", messages=MESSAGES, tools=tools)

    hint = viewer.wait_for_type("graph.hint")
    node_ids = {n["nodeId"] for n in hint["payload"]["nodes"]}
    assert node_ids == {"agent:agent", "llm:step", "tool:search_flights"}

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["output"]["toolCalls"][0]["name"] == "search_flights"


def test_the_before_gate_holds_until_the_debugger_resumes(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    result: list[Any] = []

    def call() -> None:
        with instance.run("agent"):
            result.append(client.chat.completions.create(model="gpt-test", messages=MESSAGES))

    caller = threading.Thread(target=call, daemon=True)
    caller.start()
    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["nodeId"] == "llm:step"

    time.sleep(0.3)
    assert len(recorder) == 0, "no HTTP request may be in flight while a gate is held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert len(recorder) == 1
    assert result[0].choices[0].message.content == "Lisbon is sunny."


def test_inject_replaces_the_response_without_calling_the_provider(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"choices": [{"message": {"content": "injected"}}]})
    with instance.run("agent"):
        response = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert response == {"choices": [{"message": {"content": "injected"}}]}
    assert len(recorder) == 0


def test_retry_at_the_error_gate_re_issues_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_openai(failing_then(CHAT_COMPLETION, failures=1))
    instance.instrument_openai(client)

    _resume_next(viewer, "retry")
    with instance.run("agent"):
        response = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert response.choices[0].message.content == "Lisbon is sunny."
    assert len(recorder) == 2, "retry must actually re-issue the provider call"
    assert len(viewer.of_type("node.error")) == 1


def test_abort_before_the_call_raises_and_marks_the_run(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "abort")
    with pytest.raises(GraphMindAbortError), instance.run("agent"):
        client.chat.completions.create(model="gpt-test", messages=MESSAGES)
    assert len(recorder) == 0


def test_streaming_is_teed_without_disturbing_the_consumer(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(stream_responder(sse(CHAT_STREAM_CHUNKS)))
    instance.instrument_openai(client)

    with instance.run("agent"):
        stream = client.chat.completions.create(
            model="gpt-test",
            messages=MESSAGES,
            stream=True,
            stream_options={"include_usage": True},
        )
        text = "".join(
            chunk.choices[0].delta.content or ""
            for chunk in stream
            if chunk.choices and chunk.choices[0].delta
        )
    assert text == "Lisbon"

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["streaming"] is True
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["output"]["finishReason"] == "stop"
    assert finished["payload"]["usage"] == {"inputTokens": 7, "outputTokens": 3}

    tokens = viewer.of_type("node.token")
    assert tokens
    streamed = "".join(d["v"] for f in tokens for d in f["payload"]["deltas"])
    assert streamed == "Lisbon"


def test_a_provider_error_propagates_untouched_on_continue(attached: Any) -> None:
    from openai import APIStatusError

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, _ = make_openai(failing_then(CHAT_COMPLETION, failures=99))
    instance.instrument_openai(client)

    _resume_next(viewer, "continue")
    with pytest.raises(APIStatusError), instance.run("agent"):
        client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    errors = viewer.of_type("node.error")
    assert errors and "provider exploded" in str(errors[0]["payload"]["error"])
    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["status"] == "error"
    )
    assert finished["payload"]["nodeId"] == "llm:step"


def test_disabled_graphmind_leaves_the_client_untouched(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", enabled=False)
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    # Bound methods are re-created on each access, so identity is not the test:
    # the marker is. Nothing was wrapped, and the call still works.
    assert not getattr(client.chat.completions.create, "__graphmind_wrapped__", False)
    assert not getattr(client.responses.create, "__graphmind_wrapped__", False)
    assert (
        client.chat.completions.create(model="gpt-test", messages=MESSAGES)
        .choices[0]
        .message.content
        == "Lisbon is sunny."
    )
    assert len(recorder) == 1


# -- async client -------------------------------------------------------------


async def test_async_client_non_streaming(attached: Any) -> None:
    instance, viewer = attached()
    client, _recorder = make_openai(json_responder(CHAT_COMPLETION), is_async=True)
    instance.instrument_openai(client)

    async with instance.run("agent"):
        response = await client.chat.completions.create(model="gpt-test", messages=MESSAGES)
    assert response.choices[0].message.content == "Lisbon is sunny."

    finished = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["usage"] == {"inputTokens": 11, "outputTokens": 7}


async def test_async_client_gate_holds_before_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION), is_async=True)
    instance.instrument_openai(client)

    async with instance.run("agent"):
        task = asyncio.ensure_future(
            client.chat.completions.create(model="gpt-test", messages=MESSAGES)
        )
        paused = await viewer.wait_for_type_async("exec.paused")
        await asyncio.sleep(0.2)
        assert len(recorder) == 0
        viewer.resume(paused["payload"]["pauseId"], "continue")
        response = await asyncio.wait_for(task, timeout=5)
    assert response.choices[0].message.content == "Lisbon is sunny."
    assert len(recorder) == 1


async def test_async_streaming_is_teed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(stream_responder(sse(CHAT_STREAM_CHUNKS)), is_async=True)
    instance.instrument_openai(client)

    async with instance.run("agent"):
        stream = await client.chat.completions.create(
            model="gpt-test",
            messages=MESSAGES,
            stream=True,
            stream_options={"include_usage": True},
        )
        text = ""
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta:
                text += chunk.choices[0].delta.content or ""
    assert text == "Lisbon"

    finished = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 7, "outputTokens": 3}


async def test_the_async_tee_adds_no_async_generator_to_your_loop(attached: Any) -> None:
    """GraphMind must put nothing on the loop's async-generator shutdown list.

    ``openai>=3`` ships ``httpcore2``, whose connection-pool async generator makes
    ``loop.shutdown_asyncgens()`` print a ``GeneratorExit`` / "generator didn't
    stop after athrow()" traceback at loop close. That is upstream — it
    reproduces on a bare ``AsyncOpenAI`` stream with GraphMind absent — and is
    documented in the README. The tee is a plain class-based proxy exactly so we
    never add a second one to be finalized; rewriting it as an ``async def`` +
    ``yield`` generator would break that, so pin it.
    """
    instance, _viewer = attached()
    client, _ = make_openai(stream_responder(sse(CHAT_STREAM_CHUNKS)), is_async=True)
    instance.instrument_openai(client)

    async with instance.run("agent"):
        stream = await client.chat.completions.create(
            model="gpt-test", messages=MESSAGES, stream=True
        )
        assert not inspect.isasyncgen(stream)
        assert not inspect.isasyncgenfunction(type(stream).__aiter__)
        assert not inspect.isasyncgenfunction(type(stream).__anext__)
        async for _chunk in stream:
            pass


async def test_the_async_tee_closes_the_provider_stream_once() -> None:
    """`close()` reaches the provider stream, and the node is finished exactly once."""
    from graphmind.integrations._common import AsyncStreamTee

    class Inner:
        def __init__(self) -> None:
            self.closed = False
            self._chunks = iter(["a", "b"])

        def __aiter__(self) -> Any:
            return self

        async def __anext__(self) -> str:
            try:
                return next(self._chunks)
            except StopIteration:
                raise StopAsyncIteration from None

        async def close(self) -> None:
            self.closed = True

    inner = Inner()
    ended: list[BaseException | None] = []
    tee = AsyncStreamTee(inner, lambda _chunk: None, ended.append)

    assert [chunk async for chunk in tee] == ["a", "b"]
    await tee.close()

    assert inner.closed is True
    assert ended == [None]


def test_a_full_agent_loop_produces_a_coherent_graph(attached: Any) -> None:
    """The scenario the viewer actually renders: agent -> llm -> tool -> llm."""
    instance, viewer = attached()
    responses = [CHAT_TOOL_CALL, CHAT_COMPLETION]
    calls: list[int] = []

    import httpx

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        payload = responses[min(len(calls), len(responses) - 1)]
        calls.append(1)
        return httpx.Response(200, json=payload)

    client, _ = make_openai(responder)
    instance.instrument_openai(client)

    @instance.tool
    def search_flights(origin: str) -> dict:
        return {"flight": "TP1234", "from": origin}

    tools = [{"type": "function", "function": {"name": "search_flights"}}]
    with instance.run("book-trip"):
        first = client.chat.completions.create(model="gpt-test", messages=MESSAGES, tools=tools)
        call = first.choices[0].message.tool_calls[0]
        result = search_flights(origin="VIE")
        client.chat.completions.create(
            model="gpt-test",
            messages=[*MESSAGES, {"role": "tool", "tool_call_id": call.id, "content": str(result)}],
            tools=tools,
        )

    wait_until(lambda: len(viewer.of_type("run.finished")) == 1, label="run finished")
    started = viewer.of_type("node.started")
    kinds = [f["payload"]["kind"] for f in started]
    assert kinds.count("agent") == 1
    assert kinds.count("llm") == 2
    assert kinds.count("tool") == 1

    tool_node = next(f for f in started if f["payload"]["kind"] == "tool")
    assert tool_node["payload"]["nodeId"] == "tool:search_flights"
    assert tool_node["payload"]["input"] == {"origin": "VIE"}

    llm_instances = {f["payload"]["instanceId"] for f in started if f["payload"]["kind"] == "llm"}
    assert len(llm_instances) == 2, "each model step needs its own instanceId"
    assert all(
        f["payload"]["parentId"] == "agent:book-trip"
        for f in started
        if f["payload"]["kind"] == "llm"
    )
