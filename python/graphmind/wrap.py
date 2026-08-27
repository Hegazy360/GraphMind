"""Gating a plain callable — where ``inject`` and ``retry`` actually work.

Callbacks (LangChain) and provider-SDK patches can *observe* and *hold*, but
only a wrapper that owns the call site can substitute a result. So this module
is the sharp end of the debugger:

* ``before`` gate before the function body runs — ``inject`` returns the
  debugger's value instead of calling it at all;
* ``error`` gate when the body raises, **before** the caller sees the error —
  ``inject`` swallows the error and returns a value, ``retry`` re-runs the
  body, ``continue`` re-raises the original, ``abort`` aborts the run;
* ``after`` gate post-body, pre-return (fires only in step mode or with an
  explicit ``after`` breakpoint — decisions.md #2).

Sync functions gate on the calling thread; ``async def`` functions gate on the
calling task. Nothing here may raise into the host except the host's own error
(or a deliberate abort).
"""

from __future__ import annotations

import functools
import inspect
import time
from collections.abc import Callable, Mapping
from typing import Any, TypeVar, Union

from .errors import is_abort_error
from .gate import GateNode
from .ids import next_id, tool_node_id
from .session import Session

F = TypeVar("F", bound=Callable[..., Any])

MAX_PREVIEW = 4000


def _describe(signature: inspect.Signature | None, args: Any, kwargs: Any) -> Any:
    """A readable ``input`` payload for the viewer."""
    if signature is not None:
        try:
            bound = signature.bind_partial(*args, **kwargs)
            bound.apply_defaults()
            return dict(bound.arguments)
        except Exception:
            pass
    out: dict[str, Any] = {}
    if args:
        out["args"] = list(args)
    if kwargs:
        out["kwargs"] = dict(kwargs)
    return out


def _signature_of(fn: Callable[..., Any]) -> inspect.Signature | None:
    try:
        return inspect.signature(fn)
    except (TypeError, ValueError):  # builtins, C extensions
        return None


class _Wrapper:
    """Shared state between the sync and async gate loops."""

    __slots__ = ("kind", "name", "node_id", "parent_id", "session_of", "signature")

    def __init__(
        self,
        session_of: Callable[[], Session | None],
        name: str,
        kind: str,
        node_id: str,
        parent_id: str | None,
        signature: inspect.Signature | None,
    ) -> None:
        self.session_of = session_of
        self.name = name
        self.kind = kind
        self.node_id = node_id
        self.parent_id = parent_id
        self.signature = signature

    def node(self) -> GateNode:
        return GateNode(self.node_id, self.kind, self.name)


def gate_callable(
    fn: F,
    session_of: Callable[[], Session | None],
    *,
    name: str | None = None,
    kind: str = "tool",
    node_id: str | None = None,
    parent_id: str | None = None,
) -> F:
    """Wrap ``fn`` with before/error/after gates. Async functions stay async."""
    resolved_name = name or getattr(fn, "__name__", None) or repr(fn)
    state = _Wrapper(
        session_of=session_of,
        name=resolved_name,
        kind=kind,
        node_id=node_id or tool_node_id(resolved_name),
        parent_id=parent_id,
        signature=_signature_of(fn),
    )

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            session = state.session_of()
            if session is None or not session.enabled or session.disposed:
                return await fn(*args, **kwargs)
            return await _run_async(state, session, fn, args, kwargs)

        _mark(async_wrapper, fn, state)
        return async_wrapper  # type: ignore[return-value]

    @functools.wraps(fn)
    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        session = state.session_of()
        if session is None or not session.enabled or session.disposed:
            return fn(*args, **kwargs)
        return _run_sync(state, session, fn, args, kwargs)

    _mark(sync_wrapper, fn, state)
    return sync_wrapper  # type: ignore[return-value]


def _mark(wrapper: Any, original: Any, state: _Wrapper) -> None:
    wrapper.__graphmind_wrapped__ = True
    wrapper.__graphmind_original__ = original
    wrapper.__graphmind_node_id__ = state.node_id
    wrapper.__graphmind_name__ = state.name


def is_wrapped(fn: Any) -> bool:
    return getattr(fn, "__graphmind_wrapped__", False) is True


def _run_sync(
    state: _Wrapper, session: Session, fn: Callable[..., Any], args: Any, kwargs: Any
) -> Any:
    node = state.node()
    ctx = session.current_run()
    instance_id = next_id("call")
    started = time.monotonic()
    session.start_node(
        node_id=node.node_id,
        kind=state.kind,
        name=state.name,
        instance_id=instance_id,
        parent_id=state.parent_id,
        input=_describe(state.signature, args, kwargs),
    )

    def finish(output: Any, status: str, extra: dict[str, Any] | None = None) -> None:
        session.finish_node(
            node_id=node.node_id,
            instance_id=instance_id,
            duration_ms=(time.monotonic() - started) * 1000.0,
            status=status,
            output=output,
            extra=extra,
        )

    while True:
        pre = session.gate("before", node)
        if pre.action == "abort":
            finish(None, "aborted")
            raise session.abort_error(ctx)
        if pre.action == "inject":
            finish(pre.output, "ok", {"injected": True})
            return pre.output
        # 'retry' before execution is equivalent to continue.

        try:
            result = fn(*args, **kwargs)
        except BaseException as exc:
            decision = _handle_error(session, node, instance_id, ctx, exc, finish)
            if decision is _RETRY:
                continue
            if decision is _RERAISE:
                raise
            return decision.output  # type: ignore[union-attr]

        post = session.gate("after", node)
        if post.action == "inject":
            finish(post.output, "ok", {"injected": True})
            return post.output
        if post.action == "retry":
            continue
        if post.action == "abort":
            finish(result, "aborted")
            raise session.abort_error(ctx)
        finish(result, "ok")
        return result


