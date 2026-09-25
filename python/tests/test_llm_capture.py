"""LLM-step capture (contract C1): the shared conformance fixture
(``packages/client/test/fixtures/llm.json``) plus end-to-end checks through the
real OpenAI / Anthropic SDKs and a LangChain chat model.

Reads a monorepo fixture at collection time, so it is excluded from the sdist
(see pyproject.toml) like test_redaction.py.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from graphmind.llm_capture import (
    MAX_SCHEMA_RUNS,
    SAMPLING_PARAM_KEYS,
    AnthropicUsageAccumulator,
    anthropic_usage,
    capture_tools,
    langchain_usage,
    make_usage,
    normalize_finish_reason,
    openai_chat_usage,
    openai_responses_usage,
    pick_params,
    record_value,
    reset_tool_schema_memory,
    sanitize_tool_definition,
    schema_hash,
    token_count,
    tool_call,
    usage_of,
)
from graphmind.loop_guard import canonicalize

from .helpers.providers import (
    ANTHROPIC_HTTPX,
    anthropic_sse,
    make_anthropic,
    make_openai,
    sse,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "client" / "test" / "fixtures" / "llm.json").read_text()
)

MAPPERS = {
    "anthropic": anthropic_usage,
    "openai-chat": openai_chat_usage,
    "openai-responses": openai_responses_usage,
    "langchain": langchain_usage,
}
USAGE_CASES = [c for c in FIXTURE["usage"] if c["provider"] in MAPPERS]


def _label(case: dict[str, Any]) -> str:
    return f"{case['provider']}: {case['name']}"


# -- the shared fixture ------------------------------------------------------------


@pytest.mark.parametrize("row", FIXTURE["finishReasons"], ids=lambda r: json.dumps(r[:2]))
def test_finish_reasons(row: list[Any]) -> None:
    raw, has_tool_calls, expected = row
    assert normalize_finish_reason(raw, has_tool_calls) == expected


@pytest.mark.parametrize("row", FIXTURE["toolCalls"], ids=lambda r: json.dumps(r["in"]))
def test_tool_calls(row: dict[str, Any]) -> None:
    given = row["in"]
    assert tool_call(given.get("id"), given.get("name"), given.get("args")) == row["out"]


@pytest.mark.parametrize("row", FIXTURE["schemaHashes"], ids=lambda r: r["hash"])
def test_schema_hashes(row: dict[str, Any]) -> None:
    assert schema_hash(row["in"]) == row["hash"]
    canonical = canonicalize(row["in"]).encode("utf-8", "surrogatepass")
    assert hashlib.sha256(canonical).hexdigest()[:16] == row["hash"]


@pytest.mark.parametrize("row", FIXTURE["toolDefinitions"], ids=lambda r: r["name"])
def test_tool_definitions_are_recorded_without_credentials(row: dict[str, Any]) -> None:
    assert sanitize_tool_definition(row["in"]) == row["out"]
    assert schema_hash(row["out"]) == row["hash"]
    # capture_tools records exactly that, under exactly that hash.
    captured = capture_tools(object.__new__(_Owner), "run-1", [row["in"]], lambda _d: "tool")
    assert captured == {"tools": [{"name": "tool", "schemaHash": row["hash"]}], "toolSchemas": {row["hash"]: row["out"]}}


def test_an_openai_mcp_tool_never_records_its_token() -> None:
    stripe = {
        "type": "mcp",
        "server_label": "stripe",
        "server_url": "https://mcp.stripe.com",
        "authorization": "sk_live_OAUTH_TOKEN_SECRET_2",
        "headers": {"Authorization": "Bearer sk_live_HEADER_SECRET_2"},
        "require_approval": "never",
    }
    captured = capture_tools(object.__new__(_Owner), "run-1", [stripe])
    assert captured is not None
    assert captured["tools"][0]["name"] == "mcp"
    recorded = json.dumps(captured)
    assert "sk_live_OAUTH_TOKEN_SECRET_2" not in recorded
    assert "sk_live_HEADER_SECRET_2" not in recorded


class _Owner:
    """A weakly referenceable stand-in for a session."""


@pytest.mark.parametrize("case", USAGE_CASES, ids=_label)
def test_usage_mapping(case: dict[str, Any]) -> None:
    assert MAPPERS[case["provider"]](case["raw"]) == case["out"]


@pytest.mark.parametrize("case", USAGE_CASES, ids=_label)
def test_usage_of_sniffs_the_same_answer_from_the_shape(case: dict[str, Any]) -> None:
    assert usage_of(case["raw"]) == case["out"]
    assert usage_of({"usage": case["raw"]}) == case["out"]


def test_the_sampling_allow_list_matches_typescript() -> None:
    assert list(SAMPLING_PARAM_KEYS) == FIXTURE["samplingParams"]


def test_the_fixture_is_not_vacuous() -> None:
    assert len(USAGE_CASES) >= 30
    assert {c["provider"] for c in USAGE_CASES} == set(MAPPERS)
    assert any(c["out"] is None for c in USAGE_CASES)


# -- helpers ---------------------------------------------------------------------


def test_make_usage_never_invents_optional_counts() -> None:
    assert make_usage(input=10, output=2) == {"inputTokens": 10, "outputTokens": 2, "inclusive": True}
    assert make_usage(input=10, output=2, cache_read=0) == {
        "inputTokens": 10,
        "outputTokens": 2,
        "inclusive": True,
        "cacheReadTokens": 0,
    }
    assert make_usage(cache_read=5) is None
    assert make_usage(output=3) == {"inputTokens": 0, "outputTokens": 3, "inclusive": True}


def test_token_count_rounds_like_javascript() -> None:
    assert token_count(2.5) == 3  # Math.round, not banker's rounding
    assert token_count(10.4) == 10
    assert token_count(True) is None
    assert token_count(-1) is None
    assert token_count(float("nan")) is None
    assert token_count(float("inf")) is None
    assert token_count("3") is None


def test_json_constants_are_not_json() -> None:
    assert tool_call("c", "f", "NaN") == {"id": "c", "name": "f", "input": None, "inputText": "NaN"}


def test_the_anthropic_accumulator_merges_raw_pieces() -> None:
    acc = AnthropicUsageAccumulator()
    assert acc.usage() is None
    acc.add({
        "input_tokens": 12,
        "output_tokens": 1,
        "cache_read_input_tokens": 4000,
        "cache_creation_input_tokens": None,
        "cache_creation": {"ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 200},
    })
    # A cumulative message_delta: output only, the rest null (unknown).
    acc.add({"output_tokens": 57, "input_tokens": None, "cache_read_input_tokens": None})
    assert acc.usage() == {
        "inputTokens": 4512,
        "outputTokens": 57,
        "inclusive": True,
        "cacheReadTokens": 4000,
        "cacheWriteTokens": 500,
    }


def test_anthropic_thinking_tokens_are_the_reasoning_count() -> None:
    from anthropic.types import Usage

    # The SDK object (anthropic-python 1.x types output_tokens_details).
    sdk = Usage.model_validate(
        {"input_tokens": 100, "output_tokens": 900, "output_tokens_details": {"thinking_tokens": 420}}
    )
    assert anthropic_usage(sdk) == {
        "inputTokens": 100,
        "outputTokens": 900,
        "inclusive": True,
        "reasoningTokens": 420,
    }
    # Streamed: message_delta carries the cumulative count.
    acc = AnthropicUsageAccumulator()
    acc.add({"input_tokens": 12, "output_tokens": 1, "output_tokens_details": None})
    acc.add({"output_tokens": 700, "output_tokens_details": {"thinking_tokens": 420}})
    acc.add({"output_tokens": 710})
    assert acc.usage() == {
        "inputTokens": 12,
        "outputTokens": 710,
        "inclusive": True,
        "reasoningTokens": 420,
    }


def test_capture_tools_sends_each_definition_once_per_run() -> None:
    owner = type("Owner", (), {})()
    weather = {"name": "get_weather", "input_schema": {"type": "object"}}
    first = capture_tools(owner, "r1", [weather])
    digest = schema_hash(weather)
    assert first == {
        "tools": [{"name": "get_weather", "schemaHash": digest}],
        "toolSchemas": {digest: weather},
    }
    assert capture_tools(owner, "r1", [weather]) == {"tools": first["tools"]}  # type: ignore[index]
    assert capture_tools(owner, "r2", [weather]) == first
    assert capture_tools(owner, "r1", []) is None
    assert capture_tools(owner, "r1", [{"description": "no name"}]) is None
    # Bounded: the least recently used run is forgotten.
    for index in range(MAX_SCHEMA_RUNS):
        capture_tools(owner, f"other-{index}", [weather])
    assert "toolSchemas" in (capture_tools(owner, "r1", [weather]) or {})
    reset_tool_schema_memory(owner)


def test_pick_params_skips_sentinels_and_unlisted_keys() -> None:
    class NotGiven:
        pass

    kwargs = {
        "model": "m",
        "temperature": 0.2,
        "max_tokens": 10,
        "top_p": NotGiven(),
        "seed": None,
        "metadata": {"user_id": "SECRET"},
        "extra_headers": {"x": "SECRET"},
    }
    assert pick_params(kwargs) == {"temperature": 0.2, "max_tokens": 10}


def test_record_value_keeps_everything_and_stays_json_safe() -> None:
    long = "x" * 50_000
    history = [{"role": "user", "content": f"{i}"} for i in range(500)]
    cyclic: dict[str, Any] = {"a": 1}
    cyclic["self"] = cyclic
    out = record_value(
        {"long": long, "history": history, "image": b"\x89PNG" * 4, "cyclic": cyclic}
    )
    assert out["long"] == long
    assert len(out["history"]) == 500
    assert out["image"] == {"type": "binary", "bytes": 16}
    assert out["cyclic"] == {"a": 1, "self": "[Circular]"}
    json.dumps(out)


# -- end to end ------------------------------------------------------------------


def _finished(viewer: Any) -> dict[str, Any]:
    return viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    )


def _started(viewer: Any) -> dict[str, Any]:
    return viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["nodeId"] == "llm:step"
    )


def _all_valid(viewer: Any, validate_frame: Any) -> None:
    for frame in viewer.frames():
        if "type" in frame and "gm" in frame:
            validate_frame(frame)


WEATHER_TOOL = {
    "type": "function",
    "function": {"name": "get_weather", "parameters": {"type": "object", "properties": {}}},
}


def test_openai_chat_records_the_request_and_a_truncated_tool_call(
    attached: Any, validate_frame: Any
) -> None:
    instance, viewer = attached()
    base = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "gpt-test"}
    chunks = [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
            {"index": 0, "id": "call_1", "type": "function",
             "function": {"name": "write", "arguments": ""}}]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": '{"path":"a.txt","content":"hel'}}]},
            "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "length"}]},
        {**base, "choices": [], "usage": {
            "prompt_tokens": 2048, "completion_tokens": 16, "total_tokens": 2064,
            "prompt_tokens_details": {"cached_tokens": 1920},
            "completion_tokens_details": {"reasoning_tokens": 0}}},
    ]
    body = sse(chunks)
    client, _ = make_openai(
        lambda request, recorder: __import__("httpx").Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    instance.instrument_openai(client)
    history = [{"role": "user", "content": "q" * 30_000}] * 3
    with instance.run("agent"):
        stream = client.chat.completions.create(
            model="gpt-test",
            messages=history,
            temperature=0.1,
            max_completion_tokens=16,
            tools=[WEATHER_TOOL],
            tool_choice="auto",
            user="SECRET-USER",
            stream=True,
            stream_options={"include_usage": True},
        )
        for _ in stream:
            pass
    started = _started(viewer)["payload"]["input"]
    digest = schema_hash(WEATHER_TOOL)
    assert started["messages"] == history  # in full: no 20,000-char cap
    assert started["temperature"] == 0.1
    assert started["max_completion_tokens"] == 16
    assert started["tool_choice"] == "auto"
    assert started["tools"] == [{"name": "get_weather", "schemaHash": digest}]
    assert started["toolSchemas"] == {digest: WEATHER_TOOL}
    assert "SECRET-USER" not in json.dumps(viewer.frames())
    finished = _finished(viewer)["payload"]
    assert finished["usage"] == {
        "inputTokens": 2048,
        "outputTokens": 16,
        "inclusive": True,
        "cacheReadTokens": 1920,
        "reasoningTokens": 0,
    }
    assert finished["output"]["finishReason"] == "length"
    assert finished["output"]["rawFinishReason"] == "length"
    assert finished["output"]["toolCalls"] == [
        {"id": "call_1", "name": "write", "input": None,
         "inputText": '{"path":"a.txt","content":"hel'}
    ]
    _all_valid(viewer, validate_frame)


def test_openai_chat_streamed_custom_tool_call_is_recorded_like_the_non_streaming_one(
    attached: Any, validate_frame: Any
) -> None:
    instance, viewer = attached()
    patch = "*** Begin Patch\n*** Update File: a.txt\n-old\n+new\n*** End Patch"
    base = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5"}

    def choice(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

    chunks = [
        choice({"role": "assistant", "content": None}),
        choice({"tool_calls": [{"index": 0, "id": "call_c1", "type": "custom",
                                "custom": {"name": "apply_patch", "input": ""}}]}),
        *[choice({"tool_calls": [{"index": 0, "custom": {"input": patch[i : i + 6]}}]})
          for i in range(0, len(patch), 6)],
        choice({}, "tool_calls"),
    ]
    body = sse(chunks)
    client, _ = make_openai(
        lambda request, recorder: __import__("httpx").Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    instance.instrument_openai(client)
    with instance.run("agent"):
        stream = client.chat.completions.create(
            model="gpt-5", messages=[{"role": "user", "content": "patch it"}], stream=True
        )
        for _ in stream:
            pass
    output = _finished(viewer)["payload"]["output"]
    assert output["finishReason"] == "tool-calls"
    assert output["toolCalls"] == [{"id": "call_c1", "name": "apply_patch", "input": patch}]
    streamed = "".join(
        delta["v"]
        for f in viewer.frames()
        if f.get("type") == "node.token"
        for delta in f["payload"]["deltas"]
        if delta.get("t") == "tool-args"
    )
    assert streamed == patch
    _all_valid(viewer, validate_frame)


def test_openai_refusals_normalize_to_content_filter(attached: Any, validate_frame: Any) -> None:
    instance, viewer = attached()
    httpx = __import__("httpx")
    completion = {
        "id": "c1", "object": "chat.completion", "created": 1, "model": "gpt-5",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": None, "refusal": "I cannot help."}}],
    }
    base = {"id": "c2", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5"}
    chunks = [
        {**base, "choices": [{"index": 0, "delta": {"refusal": "I cannot"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ]
    responses = [
        httpx.Response(200, json=completion),
        httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(chunks)),
    ]
    client, _ = make_openai(lambda request, recorder: responses.pop(0))
    instance.instrument_openai(client)
    with instance.run("agent"):
        client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "x"}])
        for _ in client.chat.completions.create(
            model="gpt-5", messages=[{"role": "user", "content": "y"}], stream=True
        ):
            pass
    viewer.wait_for(
        lambda f: sum(
            1 for g in viewer.frames()
            if g.get("type") == "node.finished" and g["payload"]["nodeId"] == "llm:step"
        ) >= 2
    )
    outputs = [
        f["payload"]["output"] for f in viewer.frames()
        if f.get("type") == "node.finished" and f["payload"]["nodeId"] == "llm:step"
    ]
    for output in outputs:
        assert output["finishReason"] == "content-filter"
        assert output["rawFinishReason"] == "stop"
    _all_valid(viewer, validate_frame)


def test_anthropic_stream_usage_is_inclusive_and_a_cut_tool_use_keeps_its_text(
    attached: Any, validate_frame: Any
) -> None:
    instance, viewer = attached()
    events = [
        {"type": "message_start", "message": {
            "id": "m", "type": "message", "role": "assistant", "model": "claude-test",
            "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 12, "output_tokens": 1, "cache_read_input_tokens": 4000,
                      "cache_creation": {"ephemeral_5m_input_tokens": 300,
                                         "ephemeral_1h_input_tokens": 200}}}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "tool_use", "id": "toolu_ok", "name": "ls", "input": {}}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1,
         "content_block": {"type": "tool_use", "id": "toolu_cut", "name": "write", "input": {}}},
        {"type": "content_block_delta", "index": 1,
         "delta": {"type": "input_json_delta", "partial_json": '{"path":"a'}},
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens", "stop_sequence": None},
         "usage": {"output_tokens": 64}},
        {"type": "message_stop"},
    ]
    body = anthropic_sse(events)
    client, _ = make_anthropic(
        lambda request, recorder: ANTHROPIC_HTTPX.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    instance.instrument_anthropic(client)
    tool = {"name": "write", "input_schema": {"type": "object"}}
    with instance.run("agent"):
        stream = client.messages.create(
            model="claude-test", max_tokens=64, stop_sequences=["END"], messages=[{"role": "user", "content": "go"}],
            system="be terse", tools=[tool], stream=True,
            metadata={"user_id": "SECRET-USER"},
        )
        for _ in stream:
            pass
    started = _started(viewer)["payload"]["input"]
    assert started["system"] == "be terse"
    assert started["max_tokens"] == 64
    assert started["stop_sequences"] == ["END"]
    assert started["tools"] == [{"name": "write", "schemaHash": schema_hash(tool)}]
    assert "SECRET-USER" not in json.dumps(viewer.frames())
    finished = _finished(viewer)["payload"]
    assert finished["usage"] == {
        "inputTokens": 4512,
        "outputTokens": 64,
        "inclusive": True,
        "cacheReadTokens": 4000,
        "cacheWriteTokens": 500,
    }
    assert finished["output"]["finishReason"] == "length"
    assert finished["output"]["rawFinishReason"] == "max_tokens"
    assert finished["output"]["toolCalls"] == [
        {"id": "toolu_ok", "name": "ls", "input": {}},
        {"id": "toolu_cut", "name": "write", "input": None, "inputText": '{"path":"a'},
    ]
    _all_valid(viewer, validate_frame)


def test_a_step_shrunk_by_the_budget_does_not_use_up_the_runs_intact_tool_definition(
    attached: Any, validate_frame: Any
) -> None:
    instance, viewer = attached()
    message = {
        "id": "m", "type": "message", "role": "assistant", "model": "claude-test",
        "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
        "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 1},
    }
    client, _ = make_anthropic(lambda request, recorder: ANTHROPIC_HTTPX.Response(200, json=message))
    instance.instrument_anthropic(client)
    run_sql = {
        "name": "run_sql",
        "description": "Run a read-only SQL query",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "enum": [10, 100]}},
            "required": ["query"],
        },
    }
    big_document = "lorem ipsum dolor sit amet " * 24_000  # ~650 KB > the 512 KB budget
    with instance.run("agent"):
        for content in (f"Summarise:\n{big_document}", "Now count the rows.", "And again."):
            client.messages.create(
                model="claude-test", max_tokens=64, messages=[{"role": "user", "content": content}],
                tools=[run_sql],
            )
    viewer.wait_for(
        lambda f: sum(
            1 for g in viewer.frames()
            if g.get("type") == "node.finished" and g["payload"]["nodeId"] == "llm:step"
        ) >= 3
    )
    started = [
        f["payload"] for f in viewer.frames()
        if f.get("type") == "node.started" and f["payload"]["nodeId"] == "llm:step"
    ]
    digest = schema_hash(run_sql)
    # Step 1 was shrunk (its arrays emptied), so step 2 sends the definition
    # again, intact; step 3 only references it.
    assert started[0].get("__graphmindTruncated") is True
    assert started[1]["input"]["tools"] == [{"name": "run_sql", "schemaHash": digest}]
    assert started[1]["input"]["toolSchemas"] == {digest: run_sql}
    assert "toolSchemas" not in started[2]["input"]
    _all_valid(viewer, validate_frame)


def test_langchain_chat_model_usage_finish_reason_and_tool_calls(
    attached: Any, validate_frame: Any
) -> None:
    pytest.importorskip("langchain_core")
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    from graphmind.integrations.langchain import GraphMindCallbackHandler

    class Scripted(BaseChatModel):
        @property
        def _llm_type(self) -> str:
            return "scripted"

        @property
        def _identifying_params(self) -> dict[str, Any]:
            return {"model": "scripted-1", "temperature": 0.3, "api_key": "SECRET-KEY"}

        def _generate(self, messages: Any, stop: Any = None, run_manager: Any = None,
                      **kwargs: Any) -> ChatResult:
            message = AIMessage(
                content="checking",
                tool_calls=[{"id": "c1", "name": "get_weather", "args": {"city": "Lisbon"}}],
                invalid_tool_calls=[{"id": "c2", "name": "write", "args": '{"a', "error": "bad"}],
                usage_metadata={
                    "input_tokens": 1350, "output_tokens": 40, "total_tokens": 1390,
                    "input_token_details": {"cache_read": 1000, "cache_creation": 300},
                    "output_token_details": {"reasoning": 12},
                },
                response_metadata={"stop_reason": "tool_use"},
            )
            return ChatResult(generations=[ChatGeneration(message=message)])

    instance, viewer = attached()
    handler = GraphMindCallbackHandler(instance.session)
    long = "z" * 40_000
    Scripted().invoke([HumanMessage(long)], config={"callbacks": [handler]})
    started = viewer.wait_for(
        lambda f: f.get("type") == "node.started" and f["payload"]["kind"] == "llm"
    )["payload"]["input"]
    assert started["messages"][0][0]["content"] == long
    assert started["temperature"] == 0.3
    assert "SECRET-KEY" not in json.dumps(viewer.frames())
    finished = viewer.wait_for(
        lambda f: f.get("type") == "node.finished" and f["payload"]["nodeId"].startswith("llm:")
    )["payload"]
    assert finished["usage"] == {
        "inputTokens": 1350,
        "outputTokens": 40,
        "inclusive": True,
        "cacheReadTokens": 1000,
        "cacheWriteTokens": 300,
        "reasoningTokens": 12,
    }
    assert finished["output"]["finishReason"] == "tool-calls"
    assert finished["output"]["rawFinishReason"] == "tool_use"
    assert finished["output"]["toolCalls"] == [
        {"id": "c1", "name": "get_weather", "input": {"city": "Lisbon"}},
        {"id": "c2", "name": "write", "input": None, "inputText": '{"a'},
    ]
    _all_valid(viewer, validate_frame)
