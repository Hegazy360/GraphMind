"""What every LLM integration records about a model step (0.6.0+, contract C1).

Port of ``packages/client/src/llm-capture.ts`` and ``packages/schema/src/llm.ts``
(read those for the rationale); held to the same conformance fixture,
``packages/client/test/fixtures/llm.json``.

* :func:`make_usage` — the wire ``TokenUsage``: ``inputTokens`` is the TOTAL
  prompt (cached reads and cache writes included), ``inclusive: True`` always;
  ``cacheReadTokens`` / ``cacheWriteTokens`` / ``reasoningTokens`` only when
  the provider reported them (a reported ``0`` stays ``0``; an unreported
  count is absent, never 0-filled). The provider mappers
  (:func:`anthropic_usage`, :func:`openai_chat_usage`,
  :func:`openai_responses_usage`, :func:`langchain_usage`) and the shape
  sniffing :func:`usage_of` build on it.
* :func:`normalize_finish_reason` — ``stop|length|tool-calls|content-filter|
  error|other`` from a provider's own string (kept as ``rawFinishReason``).
* :func:`tool_call` — one requested call as ``{id?, name, input, inputText?}``;
  ``inputText`` keeps the raw argument text only when it does not parse.
* :func:`capture_tools` — ``tools: [{name, schemaHash}]`` plus
  ``toolSchemas: {hash: definition}`` the first time a run sees a definition
  (sha256 of the canonical JSON, first 16 hex chars; the memory is per session,
  bounded to 256 runs x 1024 hashes). A definition is recorded (and hashed) as
  :func:`sanitize_tool_definition` leaves it: its schema verbatim, never a
  credential it carries (an OpenAI ``type: "mcp"`` tool's ``authorization``
  and ``headers``).
* :func:`pick_params` — the allow-listed sampling parameters actually sent.
* :func:`record_value` — a prompt made JSON-safe WITHOUT the length/width caps
  of ``safe_value`` (bytes become ``{"type": "binary", "bytes": n}``): the
  session's 512 KB per-event shrink is the only bound on a recorded prompt.

Nothing here raises into an integration.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import weakref
from collections import OrderedDict
from collections.abc import Callable, Mapping
from typing import Any

from .loop_guard import canonicalize

__all__ = [
    "FINISH_REASONS",
    "MAX_SCHEMA_HASHES_PER_RUN",
    "MAX_SCHEMA_RUNS",
    "SAMPLING_PARAM_KEYS",
    "SCHEMA_HASH_HEX_CHARS",
    "AnthropicUsageAccumulator",
    "anthropic_usage",
    "capture_tools",
    "finish_fields",
    "langchain_usage",
    "make_usage",
    "normalize_finish_reason",
    "openai_chat_usage",
    "openai_responses_usage",
    "pick_params",
    "record_value",
    "release_tool_schemas",
    "reset_tool_schema_memory",
    "sanitize_tool_definition",
    "schema_hash",
    "sum_reported",
    "token_count",
    "tool_call",
    "tool_def_name",
    "usage_of",
]

# -- finish reasons -------------------------------------------------------------

FINISH_REASONS = ("stop", "length", "tool-calls", "content-filter", "error", "other")

_FINISH_REASON_MAP = {
    "stop": "stop",
    "end_turn": "stop",
    "stop_sequence": "stop",
    "pause_turn": "other",  # a paused server-tool turn: the model did not finish
    "eos": "stop",
    "eos_token": "stop",
    "complete": "stop",
    "completed": "stop",
    "finished": "stop",
    "length": "length",
    "max_tokens": "length",
    "max_output_tokens": "length",
    "max_completion_tokens": "length",
    "model_context_window_exceeded": "length",
    "model_length": "length",
    "tool_calls": "tool-calls",
    "tool_call": "tool-calls",
    "tool_use": "tool-calls",
    "function_call": "tool-calls",
    "content_filter": "content-filter",
    "content_filtered": "content-filter",
    "refusal": "content-filter",
    "safety": "content-filter",
    "recitation": "content-filter",
    "blocklist": "content-filter",
    "prohibited_content": "content-filter",
    "spii": "content-filter",
    "image_safety": "content-filter",
    "guardrail_intervened": "content-filter",
    "error": "error",
    "failed": "error",
    "malformed_function_call": "error",
    "other": "other",
    "unknown": "other",
}

_FOLD = re.compile(r"[-\s]+")


def normalize_finish_reason(raw: Any, has_tool_calls: bool = False) -> str | None:
    """The normalized finish reason, or ``None`` when nothing usable was
    reported. A plain stop on a step that requested tool calls is
    ``tool-calls`` (Gemini reports ``STOP`` there)."""
    if not isinstance(raw, str):
        return None
    key = _FOLD.sub("_", str.__str__(raw).strip().lower())
    if not key:
        return None
    mapped = _FINISH_REASON_MAP.get(key, "other")
    return "tool-calls" if mapped == "stop" and has_tool_calls else mapped


def finish_fields(raw: Any, has_tool_calls: bool, refused: bool = False) -> dict[str, str]:
    """``finishReason`` (normalized) and ``rawFinishReason`` (as reported). A
    ``refused`` step (OpenAI: a plain stop carrying a refusal) is
    ``content-filter``, as Anthropic's ``refusal`` stop reason is."""
    out: dict[str, str] = {}
    normalized = normalize_finish_reason(raw, has_tool_calls)
    if refused and normalized == "stop":
        normalized = "content-filter"
    if normalized is not None:
        out["finishReason"] = normalized
    if isinstance(raw, str) and raw:
        out["rawFinishReason"] = str.__str__(raw)
    return out


