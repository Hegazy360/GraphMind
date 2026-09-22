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
    merge_usage,
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
    usage_of,
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


def _describe(kwargs: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {"provider": SDK_NAME}
    for key in ("model", "max_tokens", "temperature", "system"):
        if key in kwargs:
            payload[key] = safe_value(kwargs[key])
    payload["messages"] = safe_value(kwargs.get("messages"))
    tools = kwargs.get("tools")
    if tools:
        payload["tools"] = safe_value(tools)
    if kwargs.get("stream"):
        payload["stream"] = True
    return payload


def _summarize(message: Any) -> dict[str, Any]:
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
                tool_calls.append(
                    {
                        "id": getattr(block, "id", None),
                        "name": getattr(block, "name", None),
                        "input": safe_value(getattr(block, "input", None)),
                    }
                )
            elif block_type == "thinking":
                thinking = getattr(block, "thinking", None)
                if isinstance(thinking, str):
                    out["thinking"] = safe_value(thinking)
        out["text"] = safe_value("".join(texts))
        if tool_calls:
            out["toolCalls"] = tool_calls
        stop_reason = getattr(message, "stop_reason", None)
        if isinstance(stop_reason, str):
            out["finishReason"] = stop_reason
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


class _StreamState:
    __slots__ = ("chunks", "finish_reason", "text", "usage")

    def __init__(self) -> None:
        self.text: list[str] = []
        self.usage: dict[str, int] | None = None
        self.finish_reason: str | None = None
        self.chunks = 0

    def output(self) -> dict[str, Any]:
        out: dict[str, Any] = {"text": safe_value("".join(self.text)), "chunks": self.chunks}
        if self.finish_reason:
            out["finishReason"] = self.finish_reason
        return out


def _observe_event(session: Session, node_id: str, state: _StreamState, event: Any) -> None:
    state.chunks += 1
    event_type = getattr(event, "type", None)
    if event_type == "message_start":
        usage = usage_of(getattr(getattr(event, "message", None), "usage", None))
        if usage is not None:
            state.usage = merge_usage(state.usage, usage)
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
        elif delta_type == "thinking_delta":
            thinking = getattr(delta, "thinking", None)
            if isinstance(thinking, str) and thinking:
                session.push_token(node_id, "reasoning", thinking)
        return
    if event_type == "message_delta":
        usage = usage_of(getattr(event, "usage", None))
        if usage is not None:
            state.usage = merge_usage(state.usage, usage)
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
            input=_describe(kwargs),
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
    output = state.output()
    usage = state.usage
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
                usage = merge_usage(usage, usage_of(getattr(final, "usage", None)))
                summary = _summarize(final)
                if summary.get("text"):
                    output.update(summary)
        except Exception:
            pass
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
                call.finish(_summarize(parsed), "ok", usage_of(parsed))
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
                call.finish(_summarize(parsed), "ok", usage_of(parsed))
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
