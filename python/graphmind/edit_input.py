"""Edited input (0.6.0, contract C2): the pure pieces of running a held call
with an input the debugger edited (``exec.resume.input``).

Port of ``packages/client/src/edit-input.ts``; the shared conformance fixture
``packages/client/test/fixtures/edit-input.json`` pins every function here to
the TypeScript reference, byte for byte.

The session decides WHETHER an edit may be honoured — it announced
``edit-input``, the debugger listed it in ``hello.ack.hubCapabilities``, the
integration marked the pause ``editable``, ``GRAPHMIND_DISABLE_EDIT_INPUT`` is
off, and the action fits the point (``continue`` at ``before``, ``retry`` at
``after`` / ``error``). This module holds what it checks the edit itself with:

* :func:`proposed_value_refusal`: an input (or inject output) carrying the
  redaction placeholder or a truncation marker — the shrink's, LangGraph's,
  the MCP server's ``get_node`` preview, or this SDK's own recording bounds
  (``safe_value`` in ``integrations/_common.py``) — is a pre-filled copy of a
  value its sender never saw in full, not an argument anyone meant to run
  with. Refused (``placeholder`` / ``truncated``) wherever it appears.
* :func:`prototype_key_refusal`: the two standard deep-merge pollution payloads
  (an own ``__proto__`` key, a ``constructor.prototype`` path), refused
  (``shape``) at any depth on every edit. Harmless to Python itself, but an
  edited argument may well be handed on to JavaScript (an MCP server, a Node
  service), and the rule must be the same in every SDK.
* :func:`normalize_validation`: a validator is host code. It may raise, return
  garbage, or quote a value in a long message; what reaches the wire is always
  one of the two documented shapes, with a message of at most
  :data:`MAX_REFUSAL_MESSAGE` printable characters.
* :func:`merge_tool_input`: the default rule for tool arguments — the edit's
  top-level keys replace the live ones and every key it does not mention keeps
  its LIVE value (the recorded copy may be a ``repr`` or truncated; the live
  one is exact) — unless a switch hides the input, when only a full
  replacement counts.

A verdict (:data:`InputValidation`) is a plain dict, exactly the TypeScript
shape: ``{"ok": True, "value": v}`` or ``{"ok": False, "code": c,
"message"?: m}`` — :func:`accept` and :func:`refuse` build them.

Nothing here raises.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .protocol import _dumps_like_js
from .redaction import REDACTED
from .shrink import TRUNCATION_SUFFIX

#: ``exec.refused.message`` is cut to this many characters (UTF-16 code units).
MAX_REFUSAL_MESSAGE = 200

#: Why an edit was refused (``exec.refused.code``).
REFUSAL_CODES = frozenset(
    {"schema", "shape", "placeholder", "truncated", "disabled", "unsupported"}
)

#: How the read-only MCP server's ``get_node`` preview note begins
#: (``MCP_PREVIEW_NOTE_PREFIX`` in ``packages/schema``).
MCP_PREVIEW_NOTE_PREFIX = "payload truncated: showing first "

#: A validator's verdict: ``{"ok": True, "value": ...}`` or
#: ``{"ok": False, "code": ..., "message"?: ...}``.
InputValidation = dict[str, Any]

#: Supplied by an integration that can apply an edit at a gate: checks (and
#: completes) the proposed input. Called on the thread (sync gate) or task
#: (async gate) that is blocked in the gate — never on the transport's thread —
#: with the host's context variables. It may return an awaitable; a raise, a
#: failed awaitable or a malformed result is a refusal with code ``shape``.
ValidateInput = Callable[[Any, "ValidateInputContext"], InputValidation | Awaitable[Any]]


class ValidateInputContext:
    """What the session tells a validator about the edit it is checking.

    ``input_hidden``: a ``GRAPHMIND_HIDE_*`` switch hides this call's input
    from the record (``hide_inputs``, or ``hide_tool_args`` on a tool). The
    debugger never saw the live input, so the edit is judged on its own, as a
    FULL replacement: never merged onto, completed from or compared with the
    hidden live values — otherwise the answer to a guess (refused, or run),
    repeatable while the gate stays held, would reveal them.
    :func:`merge_tool_input` does this when passed the context.
    """

    __slots__ = ("_input_hidden",)
    _input_hidden: bool

    def __init__(self, input_hidden: bool) -> None:
        object.__setattr__(self, "_input_hidden", input_hidden is True)

    @property
    def input_hidden(self) -> bool:
        return self._input_hidden

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("ValidateInputContext is read-only")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ValidateInputContext(input_hidden={self._input_hidden})"


class Refusal:
    """A refusal the client itself decided (codes and messages never quote values)."""

    __slots__ = ("code", "message")

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        self.message = message

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Refusal) and (other.code, other.message) == (
            self.code,
            self.message,
        )

    def __hash__(self) -> int:
        return hash((self.code, self.message))

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Refusal({self.code!r}, {self.message!r})"


def accept(value: Any) -> InputValidation:
    """The verdict that runs the call with ``value``."""
    return {"ok": True, "value": value}


def refuse(code: str, message: str | None = None) -> InputValidation:
    """The verdict that refuses the edit (the gate stays held)."""
    verdict: InputValidation = {"ok": False, "code": code}
    if message is not None:
        verdict["message"] = message
    return verdict


# -- placeholders and truncation markers ---------------------------------------

#: Written with their quotes, so they match a real key/value pair and never the
#: escaped text of a string that merely mentions them (see edit-input.ts).
_TRUNCATION_MARKERS = (
    "__graphmindTruncated",
    TRUNCATION_SUFFIX,
    '"__graphmind":"truncated"',
    '"__graphmind":"unserializable"',
    f'"note":"{MCP_PREVIEW_NOTE_PREFIX}',
)

#: This SDK's own recording bounds (``safe_value``), over compact JSON text —
#: the very patterns of ``PYTHON_PREVIEW_MARKERS`` in edit-input.ts (``\A`` /
#: ``\Z`` for its ``^`` / ``$``; ASCII digits only).
_PYTHON_PREVIEW_MARKERS = tuple(
    re.compile(pattern)
    for pattern in (
        r'…\[truncated\]"',
        r'(?:\A|[\[:,])"<[0-9]+ bytes>"(?=[,\]}]|\Z)',
        r'(?:\A|[\[:,])"…\[depth limit\]"(?=[,\]}]|\Z)',
        r'[{,]"…":"\[[0-9]+ more keys\]"(?=[,}])',
        r'(?:\A|[\[:,])"…\[[0-9]+ more\]"(?=[,\]}]|\Z)',
    )
)


def _compact_json(value: Any) -> str:
    """``JSON.stringify(value)`` for a JSON value: no whitespace, non-ASCII kept."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def proposed_value_refusal(value: Any) -> Refusal | None:
    """Refusal for a proposed input (or inject output) that must never run:
    ``placeholder`` when it contains ``"__REDACTED__"``, ``truncated`` when it
    contains a truncation marker, ``shape`` when it cannot be serialised to be
    checked. ``None`` when it is clean."""
    try:
        text = _compact_json(value)
    except Exception:
        return Refusal("shape", "the value could not be read as JSON")
    if REDACTED in text:
        return Refusal(
            "placeholder",
            'the value contains redacted content ("__REDACTED__"); replace it before running',
        )
    if any(marker in text for marker in _TRUNCATION_MARKERS) or any(
        pattern.search(text) for pattern in _PYTHON_PREVIEW_MARKERS
    ):
        return Refusal(
            "truncated",
            "the value contains a truncated preview, not the full value; replace it before running",
        )
    return None