# -- usage ------------------------------------------------------------------------


def token_count(value: Any) -> int | None:
    """A finite non-negative number rounded like JS ``Math.round``; else ``None``
    (``bool`` and strings are not counts)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except Exception:
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return int(value) if isinstance(value, int) else math.floor(number + 0.5)


def sum_reported(*parts: int | None) -> int | None:
    """The sum of the parts that were reported; ``None`` when none was."""
    total: int | None = None
    for part in parts:
        if part is not None:
            total = (total or 0) + part
    return total


def make_usage(
    input: int | None = None,
    output: int | None = None,
    cache_read: int | None = None,
    cache_write: int | None = None,
    reasoning: int | None = None,
    extras: Mapping[str, int | None] | None = None,
) -> dict[str, Any] | None:
    """The wire ``TokenUsage`` for one step, or ``None`` when neither the input
    nor the output count was reported. The schema requires both counts, so the
    one a provider left out is ``0``; the optional counts are never invented."""
    input_tokens = token_count(input)
    output_tokens = token_count(output)
    if input_tokens is None and output_tokens is None:
        return None
    usage: dict[str, Any] = {
        "inputTokens": input_tokens or 0,
        "outputTokens": output_tokens or 0,
        "inclusive": True,
    }
    for key, value in (
        ("cacheReadTokens", cache_read),
        ("cacheWriteTokens", cache_write),
        ("reasoningTokens", reasoning),
    ):
        count = token_count(value)
        if count is not None:
            usage[key] = count
    for key, value in (extras or {}).items():
        count = token_count(value)
        if count is not None:
            usage[key] = count
    return usage


def _get(source: Any, key: str) -> Any:
    """``source[key]`` for a mapping, ``source.key`` for an SDK object."""
    if source is None:
        return None
    if isinstance(source, Mapping):
        return source.get(key)
    try:
        return getattr(source, key, None)
    except Exception:
        return None


def _has(source: Any, key: str) -> bool:
    if isinstance(source, Mapping):
        return key in source
    try:
        return hasattr(source, key)
    except Exception:
        return False


def _anthropic_cache_write(source: Any) -> int | None:
    total = token_count(_get(source, "cache_creation_input_tokens"))
    if total is not None:
        return total
    split = _get(source, "cache_creation")
    if split is None:
        return None
    return sum_reported(
        token_count(_get(split, "ephemeral_5m_input_tokens")),
        token_count(_get(split, "ephemeral_1h_input_tokens")),
    )


def anthropic_usage(usage: Any) -> dict[str, Any] | None:
    """Anthropic ``Usage``: ``input_tokens`` is the UNCACHED tail, so the total is
    ``input_tokens + cache_read_input_tokens + cache_creation_input_tokens``
    (the 5m/1h ``cache_creation`` split summed when only it was reported);
    ``output_tokens_details.thinking_tokens`` (extended thinking) is the
    reasoning count when reported."""
    if usage is None:
        return None
    cache_read = token_count(_get(usage, "cache_read_input_tokens"))
    cache_write = _anthropic_cache_write(usage)
    return make_usage(
        input=sum_reported(token_count(_get(usage, "input_tokens")), cache_read, cache_write),
        output=token_count(_get(usage, "output_tokens")),
        cache_read=cache_read,
        cache_write=cache_write,
        reasoning=token_count(_get(_get(usage, "output_tokens_details"), "thinking_tokens")),
    )


def openai_chat_usage(usage: Any) -> dict[str, Any] | None:
    """Chat Completions usage: ``prompt_tokens`` is inclusive; cache reads in
    ``prompt_tokens_details.cached_tokens`` (``prompt_cache_hit_tokens`` on
    OpenAI-compatible servers), writes in ``.cache_write_tokens``, reasoning in
    ``completion_tokens_details.reasoning_tokens``."""
    if usage is None:
        return None
    details = _get(usage, "prompt_tokens_details")
    cache_read = token_count(_get(details, "cached_tokens"))
    if cache_read is None:
        cache_read = token_count(_get(usage, "prompt_cache_hit_tokens"))
    return make_usage(
        input=token_count(_get(usage, "prompt_tokens")),
        output=token_count(_get(usage, "completion_tokens")),
        cache_read=cache_read,
        cache_write=token_count(_get(details, "cache_write_tokens")),
        reasoning=token_count(_get(_get(usage, "completion_tokens_details"), "reasoning_tokens")),
    )


def openai_responses_usage(usage: Any) -> dict[str, Any] | None:
    """Responses usage: ``input_tokens`` is inclusive; details in
    ``input_tokens_details`` / ``output_tokens_details``."""
    if usage is None:
        return None
    details = _get(usage, "input_tokens_details")
    return make_usage(
        input=token_count(_get(usage, "input_tokens")),
        output=token_count(_get(usage, "output_tokens")),
        cache_read=token_count(_get(details, "cached_tokens")),
        cache_write=token_count(_get(details, "cache_write_tokens")),
        reasoning=token_count(_get(_get(usage, "output_tokens_details"), "reasoning_tokens")),
    )


def langchain_usage(usage: Any) -> dict[str, Any] | None:
    """LangChain ``usage_metadata`` (inclusive by LangChain's definition), or
    whichever raw provider shape an integration left in ``llm_output`` /
    ``response_metadata`` (see :func:`usage_of`). An integration that still
    reports Anthropic's uncached tail as ``input_tokens`` is recognisable when
    the cache counts exceed it; then they are added."""
    if usage is None:
        return None
    if _looks_anthropic(usage):
        return anthropic_usage(usage)
    if _has(usage, "input_token_details") or _has(usage, "output_token_details"):
        in_details = _get(usage, "input_token_details")
        cache_read = token_count(_get(in_details, "cache_read"))
        cache_write = token_count(_get(in_details, "cache_creation"))
        if in_details is not None:
            # langchain-anthropic reports the writes as the 5m/1h split and
            # zeroes ``cache_creation`` ("to avoid double counting").
            split = sum_reported(
                token_count(_get(in_details, "ephemeral_5m_input_tokens")),
                token_count(_get(in_details, "ephemeral_1h_input_tokens")),
            )
            if split is not None and (cache_write is None or split > cache_write):
                cache_write = split
        input_tokens = token_count(_get(usage, "input_tokens"))
        cached = sum_reported(cache_read, cache_write)
        if input_tokens is not None and cached is not None and cached > input_tokens:
            input_tokens += cached
        return make_usage(
            input=input_tokens,
            output=token_count(_get(usage, "output_tokens")),
            cache_read=cache_read,
            cache_write=cache_write,
            reasoning=token_count(_get(_get(usage, "output_token_details"), "reasoning")),
        )
    return usage_of(usage)


def _looks_anthropic(usage: Any) -> bool:
    """Anthropic's raw usage: it names its cache fields (an SDK ``Usage`` object
    has them as attributes, ``None`` when unused; a JSON dict as keys)."""
    return (
        _has(usage, "cache_read_input_tokens")
        or _has(usage, "cache_creation_input_tokens")
        or _get(usage, "cache_creation") is not None
        or token_count(_get(_get(usage, "output_tokens_details"), "thinking_tokens")) is not None
    )


def usage_of(obj: Any) -> dict[str, Any] | None:
    """Map any provider usage object (or an object carrying one as ``.usage``)
    onto the wire ``TokenUsage``, by its shape: Anthropic (cache fields) ->
    exclusive, summed; OpenAI Responses (``input_tokens_details``) and LangChain
    ``usage_metadata`` (``input_token_details``) -> inclusive; OpenAI chat
    (``prompt_tokens``); LangChain JS camelCase (``promptTokens``)."""
    if obj is None:
        return None
    source = obj
    fields = ("input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "promptTokens")
    if not any(_has(source, field) for field in fields):
        inner = _get(obj, "usage")
        if inner is None:
            return None
        source = inner
    if _looks_anthropic(source):
        return anthropic_usage(source)
    if _has(source, "input_tokens_details") or _has(source, "output_tokens_details"):
        return openai_responses_usage(source)
    if _has(source, "input_token_details") or _has(source, "output_token_details"):
        return langchain_usage(source)
    if _has(source, "input_tokens") or _has(source, "output_tokens"):
        return make_usage(
            input=token_count(_get(source, "input_tokens")),
            output=token_count(_get(source, "output_tokens")),
        )
    if _has(source, "prompt_tokens") or _has(source, "completion_tokens"):
        return openai_chat_usage(source)
    return make_usage(
        input=token_count(_get(source, "promptTokens")),
        output=token_count(_get(source, "completionTokens")),
    )


_ANTHROPIC_RAW_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)
_ANTHROPIC_SPLIT_FIELDS = ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")


class AnthropicUsageAccumulator:
    """A streamed Anthropic message reports usage in pieces: ``message_start``
    (input + cache counts) and a cumulative ``message_delta`` (output; newer API
    versions repeat the others, ``None`` when unknown). Later REPORTED raw
    fields win; the wire usage is mapped once, at the end — mapping each piece
    and merging would turn the delta's missing input into a reported 0."""

    __slots__ = ("raw",)

    def __init__(self) -> None:
        self.raw: dict[str, Any] = {}

    def add(self, usage: Any) -> None:
        if usage is None:
            return
        for key in _ANTHROPIC_RAW_FIELDS:
            value = token_count(_get(usage, key))
            if value is not None:
                self.raw[key] = value
        split = _get(usage, "cache_creation")
        if split is not None:
            current = dict(self.raw.get("cache_creation") or {})
            for key in _ANTHROPIC_SPLIT_FIELDS:
                value = token_count(_get(split, key))
                if value is not None:
                    current[key] = value
            if current:
                self.raw["cache_creation"] = current
        # Cumulative on message_delta, like output_tokens.
        thinking = token_count(_get(_get(usage, "output_tokens_details"), "thinking_tokens"))
        if thinking is not None:
            self.raw["output_tokens_details"] = {"thinking_tokens": thinking}

    def usage(self) -> dict[str, Any] | None:
        return anthropic_usage(self.raw) if self.raw else None


