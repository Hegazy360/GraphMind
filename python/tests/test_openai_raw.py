"""OpenAI ``.with_streaming_response`` / ``.with_raw_response``, through the real SDK.

``Runner.run_streamed`` in the OpenAI Agents SDK calls
``client.responses.with_streaming_response.create(..., stream=True)``. The SDK
builds that wrapper around the resource's own ``create`` the first time the
property is touched and calls it with an ``X-Stainless-Raw-Response`` header,
so the patched ``create`` sees these calls and gets the SDK's raw response
object back instead of a parsed one. These tests pin that: one node per call in
either access order, text and usage recorded, the caller's stream untouched.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import httpx
import pytest

from graphmind.integrations import _common
from graphmind.safe import OnceWarner

from .helpers.providers import (
    CHAT_COMPLETION,
    CHAT_STREAM_CHUNKS,
    RESPONSE,
    RESPONSES_STREAM_EVENTS,
    RESPONSES_STREAM_NO_USAGE,
    MidStreamError,
    failing_body,
    json_responder,
    make_openai,
    responses_sse,
    sse,
    stream_responder,
)

MESSAGES = [{"role": "user", "content": "weather in Lisbon?"}]
EVENT_TYPES = [e["type"] for e in RESPONSES_STREAM_EVENTS]


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


def _responses_stream(events: list[dict[str, Any]] = RESPONSES_STREAM_EVENTS) -> Any:
    return stream_responder(responses_sse(events))


@pytest.fixture
def warnings(monkeypatch: Any) -> list[str]:
    """Capture GraphMind's once-per-process warnings for this test only."""
    messages: list[str] = []
    monkeypatch.setattr(_common, "_warner", OnceWarner(sink=messages.append))
    return messages


# -- with_streaming_response, stream=True (Runner.run_streamed) --------------------


def test_streaming_response_records_text_and_usage_and_hands_back_the_raw_stream(
    attached: Any,
) -> None:
    instance, viewer = attached()
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert type(raw).__name__ == "APIResponse", "the host keeps the SDK's own type"
        assert raw.headers["content-type"] == "text/event-stream"
        events = list(raw.parse())
        assert raw.parse() is not None

    assert [e.type for e in events] == EVENT_TYPES
    assert "".join(getattr(e, "delta", "") for e in events) == "Lisbon"
    assert events[-1].response.usage.input_tokens == 5
    assert len(recorder) == 1

    (finished,) = _finished(viewer)
    payload = finished["payload"]
    assert payload["status"] == "ok"
    assert payload["streaming"] is True
    assert payload["output"]["text"] == "Lisbon"
    assert payload["output"]["finishReason"] == "completed"
    assert payload["output"]["chunks"] == 4
    assert payload["usage"] == {"inputTokens": 5, "outputTokens": 2}
    streamed = "".join(d["v"] for f in viewer.of_type("node.token") for d in f["payload"]["deltas"])
    assert streamed == "Lisbon"


def test_streaming_response_stream_matches_an_uninstrumented_client(attached: Any) -> None:
    instance, _viewer = attached()
    plain, _ = make_openai(_responses_stream())
    client, _ = make_openai(_responses_stream())
    instance.instrument_openai(client)

    def collect(c: Any) -> list[Any]:
        with c.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw:
            return [e.model_dump() for e in raw.parse()]

    with instance.run("agent"):
        assert collect(client) == collect(plain)


@pytest.mark.parametrize("touched_first", [False, True], ids=["instrument-first", "touch-first"])
def test_exactly_one_node_per_call_in_either_access_order(
    attached: Any, touched_first: bool
) -> None:
    instance, viewer = attached()
    client, recorder = make_openai(_responses_stream())
    if touched_first:
        # The Agents SDK may have touched these before you instrument.
        _ = client.responses.with_streaming_response
        _ = client.responses.with_raw_response
    instance.instrument_openai(client)

    with instance.run("agent"):
        for _ in range(2):
            with client.responses.with_streaming_response.create(
                model="gpt-test", input="weather?", stream=True
            ) as raw:
                list(raw.parse())
        raw_legacy = client.responses.with_raw_response.create(
            model="gpt-test", input="weather?", stream=True
        )
        list(raw_legacy.parse())
        list(client.responses.create(model="gpt-test", input="weather?", stream=True))

    assert len(recorder) == 4
    finished = _finished(viewer, 4)
    time.sleep(0.1)  # a duplicate would arrive right behind the first
    assert len(_llm(viewer, "node.started")) == 4
    assert len(_llm(viewer, "node.finished")) == 4
    assert all(f["payload"]["output"]["text"] == "Lisbon" for f in finished)
    assert len({f["payload"]["instanceId"] for f in finished}) == 4


