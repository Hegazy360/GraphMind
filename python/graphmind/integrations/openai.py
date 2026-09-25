"""OpenAI SDK integration.

``instrument_openai(client)`` patches the *instance*'s bound methods:

* ``client.chat.completions.create`` (and ``.parse``, when present)
* ``client.responses.create``

Sync (``OpenAI``) and async (``AsyncOpenAI``) clients are both supported, as
are streaming responses — the stream is teed, so the host consumes exactly what
the provider sent while GraphMind observes deltas.

``.with_raw_response.create`` and ``.with_streaming_response.create`` (the
latter is what the OpenAI Agents SDK's ``Runner.run_streamed`` calls) reach the
same patched method: the host gets the SDK's raw response object back, and the
event stream its ``.parse()`` returns is teed like any other.

The ``before`` gate is awaited **before** the HTTP request is issued: while a
gate is held nothing is in flight, so holds are indefinite by design and cost
no provider time. ``inject`` substitutes the whole response object, rebuilt as
the SDK type the call returns (``ChatCompletion``, ``ParsedChatCompletion``,
``Response``) from a bare string or an object with that type's fields — which
is how you replay a model answer without paying for it.

No import of ``openai`` happens at import time — everything is duck-typed, so
this module is importable with the SDK absent. The reply types are imported
lazily, from the client's own package, only when something is injected.
"""

from __future__ import annotations

import functools
import time
from collections.abc import Callable
from typing import Any

from ..clock import elapsed_ms, monotonic_ms
from ..gate import GateNode
from ..ids import LLM_NODE_ID, LLM_NODE_NAME, agent_node_id, next_id
from ..llm_capture import (
    capture_tools,
    finish_fields,
    openai_chat_usage,
    openai_responses_usage,
    pick_params,
    record_value,
    tool_call,
)
from ..session import Session
from ._common import (
    AsyncStreamTee,
    GraphHinter,
    ReplyType,
    SyncStreamTee,
    close_raw,
    close_raw_async,
    injected_response,
    is_async_callable,
    is_async_client,
    json_arguments,
    observe_raw_stream,
    parse_raw,
    parse_raw_async,
    patch_method,
    placeholder_id,
    raw_mode,
    rebuild_reply,
    refresh_raw_wrappers,
    safe_value,
    sdk_packages,
    unpatch_method,
    warn_once,
)

SDK_NAME = "openai"

#: (resource path, method, flavor, reply type as (module, class) candidates
#: relative to the client's package — tried in order).
_TARGETS: tuple[tuple[tuple[str, ...], str, str, tuple[tuple[str, str], ...]], ...] = (
    (("chat", "completions"), "create", "chat", (("types.chat", "ChatCompletion"),)),
    (
        ("chat", "completions"),
        "parse",
        "chat",
        (("types.chat", "ParsedChatCompletion"), ("types.chat", "ChatCompletion")),
    ),
    (("responses",), "create", "responses", (("types.responses", "Response"),)),
)

_RAW_STREAM_INJECT = (
    "`inject` is not supported on a with_streaming_response / with_raw_response call "
    "made with stream=True (GraphMind cannot fabricate the provider's raw HTTP stream); "
    "treating it as `continue`. Inject on a non-streamed call instead."
)
_STREAM_INJECT = (
    "`inject` on a stream=True call hands your payload back as-is: GraphMind cannot "
    "synthesize a provider event stream, so code that iterates it gets no chunks. "
    "Inject on a non-streamed call instead."
)


# -- input / output shaping ---------------------------------------------------


