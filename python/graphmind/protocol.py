"""The wire contract, ported from ``packages/schema``.

Every frame is one JSON text frame::

    {"gm": 1, "seq": <int>, "ts": <epoch ms>, "runId": <str>, "type": <str>,
     "payload": {...}}

``gm`` is the protocol MAJOR version: peers reject envelopes whose ``gm``
differs from theirs. Backwards-compatible additions (new message types, new
payload fields) do NOT bump it — receivers tolerate unknown types and unknown
fields instead, which is why every payload here is a plain ``dict`` rather than
a closed dataclass.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .shrink import escape_lone_surrogates

PROTOCOL_VERSION = 1
"""Envelope ``gm`` field. See ``packages/schema/src/constants.ts``."""

WILDCARD_RUN_ID = "*"
"""``runId`` for messages not bound to a run (handshake, breakpoints, mode)."""

#: Capabilities announced in ``hello``. This client implements all of them.
#:
#: ``run-claim``: this client stores the ``sessionToken`` from ``hello.ack``
#: and echoes it as ``hello.resumeToken`` on reconnect, so the debugger can
#: refuse writes to this app's runs from any other local process — including
#: across a disconnect, which is otherwise the one window a claim cannot be
#: proven in.
KNOWN_CAPABILITIES = ("pause", "step", "inject", "retry", "abort", "run-claim")

#: Messages the instrumented app sends.
EVENT_TYPES = frozenset(
    {
        "run.started",
        "run.finished",
        "graph.hint",
        "node.started",
        "node.token",
        "node.finished",
        "node.error",
        "exec.paused",
        "exec.resumed",
    }
)

#: Messages the viewer sends.
CONTROL_TYPES = frozenset({"exec.resume", "breakpoint.set", "breakpoint.clear", "mode.set"})

HANDSHAKE_TYPES = frozenset({"hello", "hello.ack"})

MESSAGE_TYPES = EVENT_TYPES | CONTROL_TYPES | HANDSHAKE_TYPES

#: ``NodeKind`` (schema ``primitives.ts``).
NODE_KINDS = frozenset({"agent", "llm", "tool", "chain", "retriever", "custom"})
#: ``RunStatus``.
RUN_STATUSES = frozenset({"ok", "error", "aborted"})
#: ``PausePoint``.
PAUSE_POINTS = frozenset({"before", "after", "error"})
#: ``ResumeAction``.
RESUME_ACTIONS = frozenset({"continue", "retry", "inject", "abort"})
#: ``RunMode``.
RUN_MODES = frozenset({"run", "step"})

#: ``TokenDelta.t`` channels.
TOKEN_CHANNELS = frozenset({"text", "reasoning", "tool-args"})


def now_ms() -> int:
    """Sender wall clock in epoch milliseconds (envelope ``ts``)."""
    return int(time.time() * 1000)


def create_envelope(
    type: str,
    payload: dict[str, Any],
    seq: int,
    run_id: str,
    ts: int | None = None,
) -> dict[str, Any]:
    """Build a well-formed envelope. Does not validate the payload."""
    return {
        "gm": PROTOCOL_VERSION,
        "seq": seq,
        "ts": now_ms() if ts is None else ts,
        "runId": run_id,
        "type": type,
        "payload": payload,
    }


def _fallback(obj: Any) -> Any:
    """Last-resort JSON coercion for values the host handed us.

    Agent inputs/outputs are arbitrary user objects (pydantic models, numpy
    arrays, LangChain Documents, ...). Serialization must never raise into the
    host, so anything unknown degrades to a bounded ``repr``.
    """
    for attr in ("model_dump", "dict", "to_dict"):
        method = getattr(obj, attr, None)
        if callable(method):
            try:
                return method()
            except Exception:
                pass
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    if isinstance(obj, (bytes, bytearray)):
        try:
            return obj.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - decode with errors never raises
            return "<bytes>"
    try:
        return repr(obj)[:2000]
    except Exception:
        return f"<unserializable {type(obj).__name__}>"


def _dumps_like_js(value: Any) -> str:
    """``json.dumps`` held to what ``JSON.stringify`` would put on the wire.

    * A non-finite float (NaN, Infinity) is written as ``null`` at any depth.
      Python writes the bare literals, which are not JSON: the debugger's
      parser rejected the whole frame and the event silently vanished.
    * A lone surrogate is written as a ``\\udXXX`` escape. A ``str`` can hold
      one (a JSON-decoded ``"\\ud800"``, ``surrogateescape``-decoded bytes);
      written raw, the frame could not be encoded as UTF-8, the WebSocket send
      raised, the connection dropped — and the frame, still in the replay
      buffer, dropped the next connection too. Adjacent high+low code points
      are paired first, as a UTF-16 string would see them.
    """
    try:
        text = json.dumps(value, default=_fallback, ensure_ascii=False, allow_nan=False)
    except ValueError as exc:
        if "Circular" in str(exc):
            raise
        # A non-finite float somewhere (default= results included). Serialise
        # with the literals, then re-read them as None and write again: the
        # round trip is exact for everything else json.dumps writes.
        text = json.dumps(value, default=_fallback, ensure_ascii=False)
        text = json.dumps(json.loads(text, parse_constant=lambda _: None), ensure_ascii=False)
    return escape_lone_surrogates(text)


def _degraded_payload(payload: Any) -> dict[str, Any]:
    """A payload that does not serialise even with ``default`` (a cyclic
    container): keep every top-level field that does and replace only the
    ones that do not, as ``serializePayload`` in ``packages/schema`` does, so
    the event keeps its identity fields and stays a valid event instead of
    being dropped by the debugger. ``_graphmindSerializationError`` marks it."""
    if not isinstance(payload, dict):
        return {"_graphmindSerializationError": True}
    kept: dict[Any, Any] = {}
    dropped: list[str] = []
    for key, value in list(payload.items()):
        if key is not None and not isinstance(key, (str, int, float)):
            continue  # a key json.dumps cannot write at all (a tuple): omitted
        try:
            _dumps_like_js([value])
            kept[key] = value
        except Exception:
            dropped.append(key if isinstance(key, str) else json.dumps(key))
            # Type-preserving where it matters: an array stays an array.
            kept[key] = (
                []
                if isinstance(value, (list, tuple))
                else {"__graphmindTruncated": True, "bytes": 0, "preview": "[unserializable value]"}
            )
    kept["__graphmindTruncated"] = True
    kept["fields"] = dropped
    kept["_graphmindSerializationError"] = True
    return kept


def serialize_envelope(envelope: dict[str, Any]) -> str:
    """Serialize an envelope to a single JSON text frame. Never raises.

    The text is valid JSON, as ``JSON.stringify`` would write it: non-finite
    floats become ``null`` and lone surrogates are escaped (see
    :func:`_dumps_like_js`)."""
    try:
        return _dumps_like_js(envelope)
    except Exception:
        pass
    # A container that breaks even with `default` (e.g. a cyclic dict): degrade
    # the offending fields rather than lose the event entirely.
    safe = dict(envelope)
    try:
        safe["payload"] = _degraded_payload(envelope.get("payload"))
        return _dumps_like_js(safe)
    except Exception:
        safe["payload"] = {"_graphmindSerializationError": True}
        return json.dumps(safe, default=repr)


class ParseResult:
    """Outcome of parsing one inbound frame."""

    __slots__ = ("envelope", "kind", "reason", "received")

    def __init__(
        self,
        kind: str,
        envelope: dict[str, Any] | None = None,
        reason: str = "",
        received: int | None = None,
    ) -> None:
        #: one of ``ok`` / ``invalid`` / ``version-mismatch`` / ``unknown-type``
        self.kind = kind
        self.envelope = envelope
        self.reason = reason
        self.received = received


def parse_envelope_json(text: str) -> ParseResult:
    """Parse an inbound frame, mirroring ``packages/schema/src/parse.ts``."""
    try:
        value = json.loads(text)
    except Exception as exc:
        return ParseResult("invalid", reason=f"not JSON: {exc}")
    if not isinstance(value, dict):
        return ParseResult("invalid", reason="envelope is not an object")
    gm = value.get("gm")
    if not isinstance(gm, int) or isinstance(gm, bool):
        return ParseResult("invalid", reason="missing or non-integer 'gm'")
    if gm != PROTOCOL_VERSION:
        return ParseResult("version-mismatch", received=gm)
    type_ = value.get("type")
    if not isinstance(type_, str):
        return ParseResult("invalid", reason="missing or non-string 'type'")
    if not isinstance(value.get("payload"), dict):
        return ParseResult("invalid", reason="missing or non-object 'payload'")
    if not isinstance(value.get("runId"), str):
        return ParseResult("invalid", reason="missing or non-string 'runId'")
    seq = value.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        return ParseResult("invalid", reason="missing or invalid 'seq'")
    if type_ not in MESSAGE_TYPES:
        # Forward compatibility: a later 1.x peer may send types we don't know.
        return ParseResult("unknown-type", envelope=value)
    return ParseResult("ok", envelope=value)