# -- tool calls -----------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _parse_json(text: str) -> tuple[bool, Any]:
    """``JSON.parse`` semantics: NaN / Infinity are not JSON."""
    try:
        return True, json.loads(text, parse_constant=_reject_constant)
    except Exception:
        return False, None


def tool_call(id: Any, name: Any, args: Any) -> dict[str, Any] | None:
    """One requested tool call as ``{id?, name, input, inputText?}``, or ``None``
    without a name. A string ``args`` is JSON-parsed (blank -> ``{}``; text that
    does not parse -> ``input: None`` + ``inputText``); anything else is the
    input as it is (made JSON-safe)."""
    if not isinstance(name, str) or not name:
        return None
    out: dict[str, Any] = {}
    if isinstance(id, str) and id:
        out["id"] = str.__str__(id)
    out["name"] = str.__str__(name)
    if args is None:
        out["input"] = {}
    elif isinstance(args, str):
        if not args.strip():
            out["input"] = {}
        else:
            ok, parsed = _parse_json(args)
            if ok:
                out["input"] = parsed
            else:
                out["input"] = None
                out["inputText"] = str.__str__(args)
    else:
        out["input"] = record_value(args)
    return out


# -- tool definitions --------------------------------------------------------------

SCHEMA_HASH_HEX_CHARS = 16
MAX_SCHEMA_RUNS = 256
MAX_SCHEMA_HASHES_PER_RUN = 1024