def test_abort_before_a_streaming_response_raises_in_enter(attached: Any) -> None:
    from graphmind.errors import GraphMindAbortError

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)

    _resume_next(viewer, "abort")
    with (
        pytest.raises(GraphMindAbortError),
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ),
    ):
        pass
    assert len(recorder) == 0
    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "aborted"


def test_retry_at_the_error_gate_of_a_streaming_response(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    body = responses_sse(RESPONSES_STREAM_EVENTS)

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        if len(recorder.requests) == 1:
            return httpx.Response(500, json={"error": {"message": "provider exploded"}})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    client, recorder = make_openai(responder)
    instance.instrument_openai(client)

    _resume_next(viewer, "retry")
    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert [e.type for e in raw.parse()] == EVENT_TYPES

    assert len(recorder) == 2, "retry re-issued the request"
    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert len(_llm(viewer, "node.error")) == 1


def test_the_before_gate_holds_in_enter_with_nothing_in_flight(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)

    manager = client.responses.with_streaming_response.create(
        model="gpt-test", input="weather?", stream=True
    )
    texts: list[str] = []

    def consume() -> None:
        with instance.run("agent"), manager as raw:
            texts.append("".join(getattr(e, "delta", "") for e in raw.parse()))

    caller = threading.Thread(target=consume, daemon=True)
    caller.start()
    paused = viewer.wait_for_type("exec.paused")
    assert paused["payload"]["nodeId"] == "llm:step"
    time.sleep(0.25)
    assert len(recorder) == 0, "no request may be in flight while the gate holds"

    viewer.resume(paused["payload"]["pauseId"], "continue")
    caller.join(timeout=5)
    assert texts == ["Lisbon"]
    assert len(recorder) == 1


def test_leaving_the_context_early_finishes_the_node_once(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(_responses_stream())
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        for event in raw.parse():
            if event.type == "response.output_text.delta":
                break

    (finished,) = _finished(viewer)
    time.sleep(0.1)
    assert len(_llm(viewer, "node.finished")) == 1
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["output"]["text"] == "Lis"


def test_reading_raw_bytes_instead_of_parse_still_finishes_the_node(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(_responses_stream())
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        body = b"".join(raw.iter_bytes())

    assert body == responses_sse(RESPONSES_STREAM_EVENTS)
    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["streaming"] is True


def test_an_empty_stream_finishes_cleanly(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(stream_responder(b""))
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert list(raw.parse()) == []

    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "ok"
    assert finished["payload"]["output"] == {"text": "", "chunks": 0}
    assert "usage" not in finished["payload"]


def test_a_stream_without_usage_records_text_and_no_usage(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(_responses_stream(RESPONSES_STREAM_NO_USAGE))
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        list(raw.parse())

    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert "usage" not in finished["payload"]


def test_a_stream_that_breaks_mid_way_reaches_the_host_and_marks_the_node(
    attached: Any,
) -> None:
    instance, viewer = attached()
    head = responses_sse(RESPONSES_STREAM_EVENTS[:2])

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=failing_body(head)
        )

    client, _ = make_openai(responder)
    instance.instrument_openai(client)

    seen: list[str] = []
    with (
        pytest.raises(MidStreamError),
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        for event in raw.parse():
            seen.append(event.type)

    assert seen == EVENT_TYPES[:2]
    (finished,) = _finished(viewer)
    assert finished["payload"]["status"] == "error"
    assert finished["payload"]["output"]["text"] == "Lis"
    errors = _llm(viewer, "node.error")
    assert errors and "dropped" in str(errors[0]["payload"]["error"])


def test_chat_completions_streaming_response_is_teed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(stream_responder(sse(CHAT_STREAM_CHUNKS)))
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.chat.completions.with_streaming_response.create(
            model="gpt-test",
            messages=MESSAGES,
            stream=True,
            stream_options={"include_usage": True},
        ) as raw,
    ):
        text = "".join(
            c.choices[0].delta.content or ""
            for c in raw.parse()
            if c.choices and c.choices[0].delta
        )

    assert text == "Lisbon"
    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 7, "outputTokens": 3}


def test_chat_stream_without_include_usage_records_no_usage(attached: Any) -> None:
    instance, viewer = attached()
    chunks = [c for c in CHAT_STREAM_CHUNKS if "usage" not in c]
    client, _ = make_openai(stream_responder(sse(chunks)))
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.chat.completions.with_streaming_response.create(
            model="gpt-test", messages=MESSAGES, stream=True
        ) as raw,
    ):
        list(raw.parse())

    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert "usage" not in finished["payload"]


# -- non-streamed raw responses ------------------------------------------------------


def test_streaming_response_without_stream_records_the_parsed_reply(attached: Any) -> None:
    instance, viewer = attached()
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(model="gpt-test", input="hi") as raw,
    ):
        response = raw.parse()
        assert raw.parse() is response
        assert raw.json()["id"] == "resp_test", "the body is still readable after we parsed"

    assert response.output_text == "Lisbon is sunny."
    assert len(recorder) == 1
    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny."
    assert finished["payload"]["usage"] == {"inputTokens": 5, "outputTokens": 2}
    assert "streaming" not in finished["payload"]


def test_with_raw_response_records_usage_and_keeps_headers(attached: Any) -> None:
    instance, viewer = attached()

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        return httpx.Response(200, json=CHAT_COMPLETION, headers={"x-request-id": "req_42"})

    client, _ = make_openai(responder)
    instance.instrument_openai(client)

    with instance.run("agent"):
        raw = client.chat.completions.with_raw_response.create(model="gpt-test", messages=MESSAGES)

    assert type(raw).__name__ == "LegacyAPIResponse"
    assert raw.headers["x-request-id"] == "req_42"
    assert raw.parse().choices[0].message.content == "Lisbon is sunny."
    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon is sunny."
    assert finished["payload"]["usage"] == {"inputTokens": 11, "outputTokens": 7}


def test_with_raw_response_on_a_stream_tees_the_parsed_stream(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(_responses_stream())
    instance.instrument_openai(client)

    with instance.run("agent"):
        raw = client.responses.with_raw_response.create(
            model="gpt-test", input="weather?", stream=True
        )
        assert [e.type for e in raw.parse()] == EVENT_TYPES

    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 5, "outputTokens": 2}


def test_retry_at_the_after_gate_re_issues_a_raw_call(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "after"}])
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    def worker() -> None:
        first = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(first["payload"]["pauseId"], "retry")
        second = viewer.wait_for(
            lambda f: (
                f.get("type") == "exec.paused"
                and f["payload"]["pauseId"] != first["payload"]["pauseId"]
            )
        )
        viewer.resume(second["payload"]["pauseId"], "continue")

    threading.Thread(target=worker, daemon=True).start()
    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(model="gpt-test", input="hi") as raw,
    ):
        assert raw.parse().output_text == "Lisbon is sunny."
    assert len(recorder) == 2


