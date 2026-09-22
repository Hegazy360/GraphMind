"""An injected LLM reply comes back as the SDK type the call returns.

Frameworks read attributes off the provider SDK's own types and some check
``isinstance`` (Pydantic AI rejects anything that is not a ``ChatCompletion``;
the OpenAI Agents SDK reads ``response.output`` / ``.usage`` / ``.id``). The
viewer sends JSON, so the payload is rebuilt: a bare string becomes a minimal
assistant reply with that text, an object is read as (some of) the type's
fields. Anything that cannot be rebuilt is handed back unchanged with one
warning — never an exception into the host.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from graphmind.integrations import _common
from graphmind.safe import OnceWarner

from .helpers.providers import (
    ANTHROPIC_HTTPX,
    ANTHROPIC_MESSAGE,
    CHAT_COMPLETION,
    RESPONSE,
    failing_then,
    json_responder,
    make_anthropic,
    make_openai,
)

MESSAGES = [{"role": "user", "content": "weather in Lisbon?"}]


def _resume_next(viewer: Any, action: str, output: Any = None) -> threading.Thread:
    def worker() -> None:
        frame = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(frame["payload"]["pauseId"], action, output)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


def _llm_finished(viewer: Any) -> dict[str, Any]:
    return viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )["payload"]


@pytest.fixture
def warnings(monkeypatch: Any) -> list[str]:
    messages: list[str] = []
    monkeypatch.setattr(_common, "_warner", OnceWarner(sink=messages.append))
    return messages


def _anthropic_responder(failures: int = 0) -> Any:
    def responder(request: Any, recorder: Any) -> Any:
        if len(recorder.requests) <= failures:
            return ANTHROPIC_HTTPX.Response(500, json={"error": {"message": "provider exploded"}})
        return ANTHROPIC_HTTPX.Response(200, json=ANTHROPIC_MESSAGE)

    return responder


# -- OpenAI chat.completions ------------------------------------------------------------


def test_a_string_becomes_a_chat_completion(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "It is sunny in Lisbon.")
    with instance.run("agent"):
        completion = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert isinstance(completion, ChatCompletion)
    choice = completion.choices[0]
    assert choice.message.content == "It is sunny in Lisbon."
    assert choice.message.role == "assistant"
    assert choice.finish_reason == "stop"
    assert completion.model == "gpt-test", "the requested model is echoed back"
    assert completion.id and completion.usage is None
    assert len(recorder) == 0

    finished = _llm_finished(viewer)
    assert finished["injected"] is True
    assert finished["output"] == "It is sunny in Lisbon.", "the node shows what was typed"
    assert "usage" not in finished


def test_a_partial_completion_object_is_completed(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(
        viewer,
        "inject",
        {
            "id": "chatcmpl-replay",
            "choices": [{"message": {"content": "replayed"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1},
        },
    )
    with instance.run("agent"):
        completion = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert isinstance(completion, ChatCompletion)
    assert completion.id == "chatcmpl-replay"
    assert completion.choices[0].message.content == "replayed"
    assert completion.usage is not None
    assert (completion.usage.prompt_tokens, completion.usage.total_tokens) == (3, 4)


def test_a_bare_message_with_tool_calls_becomes_a_tool_call_completion(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(
        viewer,
        "inject",
        {"tool_calls": [{"function": {"name": "search_flights", "arguments": {"origin": "VIE"}}}]},
    )
    with instance.run("agent"):
        completion = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    choice = completion.choices[0]
    assert choice.finish_reason == "tool_calls"
    call = choice.message.tool_calls[0]
    assert call.type == "function" and call.id
    assert call.function.name == "search_flights"
    assert call.function.arguments == '{"origin": "VIE"}'


def test_parse_gets_a_parsed_chat_completion(attached: Any) -> None:
    from openai.types.chat import ParsedChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"content": '{"city": "Lisbon"}', "parsed": {"city": "Lisbon"}})
    with instance.run("agent"):
        completion = client.chat.completions.parse(model="gpt-test", messages=MESSAGES)

    assert isinstance(completion, ParsedChatCompletion)
    assert completion.choices[0].message.parsed == {"city": "Lisbon"}


def test_inject_at_the_error_gate_is_typed(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_openai(failing_then(CHAT_COMPLETION, failures=99))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "fallback answer")
    with instance.run("agent"):
        completion = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert isinstance(completion, ChatCompletion)
    assert completion.choices[0].message.content == "fallback answer"
    assert len(recorder) == 1
    assert _llm_finished(viewer)["recoveredFromError"] is True


def test_inject_at_the_after_gate_keeps_the_real_reply_type(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "after"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "edited answer")
    with instance.run("agent"):
        completion = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert type(completion) is ChatCompletion
    assert completion.choices[0].message.content == "edited answer"
    assert len(recorder) == 1


# -- OpenAI responses -------------------------------------------------------------------


def test_a_string_becomes_a_response(attached: Any) -> None:
    from openai.types.responses import Response

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "It is sunny in Lisbon.")
    with instance.run("agent"):
        response = client.responses.create(model="gpt-test", input="weather?")

    assert isinstance(response, Response)
    # What the OpenAI Agents SDK reads off a Response:
    assert response.output_text == "It is sunny in Lisbon."
    assert response.output[0].type == "message"
    assert response.output[0].content[0].text == "It is sunny in Lisbon."
    assert response.id and response.usage is None
    assert response.status == "completed"
    assert len(recorder) == 0


def test_a_response_object_with_a_function_call_is_rebuilt(attached: Any) -> None:
    from openai.types.responses import Response, ResponseFunctionToolCall

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(
        viewer,
        "inject",
        {
            "output": [
                {"type": "message", "content": ["Let me search."]},
                {"type": "function_call", "name": "search_flights", "arguments": {"to": "LIS"}},
            ],
            # What a human types; the detail sub-objects are filled in.
            "usage": {"input_tokens": 9, "output_tokens": 4},
        },
    )
    with instance.run("agent"):
        response = client.responses.create(model="gpt-test", input="weather?")

    assert isinstance(response, Response)
    assert response.output_text == "Let me search."
    call = response.output[1]
    assert isinstance(call, ResponseFunctionToolCall)
    assert call.name == "search_flights" and call.call_id
    assert call.arguments == '{"to": "LIS"}'
    assert response.usage is not None
    assert (response.usage.input_tokens, response.usage.total_tokens) == (9, 13)


def test_output_text_shortcut_is_accepted(attached: Any) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(RESPONSE))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"output_text": "short form"})
    with instance.run("agent"):
        response = client.responses.create(model="gpt-test", input="weather?")
    assert response.output_text == "short form"


# -- coercion failures fall back, never raise --------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        [1, 2, 3],
        42,
        {"choices": "not a list"},
        {"unrelated": True},
    ],
    ids=["list", "number", "wrong-field-type", "unrecognised-object"],
)
def test_an_uncoercible_payload_is_handed_back_unchanged_with_one_warning(
    attached: Any, warnings: list[str], payload: Any
) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", payload)
    with instance.run("agent"):
        result = client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert result == payload
    assert len(recorder) == 0
    assert len([w for w in warnings if "could not rebuild" in w]) == 1
    assert _llm_finished(viewer)["injected"] is True


def test_the_rebuild_warning_is_logged_once(attached: Any, warnings: list[str]) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    def worker() -> None:
        seen: set[str] = set()
        for _ in range(2):
            frame = viewer.wait_for(
                lambda f: f.get("type") == "exec.paused" and f["payload"]["pauseId"] not in seen
            )
            seen.add(frame["payload"]["pauseId"])
            viewer.resume(frame["payload"]["pauseId"], "inject", [1])

    threading.Thread(target=worker, daemon=True).start()
    with instance.run("agent"):
        for _ in range(2):
            assert client.chat.completions.create(model="gpt-test", messages=MESSAGES) == [1]
    assert len([w for w in warnings if "could not rebuild" in w]) == 1


def test_a_client_from_another_package_is_not_coerced(attached: Any) -> None:
    """Duck-typed fakes are left alone: types come from the client's own package."""
    from graphmind.integrations._common import ReplyType, sdk_packages

    class FakeClient:
        pass

    reply = ReplyType(sdk_packages(FakeClient()), (("types.chat", "ChatCompletion"),))
    assert reply.resolve() is None


