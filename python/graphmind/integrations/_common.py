"""Shared machinery for the provider-SDK integrations.

Four jobs:

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
4. **Raw responses and typed inject.** ``.with_raw_response`` /
   ``.with_streaming_response`` route through the same patched method but hand
   the host the SDK's raw response object, and an injected reply has to come
   back as the SDK type the caller reads attributes off, not as a dict.
"""

from __future__ import annotations

import importlib
import inspect
import json
from collections.abc import Callable
from typing import Any

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
        out: dict[str, Any] = {}
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


def tool_names(tools: Any) -> list[str]:
    """Extract tool names from any of the provider tool-definition shapes."""
    names: list[str] = []
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
        self._seen: set[str] = set()

    def maybe_hint(self, session: Session, tools: Any, node_id: str, node_name: str) -> None:
        try:
            ctx = session.current_run()
            key = ctx.run_id if ctx is not None else "-"
            if key in self._seen:
                return
            if len(self._seen) >= self.MAX_RUNS:
                self._seen.clear()
            self._seen.add(key)
            nodes: list[dict[str, Any]] = []
            parent: str | None = None
            if ctx is not None:
                parent = agent_node_id(ctx.name)
                nodes.append({"nodeId": parent, "kind": "agent", "name": ctx.name})
            llm: dict[str, Any] = {"nodeId": node_id, "kind": "llm", "name": node_name}
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


def usage_of(obj: Any) -> dict[str, int] | None:
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

    def read(fields: tuple[str, ...]) -> int | None:
        for field in fields:
            value = source.get(field) if isinstance(source, dict) else getattr(source, field, None)
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


def merge_usage(left: dict[str, int] | None, right: dict[str, int] | None) -> dict[str, int] | None:
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
        on_end: Callable[[BaseException | None], None],
    ) -> None:
        self._inner = inner
        self._on_chunk = on_chunk
        self._on_end = on_end
        self._iterator: Any = None
        self._finished = False

    def __iter__(self) -> SyncStreamTee:
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

    def __enter__(self) -> SyncStreamTee:
        enter = getattr(self._inner, "__enter__", None)
        if enter is not None:
            enter()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._finish(exc)
        exit_ = getattr(self._inner, "__exit__", None)
        if exit_ is not None:
            try:
                exit_(exc_type, exc, tb)
            except Exception:
                pass

    def close(self) -> None:
        self._finish(None)
        closer = getattr(self._inner, "close", None)
        if closer is not None:
            try:
                closer()
            except Exception:
                pass

    def _finish(self, error: BaseException | None) -> None:
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
        on_end: Callable[[BaseException | None], None],
    ) -> None:
        self._inner = inner
        self._on_chunk = on_chunk
        self._on_end = on_end
        self._iterator: Any = None
        self._finished = False

    def __aiter__(self) -> AsyncStreamTee:
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

    async def __aenter__(self) -> AsyncStreamTee:
        enter = getattr(self._inner, "__aenter__", None)
        if enter is not None:
            await enter()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._finish(exc)
        exit_ = getattr(self._inner, "__aexit__", None)
        if exit_ is not None:
            try:
                await exit_(exc_type, exc, tb)
            except Exception:
                pass

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

    def _finish(self, error: BaseException | None) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            self._on_end(error)
        except Exception:
            pass

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)


# -- raw responses ------------------------------------------------------------
#
# Both SDKs (Stainless-generated) implement `.with_raw_response.create(...)` and
# `.with_streaming_response.create(...)` by calling the resource's own bound
# method with one extra header, `X-Stainless-Raw-Response`: "true" returns a
# `LegacyAPIResponse` (body read, `.parse()` sync), "stream" returns an
# `APIResponse` whose body is still unread (`.parse()` async on async clients).
# The wrappers capture `resource.create` when the cached property is first
# touched, so once the method is patched they call the wrapper — which then
# only has to treat the raw object differently from a parsed one.

RAW_RESPONSE_HEADER = "x-stainless-raw-response"
RAW_WRAPPERS = ("with_raw_response", "with_streaming_response")


def raw_mode(kwargs: dict[str, Any]) -> str | None:
    """The raw-response mode a call was made in (``"true"``/``"stream"``), or None."""
    try:
        headers = kwargs.get("extra_headers")
        if not headers:
            return None
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == RAW_RESPONSE_HEADER and value:
                return str(value)
    except Exception:
        pass
    return None


