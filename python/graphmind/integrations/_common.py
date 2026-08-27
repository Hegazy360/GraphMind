"""Shared machinery for the provider-SDK integrations.

Three jobs:

1. **Safe previews.** Agent prompts contain base64 images, giant documents and
   arbitrary objects. Everything that goes on the wire is depth-, width- and
   length-bounded first, so instrumenting a vision agent cannot melt the
   socket.
2. **Stream tees.** A streamed response must reach the host untouched while
   GraphMind observes it. The tee proxies the provider's stream object
   (``__getattr__`` passes through ``.response``, ``.close()``, context-manager
   use, ...) and emits token deltas plus the terminal ``node.finished``.
3. **Method patching.** Provider clients expose their calls as bound methods on
   cached resource objects, so instrumentation is an instance attribute
   assignment — no monkey-patching of library classes, no import-time hooks.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Set

from ..ids import LLM_NODE_ID, LLM_NODE_NAME, agent_node_id, tool_node_id
from ..safe import OnceWarner
from ..session import Session

MAX_STRING = 20_000
MAX_ITEMS = 200
MAX_DEPTH = 8

_warner = OnceWarner()


def warn_once(key: str, message: str, cause: Any = None) -> None:
    _warner.warn(key, message, cause)


# -- previews -----------------------------------------------------------------


def safe_value(value: Any, depth: int = 0) -> Any:
    """Bound a user value so it is cheap and safe to serialize."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING else value[:MAX_STRING] + "…[truncated]"
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    if depth >= MAX_DEPTH:
        return "…[depth limit]"
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_ITEMS:
                out["…"] = f"[{len(value) - MAX_ITEMS} more keys]"
                break
            out[str(key)] = safe_value(item, depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        head = [safe_value(item, depth + 1) for item in items[:MAX_ITEMS]]
        if len(items) > MAX_ITEMS:
            head.append(f"…[{len(items) - MAX_ITEMS} more]")
        return head
    for attr in ("model_dump", "to_dict", "dict"):
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return safe_value(method(), depth + 1)
            except Exception:
                break
    try:
        return safe_value(vars(value), depth + 1)
    except Exception:
        pass
    try:
        return safe_value(repr(value), depth + 1)
    except Exception:
        return f"<{type(value).__name__}>"


def tool_names(tools: Any) -> List[str]:
    """Extract tool names from any of the provider tool-definition shapes."""
    names: List[str] = []
    if not isinstance(tools, (list, tuple)):
        return names
    for entry in tools:
        name: Any = None
        if isinstance(entry, dict):
            name = entry.get("name")
            if not name:
                function = entry.get("function")
                if isinstance(function, dict):
                    name = function.get("name")
        else:
            name = getattr(entry, "name", None)
            if name is None:
                function = getattr(entry, "function", None)
                name = getattr(function, "name", None)
        if isinstance(name, str) and name:
            names.append(name)
    return names


class GraphHinter:
    """Emits ``graph.hint`` once per run so the canvas pre-renders the roster."""

    __slots__ = ("_seen",)

    MAX_RUNS = 256

    def __init__(self) -> None:
        self._seen: Set[str] = set()

    def maybe_hint(self, session: Session, tools: Any, node_id: str, node_name: str) -> None:
        try:
            ctx = session.current_run()
            key = ctx.run_id if ctx is not None else "-"
            if key in self._seen:
                return
            if len(self._seen) >= self.MAX_RUNS:
                self._seen.clear()
            self._seen.add(key)
            nodes: List[Dict[str, Any]] = []
            parent: Optional[str] = None
            if ctx is not None:
                parent = agent_node_id(ctx.name)
                nodes.append({"nodeId": parent, "kind": "agent", "name": ctx.name})
            llm: Dict[str, Any] = {"nodeId": node_id, "kind": "llm", "name": node_name}
            if parent is not None:
                llm["parentId"] = parent
            nodes.append(llm)
            for name in tool_names(tools):
                nodes.append(
                    {
                        "nodeId": tool_node_id(name),
                        "kind": "tool",
                        "name": name,
                        "parentId": node_id,
                    }
                )
            session.graph_hint(nodes)
        except Exception:
            pass


# -- usage --------------------------------------------------------------------

_INPUT_FIELDS = ("input_tokens", "prompt_tokens")
_OUTPUT_FIELDS = ("output_tokens", "completion_tokens")


def usage_of(obj: Any) -> Optional[Dict[str, int]]:
    """Map any provider usage object onto the wire ``TokenUsage`` shape."""
    if obj is None:
        return None
    source = obj
    if not any(hasattr(source, field) for field in _INPUT_FIELDS + _OUTPUT_FIELDS):
        source = getattr(obj, "usage", None)
        if source is None and isinstance(obj, dict):
            source = obj.get("usage")
    if source is None:
        return None

    def read(fields: "tuple[str, ...]") -> Optional[int]:
        for field in fields:
            value = (
                source.get(field) if isinstance(source, dict) else getattr(source, field, None)
            )
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    input_tokens = read(_INPUT_FIELDS)
    output_tokens = read(_OUTPUT_FIELDS)
    if input_tokens is None and output_tokens is None:
        return None
    return {
        "inputTokens": max(0, input_tokens or 0),
        "outputTokens": max(0, output_tokens or 0),
    }


def merge_usage(
    left: Optional[Dict[str, int]], right: Optional[Dict[str, int]]
) -> Optional[Dict[str, int]]:
    if left is None:
        return right
    if right is None:
        return left
    return {
        "inputTokens": max(left.get("inputTokens", 0), right.get("inputTokens", 0)),
        "outputTokens": max(left.get("outputTokens", 0), right.get("outputTokens", 0)),
    }


# -- stream tees --------------------------------------------------------------


class SyncStreamTee:
    """Proxy around a provider's sync stream that observes without consuming."""

    def __init__(
        self,
        inner: Any,
        on_chunk: Callable[[Any], None],
        on_end: Callable[[Optional[BaseException]], None],
    ) -> None:
        self._inner = inner
        self._on_chunk = on_chunk
        self._on_end = on_end
        self._iterator: Any = None
        self._finished = False

    def __iter__(self) -> "SyncStreamTee":
        if self._iterator is None:
            self._iterator = iter(self._inner)
        return self

    def __next__(self) -> Any:
        if self._iterator is None:
            self._iterator = iter(self._inner)
        try:
            chunk = next(self._iterator)
        except StopIteration:
            self._finish(None)
            raise
        except BaseException as exc:
            self._finish(exc)
            raise
        try:
            self._on_chunk(chunk)
        except Exception:
            pass
        return chunk

    def __enter__(self) -> "SyncStreamTee":
        enter = getattr(self._inner, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._finish(exc)
        exit_ = getattr(self._inner, "__exit__", None)
        if exit_ is not None:
            try:
                exit_(exc_type, exc, tb)
            except Exception:
                pass
        return False

    def close(self) -> None:
        self._finish(None)
        closer = getattr(self._inner, "close", None)
        if closer is not None:
            try:
                closer()
            except Exception:
                pass

    def _finish(self, error: Optional[BaseException]) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            self._on_end(error)
        except Exception:
            pass

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)


class AsyncStreamTee:
    """Proxy around a provider's async stream."""

    def __init__(
        self,
        inner: Any,
        on_chunk: Callable[[Any], None],
        on_end: Callable[[Optional[BaseException]], None],
    ) -> None:
        self._inner = inner
        self._on_chunk = on_chunk
        self._on_end = on_end
        self._iterator: Any = None
        self._finished = False

    def __aiter__(self) -> "AsyncStreamTee":
        if self._iterator is None:
            self._iterator = self._inner.__aiter__()
        return self

    async def __anext__(self) -> Any:
        if self._iterator is None:
            self._iterator = self._inner.__aiter__()
        try:
            chunk = await self._iterator.__anext__()
        except StopAsyncIteration:
            self._finish(None)
            raise
        except BaseException as exc:
            self._finish(exc)
            raise
        try:
            self._on_chunk(chunk)
        except Exception:
            pass
        return chunk

    async def __aenter__(self) -> "AsyncStreamTee":
        enter = getattr(self._inner, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._finish(exc)
        exit_ = getattr(self._inner, "__aexit__", None)
        if exit_ is not None:
            try:
                await exit_(exc_type, exc, tb)
            except Exception:
                pass
        return False

    async def close(self) -> None:
        self._finish(None)
        closer = getattr(self._inner, "close", None)
        if closer is not None:
            try:
                result = closer()
                if hasattr(result, "__await__"):
                    await result
            except Exception:
                pass

    def _finish(self, error: Optional[BaseException]) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            self._on_end(error)
        except Exception:
            pass

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)


# -- patching -----------------------------------------------------------------

WRAPPED_FLAG = "__graphmind_wrapped__"


def patch_method(
    root: Any,
    path: "tuple[str, ...]",
    attr: str,
    make_wrapper: Callable[[Callable[..., Any]], Callable[..., Any]],
    label: str,
) -> bool:
    """Replace ``root.<path>.<attr>`` with a wrapper. Returns True if it stuck.

    Never raises: a provider SDK that reshapes its resource objects leaves the
    client uninstrumented plus one warning, not a crashed import.
    """
    try:
        target = root
        for part in path:
            target = getattr(target, part, None)
            if target is None:
                return False
        original = getattr(target, attr, None)
        if original is None or not callable(original):
            return False
        if getattr(original, WRAPPED_FLAG, False):
            return True  # already instrumented; idempotent
        wrapper = make_wrapper(original)
        setattr(wrapper, WRAPPED_FLAG, True)
        setattr(wrapper, "__graphmind_original__", original)
        setattr(target, attr, wrapper)
        # Verify the patch stuck: some SDKs build resource objects on every
        # attribute access, in which case an instance patch is invisible.
        check: Any = root
        for part in path:
            check = getattr(check, part, None)
            if check is None:
                return False
        if not getattr(getattr(check, attr, None), WRAPPED_FLAG, False):
            warn_once(
                f"patch-unstable:{label}",
                f"could not instrument {label}: this SDK rebuilds its resource objects on "
                "every access, so GraphMind cannot attach to it. Wrap your own call site "
                "with @gm.tool or gm.span instead.",
            )
            return False
        return True
    except Exception as exc:
        warn_once(f"patch-failed:{label}", f"could not instrument {label}; continuing without it", exc)
        return False


def unpatch_method(root: Any, path: "tuple[str, ...]", attr: str) -> bool:
    """Restore an instrumented method (used by tests and by ``uninstrument``)."""
    try:
        target = root
        for part in path:
            target = getattr(target, part, None)
            if target is None:
                return False
        current = getattr(target, attr, None)
        original = getattr(current, "__graphmind_original__", None)
        if original is None:
            return False
        setattr(target, attr, original)
        return True
    except Exception:
        return False


__all__ = [
    "LLM_NODE_ID",
    "LLM_NODE_NAME",
    "AsyncStreamTee",
    "GraphHinter",
    "SyncStreamTee",
    "merge_usage",
    "patch_method",
    "safe_value",
    "tool_names",
    "unpatch_method",
    "usage_of",
    "warn_once",
]
