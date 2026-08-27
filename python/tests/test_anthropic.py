"""Anthropic integration, driven through the real SDK against canned HTTP bytes."""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import httpx
import pytest

from graphmind.errors import GraphMindAbortError

from .helpers.providers import (
    ANTHROPIC_MESSAGE,
    ANTHROPIC_STREAM_EVENTS,
    anthropic_sse,
    make_anthropic,
)

MESSAGES = [{"role": "user", "content": "weather in Lisbon?"}]
MODEL = "claude-test"


def _responder(stream_events: Any = None, failures: int = 0) -> Any:
    body = anthropic_sse(stream_events or ANTHROPIC_STREAM_EVENTS)

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        if len(recorder.requests) <= failures:
            return httpx.Response(500, json={"error": {"message": "provider exploded"}})
        payload = request.content or b""
        if b'"stream":true' in payload.replace(b" ", b""):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)
        return httpx.Response(200, json=ANTHROPIC_MESSAGE)

    return responder


def _resume_next(viewer: Any, action: str, output: Any = None) -> threading.Thread:
    def worker() -> None:
        frame = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


def test_messages_create_emits_a_gated_llm_node_with_usage(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        message = client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "llm:step"
    )
    assert started["payload"]["sdk"] == "anthropic"
    assert started["payload"]["input"]["model"] == MODEL
    assert started["payload"]["parentId"] == "agent:agent"

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny."
    assert finished["payload"]["output"]["finishReason"] == "end_turn"


def test_the_before_gate_holds_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    result: list[Any] = []
    caller = threading.Thread(
        target=lambda: result.append(
            client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
        ),
        daemon=True,
    )
    caller.start()
    paused = viewer.wait_for_type("exec.paused")
    time.sleep(0.3)
    assert len(recorder) == 0

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert len(recorder) == 1
    assert result[0].content[0].text == "Lisbon is sunny."


def test_inject_substitutes_a_message(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", {"content": [{"type": "text", "text": "injected"}]})
    with instance.run("agent"):
        message = client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message == {"content": [{"type": "text", "text": "injected"}]}
    assert len(recorder) == 0


def test_retry_at_the_error_gate_re_issues_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_anthropic(_responder(failures=1))
    instance.instrument_anthropic(client)

    _resume_next(viewer, "retry")
    with instance.run("agent"):
        message = client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."
    assert len(recorder) == 2


def test_abort_raises_before_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "abort")
    with pytest.raises(GraphMindAbortError), instance.run("agent"):
        client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert len(recorder) == 0


def test_create_with_stream_true_is_teed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        stream = client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES, stream=True)
        types = [event.type for event in stream]

    assert types[0] == "message_start" and types[-1] == "message_stop"
    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["streaming"] is True
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


def test_messages_stream_gates_in_enter_and_observes_text_stream(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    collected: list[str] = []

    def call() -> None:
        with (
            instance.run("agent"),
            client.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream,
        ):
            collected.append("".join(stream.text_stream))

    caller = threading.Thread(target=call, daemon=True)
    caller.start()
    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["nodeId"] == "llm:step"
    time.sleep(0.25)
    assert len(recorder) == 0, "messages.stream() must not hit the network while held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert collected == ["Lisbon"]
    assert len(recorder) == 1

    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}

    tokens = viewer.of_type("node.token")
    assert "".join(d["v"] for f in tokens for d in f["payload"]["deltas"]) == "Lisbon"


def test_messages_stream_raw_event_iteration_is_observed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with (
        instance.run("agent"),
        client.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream,
    ):
        types = [event.type for event in stream]

    assert "content_block_delta" in types
    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["output"]["text"] == "Lisbon"


def test_instrumenting_is_idempotent(attached: Any) -> None:
    instance, _viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)
    first = client.messages.create
    instance.instrument_anthropic(client)
    assert client.messages.create is first


# -- async client -------------------------------------------------------------


async def test_async_create(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with instance.run("agent"):
        message = await client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."

    finished = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


async def test_async_gate_does_not_block_the_loop(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with instance.run("agent"):
        task = asyncio.ensure_future(
            client.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
        )
        paused = await viewer.wait_for_type_async("exec.paused")
        await asyncio.sleep(0.2)
        assert len(recorder) == 0
        viewer.resume(paused["payload"]["pauseId"], "continue")
        message = await asyncio.wait_for(task, timeout=5)
    assert message.content[0].text == "Lisbon is sunny."


async def test_async_messages_stream(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with (
        instance.run("agent"),
        client.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream,
    ):
        text = ""
        async for piece in stream.text_stream:
            text += piece
    assert text == "Lisbon"

    finished = await viewer.wait_for_async(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )
    assert finished["payload"]["output"]["text"] == "Lisbon"
    # Usage is recovered from the SDK's message snapshot even though the host
    # only touched `.text_stream` (which bypasses the raw-event tee).
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}