def _describe(session: Session, flavor: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    """``node.started.input``: the request as sent (contract C1) — ``model``,
    ``instructions`` and ``messages`` / ``input`` in full (the per-event 512 KB
    shrink is the only bound), the sampling parameters under the API's own
    names (``temperature``, ``max_tokens`` / ``max_completion_tokens`` /
    ``max_output_tokens``, ``top_p``, ``stop``, ``seed``, ``tool_choice``,
    ``reasoning``, ``text``, ... — an allow-list; ``metadata``, ``user`` and
    the ``extra_*`` request options are never read), and ``tools: [{name,
    schemaHash}]`` with each definition sent once per run as ``toolSchemas``."""
    payload: dict[str, Any] = {"provider": SDK_NAME}
    for key in ("model", "instructions", "previous_response_id"):
        value = kwargs.get(key)
        if value is not None and type(value).__name__ not in ("NotGiven", "Omit"):
            payload[key] = record_value(value)
    if flavor == "chat":
        payload["messages"] = record_value(kwargs.get("messages"))
    else:
        payload["input"] = record_value(kwargs.get("input"))
    payload.update(pick_params(kwargs))
    ctx = session.current_run()
    run_key = ctx.run_id if ctx is not None else "implicit"
    tools = capture_tools(session, run_key, kwargs.get("tools"))
    if tools:
        payload.update(tools)
    if kwargs.get("stream") is True:
        payload["stream"] = True
    return payload


def _chat_tool_calls(calls: Any) -> list[dict[str, Any]]:
    """A message's ``tool_calls`` as ``{id, name, input, inputText?}``: a
    function's JSON arguments parsed (the text kept when it does not parse —
    cut off by ``length``); a custom (freeform) tool's input is text by design
    and recorded as the string it is."""
    out: list[dict[str, Any]] = []
    for call in calls or []:
        function = getattr(call, "function", None)
        if function is None and isinstance(call, dict):
            function = call.get("function")
        if function is not None:
            name = getattr(function, "name", None)
            arguments = getattr(function, "arguments", None)
            if isinstance(function, dict):
                name, arguments = function.get("name"), function.get("arguments")
            call_id = call.get("id") if isinstance(call, dict) else getattr(call, "id", None)
            recorded = tool_call(call_id, name, arguments)
            if recorded is not None:
                out.append(recorded)
            continue
        custom = getattr(call, "custom", None)
        name = getattr(custom, "name", None)
        if isinstance(name, str) and name:
            entry: dict[str, Any] = {"name": name, "input": getattr(custom, "input", None) or ""}
            call_id = getattr(call, "id", None)
            if isinstance(call_id, str) and call_id:
                entry = {"id": call_id, **entry}
            out.append(entry)
    return out


def _responses_tool_calls(output: Any) -> list[dict[str, Any]]:
    """The locally executed calls in a Response's ``output`` items."""
    out: list[dict[str, Any]] = []
    for item in output or []:
        kind = getattr(item, "type", None)
        if kind == "function_call":
            recorded = tool_call(
                getattr(item, "call_id", None),
                getattr(item, "name", None),
                getattr(item, "arguments", None),
            )
            if recorded is not None:
                out.append(recorded)
        elif kind == "custom_tool_call":
            name = getattr(item, "name", None)
            if not isinstance(name, str) or not name:
                continue
            entry: dict[str, Any] = {"name": name, "input": getattr(item, "input", None) or ""}
            call_id = getattr(item, "call_id", None)
            if isinstance(call_id, str) and call_id:
                entry = {"id": call_id, **entry}
            out.append(entry)
    return out


def _summarize(flavor: str, result: Any) -> dict[str, Any]:
    """``node.finished.output``: text, the requested ``toolCalls``, the
    normalized ``finishReason`` and the API's own value as ``rawFinishReason``
    (chat: the first choice's ``finish_reason``; Responses: the incomplete
    reason when it stopped early, else the ``status``)."""
    out: dict[str, Any] = {}
    try:
        if flavor == "chat":
            choices = getattr(result, "choices", None) or []
            texts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            finish_reason: str | None = None
            refused = False
            for choice in choices:
                message = getattr(choice, "message", None)
                content = getattr(message, "content", None)
                if isinstance(content, str) and content:
                    texts.append(content)
                refusal = getattr(message, "refusal", None)
                if isinstance(refusal, str) and refusal:
                    refused = True
                parsed = getattr(message, "parsed", None)
                if parsed is not None:
                    out["parsed"] = safe_value(parsed)
                tool_calls.extend(_chat_tool_calls(getattr(message, "tool_calls", None)))
                if finish_reason is None:
                    finish_reason = getattr(choice, "finish_reason", None)
            out["text"] = "".join(texts)
            if tool_calls:
                out["toolCalls"] = tool_calls
            out.update(finish_fields(finish_reason, bool(tool_calls), refused))
        else:
            text = getattr(result, "output_text", None)
            if isinstance(text, str):
                out["text"] = safe_value(text)
            output = getattr(result, "output", None)
            calls = _responses_tool_calls(output)
            if calls:
                out["toolCalls"] = calls
            status = getattr(result, "status", None)
            reason = getattr(getattr(result, "incomplete_details", None), "reason", None)
            raw = reason if isinstance(reason, str) and reason else status
            refused = any(
                _field(part, "type") == "refusal"
                for item in output or []
                for part in (_field(item, "content") or [])
            )
            out.update(finish_fields(raw, bool(calls), refused))
            if isinstance(status, str):
                out["status"] = status
            # Not the raw ``output`` items too (TS parity): their
            # ``arguments`` / ``input`` would carry, one key over, the very
            # tool-call arguments the redaction switches hide in ``toolCalls``.
    except Exception:
        pass
    return out


def _reported_usage(flavor: str, result: Any) -> dict[str, Any] | None:
    """The inclusive wire usage of a complete (non-streamed) result."""
    usage = getattr(result, "usage", None)
    return openai_chat_usage(usage) if flavor == "chat" else openai_responses_usage(usage)


# -- typed inject: what a human types -> the SDK type's fields ------------------


def _chat_tool_call(call: Any, index: int) -> Any:
    if not isinstance(call, dict):
        return call
    call = dict(call)
    function = call.get("function")
    if isinstance(function, dict):
        function = dict(function)
    else:
        function = {"name": call.pop("name", None), "arguments": call.pop("arguments", None)}
    function["arguments"] = json_arguments(function.get("arguments"))
    call["function"] = function
    call.setdefault("id", f"call_graphmind_{index}")
    call.setdefault("type", "function")
    return call


def _usage(value: Any, fields: tuple[str, str], details: dict[str, dict[str, int]]) -> Any:
    """Fill the parts of a typed-in usage object people leave out.

    Only when some usage was given — an injected reply without one keeps
    ``usage=None``. The detail sub-objects differ between SDK releases
    (``cache_write_tokens`` is recent) and the SDK models accept extra keys, so
    over-filling is harmless on older versions.
    """
    if not isinstance(value, dict):
        return value
    usage = dict(value)
    first, second = fields
    usage.setdefault(first, 0)
    usage.setdefault(second, 0)
    if isinstance(usage[first], int) and isinstance(usage[second], int):
        usage.setdefault("total_tokens", usage[first] + usage[second])
    for key, defaults in details.items():
        given = usage.get(key)
        if given is None:
            usage[key] = dict(defaults)
        elif isinstance(given, dict):
            usage[key] = {**defaults, **given}
    return usage


def _chat_reply(value: Any, model: str) -> dict[str, Any] | None:
    """A ``ChatCompletion`` from a string, a bare message, or (part of) a completion."""
    if isinstance(value, str):
        data: dict[str, Any] = {"choices": [{"message": {"content": value}}]}
    elif isinstance(value, dict):
        data = dict(value)
        if "choices" not in data:
            # A bare assistant message: {"content": ...} / {"tool_calls": [...]}.
            message = {
                key: data.pop(key)
                for key in ("role", "content", "tool_calls", "refusal", "parsed")
                if key in data
            }
            if "content" not in message and isinstance(data.get("text"), str):
                message["content"] = data.pop("text")
            if not message:
                return None
            data["choices"] = [{"message": message}]
    else:
        return None
    choices = data.get("choices")
    if isinstance(choices, list):
        rebuilt: list[Any] = []
        for index, choice in enumerate(choices):
            if isinstance(choice, str):
                choice = {"message": {"content": choice}}
            if isinstance(choice, dict):
                choice = dict(choice)
                given = choice.get("message")
                if isinstance(given, str):
                    given = {"content": given}
                reply: dict[str, Any] = dict(given) if isinstance(given, dict) else {}
                reply.setdefault("role", "assistant")
                calls = reply.get("tool_calls")
                if isinstance(calls, list):
                    reply["tool_calls"] = [_chat_tool_call(c, i) for i, c in enumerate(calls)]
                choice["message"] = reply
                choice.setdefault("index", index)
                choice.setdefault(
                    "finish_reason", "tool_calls" if reply.get("tool_calls") else "stop"
                )
            rebuilt.append(choice)
        data["choices"] = rebuilt
    if "usage" in data:
        data["usage"] = _usage(data["usage"], ("prompt_tokens", "completion_tokens"), {})
    data.setdefault("id", placeholder_id("chatcmpl-"))
    data.setdefault("object", "chat.completion")
    data.setdefault("created", int(time.time()))
    data.setdefault("model", model)
    return data


def _output_text(part: Any) -> Any:
    if isinstance(part, str):
        return {"type": "output_text", "text": part, "annotations": []}
    if isinstance(part, dict):
        part = dict(part)
        if "type" not in part and "text" in part:
            part["type"] = "output_text"
        if part.get("type") == "output_text":
            part.setdefault("annotations", [])
    return part


def _responses_item(item: Any, index: int) -> Any:
    if isinstance(item, str):
        item = {"content": [item]}
    if not isinstance(item, dict):
        return item
    item = dict(item)
    if "type" not in item:
        item["type"] = "function_call" if "arguments" in item or "call_id" in item else "message"
    if item["type"] == "message":
        if "content" not in item and isinstance(item.get("text"), str):
            item["content"] = [item.pop("text")]
        content = item.get("content")
        if isinstance(content, str):
            content = [content]
        if isinstance(content, list):
            item["content"] = [_output_text(part) for part in content]
        item.setdefault("id", f"msg_graphmind_{index}")
        item.setdefault("role", "assistant")
        item.setdefault("status", "completed")
    elif item["type"] == "function_call":
        item["arguments"] = json_arguments(item.get("arguments"))
        item.setdefault("call_id", f"call_graphmind_{index}")
    return item


def _responses_reply(value: Any, model: str) -> dict[str, Any] | None:
    """A ``Response`` from a string or (part of) a response object."""
    if isinstance(value, str):
        data: dict[str, Any] = {"output": [value]}
    elif isinstance(value, dict):
        data = dict(value)
        # `output_text` is a read-only property on Response, and `text` is a
        # config object there, so a string in either can only mean "the reply".
        text = data.pop("output_text", None)
        if "output" not in data:
            if not isinstance(text, str) and isinstance(data.get("text"), str):
                text = data.pop("text")
            if not isinstance(text, str):
                return None
            data["output"] = [text]
    else:
        return None
    output = data.get("output")
    if isinstance(output, list):
        data["output"] = [_responses_item(item, index) for index, item in enumerate(output)]
    if "usage" in data:
        data["usage"] = _usage(
            data["usage"],
            ("input_tokens", "output_tokens"),
            {
                "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        )
    data.setdefault("id", placeholder_id("resp_"))
    data.setdefault("object", "response")
    data.setdefault("created_at", time.time())
    data.setdefault("model", model)
    data.setdefault("status", "completed")
    data.setdefault("parallel_tool_calls", True)
    data.setdefault("tool_choice", "auto")
    data.setdefault("tools", [])
    return data


_REPLY_BUILDERS: dict[str, Callable[[Any, str], dict[str, Any] | None]] = {
    "chat": _chat_reply,
    "responses": _responses_reply,
}


# -- streams ------------------------------------------------------------------


class _StreamState:
    __slots__ = ("calls", "chunks", "final", "finish_reason", "refused", "text", "usage")

    def __init__(self) -> None:
        self.text: list[str] = []
        self.usage: dict[str, Any] | None = None
        self.finish_reason: str | None = None
        self.chunks = 0
        #: The terminal ``Response`` of a Responses-API stream, when one arrived.
        self.final: Any = None
        #: Streamed chat tool calls by index: [id, name, argument text, custom?].
        self.calls: dict[int, list[Any]] = {}
        #: A chat stream carried refusal deltas (a stop that is a refusal).
        self.refused = False

    def tool_calls(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for index in sorted(self.calls):
            call_id, name, text, custom = self.calls[index]
            if custom:
                # A custom (freeform) tool's input is text by design: recorded
                # as the string, as _chat_tool_calls does.
                if not isinstance(name, str) or not name:
                    continue
                entry: dict[str, Any] = {"name": name, "input": text}
                out.append({"id": call_id, **entry} if call_id else entry)
                continue
            recorded = tool_call(call_id, name, text)
            if recorded is not None:
                out.append(recorded)
        return out

    def output(self) -> dict[str, Any]:
        out: dict[str, Any] = {"text": safe_value("".join(self.text)), "chunks": self.chunks}
        calls = self.tool_calls()
        if calls:
            out["toolCalls"] = calls
        out.update(finish_fields(self.finish_reason, bool(calls), self.refused))
        return out


def _field(source: Any, key: str) -> Any:
    """``source.key``, or ``source[key]`` for a dict (a field the installed SDK
    does not model yet arrives as the raw dict)."""
    if isinstance(source, dict):
        return source.get(key)
    return getattr(source, key, None)


def _observe_chat_chunk(session: Session, node_id: str, state: _StreamState, chunk: Any) -> None:
    state.chunks += 1
    # With stream_options.include_usage the usage rides the LAST chunk (empty
    # choices); a later report replaces an earlier one.
    usage = openai_chat_usage(getattr(chunk, "usage", None))
    if usage is not None:
        state.usage = usage
    for choice in getattr(chunk, "choices", None) or []:
        delta = getattr(choice, "delta", None)
        if delta is None:
            continue
        content = getattr(delta, "content", None)
        if isinstance(content, str) and content:
            state.text.append(content)
            session.push_token(node_id, "text", content)
        refusal = getattr(delta, "refusal", None)
        if isinstance(refusal, str) and refusal:
            state.refused = True
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        if isinstance(reasoning, str) and reasoning:
            session.push_token(node_id, "reasoning", reasoning)
        for call in getattr(delta, "tool_calls", None) or []:
            function = getattr(call, "function", None)
            # A custom (freeform) tool streams ``custom: {name, input}`` (openai 2.x+).
            custom = getattr(call, "custom", None)
            index = getattr(call, "index", None)
            entry = state.calls.setdefault(
                index if isinstance(index, int) else 0, [None, None, "", False]
            )
            if getattr(call, "type", None) == "custom" or custom is not None:
                entry[3] = True
            source = custom if entry[3] else function
            arguments = _field(source, "input" if entry[3] else "arguments")
            call_id = getattr(call, "id", None)
            if isinstance(call_id, str) and call_id:
                entry[0] = call_id
            name = _field(source, "name")
            if isinstance(name, str) and name:
                entry[1] = name
            if isinstance(arguments, str) and arguments:
                entry[2] += arguments
                session.push_token(node_id, "tool-args", arguments)
        reason = getattr(choice, "finish_reason", None)
        if isinstance(reason, str) and reason:
            state.finish_reason = reason


def _observe_responses_event(
    session: Session, node_id: str, state: _StreamState, event: Any
) -> None:
    state.chunks += 1
    event_type = getattr(event, "type", None)
    delta = getattr(event, "delta", None)
    if event_type == "response.output_text.delta" and isinstance(delta, str) and delta:
        state.text.append(delta)
        session.push_token(node_id, "text", delta)
    elif event_type == "response.function_call_arguments.delta" and isinstance(delta, str):
        session.push_token(node_id, "tool-args", delta)
    elif event_type in (
        "response.reasoning_summary_text.delta",
        "response.reasoning_text.delta",
    ) and isinstance(delta, str):
        session.push_token(node_id, "reasoning", delta)
    elif event_type in ("response.completed", "response.incomplete", "response.failed"):
        response = getattr(event, "response", None)
        if response is not None:
            state.final = response
        usage = openai_responses_usage(getattr(response, "usage", None))
        if usage is not None:
            state.usage = usage
        status = getattr(response, "status", None)
        if isinstance(status, str):
            state.finish_reason = status


_OBSERVERS: dict[str, Callable[[Session, str, _StreamState, Any], None]] = {
    "chat": _observe_chat_chunk,
    "responses": _observe_responses_event,
}


# -- the wrapper --------------------------------------------------------------


class _Call:
    """Per-invocation bookkeeping shared by the sync and async paths."""

    __slots__ = (
        "finished",
        "flavor",
        "hinter",
        "instance_id",
        "model",
        "node",
        "reply",
        "session",
        "started",
    )

    def __init__(
        self, session: Session, hinter: GraphHinter, flavor: str, reply: ReplyType
    ) -> None:
        self.session = session
        self.hinter = hinter
        self.flavor = flavor
        self.reply = reply
        self.instance_id = next_id("step")
        # exec.paused names this step's execution (parallel steps stay apart).
        self.node = GateNode(LLM_NODE_ID, "llm", LLM_NODE_NAME, self.instance_id)
        self.started = monotonic_ms()
        self.model = "graphmind-injected"
        self.finished = False

    def begin(self, kwargs: dict[str, Any]) -> None:
        ctx = self.session.current_run()
        self.hinter.maybe_hint(self.session, kwargs.get("tools"), LLM_NODE_ID, LLM_NODE_NAME)
        self.session.start_node(
            node_id=LLM_NODE_ID,
            kind="llm",
            name=LLM_NODE_NAME,
            instance_id=self.instance_id,
            parent_id=agent_node_id(ctx.name) if ctx is not None else None,
            input=_describe(self.session, self.flavor, kwargs),
            extra={"sdk": SDK_NAME},
        )
        model = kwargs.get("model")
        if isinstance(model, str) and model:
            self.model = model
        self.started = monotonic_ms()

    def finish(
        self,
        output: Any,
        status: str,
        usage: dict[str, int] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        # Once only: a raw stream can end through the tee *and* through the
        # response's close(), whichever the host reaches first.
        if self.finished:
            return
        self.finished = True
        self.session.finish_node(
            node_id=LLM_NODE_ID,
            instance_id=self.instance_id,
            duration_ms=elapsed_ms(self.started),
            status=status,
            output=output,
            usage=usage,
            extra=extra,
        )

    # -- inject -----------------------------------------------------------------

    def can_inject(self, raw: str | None, streaming: bool) -> bool:
        if raw is not None and streaming:
            warn_once("openai-raw-stream-inject", _RAW_STREAM_INJECT)
            return False
        return True

    def inject(
        self,
        value: Any,
        raw: str | None,
        streaming: bool,
        async_api: bool,
        like: Any = None,
        recovered: bool = False,
    ) -> Any:
        """Finish the node as injected and build what the host gets back."""
        extra: dict[str, Any] = {"injected": True}
        if recovered:
            extra["recoveredFromError"] = True
        self.finish(safe_value(value), "ok", None, extra)
        if streaming:
            warn_once("openai-stream-inject", _STREAM_INJECT)
            return value
        reply = self.rebuild(value, like)
        if raw is not None:
            return injected_response(reply, raw, async_api)
        return reply

    def rebuild(self, value: Any, like: Any = None) -> Any:
        cls = self.reply.resolve(like)
        if cls is None:
            return value
        build = _REPLY_BUILDERS[self.flavor]
        model = self.model
        return rebuild_reply(value, cls, lambda v: build(v, model), f"openai.{self.flavor}")

    # -- streams ----------------------------------------------------------------

    def tee(self, result: Any, is_async: bool, state: _StreamState | None = None) -> Any:
        stream_state = state if state is not None else _StreamState()
        observe = _OBSERVERS[self.flavor]

        def on_chunk(chunk: Any) -> None:
            observe(self.session, LLM_NODE_ID, stream_state, chunk)

        def on_end(error: BaseException | None) -> None:
            self.end_stream(stream_state, error)

        tee_cls = AsyncStreamTee if is_async else SyncStreamTee
        return tee_cls(result, on_chunk, on_end)

    def end_stream(self, state: _StreamState, error: BaseException | None) -> None:
        if self.finished:
            return
        output = state.output()
        if state.final is not None:
            # A Responses-API stream ends with the whole Response: report the
            # same fields a non-streamed call does (tool calls, status).
            summary = _summarize(self.flavor, state.final)
            if not summary.get("text"):
                summary.pop("text", None)
            output.update(summary)
        if error is not None:
            self.session.error_node(LLM_NODE_ID, self.instance_id, error)
            self.finish(output, "error", state.usage, {"streaming": True})
        else:
            self.finish(output, "ok", state.usage, {"streaming": True})

    def raw_stream(self, raw: Any) -> Any:
        """A raw-response call made with ``stream=True``: tee what ``.parse()`` returns."""
        state = _StreamState()

        def tee(stream: Any) -> Any:
            return self.tee(stream, hasattr(stream, "__aiter__"), state)

        def on_close() -> None:
            self.end_stream(state, None)

        if not observe_raw_stream(raw, tee, on_close):
            self.end_stream(state, None)
        return raw


def _is_stream(result: Any, kwargs: dict[str, Any], is_async: bool) -> bool:
    # Without an explicit `stream=True`, only treat the result as a stream when
    # it is not obviously a parsed model object.
    if kwargs.get("stream") is not True and (
        hasattr(result, "model_dump") or hasattr(result, "choices")
    ):
        return False
    attr = "__aiter__" if is_async else "__iter__"
    return hasattr(result, attr)


# A raw-response call (`raw` is "true" / "stream") hands the host the SDK's raw
# response instead of a parsed object. Non-streamed, the wrapper parses it the
# way the host's `.parse()` would (the SDK caches the result) so the `after`
# gate and the node see the real reply; streamed, it tees the stream `.parse()`
# returns. An injected reply comes back wrapped in a stand-in with `.parse()`.


def _make_sync_wrapper(
    session: Session, hinter: GraphHinter, flavor: str, reply: ReplyType
) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return original(*args, **kwargs)
            call = _Call(session, hinter, flavor, reply)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("openai-begin", "failed to record an OpenAI call", exc)
                return original(*args, **kwargs)
            ctx = session.current_run()
            raw = raw_mode(kwargs)
            streaming = kwargs.get("stream") is True
            while True:
                pre = session.gate("before", call.node)
                if pre.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                if pre.action == "inject" and call.can_inject(raw, streaming):
                    return call.inject(pre.output, raw, streaming, False)
                try:
                    result = original(*args, **kwargs)
                except Exception as exc:
                    session.error_node(LLM_NODE_ID, call.instance_id, exc)
                    decision = session.gate("error", call.node)
                    if decision.action == "inject" and call.can_inject(raw, streaming):
                        return call.inject(decision.output, raw, streaming, False, recovered=True)
                    if decision.action == "retry":
                        continue
                    if decision.action == "abort":
                        call.finish(None, "aborted")
                        raise session.abort_error(ctx) from exc
                    call.finish(None, "error")
                    raise
                if raw is not None and streaming:
                    return call.raw_stream(result)
                if raw is None and _is_stream(result, kwargs, False):
                    return call.tee(result, False)
                parsed = parse_raw(result) if raw is not None else result
                post = session.gate("after", call.node)
                if post.action == "inject":
                    if raw is not None:
                        close_raw(result)
                    return call.inject(post.output, raw, False, False, like=parsed)
                if post.action == "retry":
                    if raw is not None:
                        close_raw(result)
                    continue
                if post.action == "abort":
                    if raw is not None:
                        close_raw(result)
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                call.finish(_summarize(flavor, parsed), "ok", _reported_usage(flavor, parsed))
                return result

        return wrapper

    return factory


def _make_async_wrapper(
    session: Session, hinter: GraphHinter, flavor: str, reply: ReplyType
) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return await original(*args, **kwargs)
            call = _Call(session, hinter, flavor, reply)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("openai-begin", "failed to record an OpenAI call", exc)
                return await original(*args, **kwargs)
            ctx = session.current_run()
            raw = raw_mode(kwargs)
            streaming = kwargs.get("stream") is True
            while True:
                pre = await session.gate_async("before", call.node)
                if pre.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                if pre.action == "inject" and call.can_inject(raw, streaming):
                    return call.inject(pre.output, raw, streaming, True)
                try:
                    result = await original(*args, **kwargs)
                except Exception as exc:
                    session.error_node(LLM_NODE_ID, call.instance_id, exc)
                    decision = await session.gate_async("error", call.node)
                    if decision.action == "inject" and call.can_inject(raw, streaming):
                        return call.inject(decision.output, raw, streaming, True, recovered=True)
                    if decision.action == "retry":
                        continue
                    if decision.action == "abort":
                        call.finish(None, "aborted")
                        raise session.abort_error(ctx) from exc
                    call.finish(None, "error")
                    raise
                if raw is not None and streaming:
                    return call.raw_stream(result)
                if raw is None and _is_stream(result, kwargs, True):
                    return call.tee(result, True)
                parsed = await parse_raw_async(result) if raw is not None else result
                post = await session.gate_async("after", call.node)
                if post.action == "inject":
                    if raw is not None:
                        await close_raw_async(result)
                    return call.inject(post.output, raw, False, True, like=parsed)
                if post.action == "retry":
                    if raw is not None:
                        await close_raw_async(result)
                    continue
                if post.action == "abort":
                    if raw is not None:
                        await close_raw_async(result)
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                call.finish(_summarize(flavor, parsed), "ok", _reported_usage(flavor, parsed))
                return result

        return wrapper

    return factory


def instrument_openai(client: Any, session: Session | None = None) -> Any:
    """Instrument an OpenAI client **in place** and return it.

    Idempotent, safe on both ``OpenAI`` and ``AsyncOpenAI``, and a no-op when
    GraphMind is disabled.
    """
    if session is None:
        from ..api import instance

        session = instance().session
    if not session.enabled:
        return client
    hinter = GraphHinter()
    client_is_async = is_async_client(client)
    packages = sdk_packages(client)
    patched = 0
    for path, attr, flavor, candidates in _TARGETS:
        target: Any = client
        for part in path:
            target = getattr(target, part, None)
            if target is None:
                break
        if target is None:
            continue
        original = getattr(target, attr, None)
        if original is None or not callable(original):
            continue
        is_async = is_async_callable(original) or client_is_async
        reply = ReplyType(packages, candidates)
        factory = (
            _make_async_wrapper(session, hinter, flavor, reply)
            if is_async
            else _make_sync_wrapper(session, hinter, flavor, reply)
        )
        if patch_method(client, path, attr, factory, f"openai.{'.'.join(path)}.{attr}"):
            patched += 1
    for path in _resource_paths():
        # `.with_raw_response` / `.with_streaming_response` touched before now
        # captured the original method; rebuild them around the wrapper so the
        # order of access never decides whether a call is recorded.
        refresh_raw_wrappers(client, path, _methods_of(path))
    if patched == 0:
        warn_once(
            "openai-nothing-patched",
            "instrument_openai() found no chat.completions/responses methods on this object; "
            "pass an openai.OpenAI or openai.AsyncOpenAI client",
        )
    return client


def _resource_paths() -> list[tuple[str, ...]]:
    return list(dict.fromkeys(path for path, _attr, _flavor, _reply in _TARGETS))


def _methods_of(path: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(attr for p, attr, _flavor, _reply in _TARGETS if p == path)


#: Alias for people used to other tooling's naming.
wrap_openai = instrument_openai


def uninstrument_openai(client: Any) -> Any:
    """Restore the client's original methods."""
    for path, attr, _flavor, _reply in _TARGETS:
        unpatch_method(client, path, attr)
    for path in _resource_paths():
        refresh_raw_wrappers(client, path, _methods_of(path))
    return client
