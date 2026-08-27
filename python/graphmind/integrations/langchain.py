"""LangChain / LangGraph callback handlers.

Two handlers, because LangChain dispatches callbacks differently in each world
(verified against ``langchain_core`` 0.3's ``handle_event`` / ``ahandle_event``,
see the capability notes in the package README):

* :class:`GraphMindCallbackHandler` (sync ``BaseCallbackHandler``) — invoked
  inline on the executing thread by ``handle_event``, so blocking inside it
  **holds the chain**. In an *async* chain it is dispatched to the default
  executor but still awaited by ``asyncio.gather``, so it holds there too — at
  the cost of parking a thread-pool thread per concurrent run.
* :class:`AsyncGraphMindCallbackHandler` (``AsyncCallbackHandler``) — awaited
  directly by ``ahandle_event``. Prefer this for async chains and for
  LangGraph's async runtime: it holds without occupying a thread.

Both set ``raise_error = True`` so an ``abort`` from the debugger can terminate
the chain. Every handler body is fully guarded, so the only exception that ever
escapes is GraphMind's own :class:`~graphmind.errors.GraphMindAbortError`.

**Honest limits.** Callbacks are observers: LangChain ignores their return
value, so ``inject`` and ``retry`` cannot substitute a chain/LLM/tool result
here. They are accepted, logged once and treated as ``continue``. To inject or
retry a tool result, wrap the tool function with ``@gm.tool`` (or wrap the call
site in ``gm.span``) — that owns the call and can replace it.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from ..errors import GraphMindAbortError, to_error_info
from ..gate import GateNode
from ..ids import agent_node_id
from ..session import Session
from ._common import safe_value, usage_of, warn_once

try:  # pragma: no cover - exercised by the "framework absent" path
    from langchain_core.callbacks.base import (  # type: ignore[import-not-found]
        AsyncCallbackHandler as _AsyncBase,
    )
    from langchain_core.callbacks.base import (  # type: ignore[import-not-found]
        BaseCallbackHandler as _SyncBase,
    )

    LANGCHAIN_AVAILABLE = True
except Exception:  # pragma: no cover
    LANGCHAIN_AVAILABLE = False

    class _SyncBase:  # type: ignore[no-redef]
        raise_error = False
        run_inline = False

    class _AsyncBase:  # type: ignore[no-redef]
        raise_error = False
        run_inline = False


_MISSING = (
    "GraphMind's LangChain handler needs `langchain-core`. Install it with "
    "`pip install langchain-core` (or `pip install 'graphmind-ai[langchain]'`)."
)

MAX_TRACKED_RUNS = 4096


class _Node:
    __slots__ = ("instance_id", "kind", "name", "node_id", "started")

    def __init__(self, node_id: str, kind: str, name: str, instance_id: str) -> None:
        self.node_id = node_id
        self.kind = kind
        self.name = name
        self.instance_id = instance_id
        self.started = time.monotonic()

    def gate_node(self) -> GateNode:
        return GateNode(self.node_id, self.kind, self.name)


def _name_of(serialized: Any, kwargs: dict[str, Any], fallback: str) -> str:
    name = kwargs.get("name")
    if isinstance(name, str) and name:
        return name
    if isinstance(serialized, dict):
        candidate = serialized.get("name")
        if isinstance(candidate, str) and candidate:
            return candidate
        ident = serialized.get("id")
        if isinstance(ident, (list, tuple)) and ident:
            last = ident[-1]
            if isinstance(last, str) and last:
                return last
        kwargs_block = serialized.get("kwargs")
        if isinstance(kwargs_block, dict):
            model = kwargs_block.get("model") or kwargs_block.get("model_name")
            if isinstance(model, str) and model:
                return model
    return fallback


def _llm_output(response: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        texts: list[str] = []
        generations = getattr(response, "generations", None) or []
        for batch in generations:
            for generation in batch or []:
                text = getattr(generation, "text", None)
                if isinstance(text, str) and text:
                    texts.append(text)
        out["text"] = safe_value("".join(texts))
        llm_output = getattr(response, "llm_output", None)
        if isinstance(llm_output, dict):
            usage = usage_of(llm_output.get("token_usage") or llm_output)
            if usage is not None:
                out["_usage"] = usage
            model = llm_output.get("model_name") or llm_output.get("model")
            if isinstance(model, str):
                out["model"] = model
        if "_usage" not in out:
            for batch in generations:
                for generation in batch or []:
                    message = getattr(generation, "message", None)
                    metadata = getattr(message, "usage_metadata", None)
                    usage = usage_of(metadata)
                    if usage is not None:
                        out["_usage"] = usage
                        break
    except Exception:
        pass
    return out


def _documents_output(documents: Any) -> Any:
    try:
        return safe_value(
            [
                {
                    "pageContent": getattr(doc, "page_content", None),
                    "metadata": getattr(doc, "metadata", None),
                }
                for doc in (documents or [])
            ]
        )
    except Exception:
        return safe_value(documents)


class _Core:
    """Everything the sync and async handlers share, minus the awaiting."""

    def __init__(self, session: Session, capture_tokens: bool = True) -> None:
        self.session = session
        self.capture_tokens = capture_tokens
        self._runs: OrderedDict[str, _Node] = OrderedDict()

    # -- registry -------------------------------------------------------------

    def register(
        self,
        run_id: Any,
        node_id: str,
        kind: str,
        name: str,
        parent_run_id: Any,
        input: Any,
    ) -> _Node | None:
        key = str(run_id)
        node = _Node(node_id, kind, name, key)
        self._runs[key] = node
        while len(self._runs) > MAX_TRACKED_RUNS:
            self._runs.popitem(last=False)
        parent = self.parent_node_id(parent_run_id)
        self.session.start_node(
            node_id=node_id,
            kind=kind,
            name=name,
            instance_id=key,
            parent_id=parent,
            input=input,
            extra={"framework": "langchain"},
        )
        return node

    def parent_node_id(self, parent_run_id: Any) -> str | None:
        if parent_run_id is not None:
            parent = self._runs.get(str(parent_run_id))
            if parent is not None:
                return parent.node_id
        ctx = self.session.current_run()
        return agent_node_id(ctx.name) if ctx is not None else None

    def pop(self, run_id: Any) -> _Node | None:
        return self._runs.pop(str(run_id), None)

    def peek(self, run_id: Any) -> _Node | None:
        return self._runs.get(str(run_id))

    # -- emit -----------------------------------------------------------------

    def finish(self, node: _Node, output: Any, status: str, usage: Any = None) -> None:
        self.session.finish_node(
            node_id=node.node_id,
            instance_id=node.instance_id,
            duration_ms=(time.monotonic() - node.started) * 1000.0,
            status=status,
            output=output,
            usage=usage,
            extra={"framework": "langchain"},
        )

    def error(self, node: _Node, error: Any) -> None:
        self.session.emit(
            "node.error",
            {
                "nodeId": node.node_id,
                "instanceId": node.instance_id,
                "error": to_error_info(error),
                "framework": "langchain",
            },
        )

    def token(self, run_id: Any, token: str) -> None:
        if not self.capture_tokens or not token:
            return
        node = self.peek(run_id)
        if node is not None:
            self.session.push_token(node.node_id, "text", token)

    # -- gate decisions -------------------------------------------------------

    def apply(self, decision: Any, node: _Node) -> None:
        """Turn a gate decision into behaviour a callback can actually deliver."""
        action = getattr(decision, "action", "continue")
        if action == "abort":
            self.finish(node, None, "aborted")
            raise GraphMindAbortError()
        if action in ("inject", "retry"):
            warn_once(
                f"langchain-{action}",
                f"`{action}` is not supported at a LangChain callback gate — callbacks "
                "cannot substitute a result, so GraphMind continued instead. Wrap the "
                "tool with @gm.tool (or the call site with gm.span) to use it.",
            )


class _HandlerMixin:
    """Shared attributes for both handler flavours."""

    #: Needed so an `abort` decision can actually terminate the chain. Every
    #: handler body is guarded, so nothing else ever escapes.
    raise_error = True
    run_inline = False

    _core: _Core

    @property
    def session(self) -> Session:
        return self._core.session

    def _init_core(self, session: Session | None, capture_tokens: bool) -> None:
        if not LANGCHAIN_AVAILABLE:
            raise ImportError(_MISSING)
        if session is None:
            from ..api import instance

            session = instance().session
        self._core = _Core(session, capture_tokens)


class GraphMindCallbackHandler(_HandlerMixin, _SyncBase):  # type: ignore[misc]
    """Sync LangChain/LangGraph callback handler.

    ``chain`` / ``llm`` / ``tool`` / ``retriever`` runs become graph nodes,
    parented by ``parent_run_id``; ``before`` gates fire at every ``*_start``,
    ``error`` gates at every ``*_error``, ``after`` gates at every ``*_end``.
    """

    def __init__(self, session: Session | None = None, capture_tokens: bool = True) -> None:
        self._init_core(session, capture_tokens)

    # -- chains ---------------------------------------------------------------

    def on_chain_start(
        self,
        serialized: Any,
        inputs: Any,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        self._start("chain", serialized, inputs, run_id, parent_run_id, kwargs, "chain")

    def on_chain_end(self, outputs: Any, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        self._end(run_id, safe_value(outputs))

    def on_chain_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        self._error(run_id, error)

    # -- llms -----------------------------------------------------------------

    def on_llm_start(
        self,
        serialized: Any,
        prompts: Sequence[str],
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        self._start("llm", serialized, {"prompts": prompts}, run_id, parent_run_id, kwargs, "llm")

    def on_chat_model_start(
        self,
        serialized: Any,
        messages: Any,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        self._start(
            "llm", serialized, {"messages": messages}, run_id, parent_run_id, kwargs, "chat-model"
        )

    def on_llm_new_token(self, token: str, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            self._core.token(run_id, token)
        except Exception:
            pass

    def on_llm_end(self, response: Any, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        output = _llm_output(response)
        usage = output.pop("_usage", None)
        self._end(run_id, output, usage)

    def on_llm_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        self._error(run_id, error)

    # -- tools ----------------------------------------------------------------

    def on_tool_start(
        self,
        serialized: Any,
        input_str: str,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        inputs: Any = None,
        **kwargs: Any,
    ) -> None:
        payload = inputs if inputs is not None else input_str
        self._start("tool", serialized, payload, run_id, parent_run_id, kwargs, "tool")

    def on_tool_end(self, output: Any, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        self._end(run_id, safe_value(output))

    def on_tool_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        self._error(run_id, error)

    # -- retrievers -----------------------------------------------------------

    def on_retriever_start(
        self,
        serialized: Any,
        query: str,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        self._start(
            "retriever", serialized, {"query": query}, run_id, parent_run_id, kwargs, "retriever"
        )

    def on_retriever_end(
        self, documents: Any, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        self._end(run_id, _documents_output(documents))

    def on_retriever_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        self._error(run_id, error)

    # -- shared ---------------------------------------------------------------

    def _start(
        self,
        kind: str,
        serialized: Any,
        payload: Any,
        run_id: Any,
        parent_run_id: Any,
        kwargs: dict[str, Any],
        fallback: str,
    ) -> None:
        node: _Node | None = None
        try:
            name = _name_of(serialized, kwargs, fallback)
            node = self._core.register(
                run_id, f"{kind}:{name}", kind, name, parent_run_id, safe_value(payload)
            )
        except GraphMindAbortError:
            raise
        except Exception:
            return
        if node is None:
            return
        decision = self._core.session.gate("before", node.gate_node())
        self._core.apply(decision, node)

    def _end(self, run_id: Any, output: Any, usage: Any = None) -> None:
        node: _Node | None = None
        try:
            node = self._core.pop(run_id)
            if node is None:
                return
            self._core.finish(node, output, "ok", usage)
        except GraphMindAbortError:
            raise
        except Exception:
            return
        decision = self._core.session.gate("after", node.gate_node())
        self._core.apply(decision, node)

    def _error(self, run_id: Any, error: BaseException) -> None:
        node: _Node | None = None
        try:
            node = self._core.pop(run_id)
            if node is None:
                return
            self._core.error(node, error)
            self._core.finish(node, None, "error")
        except GraphMindAbortError:
            raise
        except Exception:
            return
        decision = self._core.session.gate("error", node.gate_node())
        self._core.apply(decision, node)


class AsyncGraphMindCallbackHandler(_HandlerMixin, _AsyncBase):  # type: ignore[misc]
    """Async twin of :class:`GraphMindCallbackHandler`.

    ``ahandle_event`` awaits async handlers directly, so gates here hold the
    chain without parking a thread-pool thread. Use this one with LangGraph's
    async runtime and with ``.ainvoke`` / ``.astream``.
    """

    def __init__(self, session: Session | None = None, capture_tokens: bool = True) -> None:
        self._init_core(session, capture_tokens)

    async def on_chain_start(
        self,
        serialized: Any,
        inputs: Any,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        await self._start("chain", serialized, inputs, run_id, parent_run_id, kwargs, "chain")

    async def on_chain_end(
        self, outputs: Any, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._end(run_id, safe_value(outputs))

    async def on_chain_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._error(run_id, error)

    async def on_llm_start(
        self,
        serialized: Any,
        prompts: Sequence[str],
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        await self._start(
            "llm", serialized, {"prompts": prompts}, run_id, parent_run_id, kwargs, "llm"
        )

    async def on_chat_model_start(
        self,
        serialized: Any,
        messages: Any,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        await self._start(
            "llm", serialized, {"messages": messages}, run_id, parent_run_id, kwargs, "chat-model"
        )

    async def on_llm_new_token(
        self, token: str, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        try:
            self._core.token(run_id, token)
        except Exception:
            pass

    async def on_llm_end(self, response: Any, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        output = _llm_output(response)
        usage = output.pop("_usage", None)
        await self._end(run_id, output, usage)

    async def on_llm_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._error(run_id, error)

    async def on_tool_start(
        self,
        serialized: Any,
        input_str: str,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        inputs: Any = None,
        **kwargs: Any,
    ) -> None:
        payload = inputs if inputs is not None else input_str
        await self._start("tool", serialized, payload, run_id, parent_run_id, kwargs, "tool")

    async def on_tool_end(self, output: Any, *, run_id: UUID | None = None, **kwargs: Any) -> None:
        await self._end(run_id, safe_value(output))

    async def on_tool_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._error(run_id, error)

    async def on_retriever_start(
        self,
        serialized: Any,
        query: str,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,
        **kwargs: Any,
    ) -> None:
        await self._start(
            "retriever", serialized, {"query": query}, run_id, parent_run_id, kwargs, "retriever"
        )

    async def on_retriever_end(
        self, documents: Any, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._end(run_id, _documents_output(documents))

    async def on_retriever_error(
        self, error: BaseException, *, run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        await self._error(run_id, error)

    # -- shared ---------------------------------------------------------------

    async def _start(
        self,
        kind: str,
        serialized: Any,
        payload: Any,
        run_id: Any,
        parent_run_id: Any,
        kwargs: dict[str, Any],
        fallback: str,
    ) -> None:
        try:
            name = _name_of(serialized, kwargs, fallback)
            node = self._core.register(
                run_id, f"{kind}:{name}", kind, name, parent_run_id, safe_value(payload)
            )
        except GraphMindAbortError:
            raise
        except Exception:
            return
        if node is None:
            return
        decision = await self._core.session.gate_async("before", node.gate_node())
        self._core.apply(decision, node)

    async def _end(self, run_id: Any, output: Any, usage: Any = None) -> None:
        try:
            node = self._core.pop(run_id)
            if node is None:
                return
            self._core.finish(node, output, "ok", usage)
        except GraphMindAbortError:
            raise
        except Exception:
            return
        decision = await self._core.session.gate_async("after", node.gate_node())
        self._core.apply(decision, node)

    async def _error(self, run_id: Any, error: BaseException) -> None:
        try:
            node = self._core.pop(run_id)
            if node is None:
                return
            self._core.error(node, error)
            self._core.finish(node, None, "error")
        except GraphMindAbortError:
            raise
        except Exception:
            return
        decision = await self._core.session.gate_async("error", node.gate_node())
        self._core.apply(decision, node)


__all__ = [
    "LANGCHAIN_AVAILABLE",
    "AsyncGraphMindCallbackHandler",
    "GraphMindCallbackHandler",
]