# -- inject into raw-response calls -------------------------------------------------


def test_inject_into_streaming_response_returns_a_parseable_stand_in(attached: Any) -> None:
    from openai.types.responses import Response

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "replayed answer")
    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(model="gpt-test", input="hi") as raw,
    ):
        response = raw.parse()
        assert raw.json()["output"][0]["content"][0]["text"] == "replayed answer"

    assert isinstance(response, Response)
    assert response.output_text == "replayed answer"
    assert len(recorder) == 0


def test_inject_into_with_raw_response_returns_a_parseable_stand_in(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"content": "replayed"})
    with instance.run("agent"):
        raw = client.chat.completions.with_raw_response.create(model="gpt-test", messages=MESSAGES)

    completion = raw.parse()
    assert isinstance(completion, ChatCompletion)
    assert completion.choices[0].message.content == "replayed"
    assert len(recorder) == 0


def test_inject_at_the_after_gate_of_a_raw_call_uses_the_real_reply_type(attached: Any) -> None:
    from openai.types.responses import Response

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "after"}])
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "edited answer")
    with instance.run("agent"):
        raw = client.responses.with_raw_response.create(model="gpt-test", input="hi")

    assert isinstance(raw.parse(), Response)
    assert raw.parse().output_text == "edited answer"
    assert len(recorder) == 1
    (finished,) = _finished(viewer)
    assert finished["payload"]["injected"] is True


