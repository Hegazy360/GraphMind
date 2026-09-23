"""Anthropic SDK integration.

``instrument_anthropic(client)`` patches the *instance*'s bound methods, on
both ``client.messages`` and ``client.beta.messages`` (the latter is what
Pydantic AI's Anthropic model and the SDK's own tool runner call):

* ``.create`` — including ``stream=True``
* ``.parse``, when present
* ``.stream`` — the context-manager helper

Sync (``Anthropic``) and async (``AsyncAnthropic``) clients are both supported.
For ``messages.stream`` the HTTP request is issued by ``__enter__``, so that is
where the ``before`` gate is held — again, nothing is in flight while paused.

The stream proxy observes **both** consumption styles (iterating raw events and
iterating ``.text_stream``) and reads final usage back off
``get_final_message()``, so token counts land on the node whichever way the
host reads the stream.

``inject`` hands back the SDK type the call returns (``Message``,
``BetaMessage``, their ``Parsed*`` variants), rebuilt from a bare string or an
object with that type's fields. ``.with_raw_response`` /
``.with_streaming_response`` go through the patched methods too (see
``_common``).

No import of ``anthropic`` happens at import time — everything is duck-typed;
reply types are imported lazily from the client's own package on inject.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

from ..clock import elapsed_ms, monotonic_ms
from ..gate import GateNode
from ..ids import LLM_NODE_ID, LLM_NODE_NAME, agent_node_id, next_id
from ..llm_capture import (
    AnthropicUsageAccumulator,
    anthropic_usage,
    capture_tools,
    finish_fields,
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

SDK_NAME = "anthropic"

_Candidates = tuple[tuple[str, str], ...]

#: (resource path, reply type candidates for ``create``, for ``parse``) — the
#: candidates are (module, class) relative to the client's package, in order.
_RESOURCES: tuple[tuple[tuple[str, ...], _Candidates, _Candidates], ...] = (
    (
        ("messages",),
        (("types", "Message"),),
        (("types", "ParsedMessage"), ("types", "Message")),
    ),
    (
        ("beta", "messages"),
        (("types.beta", "BetaMessage"),),
        (
            ("types.beta", "ParsedBetaMessage"),
            ("types.beta.parsed_beta_message", "ParsedBetaMessage"),
            ("types.beta", "BetaMessage"),
        ),
    ),
)
_METHODS = ("create", "parse", "stream")

_RAW_STREAM_INJECT = (
    "`inject` is not supported on a with_streaming_response / with_raw_response call "
    "made with stream=True (GraphMind cannot fabricate the provider's raw HTTP stream); "
    "treating it as `continue`. Inject on a non-streamed call instead."
)
_STREAM_INJECT = (
    "`inject` on a stream=True call hands your payload back as-is: GraphMind cannot "
    "synthesize a provider event stream, so code that iterates it gets no events. "
    "Inject on a non-streamed call instead."
)


def _describe(session: Session, kwargs: dict[str, Any]) -> dict[str, Any]:
    """``node.started.input``: the request as sent (contract C1) — ``model``,
    ``system`` and ``messages`` in full (the per-event 512 KB shrink is the
    only bound), the sampling parameters under Anthropic's own names
    (``max_tokens``, ``temperature``, ``top_p``, ``top_k``, ``stop_sequences``,
    ``tool_choice``, ``thinking``, ... — an allow-list; ``metadata``,
    ``mcp_servers`` and the ``extra_*`` request options are never read), and
    ``tools: [{name, schemaHash}]`` with each definition sent once per run as
    ``toolSchemas``."""
    payload: dict[str, Any] = {"provider": SDK_NAME}
    for key in ("model", "system"):
        if key in kwargs and kwargs[key] is not None:
            payload[key] = record_value(kwargs[key])
    payload["messages"] = record_value(kwargs.get("messages"))
    payload.update(pick_params(kwargs))
    ctx = session.current_run()
    run_key = ctx.run_id if ctx is not None else "implicit"
    tools = capture_tools(session, run_key, kwargs.get("tools"))
    if tools:
        payload.update(tools)
    if kwargs.get("stream"):
        payload["stream"] = True
    return payload


def _summarize(message: Any) -> dict[str, Any]:
    """``node.finished.output``: text, thinking, the ``tool_use`` calls the model
    requested (``{id, name, input}``), the normalized ``finishReason`` and
    Anthropic's own ``stop_reason`` as ``rawFinishReason``."""
    out: dict[str, Any] = {}
    try:
        texts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in getattr(message, "content", None) or []:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text = getattr(block, "text", None)
                if isinstance(text, str):
                    texts.append(text)
            elif block_type == "tool_use":
                call = tool_call(
                    getattr(block, "id", None),
                    getattr(block, "name", None),
                    getattr(block, "input", None),
                )
                if call is not None:
                    tool_calls.append(call)
            elif block_type == "thinking":
                thinking = getattr(block, "thinking", None)
                if isinstance(thinking, str):
                    out["thinking"] = safe_value(thinking)
        out["text"] = safe_value("".join(texts))
        if tool_calls:
            out["toolCalls"] = tool_calls
        out.update(finish_fields(getattr(message, "stop_reason", None), bool(tool_calls)))
    except Exception:
        pass
    return out