def refresh_raw_wrappers(root: Any, path: tuple[str, ...], attrs: tuple[str, ...]) -> None:
    """Drop cached raw-response wrappers built around a different method.

    ``with_raw_response`` / ``with_streaming_response`` are ``cached_property``
    values that capture ``resource.create`` the first time they are touched.
    Touched *before* ``instrument_*``, they would keep calling the original
    forever; dropping the cache makes the next access rebuild them around
    whatever the resource holds now (the wrapper — or, after ``uninstrument_*``,
    the original again). A no-op when the cache already matches, so
    instrumenting twice changes nothing.
    """
    try:
        resource = root
        for part in path:
            resource = getattr(resource, part, None)
            if resource is None:
                return
        cache = vars(resource)
        for name in RAW_WRAPPERS:
            wrappers = cache.get(name)
            if wrappers is None:
                continue
            for attr in attrs:
                captured = getattr(wrappers, attr, None)
                if captured is None:
                    continue
                if getattr(captured, "__wrapped__", None) != getattr(resource, attr, None):
                    cache.pop(name, None)
                    break
    except Exception:
        pass


def looks_like_stream(value: Any) -> bool:
    """A provider stream object, as opposed to a parsed model or plain data."""
    if value is None or isinstance(value, (str, bytes, bytearray, dict, list, tuple)):
        return False
    if hasattr(value, "model_dump"):
        return False
    return hasattr(value, "__iter__") or hasattr(value, "__aiter__")


def parse_raw(raw: Any) -> Any:
    """Parse a non-streamed raw response exactly as the host's ``.parse()`` would.

    The SDK caches the parsed object on the response, so the host's own
    ``.parse()`` later returns this very object and nothing is read twice.
    Returns None when the body does not parse — the host's ``.parse()`` will
    raise that, not GraphMind.
    """
    try:
        parsed = raw.parse()
        if inspect.isawaitable(parsed):
            # An async `.parse()` reached from a sync wrapper cannot be awaited
            # here; leave the parsing to the host.
            closer = getattr(parsed, "close", None)
            if closer is not None:
                closer()
            return None
        return parsed
    except Exception:
        return None


async def parse_raw_async(raw: Any) -> Any:
    """:func:`parse_raw` for async clients (``LegacyAPIResponse.parse`` stays sync)."""
    try:
        parsed = raw.parse()
        if inspect.isawaitable(parsed):
            parsed = await parsed
        return parsed
    except Exception:
        return None


def close_raw(raw: Any) -> None:
    """Release a raw response we are discarding (retry, abort, inject)."""
    try:
        closer = getattr(raw, "close", None)
        if closer is not None:
            result = closer()
            if inspect.iscoroutine(result):
                result.close()
    except Exception:
        pass


async def close_raw_async(raw: Any) -> None:
    try:
        closer = getattr(raw, "close", None)
        if closer is not None:
            result = closer()
            if inspect.isawaitable(result):
                await result
    except Exception:
        pass


def observe_raw_stream(raw: Any, tee: Callable[[Any], Any], on_close: Callable[[], None]) -> bool:
    """Tee the event stream the host gets from ``raw.parse()``. True if it stuck.

    The raw response goes back to the host untouched except for two instance
    attributes: ``parse`` hands back a tee of the SDK's stream (the same tee on
    every call, as the SDK caches its stream), and ``close`` — which the SDK's
    context manager calls on exit — first finishes the node, so a host that
    stops early or reads raw bytes instead still gets a finished node. The
    object keeps its type; nothing is read ahead of the host.
    """
    try:
        original_parse = raw.parse
        original_close = getattr(raw, "close", None)
        teed: dict[Any, Any] = {}

        def observed(parsed: Any, to: Any) -> Any:
            try:
                if to in teed:
                    return teed[to]
                if looks_like_stream(parsed):
                    teed[to] = tee(parsed)
                    return teed[to]
            except Exception:
                pass
            return parsed

        parse: Callable[..., Any]
        if is_async_callable(original_parse):

            async def parse_async(*args: Any, **kwargs: Any) -> Any:
                return observed(await original_parse(*args, **kwargs), kwargs.get("to"))

            parse = parse_async
        else:

            def parse_sync(*args: Any, **kwargs: Any) -> Any:
                return observed(original_parse(*args, **kwargs), kwargs.get("to"))

            parse = parse_sync
        raw.parse = parse

        def finish() -> None:
            try:
                on_close()
            except Exception:
                pass

        if callable(original_close):
            close: Callable[..., Any]
            if is_async_callable(original_close):

                async def close_async() -> Any:
                    finish()
                    return await original_close()

                close = close_async
            else:

                def close_sync() -> Any:
                    finish()
                    return original_close()

                close = close_sync
            raw.close = close
        return True
    except Exception:
        return False


