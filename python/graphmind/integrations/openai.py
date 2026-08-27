"""OpenAI SDK integration.

``instrument_openai(client)`` patches the *instance*'s bound methods:

* ``client.chat.completions.create`` (and ``.parse``, when present)
* ``client.responses.create``

Sync (``OpenAI``) and async (``AsyncOpenAI``) clients are both supported, as
are streaming responses — the stream is teed, so the host consumes exactly what
the provider sent while GraphMind observes deltas.

The ``before`` gate is awaited **before** the HTTP request is issued: while a
gate is held nothing is in flight, so holds are indefinite by design and cost
no provider time. ``inject`` at the ``before``/``error`` gate substitutes the
whole response object, which is how you replay a model answer without paying
for it.

No import of ``openai`` happens here — everything is duck-typed, so this module
is importable with the SDK absent.
"""

from __future__ import annotations

import functools
import time
from collections.abc import Callable
from typing import Any

from ..gate import GateNode
from ..ids import LLM_NODE_ID, LLM_NODE_NAME, agent_node_id, next_id
from ..session import Session
from ._common import (
    AsyncStreamTee,
    GraphHinter,
    SyncStreamTee,
    is_async_callable,
    is_async_client,
    merge_usage,
    patch_method,
    safe_value,
    unpatch_method,
    usage_of,
    warn_once,
)

SDK_NAME = "openai"

_TARGETS: tuple[tuple[tuple[str, ...], str, str], ...] = (
    (("chat", "completions"), "create", "chat"),
    (("chat", "completions"), "parse", "chat"),
    (("responses",), "create", "responses"),
)


# -- input / output shaping ---------------------------------------------------


