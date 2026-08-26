"""The public surface: :class:`GraphMind` plus the module-level default instance.

    import graphmind as gm

    gm.configure(app="support-agent")          # optional

    @gm.tool
    def search_flights(origin: str, dest: str) -> list[dict]:
        ...

    client = gm.instrument_openai(OpenAI())

    with gm.run("handle-ticket"):
        client.chat.completions.create(...)

Everything degrades to a no-op when no debugger is attached, and to literally
nothing when GraphMind is disabled.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Iterable, Optional, TypeVar

from ._version import __version__
from .gate import GateDecision, GateNode
from .ids import next_id
from .session import RunContext, RunScope, Session, SessionStats
from .wrap import ToolsInput, gate_callable
from .wrap import wrap_tools as _wrap_tools

F = TypeVar("F", bound=Callable[..., Any])


class GraphMind:
    """One debugger attachment point for a process."""

    def __init__(
        self,
        *,
        app: str = "python-app",
        sdk: Optional[Dict[str, str]] = None,
        **session_options: Any,
    ) -> None:
        self.session = Session(
            app_name=app,
            sdk=sdk if sdk is not None else {"name": "python", "version": __version__},
            **session_options,
        )

    # -- attach ---------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return self.session.enabled

    @property
    def attached(self) -> bool:
        return self.session.attached

    def ready(self, timeout: float = 2.0) -> bool:
        """Block until the debugger handshake completes (breakpoints armed)."""
        return self.session.ready(timeout)

    async def ready_async(self, timeout: float = 2.0) -> bool:
        """Async twin of :meth:`ready`."""
        return await self.session.ready_async(timeout)

    # -- runs & spans ---------------------------------------------------------

    def run(self, name: str, meta: Optional[Dict[str, Any]] = None) -> RunScope:
        """Run boundary; works as ``with`` and ``async with``."""
        return self.session.run(name, meta)

    def span(
        self,
        name: str,
        kind: str = "custom",
        input: Any = None,
        parent_id: Optional[str] = None,
    ) -> "Span":
        """An arbitrary node on the canvas: gated, timed, sync **and** async.

        Use it for the parts of a graph GraphMind cannot see by itself — a
        LangGraph node body, a retrieval step, a hand-rolled planner loop.
        """
        return Span(self.session, name, kind, input, parent_id)

    def current_run(self) -> Optional[RunContext]:
        return self.session.current_run()

    # -- tools ----------------------------------------------------------------

    def tool(
        self,
        fn: Optional[F] = None,
        *,
        name: Optional[str] = None,
        kind: str = "tool",
        parent_id: Optional[str] = None,
    ) -> Any:
        """Decorator. Usable bare (``@gm.tool``) or called (``@gm.tool(name=...)``)."""

        def decorate(target: F) -> F:
            return gate_callable(
                target,
                lambda: self.session,
                name=name,
                kind=kind,
                parent_id=parent_id,
            )

        if fn is None:
            return decorate
        return decorate(fn)

    def wrap_tools(self, tools: ToolsInput) -> Any:
        """Wrap a ``{name: fn}`` mapping, a list of callables, or one callable."""
        return _wrap_tools(tools, lambda: self.session)

    # -- integrations ---------------------------------------------------------

    def instrument_openai(self, client: Any) -> Any:
        """Instrument an ``openai.OpenAI`` / ``AsyncOpenAI`` client in place."""
        from .integrations.openai import instrument_openai

        return instrument_openai(client, self.session)

    #: Alias matching the naming other tools use.
    wrap_openai = instrument_openai

    def instrument_anthropic(self, client: Any) -> Any:
        """Instrument an ``anthropic.Anthropic`` / ``AsyncAnthropic`` client in place."""
        from .integrations.anthropic import instrument_anthropic

        return instrument_anthropic(client, self.session)

    wrap_anthropic = instrument_anthropic

    def callback_handler(self, **kwargs: Any) -> Any:
        """A sync LangChain/LangGraph ``BaseCallbackHandler`` bound to this session."""
        from .integrations.langchain import GraphMindCallbackHandler

        return GraphMindCallbackHandler(session=self.session, **kwargs)

    def async_callback_handler(self, **kwargs: Any) -> Any:
        """An async LangChain/LangGraph ``AsyncCallbackHandler`` bound to this session."""
        from .integrations.langchain import AsyncGraphMindCallbackHandler

        return AsyncGraphMindCallbackHandler(session=self.session, **kwargs)

    # -- low level ------------------------------------------------------------

    def emit(self, type: str, payload: Dict[str, Any]) -> None:
        self.session.emit(type, payload)

    def gate(self, point: str, node: GateNode) -> GateDecision:
        return self.session.gate(point, node)

    async def gate_async(self, point: str, node: GateNode) -> GateDecision:
        return await self.session.gate_async(point, node)

    def graph_hint(self, nodes: Iterable[Dict[str, Any]]) -> None:
        """Pre-announce static graph structure so the viewer renders it grey."""
        self.session.graph_hint(nodes)

    def stats(self) -> SessionStats:
        return self.session.stats()

    def dispose(self) -> None:
        """Release held gates, flush events, close the socket. Idempotent."""
        self.session.dispose()

    def __enter__(self) -> "GraphMind":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.dispose()
        return False


class Span:
    """A user-declared node, gated like a tool. ``with`` and ``async with``."""

    __slots__ = (
        "_session",
        "_name",
        "_kind",
        "_input",
        "_parent_id",
        "_node",
        "_instance_id",
        "_started",
        "_output",
        "_done",
    )

    def __init__(
        self,
        session: Session,
        name: str,
        kind: str,
        input: Any,
        parent_id: Optional[str],
    ) -> None:
        self._session = session
        self._name = name
        self._kind = kind if kind in ("agent", "llm", "tool", "chain", "retriever", "custom") else "custom"
        self._input = input
        self._parent_id = parent_id
        self._node = GateNode(f"{self._kind}:{name}", self._kind, name)
        self._instance_id = ""
        self._started = 0.0
        self._output: Any = None
        self._done = False

    @property
    def node_id(self) -> str:
        return self._node.node_id

    def set_output(self, output: Any) -> None:
        """Record what this span produced (shown on the node in the viewer)."""
        self._output = output

    def __enter__(self) -> "Span":
        self._begin()
        decision = self._session.gate("before", self._node)
        self._check(decision)
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._end(exc)
        return False

    async def __aenter__(self) -> "Span":
        self._begin()
        decision = await self._session.gate_async("before", self._node)
        self._check(decision)
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._end(exc)
        return False

    def _begin(self) -> None:
        self._instance_id = next_id("span")
        self._started = time.monotonic()
        self._session.start_node(
            node_id=self._node.node_id,
            kind=self._kind,
            name=self._name,
            instance_id=self._instance_id,
            parent_id=self._parent_id,
            input=self._input,
        )

    def _check(self, decision: GateDecision) -> None:
        if decision.action == "abort":
            self._finish(None, "aborted")
            raise self._session.abort_error()
        if decision.action == "inject":
            # A span owns no return value, so an injected one is surfaced as
            # the span's output rather than silently dropped.
            self._output = decision.output

    def _end(self, error: Optional[BaseException]) -> None:
        from .errors import is_abort_error

        if error is not None:
            status = "aborted" if is_abort_error(error) else "error"
            if status == "error":
                self._session.error_node(self._node.node_id, self._instance_id, error)
            self._finish(self._output, status)
            return
        self._finish(self._output, "ok")

    def _finish(self, output: Any, status: str) -> None:
        if self._done:
            return
        self._done = True
        self._session.finish_node(
            node_id=self._node.node_id,
            instance_id=self._instance_id,
            duration_ms=(time.monotonic() - self._started) * 1000.0,
            status=status,
            output=output,
        )


# -- module-level default instance -------------------------------------------

_default: Optional[GraphMind] = None
_default_lock = threading.Lock()


def configure(**options: Any) -> GraphMind:
    """Create (or replace) the process-wide default instance.

    Accepts everything :class:`GraphMind` accepts: ``app``, ``sdk``, ``url``,
    ``enabled``, ``meta``, ``connect_timeout``, ``handshake_timeout``,
    ``retry_interval``, ``buffer_size``, ``pause_timeout``, ``token_interval``,
    ``env``, ``logger``.
    """
    global _default
    with _default_lock:
        previous = _default
        _default = GraphMind(**options)
    if previous is not None:
        previous.dispose()
    return _default


def instance() -> GraphMind:
    """The default instance, created with defaults on first use."""
    global _default
    current = _default
    if current is not None:
        return current
    with _default_lock:
        if _default is None:
            _default = GraphMind()
        return _default


def is_configured() -> bool:
    return _default is not None


def reset() -> None:
    """Dispose and forget the default instance (mainly for tests)."""
    global _default
    with _default_lock:
        current = _default
        _default = None
    if current is not None:
        current.dispose()
