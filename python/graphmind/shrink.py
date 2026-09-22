"""The payload budget of the GraphMind protocol: port of
``packages/schema/src/shrink.ts`` (SHRINK-V2).

An event whose payload JSON is over :data:`MAX_PAYLOAD_BYTES` (512 KB of
UTF-8) is degraded — never dropped for its size when it was a valid event —
exactly as the debugger's server would store it, so what this client buffers
and sends is what gets stored, and the live view and a reload agree.

Held byte for byte to the cross-language conformance fixture
``packages/schema/test/fixtures/shrink.json`` (version 2). Read the TIERS and
UNITS comments at the top of ``shrink.ts``; the short version:

1. JSON within ``max_bytes`` -> unchanged (same object).
2. A dict with at most :data:`MAX_TRIM_FIELDS` top-level fields -> the field
   trim (biggest fields first, each shrunk type-preservingly). With a known
   event ``type`` the result must also be a valid payload of that type.
3. A known event ``type`` and a dict -> the skeleton: only the schema's
   fields, hard-shrunk, plus the marker.
4. Otherwise -> the whole-payload marker ``{__graphmindTruncated, bytes, preview}``.

UNITS — the part a port gets wrong: JavaScript strings are UTF-16. Every
``.length`` / ``slice`` of the reference counts UTF-16 code units (an astral
character is 2, and a cut may split it, leaving a lone surrogate that JSON
then writes as ``\\udXXX``); every byte count is UTF-8 of the JSON text.
Python ``str`` indexes code points, so this module never uses ``len`` or a
slice on text it measures — see :func:`utf16_length` / :func:`utf16_prefix`.

JSON TEXT is ``JSON.stringify``'s, byte for byte, for JSON-shaped values
(dict with ``str`` keys, list/tuple, str, int, float, bool, None): no
whitespace, non-ASCII raw, lone surrogates escaped, numbers in ECMAScript
``Number::toString`` form (``1.0`` -> ``1``, ``1e-05`` -> ``0.00001``),
integers beyond 2**53 rounded like a JavaScript number, non-finite -> ``null``.
Anything else (a cycle, a set, an object) is "unserializable", the Python
counterpart of what ``JSON.stringify`` throws on.

Key order: Python keeps insertion order where JavaScript enumerates
integer-like keys first (decisions.md, SHRINK-V2); the fixture never mixes the
two in one object.

Pure functions, no I/O. Never mutates its input. May raise only on a
``RecursionError``-deep structure that also defeats the fallbacks.
"""

from __future__ import annotations

import itertools
import json
import math
import re
import secrets
from typing import Any

from .loop_guard import js_number

__all__ = [
    "MAX_PAYLOAD_BYTES",
    "MAX_SHRINK_DEPTH",
    "MAX_SHRINK_KEYS",
    "MAX_TRIM_FIELDS",
    "PREVIEW_CHARS",
    "SKELETON_CHARS",
    "SKELETON_MIN_CHARS",
    "SKELETON_PLANS",
    "TRUNCATION_SUFFIX",
    "is_truncated_payload",
    "is_valid_event_payload",
    "js_compatible_json",
    "js_stringify",
    "serialize_payload",
    "utf8_length",
    "utf16_length",
    "utf16_prefix",
]

#: Largest payload, as UTF-8 bytes of its JSON, stored or sent unchanged.
MAX_PAYLOAD_BYTES = 512 * 1024
#: Length, in UTF-16 code units, of every preview and shortened string.
PREVIEW_CHARS = 2000
#: Appended to a string that had to be cut short.
TRUNCATION_SUFFIX = "…[graphmind: truncated]"
#: How deep the field shrink recurses before it marks the subtree.
MAX_SHRINK_DEPTH = 6
#: Most keys the field shrink keeps from any one object (the first ones).
MAX_SHRINK_KEYS = 256
#: Most top-level fields a payload may have for the field trim (tier 2).
MAX_TRIM_FIELDS = 4096
#: Longest string, in UTF-16 code units, the skeleton keeps.
SKELETON_CHARS = 256
#: The skeleton's string length on its final, smallest attempt.
SKELETON_MIN_CHARS = 32

_MAX_SAFE_INTEGER = 2**53 - 1

# -- UTF-16 / UTF-8 measures ---------------------------------------------------