# -- short wire text -------------------------------------------------------------

#: C0/C1 controls and the bidi marks/overrides/isolates: never rendered or printed.
_UNPRINTABLE = re.compile(r"[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]+")
#: JavaScript's ``\s`` (Python's own differs: it omits U+FEFF).
_JS_WHITESPACE = re.compile(
    r"[\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def sanitize_short_text(message: Any) -> str | None:
    """Short free text fit for the wire (a refusal message): a string,
    unprintable characters turned into spaces, whitespace collapsed, at most
    :data:`MAX_REFUSAL_MESSAGE` UTF-16 code units (never splitting a surrogate
    pair) — ``sanitizeShortText`` exactly. ``None`` when nothing is left."""
    if not isinstance(message, str):
        return None
    try:
        text = _JS_WHITESPACE.sub(" ", _UNPRINTABLE.sub(" ", str.__str__(message))).strip(" ")
        units = text.encode("utf-16-le", "surrogatepass")
        if len(units) // 2 > MAX_REFUSAL_MESSAGE:
            cut = MAX_REFUSAL_MESSAGE - 1
            last = int.from_bytes(units[2 * (cut - 1) : 2 * cut], "little")
            if 0xD800 <= last <= 0xDBFF:
                cut -= 1  # a high surrogate: its pair would be split
            text = units[: 2 * cut].decode("utf-16-le", "surrogatepass") + "…"
        return text or None
    except Exception:
        return None


# -- validator results -------------------------------------------------------------

_MALFORMED_MESSAGE = "the input could not be validated"


def validator_failed() -> InputValidation:
    """What a validator that raises, fails or returns garbage amounts to."""
    return refuse("shape", _MALFORMED_MESSAGE)


#: A fresh copy per use: see :func:`validator_failed`.
VALIDATOR_FAILED: Mapping[str, Any] = {"ok": False, "code": "shape", "message": _MALFORMED_MESSAGE}


def normalize_validation(result: Any) -> InputValidation:
    """One read of a validator's result into a documented shape. Anything that
    is not ``{"ok": True, "value": ...}`` or ``{"ok": False, "code": <known>}``
    — or whose fields cannot be read — is a ``shape`` refusal with a generic
    message. ``ok`` must be the booleans themselves (``1`` is not ``True``)."""
    try:
        if not isinstance(result, Mapping):
            return validator_failed()
        ok = result.get("ok")
        if ok is True:
            if "value" not in result:
                return validator_failed()
            return accept(result["value"])
        if ok is not False:
            return validator_failed()
        code = result.get("code")
        if not isinstance(code, str) or str.__str__(code) not in REFUSAL_CODES:
            return validator_failed()
        return refuse(str.__str__(code), sanitize_short_text(result.get("message")))
    except Exception:
        return validator_failed()


def wire_copy(value: Any) -> tuple[bool, Any]:
    """The effective input as it goes on the wire, ``(True, copy)``: a JSON
    round trip through the event serializer, so the record shows exactly what
    it will store (a model as its ``model_dump()``, NaN as null, anything else
    as its ``repr``). ``(False, None)`` when it has no JSON form (a cyclic
    container) — an edit that cannot be recorded is refused rather than run
    unrecorded."""
    try:
        return True, json.loads(_dumps_like_js(value))
    except Exception:
        return False, None


# -- prototype pollution -------------------------------------------------------------


def _pollution_path(root: Any) -> str | None:
    """The first deep-merge pollution path in this tree, if any: a mapping with
    a ``"__proto__"`` key, or a ``"constructor"`` key holding a mapping with a
    ``"prototype"`` key. Iterative, cycle-safe; raises only when the value
    cannot be read. The same walk as ``pollutionPath`` in edit-input.ts."""
    seen: set[int] = set()
    stack: list[Any] = [root]
    while stack:
        node = stack.pop()
        if id(node) in seen:
            continue
        seen.add(id(node))
        if isinstance(node, Mapping):
            if "__proto__" in node:
                return "__proto__"
            if "constructor" in node:
                ctor = node["constructor"]
                if isinstance(ctor, Mapping) and "prototype" in ctor:
                    return "constructor.prototype"
            children: Any = list(node.values())
        elif isinstance(node, (list, tuple)):
            children = list(node)
        else:
            continue
        for child in children:
            if isinstance(child, (Mapping, list, tuple)):
                stack.append(child)
    return None


def _pollution_message(subject: str, path: str) -> str:
    if path == "__proto__":
        return f'{subject} may not contain a "__proto__" key'
    return f'{subject} may not contain a "constructor.prototype" path'


def prototype_key_refusal(value: Any) -> Refusal | None:
    """Refusal (``shape``) for an edited input holding a deep-merge pollution
    path at any depth. The session applies it to EVERY edit, with or without
    an integration validator. ``None`` when clean or not a container."""
    try:
        if not isinstance(value, (Mapping, list, tuple)):
            return None
        path = _pollution_path(value)
        return (
            None if path is None else Refusal("shape", _pollution_message("the edited input", path))
        )
    except Exception:
        return Refusal("shape", "the edited input could not be read")


# -- the default edit rule for tool arguments -------------------------------------------


def _input_hidden(context: Any) -> bool:
    try:
        return getattr(context, "input_hidden", False) is True
    except Exception:
        return True  # an unreadable context: the safe reading (no live keys)


def merge_tool_input(live: Any, proposed: Any, context: Any = None) -> InputValidation:
    """The default edit rule for tool arguments (C2): ``proposed`` must be a
    plain JSON object (a ``dict`` with string keys); its top-level keys replace
    the live ones, and every key it does not mention keeps its LIVE value
    (nested values are replaced whole, never merged). Returns a new dict;
    neither argument is modified. A live input that is not a mapping
    contributes no keys.

    With the validator's ``context`` and ``context.input_hidden`` (a switch
    hides this input from the record), the live input contributes no keys
    either: the edit must be a full replacement.

    Refused with code ``shape``: a proposed value that is not a plain object,
    or one with a ``__proto__`` key or a ``constructor.prototype`` path at any
    depth. Integrations call it from their validator, passing the context on,
    then check the result with the tool's own schema."""
    try:
        if not isinstance(proposed, Mapping):
            return refuse("shape", "the edited arguments must be a JSON object")
        if type(proposed) is not dict or not all(isinstance(key, str) for key in proposed):
            return refuse("shape", "the edited arguments must be a plain JSON object")
        path = _pollution_path(proposed)
        if path is not None:
            return refuse("shape", _pollution_message("the edited arguments", path))
        base: dict[Any, Any] = (
            dict(live.items()) if not _input_hidden(context) and isinstance(live, Mapping) else {}
        )
        return accept({**base, **proposed})
    except Exception:
        return refuse("shape", "the edited arguments could not be read")


__all__ = [
    "MAX_REFUSAL_MESSAGE",
    "MCP_PREVIEW_NOTE_PREFIX",
    "REFUSAL_CODES",
    "VALIDATOR_FAILED",
    "InputValidation",
    "Refusal",
    "ValidateInput",
    "ValidateInputContext",
    "accept",
    "merge_tool_input",
    "normalize_validation",
    "proposed_value_refusal",
    "prototype_key_refusal",
    "refuse",
    "sanitize_short_text",
    "validator_failed",
    "wire_copy",
]