def _content_block(block: Any, index: int) -> Any:
    if isinstance(block, str):
        return {"type": "text", "text": block}
    if not isinstance(block, dict):
        return block
    block = dict(block)
    if "type" not in block:
        block["type"] = "tool_use" if "name" in block and "text" not in block else "text"
    if block["type"] == "tool_use":
        block.setdefault("id", f"toolu_graphmind_{index}")
        block.setdefault("input", {})
    return block


def _message_reply(value: Any, model: str) -> dict[str, Any] | None:
    """A ``Message`` / ``BetaMessage`` from a string or (part of) a message object."""
    if isinstance(value, str):
        data: dict[str, Any] = {"content": [value]}
    elif isinstance(value, dict):
        data = dict(value)
        if "content" not in data:
            if not isinstance(data.get("text"), str):
                return None
            data["content"] = [data.pop("text")]
    else:
        return None
    content = data.get("content")
    if isinstance(content, str):
        content = [content]
    if isinstance(content, list):
        data["content"] = [_content_block(block, index) for index, block in enumerate(content)]
        uses_tools = any(
            isinstance(block, dict) and block.get("type") == "tool_use" for block in data["content"]
        )
        data.setdefault("stop_reason", "tool_use" if uses_tools else "end_turn")
    usage = data.get("usage")
    usage = dict(usage) if isinstance(usage, dict) else {}
    # Required by the type; no tokens were spent on an injected reply.
    usage.setdefault("input_tokens", 0)
    usage.setdefault("output_tokens", 0)
    data["usage"] = usage
    data.setdefault("id", placeholder_id("msg_"))
    data.setdefault("type", "message")
    data.setdefault("role", "assistant")
    data.setdefault("model", model)
    return data


def _usage(message: Any) -> dict[str, Any] | None:
    """The inclusive wire usage of a complete ``Message``."""
    return anthropic_usage(getattr(message, "usage", None))


class _StreamState:
    __slots__ = ("accumulator", "blocks", "calls", "chunks", "finish_reason", "text")

    def __init__(self) -> None:
        self.text: list[str] = []
        self.accumulator = AnthropicUsageAccumulator()
        self.finish_reason: str | None = None
        self.chunks = 0
        #: Open ``tool_use`` blocks by index: [id, name, streamed argument JSON].
        self.blocks: dict[int, list[Any]] = {}
        #: Completed tool calls by block index.
        self.calls: dict[int, dict[str, Any]] = {}

    @property
    def usage(self) -> dict[str, Any] | None:
        return self.accumulator.usage()

    def tool_calls(self) -> list[dict[str, Any]]:
        """Completed calls plus any ``tool_use`` block the stream never closed
        (cut off by ``max_tokens``: its partial text becomes ``inputText``)."""
        calls = dict(self.calls)
        for index, (block_id, name, text) in self.blocks.items():
            if index not in calls:
                call = tool_call(block_id, name, text)
                if call is not None:
                    calls[index] = call
        return [calls[index] for index in sorted(calls)]

    def output(self) -> dict[str, Any]:
        out: dict[str, Any] = {"text": safe_value("".join(self.text)), "chunks": self.chunks}
        calls = self.tool_calls()
        if calls:
            out["toolCalls"] = calls
        out.update(finish_fields(self.finish_reason, bool(calls)))
        return out