def _describe(flavor: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {"provider": SDK_NAME}
    for key in ("model", "temperature", "max_tokens", "max_output_tokens", "instructions"):
        if key in kwargs:
            payload[key] = safe_value(kwargs[key])
    if flavor == "chat":
        payload["messages"] = safe_value(kwargs.get("messages"))
    else:
        payload["input"] = safe_value(kwargs.get("input"))
    tools = kwargs.get("tools")
    if tools:
        payload["tools"] = safe_value(tools)
    if kwargs.get("stream"):
        payload["stream"] = True
    return payload


def _summarize(flavor: str, result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        if flavor == "chat":
            choices = getattr(result, "choices", None) or []
            texts: list[str] = []
            tool_calls: list[Any] = []
            finish_reason: str | None = None
            for choice in choices:
                message = getattr(choice, "message", None)
                content = getattr(message, "content", None)
                if isinstance(content, str) and content:
                    texts.append(content)
                parsed = getattr(message, "parsed", None)
                if parsed is not None:
                    out["parsed"] = safe_value(parsed)
                calls = getattr(message, "tool_calls", None) or []
                for call in calls:
                    function = getattr(call, "function", None)
                    tool_calls.append(
                        {
                            "id": getattr(call, "id", None),
                            "name": getattr(function, "name", None),
                            "arguments": safe_value(getattr(function, "arguments", None)),
                        }
                    )
                if finish_reason is None:
                    finish_reason = getattr(choice, "finish_reason", None)
            out["text"] = "".join(texts)
            if tool_calls:
                out["toolCalls"] = tool_calls
            if finish_reason:
                out["finishReason"] = finish_reason
        else:
            text = getattr(result, "output_text", None)
            if isinstance(text, str):
                out["text"] = safe_value(text)
            status = getattr(result, "status", None)
            if isinstance(status, str):
                out["finishReason"] = status
            output = getattr(result, "output", None)
            if output is not None:
                out["output"] = safe_value(output)
    except Exception:
        pass
    return out


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


def _observe_chat_chunk(session: Session, node_id: str, state: _StreamState, chunk: Any) -> None:
    state.chunks += 1
    usage = usage_of(getattr(chunk, "usage", None))
    if usage is not None:
        state.usage = merge_usage(state.usage, usage)
    for choice in getattr(chunk, "choices", None) or []:
        delta = getattr(choice, "delta", None)
        if delta is None:
            continue
        content = getattr(delta, "content", None)
        if isinstance(content, str) and content:
            state.text.append(content)
            session.push_token(node_id, "text", content)
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        if isinstance(reasoning, str) and reasoning:
            session.push_token(node_id, "reasoning", reasoning)
        for call in getattr(delta, "tool_calls", None) or []:
            function = getattr(call, "function", None)
            arguments = getattr(function, "arguments", None)
            if isinstance(arguments, str) and arguments:
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
        usage = usage_of(getattr(response, "usage", None))
        if usage is not None:
            state.usage = merge_usage(state.usage, usage)
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

    __slots__ = ("flavor", "hinter", "instance_id", "node", "session", "started")

    def __init__(self, session: Session, hinter: GraphHinter, flavor: str) -> None:
        self.session = session
        self.hinter = hinter
        self.flavor = flavor
        self.node = GateNode(LLM_NODE_ID, "llm", LLM_NODE_NAME)
        self.instance_id = next_id("step")
        self.started = time.monotonic()

    def begin(self, kwargs: dict[str, Any]) -> None:
        ctx = self.session.current_run()
        self.hinter.maybe_hint(self.session, kwargs.get("tools"), LLM_NODE_ID, LLM_NODE_NAME)
        self.session.start_node(
            node_id=LLM_NODE_ID,
            kind="llm",
            name=LLM_NODE_NAME,
            instance_id=self.instance_id,
            parent_id=agent_node_id(ctx.name) if ctx is not None else None,
            input=_describe(self.flavor, kwargs),
            extra={"sdk": SDK_NAME},
        )
        self.started = time.monotonic()

    def finish(
        self,
        output: Any,
        status: str,
        usage: dict[str, int] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.session.finish_node(
            node_id=LLM_NODE_ID,
            instance_id=self.instance_id,
            duration_ms=(time.monotonic() - self.started) * 1000.0,
            status=status,
            output=output,
            usage=usage,
            extra=extra,
        )

    def tee(self, result: Any, is_async: bool) -> Any:
        state = _StreamState()
        observe = _OBSERVERS[self.flavor]

        def on_chunk(chunk: Any) -> None:
            observe(self.session, LLM_NODE_ID, state, chunk)

        def on_end(error: BaseException | None) -> None:
            if error is not None:
                self.session.error_node(LLM_NODE_ID, self.instance_id, error)
                self.finish(state.output(), "error", state.usage, {"streaming": True})
            else:
                self.finish(state.output(), "ok", state.usage, {"streaming": True})

        tee_cls = AsyncStreamTee if is_async else SyncStreamTee
        return tee_cls(result, on_chunk, on_end)


def _is_stream(result: Any, kwargs: dict[str, Any], is_async: bool) -> bool:
    # Without an explicit `stream=True`, only treat the result as a stream when
    # it is not obviously a parsed model object.
    if kwargs.get("stream") is not True and (
        hasattr(result, "model_dump") or hasattr(result, "choices")
    ):
        return False
    attr = "__aiter__" if is_async else "__iter__"
    return hasattr(result, attr)


def _make_sync_wrapper(session: Session, hinter: GraphHinter, flavor: str) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return original(*args, **kwargs)
            call = _Call(session, hinter, flavor)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("openai-begin", "failed to record an OpenAI call", exc)
                return original(*args, **kwargs)
            ctx = session.current_run()
            while True:
                pre = session.gate("before", call.node)
                if pre.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                if pre.action == "inject":
                    call.finish(safe_value(pre.output), "ok", None, {"injected": True})
                    return pre.output
                try:
                    result = original(*args, **kwargs)
                except Exception as exc:
                    session.error_node(LLM_NODE_ID, call.instance_id, exc)
                    decision = session.gate("error", call.node)
                    if decision.action == "inject":
                        call.finish(
                            safe_value(decision.output),
                            "ok",
                            None,
                            {"injected": True, "recoveredFromError": True},
                        )
                        return decision.output
                    if decision.action == "retry":
                        continue
                    if decision.action == "abort":
                        call.finish(None, "aborted")
                        raise session.abort_error(ctx) from exc
                    call.finish(None, "error")
                    raise
                if _is_stream(result, kwargs, False):
                    return call.tee(result, False)
                post = session.gate("after", call.node)
                if post.action == "inject":
                    call.finish(safe_value(post.output), "ok", None, {"injected": True})
                    return post.output
                if post.action == "retry":
                    continue
                if post.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                call.finish(_summarize(flavor, result), "ok", usage_of(result))
                return result

        return wrapper

    return factory


def _make_async_wrapper(session: Session, hinter: GraphHinter, flavor: str) -> Callable[..., Any]:
    def factory(original: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(original)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not session.enabled or session.disposed:
                return await original(*args, **kwargs)
            call = _Call(session, hinter, flavor)
            try:
                call.begin(kwargs)
            except Exception as exc:
                warn_once("openai-begin", "failed to record an OpenAI call", exc)
                return await original(*args, **kwargs)
            ctx = session.current_run()
            while True:
                pre = await session.gate_async("before", call.node)
                if pre.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                if pre.action == "inject":
                    call.finish(safe_value(pre.output), "ok", None, {"injected": True})
                    return pre.output
                try:
                    result = await original(*args, **kwargs)
                except Exception as exc:
                    session.error_node(LLM_NODE_ID, call.instance_id, exc)
                    decision = await session.gate_async("error", call.node)
                    if decision.action == "inject":
                        call.finish(
                            safe_value(decision.output),
                            "ok",
                            None,
                            {"injected": True, "recoveredFromError": True},
                        )
                        return decision.output
                    if decision.action == "retry":
                        continue
                    if decision.action == "abort":
                        call.finish(None, "aborted")
                        raise session.abort_error(ctx) from exc
                    call.finish(None, "error")
                    raise
                if _is_stream(result, kwargs, True):
                    return call.tee(result, True)
                post = await session.gate_async("after", call.node)
                if post.action == "inject":
                    call.finish(safe_value(post.output), "ok", None, {"injected": True})
                    return post.output
                if post.action == "retry":
                    continue
                if post.action == "abort":
                    call.finish(None, "aborted")
                    raise session.abort_error(ctx)
                call.finish(_summarize(flavor, result), "ok", usage_of(result))
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
    patched = 0
    for path, attr, flavor in _TARGETS:
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
        factory = (
            _make_async_wrapper(session, hinter, flavor)
            if is_async
            else _make_sync_wrapper(session, hinter, flavor)
        )
        if patch_method(client, path, attr, factory, f"openai.{'.'.join(path)}.{attr}"):
            patched += 1
    if patched == 0:
        warn_once(
            "openai-nothing-patched",
            "instrument_openai() found no chat.completions/responses methods on this object; "
            "pass an openai.OpenAI or openai.AsyncOpenAI client",
        )
    return client


#: Alias for people used to other tooling's naming.
wrap_openai = instrument_openai


def uninstrument_openai(client: Any) -> Any:
    """Restore the client's original methods."""
    for path, attr, _flavor in _TARGETS:
        unpatch_method(client, path, attr)
    return client
