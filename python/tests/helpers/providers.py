"""Deterministic, offline provider clients.

Both SDKs accept a custom ``httpx`` client, so the *real* SDK code path runs —
request building, model parsing, SSE decoding — against canned bytes. No API
keys, no network, no monkey-patching of the SDK internals under test.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx

# -- OpenAI -------------------------------------------------------------------

CHAT_COMPLETION: dict[str, Any] = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-test",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Lisbon is sunny."},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
}

CHAT_TOOL_CALL: dict[str, Any] = {
    "id": "chatcmpl-tool",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-test",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_flights",
                            "arguments": '{"origin":"VIE"}',
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 20, "completion_tokens": 9, "total_tokens": 29},
}

CHAT_STREAM_CHUNKS: list[dict[str, Any]] = [
    {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-test",
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Lis"}}],
    },
    {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-test",
        "choices": [{"index": 0, "delta": {"content": "bon"}}],
    },
    {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-test",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    },
    {
        "id": "c",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-test",
        "choices": [],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
    },
]


def sse(chunks: list[dict[str, Any]], done: bool = True) -> bytes:
    body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
    if done:
        body += "data: [DONE]\n\n"
    return body.encode()


def anthropic_sse(events: list[dict[str, Any]]) -> bytes:
    body = ""
    for event in events:
        body += f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
    return body.encode()


class Recorder:
    """Counts requests so tests can prove a retry really re-issued the call."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __len__(self) -> int:
        return len(self.requests)


def make_openai(
    responder: Callable[[httpx.Request, Recorder], httpx.Response],
    is_async: bool = False,
) -> Any:
    from openai import AsyncOpenAI, OpenAI

    recorder = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.requests.append(request)
        return responder(request, recorder)

    transport = httpx.MockTransport(handler)
    if is_async:
        client: Any = AsyncOpenAI(
            api_key="test",
            base_url="http://provider.test/v1",
            max_retries=0,
            http_client=httpx.AsyncClient(transport=transport),
        )
    else:
        client = OpenAI(
            api_key="test",
            base_url="http://provider.test/v1",
            max_retries=0,
            http_client=httpx.Client(transport=transport),
        )
    return client, recorder


def json_responder(payload: dict[str, Any]) -> Callable[..., httpx.Response]:
    def responder(request: httpx.Request, recorder: Recorder) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return responder


def stream_responder(body: bytes) -> Callable[..., httpx.Response]:
    def responder(request: httpx.Request, recorder: Recorder) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    return responder


def failing_then(payload: dict[str, Any], failures: int = 1) -> Callable[..., httpx.Response]:
    def responder(request: httpx.Request, recorder: Recorder) -> httpx.Response:
        if len(recorder.requests) <= failures:
            return httpx.Response(500, json={"error": {"message": "provider exploded"}})
        return httpx.Response(200, json=payload)

    return responder


# -- Anthropic ----------------------------------------------------------------

ANTHROPIC_MESSAGE: dict[str, Any] = {
    "id": "msg_test",
    "type": "message",
    "role": "assistant",
    "model": "claude-test",
    "content": [{"type": "text", "text": "Lisbon is sunny."}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 12, "output_tokens": 6},
}

ANTHROPIC_STREAM_EVENTS: list[dict[str, Any]] = [
    {
        "type": "message_start",
        "message": {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-test",
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 12, "output_tokens": 0},
        },
    },
    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": "Lis"},
    },
    {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": "bon"},
    },
    {"type": "content_block_stop", "index": 0},
    {
        "type": "message_delta",
        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
        "usage": {"output_tokens": 6},
    },
    {"type": "message_stop"},
]


def make_anthropic(
    responder: Callable[[httpx.Request, Recorder], httpx.Response],
    is_async: bool = False,
) -> Any:
    from anthropic import Anthropic, AsyncAnthropic

    recorder = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.requests.append(request)
        return responder(request, recorder)

    transport = httpx.MockTransport(handler)
    if is_async:
        client: Any = AsyncAnthropic(
            api_key="test",
            base_url="http://provider.test",
            max_retries=0,
            http_client=httpx.AsyncClient(transport=transport),
        )
    else:
        client = Anthropic(
            api_key="test",
            base_url="http://provider.test",
            max_retries=0,
            http_client=httpx.Client(transport=transport),
        )
    return client, recorder


def anthropic_stream_responder(
    events: list[dict[str, Any]] | None = None,
) -> Callable[..., httpx.Response]:
    body = anthropic_sse(events if events is not None else ANTHROPIC_STREAM_EVENTS)

    def responder(request: httpx.Request, recorder: Recorder) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)

    return responder