#: UTF-8 lead bytes of a code point past U+FFFF (two UTF-16 units each).
_ASTRAL_LEADS = (b"\xf0", b"\xf1", b"\xf2", b"\xf3", b"\xf4")
#: A high surrogate code point directly followed by a low one: one character
#: to JavaScript, two code points to Python.
_SURROGATE_PAIR = re.compile("[\ud800-\udbff][\udc00-\udfff]")


def utf16_length(text: str) -> int:
    """``text.length`` in JavaScript: UTF-16 code units (astral = 2)."""
    if text.isascii():
        return len(text)
    try:
        return len(text.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        # Surrogate code points (one unit each). The UTF-16 surrogatepass codec
        # is ~100x slower than UTF-8's, so count astral lead bytes instead.
        data = text.encode("utf-8", "surrogatepass")
        return len(text) + sum(data.count(lead) for lead in _ASTRAL_LEADS)


def utf16_prefix(text: str, units: int) -> str:
    """``text.slice(0, units)`` in JavaScript. A cut through an astral
    character keeps its high surrogate, alone, exactly as JavaScript does."""
    head = text[:units]  # at least `units` UTF-16 units, or all of text
    if head.isascii():
        return head
    return head.encode("utf-16-le", "surrogatepass")[: 2 * units].decode(
        "utf-16-le", "surrogatepass"
    )


def utf8_length(text: str) -> int:
    """UTF-8 bytes of ``text`` as ``TextEncoder`` counts them: a paired
    surrogate is 4 bytes, a lone one 3 (it encodes as U+FFFD)."""
    if text.isascii():
        return len(text)
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        size = len(text.encode("utf-8", "surrogatepass"))  # 3 bytes per surrogate
        # A high+low pair is one 4-byte character to TextEncoder, not 3 + 3.
        return size - 2 * sum(1 for _ in _SURROGATE_PAIR.finditer(text))


# -- JSON.stringify ----------------------------------------------------------------

_ENCODER = json.JSONEncoder(
    ensure_ascii=False, separators=(",", ":"), allow_nan=True, check_circular=True
)
_SURROGATE = re.compile("[\ud800-\udfff]")
#: Every digit mapped to "0", so a digit pattern is one substring search.
_DIGITS_TO_ZERO = bytes.maketrans(b"123456789", b"000000000")
_SIXTEEN_DIGITS = b"0" * 16
#: What may precede an integer token in json.dumps output (compact or with the
#: default ", " / ": " separators), optionally followed by a minus sign.
_INT_PREFIXES = tuple(
    prefix + sign + _SIXTEEN_DIGITS
    for prefix in (b":", b",", b"[", b": ", b", ")
    for sign in (b"", b"-")
)


def _scan(text: str) -> tuple[bool, bool]:
    """``(numbers, surrogates)`` for JSON written by ``json.dumps``.

    ``numbers``: the text may hold a number token Python spells differently
    from JavaScript — an exponent (Python always writes ``e+``/``e-``), an
    integral float (``1.0``), a non-finite literal, or an integer of 16+ digits
    (JavaScript rounds past 2**53). Only a hint: a hit inside a string just
    costs the exact pass. ``surrogates``: the text holds a surrogate code point.

    Byte searches instead of a regular expression: ``re`` walks a 17 MB text
    character by character (~270 ms); ``bytes.translate`` and ``in`` run at
    memory speed. Digits are ASCII bytes, and no multi-byte UTF-8 sequence
    contains one, so the byte form answers exactly as the text would."""
    if text.isascii():
        data = text.encode("ascii")
        surrogates = False
    else:
        try:
            data = text.encode("utf-8")
            surrogates = False
        except UnicodeEncodeError:  # only a surrogate code point fails strict UTF-8
            data = text.encode("utf-8", "surrogatepass")
            surrogates = True
    if b"NaN" in data or b"Infinity" in data:
        return True, surrogates
    zeros = data.translate(_DIGITS_TO_ZERO)
    del data
    # One search per family; the narrower checks run only after a hit.
    numbers = (
        b"0e+" in zeros
        or b"0e-" in zeros
        or (
            b".0" in zeros
            and (
                b".0," in zeros
                or b".0]" in zeros
                or b".0}" in zeros
                or zeros.endswith(b".0")
            )
        )
        or (
            _SIXTEEN_DIGITS in zeros
            and (
                zeros.startswith(_SIXTEEN_DIGITS)
                or zeros.startswith(b"-" + _SIXTEEN_DIGITS)
                or any(pattern in zeros for pattern in _INT_PREFIXES)
            )
        )
    )
    return numbers, surrogates


class _Unserializable(Exception):
    """The value is not JSON-shaped (the counterpart of a JSON.stringify throw)."""


def _escape_surrogate(match: re.Match[str]) -> str:
    return f"\\u{ord(match.group(0)):04x}"


_SURROGATE_ESCAPES = {code: f"\\u{code:04x}" for code in range(0xD800, 0xE000)}
#: Past this many lone surrogates, one ``str.translate`` beats a callback each.
_DENSE_SURROGATES = 4096


def escape_lone_surrogates(text: str) -> str:
    """``text`` with adjacent high+low surrogate code points joined (as a UTF-16
    string sees them) and every remaining lone surrogate written as the
    lowercase ``\\udXXX`` escape JSON.stringify uses. For JSON text, where a
    surrogate can only sit inside a string literal."""
    if text.isascii():
        return text
    text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    found = sum(1 for _ in itertools.islice(_SURROGATE.finditer(text), _DENSE_SURROGATES))
    if found == 0:
        return text
    if found < _DENSE_SURROGATES:
        return _SURROGATE.sub(_escape_surrogate, text)
    return text.translate(_SURROGATE_ESCAPES)


def _js_numbers(text: str) -> str:
    """Re-spell every number token of ``text`` (a compact JSON text) the way
    JSON.stringify would, without touching string contents: re-parse with
    number hooks (called only for number tokens) and re-encode."""
    nonce = secrets.token_hex(8)
    tag = f"\x00{nonce}"
    used = False

    def spell(number: float) -> Any:
        nonlocal used
        if not math.isfinite(number):
            return None
        js = js_number(number)
        body = js[1:] if js.startswith("-") else js
        if body.isdigit():
            return int(js)  # an int spells exactly its digits
        if js == float.__repr__(number):
            return number
        used = True
        return f"{tag}{js}\x00"  # a placeholder string, unquoted below

    def parse_float(token: str) -> Any:
        if "e" not in token and "E" not in token and not token.endswith(".0"):
            return float(token)  # repr round-trips to the same token
        return spell(float(token))

    def parse_int(token: str) -> Any:
        value = int(token)
        if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return value
        try:
            as_float = float(value)
        except OverflowError:
            return None  # a JavaScript number would be Infinity -> null
        return spell(as_float)

    value = json.loads(
        text, parse_float=parse_float, parse_int=parse_int, parse_constant=lambda _: None
    )
    out = _ENCODER.encode(value)
    if used:
        # The placeholder serialised as "\x00<nonce><token>\x00", quotes
        # included; the random nonce keeps host strings from matching.
        out = re.sub(r'"\\u0000' + nonce + r'([-+.0-9eE]+)\\u0000"', r"\1", out)
    return out


def _stringify_checked(value: Any, clean: bool = False) -> tuple[str, bool]:
    """``(JSON.stringify text, clean)``; ``clean`` means Python's own compact
    text needed no rewrite. Pass ``clean=True`` for a value whose encoding is
    a substring of a text already found clean (a field of a clean payload):
    every pattern :func:`_scan` looks for would have shown in the parent."""
    try:
        text = _ENCODER.encode(value)
    except (TypeError, ValueError, RecursionError, OverflowError) as exc:
        raise _Unserializable from exc
    if clean:
        return text, True
    numbers, surrogates = _scan(text)
    if numbers:
        try:
            text = _js_numbers(text)
        except (ValueError, RecursionError) as exc:
            raise _Unserializable from exc
    if surrogates:
        text = escape_lone_surrogates(text)
    return text, not numbers and not surrogates


def _stringify_raw(value: Any) -> str:
    return _stringify_checked(value)[0]


def js_compatible_json(text: str) -> bool:
    """True when ``text`` (JSON written by ``json.dumps``) holds no number
    JavaScript would spell differently and no surrogate code point, so
    ``JSON.stringify`` of the value it encodes is the same text minus the
    separators' spaces. False means "maybe different", never "different"."""
    numbers, surrogates = _scan(text)
    return not numbers and not surrogates


def js_stringify(value: Any, clean: bool = False) -> str | None:
    """``JSON.stringify(value)`` for a JSON-shaped value, or ``None`` when it
    cannot be serialised (the reference's ``safeStringify``). ``clean``: see
    :func:`_stringify_checked` (internal)."""
    try:
        return _stringify_checked(value, clean)[0]
    except _Unserializable:
        return None


# -- the wire schema (what the reference checks with zod) ---------------------------

_NODE_KINDS = frozenset(
    {"agent", "llm", "tool", "chain", "retriever", "server", "resource", "prompt", "custom"}
)
_RUN_STATUSES = frozenset({"ok", "error", "aborted"})
_PAUSE_POINTS = frozenset({"before", "after", "error"})
_RESUME_ACTIONS = frozenset({"continue", "retry", "inject", "abort"})
_PAUSE_REASONS = frozenset({"breakpoint", "error", "step", "loop"})
_LOOP_KINDS = frozenset({"repeat", "cycle", "error-repeat"})
_SMART_RULES = frozenset({"error-result", "truncated-tool-call"})
_REFUSAL_CODES = frozenset({"schema", "shape", "placeholder", "truncated", "disabled", "unsupported"})
_TOKEN_CHANNELS = frozenset({"text", "reasoning", "tool-args"})

_ABSENT = object()


def _is_number(value: Any) -> bool:
    """``z.number()`` (zod v4: finite)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an int too large for a double: Infinity in JS
        return False


def _is_nonneg_number(value: Any) -> bool:
    return _is_number(value) and value >= 0


def _is_nonneg_int(value: Any) -> bool:
    """``z.number().int().nonnegative()`` (zod v4: a safe integer)."""
    if not _is_number(value) or value < 0:
        return False
    if isinstance(value, float) and not value.is_integer():
        return False
    return value <= _MAX_SAFE_INTEGER


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def _is_bool(value: Any) -> bool:
    return isinstance(value, bool)


def _is_pos_int(value: Any) -> bool:
    """``z.number().int().positive()``."""
    return _is_nonneg_int(value) and value > 0


def _optional(payload: dict[str, Any], key: str, check: Any) -> bool:
    value = payload.get(key, _ABSENT)
    return value is _ABSENT or check(value)


def _in(values: frozenset[str]) -> Any:
    return lambda value: isinstance(value, str) and value in values


def _error_info(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _is_str(value.get("name", _ABSENT))
        and _is_str(value.get("message", _ABSENT))
        and _optional(value, "stack", _is_str)
    )


def _redaction(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = value.get("keys", _ABSENT)
    return (
        _is_nonneg_int(value.get("count", _ABSENT))
        and isinstance(keys, list)
        and all(isinstance(key, str) for key in keys)
    )


def _usage(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _is_nonneg_int(value.get("inputTokens", _ABSENT))
        and _is_nonneg_int(value.get("outputTokens", _ABSENT))
        and _optional(value, "inclusive", _is_bool)
        and _optional(value, "cacheReadTokens", _is_nonneg_int)
        and _optional(value, "cacheWriteTokens", _is_nonneg_int)
        and _optional(value, "reasoningTokens", _is_nonneg_int)
    )


def _loop_info(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _is_nonneg_int(value.get("repeats", _ABSENT))
        and _is_nonneg_int(value.get("firstSeq", _ABSENT))
        and _is_nonneg_int(value.get("lastSeq", _ABSENT))
        and _is_str(value.get("fingerprint", _ABSENT))
        and _optional(value, "kind", _in(_LOOP_KINDS))
        and _optional(value, "period", _is_pos_int)
        and _optional(value, "laps", _is_pos_int)
    )


def _smart_info(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _in(_SMART_RULES)(value.get("rule", _ABSENT))
        and _optional(value, "detail", _is_str)
    )


def _edited(value: Any) -> bool:
    """``z.looseObject({after: z.unknown()})``: zod v4 requires the key."""
    return isinstance(value, dict) and "after" in value


def _graph_node(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _is_str(value.get("nodeId", _ABSENT))
        and _in(_NODE_KINDS)(value.get("kind", _ABSENT))
        and _is_str(value.get("name", _ABSENT))
        and _optional(value, "parentId", _is_str)
    )


def _token_delta(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _in(_TOKEN_CHANNELS)(value.get("t", _ABSENT))
        and _is_str(value.get("v", _ABSENT))
    )


def _run_started(p: dict[str, Any]) -> bool:
    sdk = p.get("sdk", _ABSENT)
    return (
        _is_str(p.get("app", _ABSENT))
        and isinstance(sdk, dict)
        and _is_str(sdk.get("name", _ABSENT))
        and _is_str(sdk.get("version", _ABSENT))
        and _optional(p, "meta", lambda v: isinstance(v, dict))
    )


def _run_finished(p: dict[str, Any]) -> bool:
    return _in(_RUN_STATUSES)(p.get("status", _ABSENT)) and _optional(p, "error", _error_info)


def _graph_hint(p: dict[str, Any]) -> bool:
    nodes = p.get("nodes", _ABSENT)
    return isinstance(nodes, list) and all(_graph_node(node) for node in nodes)


def _node_started(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("nodeId", _ABSENT))
        and _optional(p, "parentId", _is_str)
        and _in(_NODE_KINDS)(p.get("kind", _ABSENT))
        and _is_str(p.get("name", _ABSENT))
        and _is_str(p.get("instanceId", _ABSENT))
        and _optional(p, "collapsed", lambda v: isinstance(v, bool))
        and _optional(p, "redaction", _redaction)
    )


def _node_token(p: dict[str, Any]) -> bool:
    deltas = p.get("deltas", _ABSENT)
    return (
        _is_str(p.get("nodeId", _ABSENT))
        and isinstance(deltas, list)
        and all(_token_delta(delta) for delta in deltas)
        and _optional(p, "redaction", _redaction)
    )


def _node_finished(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("nodeId", _ABSENT))
        and _optional(p, "instanceId", _is_str)
        and _optional(p, "usage", _usage)
        and _is_nonneg_number(p.get("durationMs", _ABSENT))
        and _optional(p, "heldMs", _is_nonneg_number)
        and _in(_RUN_STATUSES)(p.get("status", _ABSENT))
        and _optional(p, "redaction", _redaction)
    )


def _node_error(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("nodeId", _ABSENT))
        and _optional(p, "instanceId", _is_str)
        and _error_info(p.get("error", _ABSENT))
        and _optional(p, "heldMs", _is_nonneg_number)
    )


def _exec_paused(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("pauseId", _ABSENT))
        and _is_str(p.get("nodeId", _ABSENT))
        and _in(_PAUSE_POINTS)(p.get("point", _ABSENT))
        and _optional(p, "reason", _in(_PAUSE_REASONS))
        and _optional(p, "loop", _loop_info)
        and _optional(p, "smart", _smart_info)
        and _optional(p, "editable", _is_bool)
    )


def _exec_refused(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("pauseId", _ABSENT))
        and _in(_REFUSAL_CODES)(p.get("code", _ABSENT))
        and _optional(p, "message", _is_str)
        and _optional(p, "requestId", _is_str)
    )


def _exec_resumed(p: dict[str, Any]) -> bool:
    return (
        _is_str(p.get("pauseId", _ABSENT))
        and _in(_RESUME_ACTIONS)(p.get("action", _ABSENT))
        and _optional(p, "edited", _edited)
        and _optional(p, "requestId", _is_str)
        and _optional(p, "principal", _is_str)
    )


_VALIDATORS: dict[str, Any] = {
    "run.started": _run_started,
    "run.finished": _run_finished,
    "graph.hint": _graph_hint,
    "node.started": _node_started,
    "node.token": _node_token,
    "node.finished": _node_finished,
    "node.error": _node_error,
    "exec.paused": _exec_paused,
    "exec.refused": _exec_refused,
    "exec.resumed": _exec_resumed,
}


def is_valid_event_payload(type: str, payload: Any) -> bool:
    """Whether ``payload`` (JSON-shaped, e.g. parsed from the wire) is a valid
    payload of the known event ``type`` — what ``EventPayloadSchemas[type]
    .safeParse`` answers in ``packages/schema/src/events.ts``. Unknown types
    are not judged here: they answer ``True`` (the reference's ``isValidFor``)."""
    check = _VALIDATORS.get(type) if isinstance(type, str) else None
    if check is None:
        return True
    return isinstance(payload, dict) and bool(check(payload))


# -- skeleton plans -------------------------------------------------------------------

#: Per known event type, the schema's top-level keys in declaration order:
#: ``None`` = required, a dict = a required loose object with its own plan,
#: ``"optional"`` = kept only when a string, number or boolean. Equal to the
#: fixture's ``skeletonPlans`` (a test pins it).
SKELETON_PLANS: dict[str, dict[str, Any]] = {
    "run.started": {"app": None, "sdk": {"name": None, "version": None}, "meta": "optional"},
    "run.finished": {"status": None, "error": "optional"},
    "graph.hint": {"nodes": None},
    "node.started": {
        "nodeId": None,
        "parentId": "optional",
        "kind": None,
        "name": None,
        "instanceId": None,
        "input": "optional",
        "collapsed": "optional",
        "redaction": "optional",
    },
    "node.token": {"nodeId": None, "deltas": None, "redaction": "optional"},
    "node.finished": {
        "nodeId": None,
        "instanceId": "optional",
        "output": "optional",
        "usage": "optional",
        "durationMs": None,
        "heldMs": "optional",
        "status": None,
        "redaction": "optional",
    },
    "node.error": {
        "nodeId": None,
        "instanceId": "optional",
        "error": {"name": None, "message": None, "stack": "optional"},
        "heldMs": "optional",
    },
    "exec.paused": {
        "pauseId": None,
        "nodeId": None,
        "point": None,
        "reason": "optional",
        "loop": "optional",
        "smart": "optional",
        "editable": "optional",
    },
    "exec.refused": {
        "pauseId": None,
        "code": None,
        "message": "optional",
        "requestId": "optional",
    },
    "exec.resumed": {
        "pauseId": None,
        "action": None,
        "edited": "optional",
        "requestId": "optional",
        "principal": "optional",
    },
}


def is_truncated_payload(value: Any) -> bool:
    return isinstance(value, dict) and value.get("__graphmindTruncated") is True


# -- tier 2: the field trim ------------------------------------------------------------


def _cut(text: str, units: int) -> str:
    """A string of more than ``units`` UTF-16 units -> its prefix + suffix."""
    if len(text) <= units // 2 or utf16_length(text) <= units:
        return text
    return utf16_prefix(text, units) + TRUNCATION_SUFFIX


def _shrink_value(value: Any, depth: int = 0, encoded: str | None = None) -> Any:
    """Shrink one oversized field, preserving its JSON type (shrink.ts
    ``shrinkValue``)."""
    if isinstance(value, str):
        return _cut(value, PREVIEW_CHARS)
    if isinstance(value, (list, tuple)):
        return []
    if not isinstance(value, dict):
        return value  # numbers, booleans, null
    if depth >= MAX_SHRINK_DEPTH:
        return {"__graphmindTruncated": True, "bytes": 0, "preview": "[deeply nested]"}
    shrunk: dict[str, Any] = {}
    for key, item in itertools.islice(value.items(), MAX_SHRINK_KEYS):
        shrunk[key] = _shrink_value(item, depth + 1)
    dropped = max(0, len(value) - MAX_SHRINK_KEYS)
    if depth > 0:
        if dropped > 0:
            shrunk["__graphmindTruncated"] = True
            shrunk["keysDropped"] = dropped
        return shrunk
    text = encoded if encoded is not None else js_stringify(value)
    shrunk["__graphmindTruncated"] = True
    shrunk["bytes"] = 0 if text is None else utf16_length(text)
    shrunk["preview"] = (
        "[unserializable field]" if text is None else utf16_prefix(text, PREVIEW_CHARS)
    )
    if dropped > 0:
        shrunk["keysDropped"] = dropped
    return shrunk


_UNSERIALIZABLE_SIZE = 2**53 - 1
_DECODER = json.JSONDecoder()


def _top_level_spans(text: str) -> dict[str, str] | None:
    """Each top-level field's value text in ``text``, the compact JSON.stringify
    text of an object: key -> the exact slice, which IS that value's
    JSON.stringify text (``topLevelSpans`` in shrink.ts). None when ``text`` is
    not such an object. Keys and values are walked with the json module's C
    scanner, so a payload whose numbers needed JavaScript spelling does not
    pay for that rewrite a second time per field."""
    try:
        if not text.startswith("{"):
            return None
        spans: dict[str, str] = {}
        if text == "{}":
            return spans
        at = 1
        length = len(text)
        while at < length:
            if text[at] != '"':
                return None
            key, at = json.decoder.scanstring(text, at + 1)
            if text[at] != ":":
                return None
            _value, end = _DECODER.raw_decode(text, at + 1)
            spans[key] = text[at + 1 : end]
            if text[end] == "}":
                return spans if end == length - 1 else None
            if text[end] != ",":
                return None
            at = end + 1
        return None
    except (ValueError, IndexError, RecursionError):
        return None


def _truncate_fields(
    payload: dict[str, Any], max_bytes: float, total_bytes: int, text: str, clean: bool = False
) -> tuple[str, dict[str, Any]] | None:
    sizes: list[tuple[str, int, str | None]] = []
    # A field of a clean payload text is clean itself: re-encoding it is C-fast.
    # Otherwise slice it out of the (already JavaScript-spelled) payload text.
    spans = None if clean else _top_level_spans(text)
    if spans is not None and len(spans) != len(payload):
        spans = None  # keys json.dumps merges or renames ({1: .., "1": ..})
    for key, item in payload.items():
        span = None if spans is None else spans.get(key)
        encoded = span if span is not None else js_stringify(item, clean)
        sizes.append(
            (key, _UNSERIALIZABLE_SIZE if encoded is None else utf16_length(encoded), encoded)
        )
    sizes.sort(key=lambda entry: -entry[1])  # biggest first; stable on ties
    trimmed = dict(payload)
    dropped: list[str] = []
    remaining = total_bytes
    for key, size, encoded in sizes:
        if remaining <= max_bytes / 2:
            break
        trimmed[key] = _shrink_value(payload[key], 0, encoded)
        dropped.append(key)
        remaining -= size
    if not dropped:
        return None
    trimmed.update(
        {
            "__graphmindTruncated": True,
            "bytes": total_bytes,
            "preview": utf16_prefix(text, PREVIEW_CHARS),
            "fields": dropped,
        }
    )
    out = js_stringify(trimmed)
    if out is None or utf8_length(out) > max_bytes:
        return None
    return out, trimmed


def _truncate_unserializable_fields(
    payload: dict[str, Any],
) -> tuple[str, dict[str, Any]] | None:
    trimmed: dict[str, Any] = {}
    dropped: list[str] = []
    for key, item in payload.items():
        if js_stringify(item) is not None:
            trimmed[key] = item
            continue
        dropped.append(key)
        trimmed[key] = (
            []
            if isinstance(item, (list, tuple))
            else {"__graphmindTruncated": True, "bytes": 0, "preview": "[unserializable value]"}
        )
    if not dropped:
        return None
    trimmed["__graphmindTruncated"] = True
    trimmed["fields"] = dropped
    out = js_stringify(trimmed)
    return None if out is None else (out, trimmed)


# -- tier 3: the skeleton -----------------------------------------------------------


def _omitted() -> dict[str, Any]:
    return {"__graphmindTruncated": True, "bytes": 0, "preview": "[omitted]"}


def _keep_planned(
    value: dict[str, Any], plan: dict[str, Any], chars: int
) -> tuple[dict[str, Any], set[str], int]:
    out: dict[str, Any] = {}
    verbatim: set[str] = set()
    kept = 0
    for key, sub in plan.items():
        if key not in value:
            continue
        child = value[key]
        if sub == "optional" and not isinstance(child, (str, int, float)):
            continue  # bool is an int: kept too
        shrunk, is_verbatim = _hard_shrink(child, None if sub == "optional" else sub, chars)
        out[key] = shrunk
        kept += 1
        if is_verbatim:
            verbatim.add(key)
    return out, verbatim, kept


def _hard_shrink(value: Any, plan: dict[str, Any] | None, chars: int) -> tuple[Any, bool]:
    if isinstance(value, str):
        cut = _cut(value, chars)
        return cut, cut is value
    if value is None or isinstance(value, (bool, int, float)):
        return value, True
    if isinstance(value, (list, tuple)):
        return [], len(value) == 0
    if isinstance(value, dict) and plan is not None:
        out, verbatim, kept = _keep_planned(value, plan, chars)
        return out, len(verbatim) == kept and len(value) <= kept
    return _omitted(), False


_SKELETON_ATTEMPTS = ((SKELETON_CHARS, True), (SKELETON_CHARS, False), (SKELETON_MIN_CHARS, False))


def _skeleton(
    payload: dict[str, Any],
    type: str,
    plan: dict[str, Any],
    max_bytes: float,
    total_bytes: int,
    preview: str,
) -> tuple[str, dict[str, Any]] | None:
    for chars, full in _SKELETON_ATTEMPTS:
        out, verbatim, _ = _keep_planned(payload, plan, chars)
        out["__graphmindTruncated"] = True
        out["bytes"] = total_bytes
        out["preview"] = preview if full else ""
        if full:
            fields: list[str] = []
            units = 0
            for key in payload:
                if key in verbatim:
                    continue
                fields.append(key)
                units += utf16_length(key)
                if units > max_bytes:
                    break
            if units > max_bytes:
                continue
            out["fields"] = fields
        text = js_stringify(out)
        if text is None or utf8_length(text) > max_bytes:
            continue
        if not is_valid_event_payload(type, out):
            continue
        return text, out
    return None


# -- the entry point -----------------------------------------------------------------


def serialize_payload(
    payload: Any, max_bytes: float = MAX_PAYLOAD_BYTES, type: str | None = None
) -> tuple[str, Any, bool]:
    """``(json_text, payload, truncated)``: the payload's JSON, shrunk when it
    is over ``max_bytes`` UTF-8 bytes (see the module docstring for the tiers).

    Pass the event ``type`` whenever you have it: for a known type and a valid
    input the result is then a valid payload of that type, within
    ``max_bytes`` for any ``max_bytes >= 4096``. Idempotent: a result fed back
    in comes back unchanged (``truncated`` False, the same object)."""
    plan = SKELETON_PLANS.get(type) if isinstance(type, str) else None
    try:
        text, clean = _stringify_checked(payload)
    except _Unserializable:
        return _serialize_unserializable(payload, max_bytes, type, plan)
    total = utf8_length(text)
    if total <= max_bytes:
        return text, payload, False
    if isinstance(payload, dict):
        if len(payload) <= MAX_TRIM_FIELDS:
            trimmed = _truncate_fields(payload, max_bytes, total, text, clean)
            if trimmed is not None and is_valid_event_payload_or_unknown(type, trimmed[1]):
                return trimmed[0], trimmed[1], True
        if plan is not None and type is not None:
            skeleton = _skeleton(
                payload, type, plan, max_bytes, total, utf16_prefix(text, PREVIEW_CHARS)
            )
            if skeleton is not None:
                return skeleton[0], skeleton[1], True
    marker = {
        "__graphmindTruncated": True,
        "bytes": total,
        "preview": utf16_prefix(text, PREVIEW_CHARS),
    }
    return _stringify_raw(marker), marker, True


def is_valid_event_payload_or_unknown(type: str | None, payload: Any) -> bool:
    """The reference's ``isValidFor``: no type, or an unknown one, is valid."""
    return type is None or is_valid_event_payload(type, payload)


def _serialize_unserializable(
    payload: Any, max_bytes: float, type: str | None, plan: dict[str, Any] | None
) -> tuple[str, Any, bool]:
    if isinstance(payload, dict):
        trimmed = _truncate_unserializable_fields(payload)
        if trimmed is not None and plan is None:
            return trimmed[0], trimmed[1], True
        if trimmed is not None and type is not None:
            size = utf8_length(trimmed[0])
            if size <= max_bytes and is_valid_event_payload(type, trimmed[1]):
                return trimmed[0], trimmed[1], True
            if size > max_bytes and len(trimmed[1]) <= MAX_TRIM_FIELDS:
                fitted = _truncate_fields(trimmed[1], max_bytes, size, trimmed[0])
                if fitted is not None and is_valid_event_payload(type, fitted[1]):
                    return fitted[0], fitted[1], True
        if plan is not None and type is not None:
            skeleton = _skeleton(payload, type, plan, max_bytes, 0, "[unserializable payload]")
            if skeleton is not None:
                return skeleton[0], skeleton[1], True
    marker = {"__graphmindTruncated": True, "bytes": 0, "preview": "[unserializable payload]"}
    return _stringify_raw(marker), marker, True