_schema_memory: weakref.WeakKeyDictionary[Any, OrderedDict[str, set[str]]] = (
    weakref.WeakKeyDictionary()
)
_schema_lock = threading.Lock()


def schema_hash(definition: Any) -> str:
    """sha256 of the canonical JSON of a tool definition, first 16 hex chars."""
    canonical = canonicalize(definition)
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()[
        :SCHEMA_HASH_HEX_CHARS
    ]


def tool_def_name(entry: Any) -> str | None:
    """The name of one request tool definition in any provider shape:
    ``function.name`` / ``custom.name`` (OpenAI), ``name`` (Anthropic, OpenAI
    Responses), or a built-in's ``type``."""
    for candidate in (
        _get(_get(entry, "function"), "name"),
        _get(_get(entry, "custom"), "name"),
        _get(entry, "name"),
        _get(entry, "type"),
    ):
        if isinstance(candidate, str) and candidate:
            return str.__str__(candidate)
    return None


#: Keys of a tool definition that hold its SCHEMA: recorded verbatim (a schema's
#: property names are the tool's parameter names). Same list as TypeScript.
TOOL_SCHEMA_KEYS = frozenset(
    (
        "parameters",
        "input_schema",
        "inputSchema",
        "output_schema",
        "outputSchema",
        "schema",
        "format",
    )
)