async def _run_async(
    state: _Wrapper, session: Session, fn: Callable[..., Any], args: Any, kwargs: Any
) -> Any:
    node = state.node()
    ctx = session.current_run()
    instance_id = next_id("call")
    started = time.monotonic()
    session.start_node(
        node_id=node.node_id,
        kind=state.kind,
        name=state.name,
        instance_id=instance_id,
        parent_id=state.parent_id,
        input=_describe(state.signature, args, kwargs),
    )

    def finish(output: Any, status: str, extra: dict[str, Any] | None = None) -> None:
        session.finish_node(
            node_id=node.node_id,
            instance_id=instance_id,
            duration_ms=(time.monotonic() - started) * 1000.0,
            status=status,
            output=output,
            extra=extra,
        )

    while True:
        pre = await session.gate_async("before", node)
        if pre.action == "abort":
            finish(None, "aborted")
            raise session.abort_error(ctx)
        if pre.action == "inject":
            finish(pre.output, "ok", {"injected": True})
            return pre.output

        try:
            result = await fn(*args, **kwargs)
        except BaseException as exc:
            decision = await _handle_error_async(session, node, instance_id, ctx, exc, finish)
            if decision is _RETRY:
                continue
            if decision is _RERAISE:
                raise
            return decision.output  # type: ignore[union-attr]

        post = await session.gate_async("after", node)
        if post.action == "inject":
            finish(post.output, "ok", {"injected": True})
            return post.output
        if post.action == "retry":
            continue
        if post.action == "abort":
            finish(result, "aborted")
            raise session.abort_error(ctx)
        finish(result, "ok")
        return result


class _Sentinel:
    __slots__ = ("label",)

    def __init__(self, label: str) -> None:
        self.label = label


_RETRY = _Sentinel("retry")
_RERAISE = _Sentinel("reraise")


def _should_gate_error(ctx: Any, exc: BaseException) -> bool:
    """Only ordinary errors are gated.

    A debugger-driven abort surfacing from the body is terminal, and
    KeyboardInterrupt / SystemExit / asyncio cancellation must never be held.
    """
    if not isinstance(exc, Exception):
        return False
    return not is_abort_error(exc)


def _handle_error(
    session: Session,
    node: GateNode,
    instance_id: str,
    ctx: Any,
    exc: BaseException,
    finish: Callable[..., None],
) -> Any:
    if not _should_gate_error(ctx, exc):
        finish(None, "aborted" if is_abort_error(exc) else "error")
        return _RERAISE
    session.error_node(node.node_id, instance_id, exc)
    decision = session.gate("error", node)
    return _apply_error_decision(session, ctx, decision, exc, finish)


async def _handle_error_async(
    session: Session,
    node: GateNode,
    instance_id: str,
    ctx: Any,
    exc: BaseException,
    finish: Callable[..., None],
) -> Any:
    if not _should_gate_error(ctx, exc):
        finish(None, "aborted" if is_abort_error(exc) else "error")
        return _RERAISE
    session.error_node(node.node_id, instance_id, exc)
    decision = await session.gate_async("error", node)
    return _apply_error_decision(session, ctx, decision, exc, finish)


def _apply_error_decision(
    session: Session, ctx: Any, decision: Any, exc: BaseException, finish: Callable[..., None]
) -> Any:
    if decision.action == "inject":
        finish(decision.output, "ok", {"injected": True, "recoveredFromError": True})
        return decision
    if decision.action == "retry":
        return _RETRY
    if decision.action == "abort":
        finish(None, "aborted")
        raise session.abort_error(ctx)
    finish(None, "error")
    return _RERAISE


# `Union` (not `X | Y`): this alias is evaluated at import time.
ToolsInput = Union[  # noqa: UP007
    Mapping[str, Callable[..., Any]], list[Callable[..., Any]], Callable[..., Any]
]


def wrap_tools(tools: ToolsInput, session_of: Callable[[], Session | None]) -> Any:
    """Wrap a dict / list / single callable of tools. Shape in, shape out."""
    if callable(tools) and not isinstance(tools, (dict, list, tuple)):
        return gate_callable(tools, session_of)
    if isinstance(tools, Mapping):
        return {
            key: (fn if is_wrapped(fn) else gate_callable(fn, session_of, name=key))
            for key, fn in tools.items()
        }
    if isinstance(tools, (list, tuple)):
        wrapped = [fn if is_wrapped(fn) else gate_callable(fn, session_of) for fn in tools]
        return type(tools)(wrapped) if isinstance(tools, tuple) else wrapped
    raise TypeError(
        "wrap_tools expects a callable, a list of callables, or a {name: callable} mapping"
    )