def _observe_event(session: Session, node_id: str, state: _StreamState, event: Any) -> None:
    state.chunks += 1
    event_type = getattr(event, "type", None)
    if event_type == "message_start":
        state.accumulator.add(getattr(getattr(event, "message", None), "usage", None))
        return
    if event_type == "content_block_start":
        block = getattr(event, "content_block", None)
        index = getattr(event, "index", None)
        if getattr(block, "type", None) == "tool_use" and isinstance(index, int):
            state.blocks[index] = [getattr(block, "id", None), getattr(block, "name", None), ""]
        return
    if event_type == "content_block_stop":
        index = getattr(event, "index", None)
        if isinstance(index, int) and index in state.blocks:
            block_id, name, text = state.blocks.pop(index)
            call = tool_call(block_id, name, text)
            if call is not None:
                state.calls[index] = call
        return
    if event_type == "content_block_delta":
        delta = getattr(event, "delta", None)
        delta_type = getattr(delta, "type", None)
        if delta_type == "text_delta":
            text = getattr(delta, "text", None)
            if isinstance(text, str) and text:
                state.text.append(text)
                session.push_token(node_id, "text", text)
        elif delta_type == "input_json_delta":
            partial = getattr(delta, "partial_json", None)
            if isinstance(partial, str) and partial:
                session.push_token(node_id, "tool-args", partial)
                block = state.blocks.get(getattr(event, "index", None))  # type: ignore[arg-type]
                if block is not None:
                    block[2] += partial
        elif delta_type == "thinking_delta":
            thinking = getattr(delta, "thinking", None)
            if isinstance(thinking, str) and thinking:
                session.push_token(node_id, "reasoning", thinking)
        return
    if event_type == "message_delta":
        state.accumulator.add(getattr(event, "usage", None))
        stop_reason = getattr(getattr(event, "delta", None), "stop_reason", None)
        if isinstance(stop_reason, str):
            state.finish_reason = stop_reason


class _Call:
    __slots__ = (
        "finished",
        "hinter",
        "instance_id",
        "model",
        "node",
        "reply",
        "session",
        "started",
    )

    def __init__(self, session: Session, hinter: GraphHinter, reply: ReplyType | None) -> None:
        self.session = session
        self.hinter = hinter
        self.reply = reply
        self.node = GateNode(LLM_NODE_ID, "llm", LLM_NODE_NAME)
        self.instance_id = next_id("step")
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
            input=_describe(self.session, kwargs),
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

    def can_inject(self, raw: str | None, streaming: bool) -> bool:
        if raw is not None and streaming:
            warn_once("anthropic-raw-stream-inject", _RAW_STREAM_INJECT)
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
            warn_once("anthropic-stream-inject", _STREAM_INJECT)
            return value
        reply = self.rebuild(value, like)
        if raw is not None:
            return injected_response(reply, raw, async_api)
        return reply

    def rebuild(self, value: Any, like: Any = None) -> Any:
        cls = self.reply.resolve(like) if self.reply is not None else None
        if cls is None:
            return value
        model = self.model
        return rebuild_reply(value, cls, lambda v: _message_reply(v, model), "anthropic")

    def raw_tee(self, result: Any, is_async: bool, state: _StreamState | None = None) -> Any:
        stream_state = state if state is not None else _StreamState()

        def on_chunk(event: Any) -> None:
            _observe_event(self.session, LLM_NODE_ID, stream_state, event)

        def on_end(error: BaseException | None) -> None:
            self.end_stream(stream_state, error)

        cls = AsyncStreamTee if is_async else SyncStreamTee
        return cls(result, on_chunk, on_end)

    def end_stream(self, state: _StreamState, error: BaseException | None) -> None:
        if self.finished:
            return
        if error is not None:
            self.session.error_node(LLM_NODE_ID, self.instance_id, error)
            self.finish(state.output(), "error", state.usage, {"streaming": True})
        else:
            self.finish(state.output(), "ok", state.usage, {"streaming": True})

    def raw_stream(self, raw: Any) -> Any:
        """A raw-response call made with ``stream=True``: tee what ``.parse()`` returns."""
        state = _StreamState()

        def tee(stream: Any) -> Any:
            return self.raw_tee(stream, hasattr(stream, "__aiter__"), state)

        def on_close() -> None:
            self.end_stream(state, None)

        if not observe_raw_stream(raw, tee, on_close):
            self.end_stream(state, None)
        return raw


# -- messages.stream(): a context manager whose __enter__ makes the request ----


class _StreamProxy(SyncStreamTee):
    """Tee for ``anthropic`` ``MessageStream``: events *and* ``.text_stream``."""

    def __init__(self, inner: Any, call: _Call, state: _StreamState) -> None:
        session = call.session

        def on_chunk(event: Any) -> None:
            _observe_event(session, LLM_NODE_ID, state, event)

        def on_end(error: BaseException | None) -> None:
            _finish_stream(call, state, inner, error)

        super().__init__(inner, on_chunk, on_end)
        self._state = state
        self._session = session

    @property
    def text_stream(self) -> Iterator[str]:
        inner = self._inner
        state = self._state
        session = self._session

        def generator() -> Iterator[str]:
            try:
                for text in inner.text_stream:
                    if isinstance(text, str) and text:
                        state.text.append(text)
                        session.push_token(LLM_NODE_ID, "text", text)
                    yield text
            except BaseException as exc:
                self._finish(exc)
                raise
            self._finish(None)

        return generator()