#: A key of a tool definition (outside its schema) that may carry a credential
#: or transport configuration: never recorded. Same pattern as TypeScript.
TOOL_SECRET_KEY_RE = re.compile(
    r"authori[sz]ation|header|token|secret|passw(?:or)?d|key|cookie|credential|bearer",
    re.IGNORECASE,
)
_TOOL_URL_KEY_RE = re.compile(r"url$", re.IGNORECASE)
#: A URL's userinfo: after its ``//`` (a backslash may stand for a slash, a tab
#: or newline may sit between them; whatever precedes them is kept) up to the
#: LAST ``@`` before the path, where ``urlsplit`` and WHATWG end it, so a
#: password holding ``@`` goes whole. Same pattern as TypeScript.
_URL_USERINFO_RE = re.compile(r"^([^/\\]*[/\\][\t\n\r]*[/\\])[^/]*@")
_MAX_TOOL_DEFINITION_DEPTH = 16


def _without_url_secrets(url: str) -> str:
    cut = len(url)
    for mark in ("?", "#"):
        index = url.find(mark)
        if index != -1 and index < cut:
            cut = index
    return _URL_USERINFO_RE.sub(r"\1", url[:cut], count=1)


def _sanitize_definition_value(value: Any, depth: int) -> Any:
    if isinstance(value, list):
        if depth >= _MAX_TOOL_DEFINITION_DEPTH:
            return []
        return [_sanitize_definition_value(item, depth + 1) for item in value]
    if not isinstance(value, dict):
        return value
    if depth >= _MAX_TOOL_DEFINITION_DEPTH:
        return {}
    out: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            continue
        if key in TOOL_SCHEMA_KEYS:
            out[key] = item
        elif TOOL_SECRET_KEY_RE.search(key):
            continue
        elif isinstance(item, str) and _TOOL_URL_KEY_RE.search(key):
            out[key] = _without_url_secrets(item)
        else:
            out[key] = _sanitize_definition_value(item, depth + 1)
    return out