class _InjectedResponseBase:
    """What a raw-response call hands back when the viewer injected the reply.

    A minimal stand-in for the SDK's raw response: ``.parse()`` returns the
    injected (rebuilt) object. No HTTP happened, so there are no headers and
    the status is a nominal 200.
    """

    def __init__(self, value: Any) -> None:
        self._value = value
        self.headers: dict[str, str] = {}
        self.status_code = 200
        self.request_id: str | None = None
        self.http_response: Any = None
        self.retries_taken = 0
        self.is_closed = True

    def _json(self) -> Any:
        dump = getattr(self._value, "model_dump", None)
        if callable(dump):
            try:
                return dump(mode="json")
            except Exception:
                pass
        return self._value

    def __repr__(self) -> str:
        return f"<graphmind injected response type={type(self._value).__name__}>"


class InjectedResponse(_InjectedResponseBase):
    """Stand-in for ``LegacyAPIResponse`` / sync ``APIResponse``."""

    def parse(self, *args: Any, **kwargs: Any) -> Any:
        return self._value

    def json(self) -> Any:
        return self._json()

    def read(self) -> bytes:
        return json.dumps(self._json(), default=str).encode()

    def close(self) -> None:
        return None


class AsyncInjectedResponse(_InjectedResponseBase):
    """Stand-in for ``AsyncAPIResponse`` (``with_streaming_response`` on async clients)."""

    async def parse(self, *args: Any, **kwargs: Any) -> Any:
        return self._value

    async def json(self) -> Any:
        return self._json()

    async def read(self) -> bytes:
        return json.dumps(self._json(), default=str).encode()

    async def close(self) -> None:
        return None


def injected_response(value: Any, mode: str, async_api: bool) -> Any:
    """The stand-in matching what the raw-response call would have returned."""
    # `with_raw_response` returns a LegacyAPIResponse, whose `.parse()` is sync
    # even on async clients; only `with_streaming_response` goes async.
    if async_api and mode != "true":
        return AsyncInjectedResponse(value)
    return InjectedResponse(value)


# -- typed inject -------------------------------------------------------------
#
# The viewer's inject payload arrives as JSON. Frameworks read attributes off
# the SDK's own types (`response.output`, `.usage`, `.id`, `isinstance(r,
# ChatCompletion)`), so a raw dict breaks them. Each integration supplies a
# builder that turns what a human types — a bare string, or an object with
# (some of) the type's fields — into a dict the type validates; this module
# resolves the type and validates, and never raises.

_reply_classes: dict[tuple[tuple[str, ...], str, str], Any] = {}


def sdk_packages(client: Any) -> tuple[str, ...]:
    """Top-level packages along the client's MRO (``openai`` for ``AzureOpenAI`` too)."""
    try:
        roots: list[str] = []
        for klass in type(client).__mro__:
            root = (getattr(klass, "__module__", "") or "").split(".")[0]
            if root and root not in ("builtins", "typing", "abc") and root not in roots:
                roots.append(root)
        return tuple(roots)
    except Exception:
        return ()


def reply_class(packages: tuple[str, ...], candidates: tuple[tuple[str, str], ...]) -> Any:
    """Import the SDK reply type lazily: the first ``(module, name)`` that exists.

    ``module`` is relative to the client's own package, so a duck-typed fake
    client never gets coerced into a real SDK type. Cached; never raises.
    """
    for module, name in candidates:
        key = (packages, module, name)
        if key in _reply_classes:
            if _reply_classes[key] is not None:
                return _reply_classes[key]
            continue
        found: Any = None
        for package in packages:
            try:
                candidate = getattr(importlib.import_module(f"{package}.{module}"), name, None)
            except Exception:
                continue
            if candidate is not None and callable(getattr(candidate, "model_validate", None)):
                found = candidate
                break
        _reply_classes[key] = found
        if found is not None:
            return found
    return None


class ReplyType:
    """Where the SDK type a patched call returns lives; resolved only on inject."""

    __slots__ = ("candidates", "packages")

    def __init__(self, packages: tuple[str, ...], candidates: tuple[tuple[str, str], ...]) -> None:
        self.packages = packages
        self.candidates = candidates

    def resolve(self, like: Any = None) -> Any:
        """The class to rebuild into: ``type(like)`` when the call already
        returned a model (so ``ParsedChatCompletion[MyModel]`` keeps its
        parameter), else the lazily imported SDK type, else None."""
        if like is not None and callable(getattr(type(like), "model_validate", None)):
            return type(like)
        return reply_class(self.packages, self.candidates)