class _AsyncStreamProxy(AsyncStreamTee):
    def __init__(self, inner: Any, call: _Call, state: _StreamState) -> None:
        session = call.session

        def on_chunk(event: Any) -> None:
            _observe_event(session, LLM_NODE_ID, state, event)

        def on_end(error: BaseException | None) -> None:
            _finish_stream(call, state, inner, error)

        super().__init__(inner, on_chunk, on_end)
        self._state = state
        self._session = session

    @property
    def text_stream(self) -> AsyncIterator[str]:
        inner = self._inner
        state = self._state
        session = self._session

        async def generator() -> AsyncIterator[str]:
            try:
                async for text in inner.text_stream:
                    if isinstance(text, str) and text:
                        state.text.append(text)
                        session.push_token(LLM_NODE_ID, "text", text)
                    yield text
            except BaseException as exc:
                self._finish(exc)
                raise
            self._finish(None)

        return generator()


def _finish_stream(
    call: _Call, state: _StreamState, inner: Any, error: BaseException | None
) -> None:
    """Terminal bookkeeping: read usage back off the accumulated final message.

    The SDK accumulates a message snapshot regardless of how the host consumed
    the stream, so usage and the full text land on the node even when the host
    only ever touched ``.text_stream`` (which bypasses our event tee).
    """
    summary: dict[str, Any] | None = None
    if error is None:
        final = None
        try:
            getter = getattr(inner, "get_final_message", None)
            # The async variant is a coroutine function; never call it here —
            # this runs on the host's thread with no loop to await on.
            if getter is not None and not inspect.iscoroutinefunction(getter):
                final = getter()
            if final is None:
                final = getattr(inner, "current_message_snapshot", None)
        except Exception:
            final = None
        try:
            if final is not None and not inspect.isawaitable(final):
                # The SDK's snapshot has the whole message (usage accumulated,
                # tool_use inputs parsed), however the host read the stream.
                state.accumulator.add(getattr(final, "usage", None))
                summary = _summarize(final)
                if not summary.get("text"):
                    summary.pop("text", None)
        except Exception:
            summary = None
    output = state.output()
    if summary:
        output.update(summary)
    usage = state.usage
    if error is not None:
        call.session.error_node(LLM_NODE_ID, call.instance_id, error)
        call.finish(output, "error", usage, {"streaming": True})
    else:
        call.finish(output, "ok", usage, {"streaming": True})


class _ManagerProxy:
    """Wraps ``MessageStreamManager``; gates in ``__enter__``, before the request."""

    def __init__(self, inner: Any, call: _Call, kwargs: dict[str, Any]) -> None:
        self._inner = inner
        self._call = call
        self._kwargs = kwargs
        self._proxy: _StreamProxy | None = None

    def __enter__(self) -> Any:
        call = self._call
        session = call.session
        call.begin(self._kwargs)
        ctx = session.current_run()
        decision = session.gate("before", call.node)
        if decision.action == "abort":
            call.finish(None, "aborted")
            raise session.abort_error(ctx)
        if decision.action == "inject":
            warn_once(
                "anthropic-stream-inject",
                "`inject` is not supported at a messages.stream() gate (GraphMind cannot "
                "fabricate a provider stream object); continuing. Use messages.create() or "
                "wrap the call site with gm.span/@gm.tool to inject here.",
            )
        try:
            stream = self._inner.__enter__()
        except Exception as exc:
            session.error_node(LLM_NODE_ID, call.instance_id, exc)
            call.finish(None, "error")
            raise
        proxy = _StreamProxy(stream, call, _StreamState())
        self._proxy = proxy
        return proxy

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._proxy is not None:
            self._proxy._finish(exc)
        try:
            self._inner.__exit__(exc_type, exc, tb)
        except Exception:
            pass

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)