def sanitize_tool_definition(definition: Any) -> Any:
    """A (JSON-safe) tool definition as it is hashed and recorded: the schema keys
    verbatim, every key matching ``TOOL_SECRET_KEY_RE`` dropped at any depth
    outside them, a ``*url`` value cut to ``scheme://host/path``. A function
    tool is unchanged. Held to the fixture's ``toolDefinitions``."""
    return _sanitize_definition_value(definition, 0)


def _run_memory(owner: Any, run_key: str) -> set[str]:
    runs = _schema_memory.get(owner)
    if runs is None:
        runs = OrderedDict()
        _schema_memory[owner] = runs
    hashes = runs.pop(run_key, None)
    if hashes is None:
        hashes = set()
        while len(runs) >= MAX_SCHEMA_RUNS:
            runs.popitem(last=False)
    runs[run_key] = hashes
    return hashes


class ToolSchemas(dict):  # type: ignore[type-arg]
    """``toolSchemas`` as :func:`capture_tools` returns it: a plain ``dict`` on the
    wire, remembering the run memory its hashes were added to, so the session can
    :func:`release_tool_schemas` it when the event carrying it was shrunk."""

    __slots__ = ("_hashes", "_sent")

    def __init__(self, sent: set[str]) -> None:
        super().__init__()
        self._sent = sent
        self._hashes: list[str] | None = []


def release_tool_schemas(tool_schemas: Any) -> None:
    """The definitions in ``tool_schemas`` (a :func:`capture_tools` result's, as it
    sits in a ``node.started`` input) did NOT reach the wire whole: the payload
    budget shrank that event (emptying every array inside them, ``required: []``)
    or it was dropped. Forget the run was sent them, so its next step that uses
    them sends them again, intact. The session calls this. Never raises."""
    try:
        if not isinstance(tool_schemas, ToolSchemas):
            return
        with _schema_lock:
            hashes = tool_schemas._hashes
            tool_schemas._hashes = None
            if hashes:
                for digest in hashes:
                    tool_schemas._sent.discard(digest)
    except Exception:
        pass


def capture_tools(
    owner: Any,
    run_key: str,
    definitions: Any,
    describe: Callable[[Any], str | None] = tool_def_name,
) -> dict[str, Any] | None:
    """``{"tools": [...], "toolSchemas"?: {...}}`` for one LLM step, or ``None``.
    The definitions are recorded JSON-safe (:func:`record_value`) and without
    credentials (:func:`sanitize_tool_definition`), and hashed in that form, so
    the hash names exactly what is sent. Never raises."""
    try:
        if not isinstance(definitions, (list, tuple)) or not definitions:
            return None
        tools: list[dict[str, str]] = []
        with _schema_lock:
            try:
                sent = _run_memory(owner, run_key)
            except TypeError:  # an owner that cannot be weakly referenced
                sent = set()
            schemas = ToolSchemas(sent)
            for definition in definitions:
                try:
                    name = describe(definition)
                except Exception:
                    name = None
                if name is None:
                    continue
                plain = sanitize_tool_definition(record_value(definition))
                digest = schema_hash(plain)
                tools.append({"name": name, "schemaHash": digest})
                if digest in sent:
                    continue
                if len(sent) >= MAX_SCHEMA_HASHES_PER_RUN:
                    sent.clear()
                sent.add(digest)
                schemas[digest] = plain
                if schemas._hashes is not None:
                    schemas._hashes.append(digest)
        if not tools:
            return None
        out: dict[str, Any] = {"tools": tools}
        if schemas:
            out["toolSchemas"] = schemas
        return out
    except Exception:
        return None