def test_inject_into_a_stream_true_call_returns_the_payload_as_before(
    attached: Any, warnings: list[str]
) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "not a stream")
    with instance.run("agent"):
        result = client.chat.completions.create(model="gpt-test", messages=MESSAGES, stream=True)

    assert result == "not a stream"
    assert len(recorder) == 0
    assert any("cannot synthesize a provider event stream" in w for w in warnings)


# -- async OpenAI ---------------------------------------------------------------------


async def test_async_chat_inject_is_typed(attached: Any) -> None:
    from openai.types.chat import ChatCompletion

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_openai(json_responder(CHAT_COMPLETION), is_async=True)
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", "async answer")
    async with instance.run("agent"):
        completion = await client.chat.completions.create(model="gpt-test", messages=MESSAGES)

    assert isinstance(completion, ChatCompletion)
    assert completion.choices[0].message.content == "async answer"
    assert len(recorder) == 0


async def test_async_responses_inject_is_typed(attached: Any) -> None:
    from openai.types.responses import Response

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(RESPONSE), is_async=True)
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"output": [{"content": "async answer"}]})
    async with instance.run("agent"):
        response = await client.responses.create(model="gpt-test", input="weather?")

    assert isinstance(response, Response)
    assert response.output_text == "async answer"


async def test_async_uncoercible_payload_falls_back(attached: Any, warnings: list[str]) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_openai(json_responder(RESPONSE), is_async=True)
    instance.instrument_openai(client)

    _resume_next(viewer, "inject", {"output": "not a list"})
    async with instance.run("agent"):
        result = await client.responses.create(model="gpt-test", input="weather?")
    assert result == {"output": "not a list"}
    assert any("could not rebuild" in w for w in warnings)