class _AsyncManagerProxy:
    def __init__(self, inner: Any, call: _Call, kwargs: dict[str, Any]) -> None:
        self._inner = inner
        self._call = call
        self._kwargs = kwargs
        self._proxy: _AsyncStreamProxy | None = None

    async def __aenter__(self) -> Any:
        call = self._call
        session = call.session
        call.begin(self._kwargs)
        ctx = session.current_run()
        decision = await session.gate_async("before", call.node)
        if decision.action == "abort":
            call.finish(None, "aborted")
            raise session.abort_error(ctx)
        if decision.action == "inject":
            warn_once(
                "anthropic-stream-inject",
                "`inject` is not supported at a messages.stream() gate; continuing.",
            )
        try:
            stream = await self._inner.__aenter__()
        except Exception as exc:
            session.error_node(LLM_NODE_ID, call.instance_id, exc)
            call.finish(None, "error")
            raise
        proxy = _AsyncStreamProxy(stream, call, _StreamState())
        self._proxy = proxy
        return proxy

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._proxy is not None:
            self._proxy._finish(exc)
        try:
            await self._inner.__aexit__(exc_type, exc, tb)
        except Exception:
            pass

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)


# -- wrappers -----------------------------------------------------------------


# `create` and `parse` share one wrapper. A raw-response call (`raw` is "true" /
# "stream", from `.with_raw_response` / `.with_streaming_response`) hands the
# host the SDK's raw response: non-streamed, the wrapper parses it the way the
# host's `.parse()` would (the SDK caches the result) so the `after` gate sees
# the real reply; streamed, it tees the stream `.parse()` returns.


def _make_create_sync(
    session: Session, hinter: GraphHinter, reply: ReplyType
) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return original(*args, **kwargs)
            call = _Call(session, hinter, reply)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("anthropic-begin", "failed to record an Anthropic call", exc)
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
                if raw is None and streaming and hasattr(result, "__iter__"):
                    return call.raw_tee(result, False)
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
                call.finish(_summarize(parsed), "ok", _usage(parsed))
                return result

        return wrapper

    return factory


def _make_create_async(
    session: Session, hinter: GraphHinter, reply: ReplyType
) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return await original(*args, **kwargs)
            call = _Call(session, hinter, reply)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("anthropic-begin", "failed to record an Anthropic call", exc)
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
                if raw is None and streaming and hasattr(result, "__aiter__"):
                    return call.raw_tee(result, True)
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
                call.finish(_summarize(parsed), "ok", _usage(parsed))
                return result

        return wrapper

    return factory


def _make_stream(session: Session, hinter: GraphHinter, is_async: bool) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            manager = original(*args, **kwargs)
            if not session.enabled or session.disposed:
                return manager
            call = _Call(session, hinter, None)
            proxy_cls = _AsyncManagerProxy if is_async else _ManagerProxy
            return proxy_cls(manager, call, kwargs)

        return wrapper

    return factory


def _resource(client: Any, path: tuple[str, ...]) -> Any:
    target = client
    for part in path:
        target = getattr(target, part, None)
        if target is None:
            return None
    return target


def instrument_anthropic(client: Any, session: Session | None = None) -> Any:
    """Instrument an Anthropic client **in place** and return it. Idempotent."""
    if session is None:
        from ..api import instance

        session = instance().session
    if not session.enabled:
        return client
    hinter = GraphHinter()
    if getattr(client, "messages", None) is None:
        warn_once(
            "anthropic-nothing-patched",
            "instrument_anthropic() found no `.messages` resource; pass an "
            "anthropic.Anthropic or anthropic.AsyncAnthropic client",
        )
        return client

    packages = sdk_packages(client)
    for path, create_reply, parse_reply in _RESOURCES:
        messages = _resource(client, path)
        if messages is None:
            continue  # e.g. an SDK old enough to have no `beta`
        label = f"anthropic.{'.'.join(path)}"
        create = getattr(messages, "create", None)
        is_async = is_async_callable(create) or is_async_client(client)
        make = _make_create_async if is_async else _make_create_sync
        for attr, candidates in (("create", create_reply), ("parse", parse_reply)):
            if getattr(messages, attr, None) is not None:
                reply = ReplyType(packages, candidates)
                patch_method(client, path, attr, make(session, hinter, reply), f"{label}.{attr}")
        if getattr(messages, "stream", None) is not None:
            patch_method(
                client, path, "stream", _make_stream(session, hinter, is_async), f"{label}.stream"
            )
        # `.with_raw_response` / `.with_streaming_response` touched before now
        # captured the original methods; rebuild them around the wrappers.
        refresh_raw_wrappers(client, path, ("create", "parse"))
    return client


wrap_anthropic = instrument_anthropic


def uninstrument_anthropic(client: Any) -> Any:
    for path, _create_reply, _parse_reply in _RESOURCES:
        for attr in _METHODS:
            unpatch_method(client, path, attr)
        refresh_raw_wrappers(client, path, ("create", "parse"))
    return client