def reset_tool_schema_memory(owner: Any) -> None:
    """Forget what a session was sent (tests)."""
    with _schema_lock:
        _schema_memory.pop(owner, None)


# -- sampling parameters ---------------------------------------------------------

#: Same list, same order as the TypeScript client (pinned by the fixture).
SAMPLING_PARAM_KEYS = (
    "maxOutputTokens",
    "maxTokens",
    "temperature",
    "topP",
    "topK",
    "stopSequences",
    "presencePenalty",
    "frequencyPenalty",
    "seed",
    "toolChoice",
    "responseFormat",
    "reasoning",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "top_p",
    "top_k",
    "stop",
    "stop_sequences",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "n",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "reasoning_effort",
    "thinking",
    "service_tier",
    "truncation",
    "text",
    "verbosity",
    "prompt_cache_key",
    "max_tool_calls",
    "context_management",
    "output_config",
    "cache_control",
)

#: The SDKs' "argument not given" sentinels (``openai.NOT_GIVEN``, ``Omit``).
_SENTINEL_TYPES = frozenset({"NotGiven", "Omit", "_NotGiven"})


def _is_sentinel(value: Any) -> bool:
    return type(value).__name__ in _SENTINEL_TYPES


def pick_params(source: Any, keys: tuple[str, ...] = SAMPLING_PARAM_KEYS) -> dict[str, Any]:
    """The allow-listed keys of ``source`` that were actually given, JSON-safe.
    ``None`` and the SDKs' NOT_GIVEN sentinels are "not sent"."""
    out: dict[str, Any] = {}
    if not isinstance(source, Mapping):
        return out
    for key in keys:
        try:
            if key not in source:
                continue
            value = source[key]
        except Exception:
            continue
        if value is None or _is_sentinel(value):
            continue
        out[key] = record_value(value)
    return out


# -- full prompts ---------------------------------------------------------------

_MAX_RECORD_DEPTH = 64


def record_value(value: Any) -> Any:
    """``value`` made JSON-safe WITHOUT truncation: every item, every character.
    Bytes become ``{"type": "binary", "bytes": n}``, SDK models their dump, a
    cycle ``"[Circular]"``, depth past 64 ``"…[depth limit]"``. Never raises."""
    try:
        return _record(value, 0, set())
    except Exception:
        try:
            return repr(value)
        except Exception:
            return f"<{type(value).__name__}>"


def _record(value: Any, depth: int, ancestors: set[int]) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, memoryview):
        return {"type": "binary", "bytes": value.nbytes}
    if isinstance(value, (bytes, bytearray)):
        return {"type": "binary", "bytes": len(value)}
    if _is_sentinel(value):
        return None
    if depth >= _MAX_RECORD_DEPTH:
        return "…[depth limit]"
    marker = id(value)
    if marker in ancestors:
        return "[Circular]"
    ancestors.add(marker)
    try:
        if isinstance(value, Mapping):
            return {str(key): _record(item, depth + 1, ancestors) for key, item in value.items()}
        if isinstance(value, (list, tuple, set, frozenset)):
            return [_record(item, depth + 1, ancestors) for item in value]
        for attr in ("model_dump", "to_dict", "dict"):
            method = getattr(value, attr, None)
            if callable(method):
                try:
                    dumped = method()
                except Exception:
                    break
                if dumped is not value:
                    return _record(dumped, depth + 1, ancestors)
        try:
            return _record(vars(value), depth + 1, ancestors)
        except TypeError:
            pass
        return repr(value)
    finally:
        ancestors.discard(marker)
