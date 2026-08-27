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


#: How far to follow ``functools.partial(...).func`` chains. A handful is
#: plenty; the cap only exists so a pathological/cyclic object cannot spin.
_UNWRAP_DEPTH = 8


def _innermost(fn: Any) -> Any:
    """Follow ``functools.partial``/``partialmethod`` ``.func`` down to the real callable."""
    target = fn
    try:
        for _ in range(_UNWRAP_DEPTH):
            inner = getattr(target, "func", None)
            if inner is None or inner is target or not callable(inner):
                break
            target = inner
    except Exception:
        return fn
    return target


def _callable_name(fn: Any) -> str:
    """A readable, *stable* node name for anything callable.

    ``functools.partial`` has no ``__name__`` — and binding per-run state with
    a partial is an ordinary pattern — so does an instance of a class with
    ``__call__``. Falling back to ``repr`` used to put a memory address in the
    node id (``tool:functools.partial(<function load at 0x10a3f7c40>, 'prod')``),
    which is unreadable *and* changes on every run, so the viewer drew a brand
    new node each time instead of lighting up the same one.
    """
    try:
        name = getattr(fn, "__name__", None)
        if isinstance(name, str) and name:
            return name
        name = getattr(_innermost(fn), "__name__", None)
        if isinstance(name, str) and name:
            return name
        cls_name = type(fn).__name__
        if isinstance(cls_name, str) and cls_name:
            return cls_name
    except Exception:
        pass
    return "callable"


def _annotations_from(signature: inspect.Signature | None) -> dict[str, Any]:
    """Annotations describing the *bound* call rather than ``(*args, **kwargs)``.

    ``functools.wraps`` finds no ``__annotations__`` on a partial, so the wrapper
    keeps its own — and because this module uses PEP 563 those are the *strings*
    ``"Any"``, which resolve against the wrong module. Schema builders that read
    type hints (LangChain's ``StructuredTool.from_function``, pydantic's
    ``validate_arguments``) then fail with ``NameError: name 'Any' is not
    defined``. Rebuild them from the signature the caller actually sees.
    """
    out: dict[str, Any] = {}
    if signature is None:
        return out
    empty = inspect.Signature.empty
    for parameter in signature.parameters.values():
        if parameter.annotation is not empty:
            out[parameter.name] = parameter.annotation
    if signature.return_annotation is not empty:
        out["return"] = signature.return_annotation
    return out


def _copy_metadata(
    wrapper: Any, fn: Any, resolved_name: str, signature: inspect.Signature | None
) -> None:
    """``functools.wraps(fn)``, plus a usable identity for nameless callables.

    Normal functions take the first line and nothing else: behaviour is exactly
    ``@functools.wraps(fn)``. For a partial or a callable object ``wraps``
    silently skips the attributes that are missing, leaving the wrapper called
    ``sync_wrapper``, documented as ``functools.partial`` and annotated
    ``(*args, **kwargs)``; those are repaired from the underlying function.
    """
    try:
        functools.wraps(fn)(wrapper)
    except Exception:  # pragma: no cover - wraps only skips missing attributes
        pass
    if isinstance(getattr(fn, "__name__", None), str):
        return
    try:
        inner = _innermost(fn)
        wrapper.__name__ = resolved_name
        qualname = getattr(inner, "__qualname__", None)
        wrapper.__qualname__ = qualname if isinstance(qualname, str) and qualname else resolved_name
        doc = getattr(inner, "__doc__", None)
        wrapper.__doc__ = doc if isinstance(doc, str) else None
        module = getattr(inner, "__module__", None)
        if isinstance(module, str) and module:
            wrapper.__module__ = module
        wrapper.__annotations__ = _annotations_from(signature)
    except Exception:  # pragma: no cover - never break a wrap over cosmetics
        pass


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
    """Wrap ``fn`` with before/error/after gates. Async functions stay async.

    ``name`` always wins, so a caller that wants two partials of the same
    function on two nodes can say so: ``gm.tool(partial(load, "eu"), name="load_eu")``.
    """
    resolved_name = name or _callable_name(fn)
    state = _Wrapper(
        session_of=session_of,
        name=resolved_name,
        kind=kind,
        node_id=node_id or tool_node_id(resolved_name),
        parent_id=parent_id,
        signature=_signature_of(fn),
    )

    if inspect.iscoroutinefunction(fn):

        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            session = state.session_of()
            if session is None or not session.enabled or session.disposed:
                return await fn(*args, **kwargs)
            return await _run_async(state, session, fn, args, kwargs)

        _copy_metadata(async_wrapper, fn, resolved_name, state.signature)
        _mark(async_wrapper, fn, state)
        return async_wrapper  # type: ignore[return-value]

    def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
        session = state.session_of()
        if session is None or not session.enabled or session.disposed:
            return fn(*args, **kwargs)
        return _run_sync(state, session, fn, args, kwargs)

    _copy_metadata(sync_wrapper, fn, resolved_name, state.signature)
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