# -- Anthropic ------------------------------------------------------------------------


def test_a_string_becomes_an_anthropic_message(attached: Any) -> None:
    from anthropic.types import Message

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_anthropic_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "It is sunny in Lisbon.")
    with instance.run("agent"):
        message = client.messages.create(model="claude-test", max_tokens=64, messages=MESSAGES)

    assert isinstance(message, Message)
    assert message.content[0].text == "It is sunny in Lisbon."
    assert message.role == "assistant" and message.stop_reason == "end_turn"
    assert message.model == "claude-test"
    assert message.usage.input_tokens == 0 and message.usage.output_tokens == 0
    assert len(recorder) == 0
    assert "usage" not in _llm_finished(viewer), "injected nodes still report no usage"


def test_an_anthropic_tool_use_object_is_rebuilt(attached: Any) -> None:
    from anthropic.types import ToolUseBlock

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_anthropic(_anthropic_responder())
    instance.instrument_anthropic(client)

    _resume_next(
        viewer, "inject", {"content": [{"type": "tool_use", "name": "search", "input": {"q": "x"}}]}
    )
    with instance.run("agent"):
        message = client.messages.create(model="claude-test", max_tokens=64, messages=MESSAGES)

    block = message.content[0]
    assert isinstance(block, ToolUseBlock)
    assert block.name == "search" and block.input == {"q": "x"} and block.id
    assert message.stop_reason == "tool_use"


def test_beta_messages_create_inject_is_a_beta_message(attached: Any) -> None:
    from anthropic.types.beta import BetaMessage

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_anthropic_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", {"content": "from the viewer"})
    with instance.run("agent"):
        message = client.beta.messages.create(model="claude-test", max_tokens=64, messages=MESSAGES)

    assert isinstance(message, BetaMessage)
    assert message.content[0].text == "from the viewer"
    assert len(recorder) == 0


def test_beta_messages_parse_inject_is_a_parsed_beta_message(attached: Any) -> None:
    from anthropic.types.beta.parsed_beta_message import ParsedBetaMessage

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_anthropic(_anthropic_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "parsed reply")
    with instance.run("agent"):
        message = client.beta.messages.parse(model="claude-test", max_tokens=64, messages=MESSAGES)

    assert isinstance(message, ParsedBetaMessage)
    assert message.content[0].text == "parsed reply"


def test_anthropic_error_gate_inject_is_typed(attached: Any) -> None:
    from anthropic.types import Message

    instance, viewer = attached(breakpoints=[{"kind": "llm", "point": "error"}])
    client, recorder = make_anthropic(_anthropic_responder(failures=99))
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "fallback")
    with instance.run("agent"):
        message = client.messages.create(model="claude-test", max_tokens=64, messages=MESSAGES)

    assert isinstance(message, Message)
    assert message.content[0].text == "fallback"
    assert len(recorder) == 1


def test_anthropic_uncoercible_payload_falls_back(attached: Any, warnings: list[str]) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, _ = make_anthropic(_anthropic_responder())
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", {"content": [{"type": "text"}]})  # text block without text
    with instance.run("agent"):
        result = client.messages.create(model="claude-test", max_tokens=64, messages=MESSAGES)
    assert result == {"content": [{"type": "text"}]}
    assert any("could not rebuild the injected value as Message" in w for w in warnings)


async def test_async_beta_inject_is_typed(attached: Any) -> None:
    from anthropic.types.beta import BetaMessage

    instance, viewer = attached(breakpoints=[{"kind": "llm"}])
    client, recorder = make_anthropic(_anthropic_responder(), is_async=True)
    instance.instrument_anthropic(client)

    _resume_next(viewer, "inject", "async beta")
    async with instance.run("agent"):
        message = await client.beta.messages.create(
            model="claude-test", max_tokens=64, messages=MESSAGES
        )

    assert isinstance(message, BetaMessage)
    assert message.content[0].text == "async beta"
    assert len(recorder) == 0
