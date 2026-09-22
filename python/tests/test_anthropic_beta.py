"""Anthropic ``client.beta.messages``, through the real SDK against canned bytes.

Pydantic AI's Anthropic model calls ``client.beta.messages.create`` (with and
without ``stream=True``), and the SDK's own tool runner calls
``beta.messages.parse`` / ``beta.messages.stream``. They get the same treatment
as ``client.messages``. Also here: ``.with_raw_response`` /
``.with_streaming_response`` on Anthropic, which reach the same patched method.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest

from graphmind.errors import GraphMindAbortError

from .helpers.providers import ANTHROPIC_HTTPX as httpx
from .helpers.providers import (
    ANTHROPIC_MESSAGE,
    ANTHROPIC_STREAM_EVENTS,
    anthropic_sse,
    make_anthropic,
)

MESSAGES = [{"role": "user", "content": "weather in Lisbon?"}]
MODEL = "claude-test"
EVENT_TYPES = [e["type"] for e in ANTHROPIC_STREAM_EVENTS]


def _responder(events: Any = None, failures: int = 0) -> Any:
    body = anthropic_sse(ANTHROPIC_STREAM_EVENTS if events is None else events)

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        if len(recorder.requests) <= failures:
            return httpx.Response(500, json={"error": {"message": "provider exploded"}})
        if b'"stream":true' in (request.content or b"").replace(b" ", b""):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)
        return httpx.Response(200, json=ANTHROPIC_MESSAGE)

    return responder


def _llm(viewer: Any, type_: str) -> list[dict[str, Any]]:
    return [f for f in viewer.of_type(type_) if f["payload"].get("nodeId") == "llm:step"]


def _finished(viewer: Any, count: int = 1) -> list[dict[str, Any]]:
    viewer.wait_for(lambda _f: len(_llm(viewer, "node.finished")) >= count)
    return _llm(viewer, "node.finished")


async def _finished_async(viewer: Any, count: int = 1) -> list[dict[str, Any]]:
    await viewer.wait_for_async(lambda _f: len(_llm(viewer, "node.finished")) >= count)
    return _llm(viewer, "node.finished")


def _resume_next(viewer: Any, action: str, output: Any = None) -> threading.Thread:
    def worker() -> None:
        frame = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


# -- beta.messages.create -------------------------------------------------------------


def test_beta_create_emits_a_gated_llm_node_with_usage(attached: Any) -> None:
    instance, viewer = attached()
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        message = client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."
    assert "beta=true" in str(recorder.requests[0].url)

    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "llm:step"
    )
    assert started["payload"]["sdk"] == "anthropic"
    assert started["payload"]["input"]["model"] == MODEL
    (finished,) = _finished(viewer)
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny."
    assert finished["payload"]["output"]["finishReason"] == "end_turn"


def test_beta_create_holds_before_the_request_and_honours_abort(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    def worker() -> None:
        paused = viewer.wait_for_type("exec.paused")
        time.sleep(0.2)
        assert len(recorder) == 0
        viewer.resume(paused["payload"]["pauseId"], "abort")

    threading.Thread(target=worker, daemon=True).start()
    with pytest.raises(GraphMindAbortError), instance.run("agent"):
        client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert len(recorder) == 0


def test_beta_retry_at_the_error_gate_re_issues_the_request(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_anthropic(_responder(failures=1))
    instance.instrument_anthropic(client)

    _resume_next(viewer, "retry")
    with instance.run("agent"):
        message = client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."
    assert len(recorder) == 2
    assert len(_llm(viewer, "node.error")) == 1


def test_beta_after_gate_holds_and_inject_keeps_the_real_type(attached: Any) -> None:
    from anthropic.types.beta import BetaMessage

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "after"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "edited")
    with instance.run("agent"):
        message = client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert type(message) is BetaMessage
    assert message.content[0].text == "edited"
    assert len(recorder) == 1


def test_beta_create_with_stream_true_is_teed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        stream = client.beta.messages.create(
            model=MODEL, max_tokens=64, messages=MESSAGES, stream=True
        )
        types = [event.type for event in stream]

    assert types == EVENT_TYPES
    (finished,) = _finished(viewer)
    assert finished["payload"]["streaming"] is True
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


def test_beta_stream_with_no_usage_events_records_text_only(attached: Any) -> None:
    instance, viewer = attached()
    events = [
        {
            "type": "message_start",
            "message": {**ANTHROPIC_STREAM_EVENTS[0]["message"], "usage": None},
        },
        *ANTHROPIC_STREAM_EVENTS[1:5],
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}},
        {"type": "message_stop"},
    ]
    client, _ = make_anthropic(_responder(events))
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        list(
            client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES, stream=True)
        )

    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert "usage" not in finished["payload"]


def test_an_empty_beta_stream_finishes_cleanly(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder([]))
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        events = list(
            client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES, stream=True)
        )

    assert events == []
    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["output"] == {"text": "", "chunks": 0}


# -- beta.messages.stream ---------------------------------------------------------------


def test_beta_stream_gates_in_enter_and_observes_text_stream(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    collected: list[str] = []

    def call() -> None:
        with (
            instance.run("agent"),
            client.beta.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream,
        ):
            collected.append("".join(stream.text_stream))

    caller = threading.Thread(target=call, daemon=True)
    caller.start()
    paused = viewer.wait_for_type("exec.paused")
    time.sleep(0.2)
    assert len(recorder) == 0, "beta.messages.stream() must not hit the network while held"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert collected == ["Lisbon"]
    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


def test_beta_parse_is_recorded(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        message = client.beta.messages.parse(model=MODEL, max_tokens=64, messages=MESSAGES)
    assert message.content[0].text == "Lisbon is sunny."
    (finished,) = _finished(viewer)
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


# -- async --------------------------------------------------------------------------


async def test_async_beta_create_and_stream(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with instance.run("agent"):
        message = await client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
        stream = await client.beta.messages.create(
            model=MODEL, max_tokens=64, messages=MESSAGES, stream=True
        )
        async with stream:
            types = [event.type async for event in stream]

    assert message.content[0].text == "Lisbon is sunny."
    assert types == EVENT_TYPES
    first, second = await _finished_async(viewer, 2)
    assert first["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}
    assert second["payload"]["output"]["text"] == "Lisbon"
    assert second["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


async def test_async_beta_gate_does_not_block_the_loop(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with instance.run("agent"):
        task = asyncio.ensure_future(
            client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
        )
        paused = await viewer.wait_for_type_async("exec.paused")
        await asyncio.sleep(0.2)
        assert len(recorder) == 0
        viewer.resume(paused["payload"]["pauseId"], "continue")
        message = await asyncio.wait_for(task, timeout=5)
    assert message.content[0].text == "Lisbon is sunny."


async def test_async_beta_messages_stream_text_stream(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder(), is_async=True)
    instance.instrument_anthropic(client)

    async with (
        instance.run("agent"),
        client.beta.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream,
    ):
        text = "".join([piece async for piece in stream.text_stream])
    assert text == "Lisbon"
    (finished,) = await _finished_async(viewer)
    assert finished["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


# -- raw responses on Anthropic -------------------------------------------------------


@pytest.mark.parametrize("touched_first", [False, True], ids=["instrument-first", "touch-first"])
def test_with_raw_response_records_once_in_either_access_order(
    attached: Any, touched_first: bool
) -> None:
    instance, viewer = attached()
    client, recorder = make_anthropic(_responder())
    if touched_first:
        _ = client.beta.messages.with_raw_response
        _ = client.messages.with_streaming_response
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        raw = client.beta.messages.with_raw_response.create(
            model=MODEL, max_tokens=64, messages=MESSAGES
        )
        assert raw.parse().content[0].text == "Lisbon is sunny."
        with client.messages.with_streaming_response.create(
            model=MODEL, max_tokens=64, messages=MESSAGES, stream=True
        ) as streamed:
            assert [e.type for e in streamed.parse()] == EVENT_TYPES

    assert len(recorder) == 2
    first, second = _finished(viewer, 2)
    time.sleep(0.1)
    assert len(_llm(viewer, "node.started")) == 2
    assert first["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}
    assert second["payload"]["output"]["text"] == "Lisbon"
    assert second["payload"]["usage"] == {"inputTokens": 12, "outputTokens": 6}


def test_inject_into_anthropic_with_raw_response(attached: Any) -> None:
    from anthropic.types.beta import BetaMessage

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "replayed")
    with instance.run("agent"):
        raw = client.beta.messages.with_raw_response.create(
            model=MODEL, max_tokens=64, messages=MESSAGES
        )
    message = raw.parse()
    assert isinstance(message, BetaMessage)
    assert message.content[0].text == "replayed"
    assert len(recorder) == 0


# -- lifecycle ----------------------------------------------------------------------


def test_instrumenting_twice_is_a_no_op_for_beta(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)
    create, stream = client.beta.messages.create, client.beta.messages.stream
    instance.instrument_anthropic(client)
    assert client.beta.messages.create is create
    assert client.beta.messages.stream is stream

    with instance.run("agent"):
        client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
    _finished(viewer)
    time.sleep(0.1)
    assert len(_llm(viewer, "node.started")) == 1


def test_detached_beta_calls_behave_as_without_graphmind(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    client, recorder = make_anthropic(_responder())
    instance.instrument_anthropic(client)

    with instance.run("agent"):
        message = client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES)
        events = list(
            client.beta.messages.create(model=MODEL, max_tokens=64, messages=MESSAGES, stream=True)
        )
        with client.beta.messages.stream(model=MODEL, max_tokens=64, messages=MESSAGES) as stream:
            text = "".join(stream.text_stream)
    assert message.content[0].text == "Lisbon is sunny."
    assert [e.type for e in events] == EVENT_TYPES
    assert text == "Lisbon"
    assert len(recorder) == 3


def test_disabled_graphmind_leaves_beta_untouched(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", enabled=False)
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)
    assert not getattr(client.beta.messages.create, "__graphmind_wrapped__", False)
    assert not getattr(client.beta.messages.stream, "__graphmind_wrapped__", False)


def test_uninstrument_restores_beta(attached: Any) -> None:
    from graphmind.integrations.anthropic import uninstrument_anthropic

    instance, _viewer = attached()
    client, _ = make_anthropic(_responder())
    instance.instrument_anthropic(client)
    assert getattr(client.beta.messages.create, "__graphmind_wrapped__", False)
    uninstrument_anthropic(client)
    assert not getattr(client.beta.messages.create, "__graphmind_wrapped__", False)
    assert not getattr(client.messages.create, "__graphmind_wrapped__", False)