def rebuild_reply(
    value: Any, cls: Any, build: Callable[[Any], dict[str, Any] | None], label: str
) -> Any:
    """Rebuild an injected payload as ``cls``, the type the SDK call returns.

    Returns ``value`` itself when it already is one, the validated object when
    ``build`` recognises the shape, and otherwise the payload unchanged plus a
    single warning — never an exception into the host.
    """
    try:
        if isinstance(value, cls):
            return value
        data = build(value)
        if data is None:
            raise TypeError(f"expected a string or an object, got {type(value).__name__}")
        return cls.model_validate(data)
    except Exception as exc:
        reason = _first_error(exc)
        warn_once(
            f"inject-rebuild:{label}",
            f"could not rebuild the injected value as {getattr(cls, '__name__', cls)} "
            f"({reason}); handing it back unchanged. Inject a string, or an object "
            "with that type's fields.",
        )
        return value


def _first_error(exc: BaseException) -> str:
    """One line naming what was wrong: the first pydantic error's field, if any."""
    try:
        errors = getattr(exc, "errors", None)
        if callable(errors):
            first = errors()[0]
            where = ".".join(str(part) for part in first.get("loc", ()))
            return f"{where}: {first.get('msg')}" if where else str(first.get("msg"))
    except Exception:
        pass
    lines = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {lines[0]}" if lines else type(exc).__name__


def placeholder_id(prefix: str) -> str:
    return f"{prefix}graphmind_injected"


def json_arguments(value: Any) -> str:
    """Tool-call arguments as the JSON string the SDK types carry."""
    if isinstance(value, str):
        return value
    try:
        return json.dumps({} if value is None else value, default=str)
    except Exception:
        return "{}"


# -- async detection ----------------------------------------------------------


def is_async_callable(fn: Any, _depth: int = 0) -> bool:
    """True for ``async def`` functions, **including decorated ones**.

    Provider SDKs wrap their async methods in synchronous validators
    (``openai``'s ``@required_args``, ``anthropic``'s equivalent), so a bare
    ``inspect.iscoroutinefunction`` reports False for
    ``AsyncOpenAI().chat.completions.create``. Getting this wrong is not a
    cosmetic bug — it would run a blocking gate inside the caller's event loop
    and deadlock the host. So follow ``__func__`` / ``__wrapped__`` down to the
    real function.
    """
    import inspect as _inspect

    target = fn
    for _ in range(10):
        if target is None:
            return False
        if _inspect.iscoroutinefunction(target):
            return True
        nxt = getattr(target, "__func__", None)
        if nxt is not None and nxt is not target:
            target = nxt
            continue
        nxt = getattr(target, "__wrapped__", None)
        if nxt is not None and nxt is not target:
            target = nxt
            continue
        return False
    return False


def is_async_client(client: Any) -> bool:
    """Corroborating signal: the SDK's underlying transport is an httpx AsyncClient."""
    inner = getattr(client, "_client", None)
    if inner is None:
        return False
    name = type(inner).__name__
    return "Async" in name


# -- patching -----------------------------------------------------------------

WRAPPED_FLAG = "__graphmind_wrapped__"


def patch_method(
    root: Any,
    path: tuple[str, ...],
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
        setattr(wrapper, "__graphmind_original__", original)  # noqa: B010
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
        warn_once(
            f"patch-failed:{label}",
            f"could not instrument {label}; continuing without it",
            exc,
        )
        return False


def unpatch_method(root: Any, path: tuple[str, ...], attr: str) -> bool:
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
    "AsyncInjectedResponse",
    "AsyncStreamTee",
    "GraphHinter",
    "InjectedResponse",
    "ReplyType",
    "SyncStreamTee",
    "close_raw",
    "close_raw_async",
    "injected_response",
    "is_async_callable",
    "is_async_client",
    "json_arguments",
    "looks_like_stream",
    "merge_usage",
    "observe_raw_stream",
    "parse_raw",
    "parse_raw_async",
    "patch_method",
    "placeholder_id",
    "raw_mode",
    "rebuild_reply",
    "refresh_raw_wrappers",
    "reply_class",
    "safe_value",
    "sdk_packages",
    "tool_names",
    "unpatch_method",
    "usage_of",
    "warn_once",
]