def test_inject_at_the_error_gate_of_a_raw_call_is_a_typed_stand_in(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    from .helpers.providers import failing_then

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_openai(failing_then(CHAT_COMPLETION, failures=99))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "fallback")
    with instance.run("agent"):
        raw = client.chat.completions.with_raw_response.create(model="gpt-test", messages=MESSAGES)

    assert isinstance(raw.parse(), ChatCompletion)
    assert raw.parse().choices[0].message.content == "fallback"
    assert len(recorder) == 1
    (finished,) = _finished(viewer)
    assert finished["payload"]["recoveredFromError"] is True


def test_abort_before_a_raw_call_raises_and_sends_nothing(attached: Any) -> None:
    from graphmind.errors import GraphMindAbortError

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(viewer, "abort")
    with pytest.raises(GraphMindAbortError), instance.run("agent"):
        client.responses.with_raw_response.create(model="gpt-test", input="hi")
    assert len(recorder) == 0


def test_inject_on_a_raw_stream_is_treated_as_continue(attached: Any, warnings: list[str]) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "cannot become a stream")
    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert [e.type for e in raw.parse()] == EVENT_TYPES

    assert len(recorder) == 1, "the real request runs"
    (finished,) = _finished(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert "injected" not in finished["payload"]
    assert any("not supported on a with_streaming_response" in w for w in warnings)


# -- async client ---------------------------------------------------------------------


async def test_async_streaming_response_records_text_and_usage(attached: Any) -> None:
    instance, viewer = attached()
    client, recorder = make_openai(_responses_stream(), is_async=True)
    instance.instrument_openai(client)

    async with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert type(raw).__name__ == "AsyncAPIResponse"
        stream = await raw.parse()
        types = [event.type async for event in stream]

    assert types == EVENT_TYPES
    assert len(recorder) == 1
    (finished,) = await _finished_async(viewer)
    assert finished["payload"]["output"]["text"] == "Lisbon"
    assert finished["payload"]["usage"] == {"inputTokens": 5, "outputTokens": 2}


@pytest.mark.parametrize("touched_first", [False, True], ids=["instrument-first", "touch-first"])
async def test_async_one_node_per_call_in_either_access_order(
    attached: Any, touched_first: bool
) -> None:
    instance, viewer = attached()
    client, recorder = make_openai(_responses_stream(), is_async=True)
    if touched_first:
        _ = client.responses.with_streaming_response
    instance.instrument_openai(client)

    async with instance.run("agent"):
        for _ in range(2):
            async with client.responses.with_streaming_response.create(
                model="gpt-test", input="weather?", stream=True
            ) as raw:
                [e async for e in await raw.parse()]

    assert len(recorder) == 2
    await _finished_async(viewer, 2)
    await asyncio.sleep(0.1)
    assert len(_llm(viewer, "node.started")) == 2
    assert len(_llm(viewer, "node.finished")) == 2


async def test_async_gate_holds_in_aenter_without_blocking_the_loop(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(_responses_stream(), is_async=True)
    instance.instrument_openai(client)

    async def consume() -> str:
        async with client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw:
            return "".join([getattr(e, "delta", "") async for e in await raw.parse()])

    async with instance.run("agent"):
        task = asyncio.ensure_future(consume())
        paused = await viewer.wait_for_type_async("exec.paused")
        await asyncio.sleep(0.2)
        assert len(recorder) == 0
        viewer.resume(paused["payload"]["pauseId"], "continue")
        assert await asyncio.wait_for(task, timeout=5) == "Lisbon"


async def test_async_stream_that_breaks_mid_way(attached: Any) -> None:
    instance, viewer = attached()
    head = responses_sse(RESPONSES_STREAM_EVENTS[:2])

    def responder(request: httpx.Request, recorder: Any) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=failing_body(head, is_async=True),
        )

    client, _ = make_openai(responder, is_async=True)
    instance.instrument_openai(client)

    with pytest.raises(MidStreamError):
        async with (
            instance.run("agent"),
            client.responses.with_streaming_response.create(
                model="gpt-test", input="weather?", stream=True
            ) as raw,
        ):
            async for _event in await raw.parse():
                pass

    (finished,) = await _finished_async(viewer)
    assert finished["payload"]["status"] == "error"
    assert finished["payload"]["output"]["text"] == "Lis"


async def test_async_with_raw_response_non_streamed(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(json_responder(RESPONSE), is_async=True)
    instance.instrument_openai(client)

    async with instance.run("agent"):
        raw = await client.responses.with_raw_response.create(model="gpt-test", input="hi")

    # LegacyAPIResponse.parse() stays synchronous on the async client.
    assert raw.parse().output_text == "Lisbon is sunny."
    (finished,) = await _finished_async(viewer)
    assert finished["payload"]["usage"] == {"inputTokens": 5, "outputTokens": 2}


async def test_async_inject_into_streaming_response(attached: Any) -> None:
    from openai.types.responses import Response

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(RESPONSE), is_async=True)
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "replayed answer")
    async with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(model="gpt-test", input="hi") as raw,
    ):
        response = await raw.parse()

    assert isinstance(response, Response)
    assert response.output_text == "replayed answer"
    assert len(recorder) == 0


