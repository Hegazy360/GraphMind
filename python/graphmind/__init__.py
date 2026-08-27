"""GraphMind — a live debugger for AI agents.

Phoenix and Langfuse show you what your agent *did*. GraphMind attaches while
it's happening: an instrumented app streams execution events to a local viewer,
which renders the run as a live graph and can **hold execution** — before an
LLM step, before/after a tool call, or on error — then resume with
``continue`` / ``retry`` / ``inject`` / ``abort``.

Quickstart::

    import graphmind as gm
    from openai import OpenAI

    client = gm.instrument_openai(OpenAI())

    @gm.tool
    def search_flights(origin: str, destination: str) -> list[dict]:
        ...

    with gm.run("handle-ticket"):
        client.chat.completions.create(model="gpt-5", messages=[...])

Then run ``graphmind serve`` (from the ``graphmind-ai`` npm CLI) and open the
viewer. With nothing attached, all of the above is a no-op.

Everything fails open: no debugger means near-zero overhead, and a debugger
that disconnects mid-hold auto-continues every held gate.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from ._version import __version__
from .api import GraphMind, Span, configure, init, instance, is_configured, reset
from .env import DEFAULT_URL
from .errors import GraphMindAbortError, is_abort_error
from .gate import GateDecision, GateNode
from .protocol import PROTOCOL_VERSION
from .session import RunContext, RunScope, Session, SessionStats

__all__ = [
    "DEFAULT_URL",
    "PROTOCOL_VERSION",
    "AsyncGraphMindCallbackHandler",
    "GateDecision",
    "GateNode",
    "GraphMind",
    "GraphMindAbortError",
    "GraphMindCallbackHandler",
    "RunContext",
    "RunScope",
    "Session",
    "SessionStats",
    "Span",
    "__version__",
    "async_callback_handler",
    "async_handler",
    "callback_handler",
    "configure",
    "dispose",
    "emit",
    "graph_hint",
    "handler",
    "init",
    "instance",
    "instrument_anthropic",
    "instrument_openai",
    "is_abort_error",
    "is_configured",
    "ready",
    "ready_async",
    "reset",
    "run",
    "session",
    "span",
    "stats",
    "tool",
    "wrap_anthropic",
    "wrap_openai",
    "wrap_tools",
]


# -- module-level convenience API (delegates to the default instance) ---------


def run(name: str, meta: dict[str, Any] | None = None) -> RunScope:
    """Run boundary. Works as ``with gm.run(...)`` and ``async with gm.run(...)``."""
    return instance().run(name, meta)


def span(name: str, kind: str = "custom", input: Any = None, parent_id: str | None = None) -> Span:
    """A gated, timed node for code GraphMind cannot see by itself."""
    return instance().span(name, kind, input, parent_id)


def tool(
    fn: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    kind: str = "tool",
    parent_id: str | None = None,
) -> Any:
    """Decorate a tool function so the debugger can pause, retry and inject it."""
    return instance().tool(fn, name=name, kind=kind, parent_id=parent_id)


def wrap_tools(tools: Any) -> Any:
    """Wrap a ``{name: fn}`` mapping, a list of callables, or one callable."""
    return instance().wrap_tools(tools)


def instrument_openai(client: Any) -> Any:
    """Instrument an ``openai`` client in place and return it."""
    return instance().instrument_openai(client)


#: Alias for people used to other tooling's naming.
wrap_openai = instrument_openai


def instrument_anthropic(client: Any) -> Any:
    """Instrument an ``anthropic`` client in place and return it."""
    return instance().instrument_anthropic(client)


wrap_anthropic = instrument_anthropic


def ready(timeout: float = 2.0) -> bool:
    """Block until a debugger is attached. ``False`` means "carry on detached"."""
    return instance().ready(timeout)


async def ready_async(timeout: float = 2.0) -> bool:
    """Async twin of :func:`ready`."""
    return await instance().ready_async(timeout)


def emit(type: str, payload: dict[str, Any]) -> None:
    """Emit a raw protocol event (advanced)."""
    instance().emit(type, payload)


def graph_hint(nodes: Iterable[dict[str, Any]]) -> None:
    """Pre-announce static graph structure so the viewer renders it grey."""
    instance().graph_hint(nodes)


def stats() -> SessionStats:
    """Diagnostics snapshot of the default session."""
    return instance().stats()


def session() -> Session:
    """The default instance's underlying session (advanced)."""
    return instance().session


def dispose() -> None:
    """Release held gates, flush events, close the socket. Idempotent."""
    instance().dispose()


def callback_handler(**kwargs: Any) -> Any:
    """A sync LangChain/LangGraph handler bound to the default session."""
    return instance().callback_handler(**kwargs)


def async_callback_handler(**kwargs: Any) -> Any:
    """An async LangChain/LangGraph handler bound to the default session."""
    return instance().async_callback_handler(**kwargs)


#: Short aliases matching the docs and `graphmind init` scaffolding.
handler = callback_handler
async_handler = async_callback_handler


def __getattr__(name: str) -> Any:
    """Lazily expose the LangChain handlers without importing langchain_core."""
    if name in ("GraphMindCallbackHandler", "AsyncGraphMindCallbackHandler"):
        from .integrations import langchain

        return getattr(langchain, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