async def test_async_inject_into_with_raw_response_parses_synchronously(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION), is_async=True)
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "replayed")
    async with instance.run("agent"):
        raw = await client.chat.completions.with_raw_response.create(
            model="gpt-test", messages=MESSAGES
        )

    completion = raw.parse()
    assert isinstance(completion, ChatCompletion)
    assert completion.choices[0].message.content == "replayed"
    assert len(recorder) == 0


# -- lifecycle ----------------------------------------------------------------------


def test_instrumenting_twice_keeps_the_raw_wrappers_and_records_once(attached: Any) -> None:
    instance, viewer = attached()
    client, _ = make_openai(_responses_stream())
    instance.instrument_openai(client)
    wrappers = client.responses.with_streaming_response
    instance.instrument_openai(client)
    assert client.responses.with_streaming_response is wrappers

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        list(raw.parse())

    _finished(viewer)
    time.sleep(0.1)
    assert len(_llm(viewer, "node.started")) == 1


def test_detached_raw_calls_behave_exactly_as_without_graphmind(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert [e.type for e in raw.parse()] == EVENT_TYPES
    assert len(recorder) == 1


def test_disabled_graphmind_leaves_the_raw_wrappers_alone(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", enabled=False)
    client, _ = make_openai(_responses_stream())
    wrappers = client.responses.with_streaming_response
    instance.instrument_openai(client)
    assert client.responses.with_streaming_response is wrappers
    assert not getattr(client.responses.create, "__graphmind_wrapped__", False)


def test_uninstrument_stops_recording_raw_calls(attached: Any) -> None:
    from graphmind.integrations.openai import uninstrument_openai

    instance, viewer = attached()
    client, recorder = make_openai(_responses_stream())
    instance.instrument_openai(client)
    _ = client.responses.with_streaming_response  # built around the wrapper
    uninstrument_openai(client)

    with (
        instance.run("agent"),
        client.responses.with_streaming_response.create(
            model="gpt-test", input="weather?", stream=True
        ) as raw,
    ):
        assert [e.type for e in raw.parse()] == EVENT_TYPES

    assert len(recorder) == 1
    viewer.wait_for_type("run.finished")
    assert _llm(viewer, "node.started") == []
