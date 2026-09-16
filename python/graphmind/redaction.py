"""Coarse redaction: four kill switches, applied at the one emit choke point.

Port of ``packages/client/src/redaction.ts`` (read that file's header for the
rationale). Whole-field replacement of ``node.started.input`` and
``node.finished.output`` (and the text of ``node.token`` deltas) with the
placeholder ``"__REDACTED__"``, chosen by node kind. No deny lists, no
regexes, no callbacks.

* ``GRAPHMIND_HIDE_INPUTS`` (``hide_inputs``): ``node.started.input`` on
  every kind, plus streamed ``tool-args`` deltas;
* ``GRAPHMIND_HIDE_OUTPUTS`` (``hide_outputs``): ``node.finished.output`` on
  every kind, plus every streamed delta;
* ``GRAPHMIND_HIDE_TOOL_ARGS`` (``hide_tool_args``): ``node.started.input``
  when the kind is ``tool``, plus streamed ``tool-args`` deltas;
* ``GRAPHMIND_HIDE_TOOL_RESULTS`` (``hide_tool_results``):
  ``node.finished.output`` when the instance's kind is ``tool``, plus the
  deltas a tool node streams.

Env values ``1`` / ``true`` (case-insensitive, surrounding whitespace ignored)
turn a switch on; each is also a session option. Either source turning a
switch on turns it on: an environment switch is a floor code cannot lower.

Every affected event carries ``redaction: {count, keys}``. ``node.error`` is
deliberately NOT redacted (error messages may echo data). A field that is
absent, or already the placeholder, is left alone and not counted; an
existing ``redaction`` summary is merged. In Python a key that is present
with the value ``None`` is JSON ``null``, which counts as a value (the TS
client redacts ``null`` too).

What the TOOL-only switches do not cover: in an agent loop the same tool
arguments and results also travel through the LLM node (the model's tool
calls are its output; the tool results are the next request's input), and
those are recorded unless ``hide_inputs`` / ``hide_outputs`` are on as well.

The session applies this inside ``_emit_internal`` BEFORE the ring buffer, so
replay-on-attach, the socket and everything downstream see only the redacted
event. Never raises, never mutates the caller's dict, zero cost when every
switch is off. Thread-safe.

FAILS CLOSED (internal/decisions.md "Redaction fails closed on internal
error", binding for every port). With any switch on, ``node.started``,
``node.finished`` and ``node.token`` are redacted from a one-read snapshot of
the payload (a plain ``dict`` built from one pass over ``items()``, string
keys as plain ``str``), so what was inspected is exactly what is sent. When
that cannot be done — the payload is not a mapping, a read raises (``items``,
``__iter__``, ``__getitem__`` of a hostile mapping), token ``deltas`` a hiding
switch could cover is not a list/tuple, or a covered delta is neither ``None``
nor a mapping or has a ``v`` that is present and not a ``str``, or an identity
field a switch decides by (``nodeId``/``instanceId``/``kind`` of a start,
``nodeId``/``instanceId`` of a result, ``nodeId`` of a token, ``t`` of each
delta of a batch a switch could cover) is present, not ``None`` and not a
``str`` (the serializer turns ``bytes``, ``model_dump()`` and ``repr`` into the
string a switch looks for) — the event is
replaced by its FAILED FORM, built without reading ``input``/``output``/
``deltas``::

    node.started   {nodeId, parentId?, kind, name, instanceId, input: REDACTED}
    node.finished  {nodeId, instanceId?, durationMs, heldMs?, status, usage?, output: REDACTED}
    node.token     {nodeId, instanceId?, deltas: []}

each with ``redaction: {count: 0, keys: ["input", "output", "deltas"], failed:
true}``. Fields are copied best-effort: an optional one whose read raises or
whose value would fail the wire schema is omitted; when a REQUIRED one cannot
be read or is invalid, :meth:`Redactor.apply` returns :data:`DROP` and the
session does not emit the event. Both outcomes are reported through the
optional ``warn(key, message)`` callback (keys ``redaction:failed`` /
``redaction:dropped``) without quoting the payload or the error.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable, Mapping
from typing import Any

from .protocol import NODE_KINDS, RUN_STATUSES

REDACTED = "__REDACTED__"
"""The placeholder every hidden value becomes. Shared by every language port."""

#: ``redaction.keys`` on a failed form: nothing counted, every hideable field named.
FAILED_REDACTION_KEYS: tuple[str, ...] = ("input", "output", "deltas")


class _Drop:
    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "graphmind.redaction.DROP"


DROP: Any = _Drop()
"""Returned by :meth:`Redactor.apply` when the event must NOT be emitted."""

#: Receives the fail-closed reports: ``warn(key, message)``.
RedactionWarn = Callable[[str, str], None]

_NODE_EVENTS = frozenset({"node.started", "node.finished", "node.token"})
_MISSING = object()


class _Uninspectable(Exception):
    """Raised (and caught) inside ``apply`` when a payload cannot be inspected."""


#: Open instances tracked at once, across all runs; oldest evicted past this.
DEFAULT_MAX_TRACKED_INSTANCES = 10_000
#: Latest-kind-per-node entries kept; oldest evicted past this.
_MAX_TRACKED_NODES = 10_000
_MAX_SAFE_INTEGER = 2**53 - 1

SWITCH_ENV = {
    "hide_inputs": "GRAPHMIND_HIDE_INPUTS",
    "hide_outputs": "GRAPHMIND_HIDE_OUTPUTS",
    "hide_tool_args": "GRAPHMIND_HIDE_TOOL_ARGS",
    "hide_tool_results": "GRAPHMIND_HIDE_TOOL_RESULTS",
}


class RedactionSwitches:
    __slots__ = ("hide_inputs", "hide_outputs", "hide_tool_args", "hide_tool_results")

    def __init__(
        self,
        hide_inputs: bool = False,
        hide_outputs: bool = False,
        hide_tool_args: bool = False,
        hide_tool_results: bool = False,
    ) -> None:
        self.hide_inputs = hide_inputs
        self.hide_outputs = hide_outputs
        self.hide_tool_args = hide_tool_args
        self.hide_tool_results = hide_tool_results

    @property
    def any(self) -> bool:
        return (
            self.hide_inputs or self.hide_outputs or self.hide_tool_args or self.hide_tool_results
        )

    def as_dict(self) -> dict[str, bool]:
        return {name: bool(getattr(self, name)) for name in self.__slots__}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"RedactionSwitches({self.as_dict()})"


def env_flag_on(value: Any) -> bool:
    """``1`` or ``true``, case-insensitive, surrounding whitespace ignored."""
    if not isinstance(value, str):
        return False
    text = value.strip().lower()
    return text in ("1", "true")


def option_flag_on(value: Any) -> bool:
    """An option value that turns a switch ON: ``True``, ``1`` or an env spelling.

    Privacy switches are read from config files and env-derived dicts, so the
    spellings the environment accepts count here too. Anything else is off.
    """
    if value is True:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 1:
        return True
    return isinstance(value, str) and env_flag_on(value)


def resolve_redaction(
    options: Mapping[str, Any] | None, env: Mapping[str, str]
) -> RedactionSwitches:
    """Either the option or the environment turning a switch on turns it on.

    Never raises: an unreadable option or environment counts as "not on" for
    that source only.
    """
    values: dict[str, bool] = {}
    for name, env_name in SWITCH_ENV.items():
        on = False
        try:
            if options is not None:
                on = option_flag_on(options.get(name))
        except Exception:
            on = False
        if not on:
            try:
                on = env_flag_on(env.get(env_name))
            except Exception:
                on = False
        values[name] = on
    return RedactionSwitches(**values)


def _utf16_length(text: str) -> int:
    """JavaScript ``string.length``: UTF-16 code units, so an emoji counts 2."""
    try:
        return len(text.encode("utf-16-le", "surrogatepass")) // 2
    except Exception:  # pragma: no cover - surrogatepass accepts every str
        return len(text)


def _merge_summary(existing: Any, count: int, key: str) -> dict[str, Any]:
    """Merge a fresh summary into whatever ``redaction`` the payload already had."""
    if (
        isinstance(existing, dict)
        and isinstance(existing.get("count"), (int, float))
        and not isinstance(existing.get("count"), bool)
        and isinstance(existing.get("keys"), list)
    ):
        prior = [k for k in existing["keys"] if isinstance(k, str)]
        keys = prior if key in prior else [*prior, key]
        raw = existing["count"]
        # The wire schema says a non-negative safe integer, and the hub drops an
        # envelope that fails it: never carry a bad prior count into the sum.
        prior_count = 0
        try:
            if raw == raw and float(raw).is_integer() and 0 <= raw <= _MAX_SAFE_INTEGER:
                prior_count = int(raw)
        except Exception:
            prior_count = 0
        total = prior_count + count
        return {"count": total if total <= _MAX_SAFE_INTEGER else count, "keys": keys}
    return {"count": count, "keys": [key]}


def _plain_str(value: Any) -> str | None:
    """A ``str`` (a subclass as the plain string it serialises as, so its
    ``__eq__`` / ``__hash__`` cannot lie to a privacy decision), else ``None``."""
    return str.__str__(value) if isinstance(value, str) else None


def _identity(fields: Mapping[Any, Any], key: str) -> str | None:
    """An identity field a switch decides by (a start's ``kind``, the ``nodeId``
    / ``instanceId`` a result's kind is looked up by, a delta's ``t``), read from
    the snapshot: absent or ``None`` -> ``None``, a ``str`` -> its plain value.
    Anything else is compared as one value but serialised as another — the wire
    serializer decodes ``bytes`` and falls back to ``model_dump()`` /
    ``to_dict()`` / ``repr`` — so ``kind=b"tool"`` would keep the tool's
    arguments visible under ``"kind": "tool"``. Such a payload cannot be
    inspected: raise, and the caller fails closed (TS parity)."""
    value = fields.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _Uninspectable(f"{key} is not a string")
    return str.__str__(value)


def _is_placeholder(value: Any) -> bool:
    return isinstance(value, str) and str.__eq__(value, REDACTED) is True


def _snapshot(value: Mapping[Any, Any]) -> dict[Any, Any]:
    """One read of every item into a plain ``dict`` (string keys as plain
    ``str``): what is inspected is exactly what is serialised. Raises when the
    mapping cannot be read."""
    copy: dict[Any, Any] = {}
    for key, item in value.items():
        copy[str.__str__(key) if isinstance(key, str) else key] = item
    return copy


def _read(mapping: Any, key: str) -> Any:
    """``mapping[key]``, or ``_MISSING`` when absent or when the read raises."""
    try:
        return mapping[key]
    except Exception:
        return _MISSING


def _duration(value: Any) -> int | float | None:
    """A finite non-negative JSON number as a plain int/float, else ``None``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        plain = int.__int__(value) if isinstance(value, int) else float.__float__(value)
        return plain if math.isfinite(plain) and plain >= 0 else None
    except Exception:  # an int too large for a double is not finite in JS either
        return None


def _token_count(value: Any) -> int | None:
    """A non-negative safe integer (``3.0`` counts, as in JS), else ``None``."""
    plain = _duration(value)
    if plain is None:
        return None
    try:
        if float(plain).is_integer() and plain <= _MAX_SAFE_INTEGER:
            return int(plain)
    except Exception:
        return None
    return None


class Redactor:
    """Applies the switches to one event at a time. One per session."""

    def __init__(
        self,
        switches: RedactionSwitches,
        max_instances: int = DEFAULT_MAX_TRACKED_INSTANCES,
        warn: RedactionWarn | None = None,
    ) -> None:
        self.switches = switches
        self._max_instances = max(1, int(max_instances))
        self._warn = warn
        self._lock = threading.Lock()
        # dicts keep insertion order -> oldest-first eviction
        self._instances: dict[tuple[str, str, str], str] = {}
        self._nodes: dict[tuple[str, str], str] = {}

    @property
    def active(self) -> bool:
        return self.switches.any

    @property
    def tracked_instances(self) -> int:
        return len(self._instances)

    def apply(self, type: str, payload: Any, run_id: str) -> Any:
        """Redact one event. Every switch off, or a type other than
        node.started / node.finished / node.token: the very same object.
        Otherwise a plain dict (see the module docstring) — redacted,
        unchanged, or the failed form — or :data:`DROP`, meaning the event must
        NOT be emitted. Never raises."""
        if not self.switches.any or type not in _NODE_EVENTS:
            return payload
        try:
            if not isinstance(payload, Mapping):
                raise _Uninspectable("payload is not a mapping")
            p = _snapshot(payload)
            if type == "node.started":
                return self._on_started(p, run_id)
            if type == "node.finished":
                return self._on_finished(p, run_id)
            return self._on_token(p, run_id)
        except Exception:
            return self._fail_closed(type, payload, run_id)

    # -- fail closed -------------------------------------------------------------

    def _fail_closed(self, type: str, payload: Any, run_id: str) -> Any:
        try:
            out = self._failed_form(type, payload, run_id)
        except Exception:
            out = None
        if out is None:
            self._report(
                "redaction:dropped",
                f"a {type} event could not be redacted and its identity fields could not be "
                "read; dropped it rather than send data a GRAPHMIND_HIDE_* switch hides",
            )
            return DROP
        self._report(
            "redaction:failed",
            f"redaction failed on a {type} event (unreadable or malformed payload); "
            "sent it with input/output/deltas hidden and redaction.failed set",
        )
        return out

    def _failed_form(self, type: str, payload: Any, run_id: str) -> dict[str, Any] | None:
        """The failed form (module docstring), or None when it cannot be valid.
        Never reads ``input`` / ``output`` / ``deltas``."""
        if not isinstance(payload, Mapping):
            return None
        node_id = _plain_str(_read(payload, "nodeId"))
        if node_id is None:
            return None
        out: dict[str, Any] = {"nodeId": node_id}
        failed = {"count": 0, "keys": list(FAILED_REDACTION_KEYS), "failed": True}
        if type == "node.started":
            parent_id = _plain_str(_read(payload, "parentId"))
            if parent_id is not None:
                out["parentId"] = parent_id
            kind = _plain_str(_read(payload, "kind"))
            name = _plain_str(_read(payload, "name"))
            instance_id = _plain_str(_read(payload, "instanceId"))
            if kind is None or kind not in NODE_KINDS or name is None or instance_id is None:
                return None
            # Still learn the kind, so this instance's node.finished is judged right.
            self._remember(run_id, node_id, instance_id, kind)
            return {
                **out,
                "kind": kind,
                "name": name,
                "instanceId": instance_id,
                "input": REDACTED,
                "redaction": failed,
            }
        if type == "node.finished":
            instance_id = _plain_str(_read(payload, "instanceId"))
            if instance_id is not None:
                out["instanceId"] = instance_id
                with self._lock:
                    self._instances.pop((run_id, node_id, instance_id), None)
            duration = _duration(_read(payload, "durationMs"))
            status = _plain_str(_read(payload, "status"))
            if duration is None or status is None or status not in RUN_STATUSES:
                return None
            out["durationMs"] = duration
            held = _duration(_read(payload, "heldMs"))
            if held is not None:
                out["heldMs"] = held
            out["status"] = status
            usage = _read(payload, "usage")
            if isinstance(usage, Mapping):
                input_tokens = _token_count(_read(usage, "inputTokens"))
                output_tokens = _token_count(_read(usage, "outputTokens"))
                if input_tokens is not None and output_tokens is not None:
                    out["usage"] = {"inputTokens": input_tokens, "outputTokens": output_tokens}
            return {**out, "output": REDACTED, "redaction": failed}
        if type == "node.token":
            instance_id = _plain_str(_read(payload, "instanceId"))
            if instance_id is not None:
                out["instanceId"] = instance_id
            return {**out, "deltas": [], "redaction": failed}
        return None  # pragma: no cover - apply only routes the three node events

    def _report(self, key: str, message: str) -> None:
        warn = self._warn
        if warn is None:
            return
        try:
            warn(key, message)
        except Exception:
            pass  # a raising sink must not turn a safe outcome into a raise

    # -- events ---------------------------------------------------------------
    # Each handler receives the SNAPSHOT (a plain dict) and returns it, or a copy
    # of it — never the integration's object. A raise means "fail closed".

    def _on_started(self, p: dict[str, Any], run_id: str) -> dict[str, Any]:
        kind = _identity(p, "kind")
        node_id = _identity(p, "nodeId")
        instance_id = _identity(p, "instanceId")
        if node_id is not None and kind is not None:
            self._remember(run_id, node_id, instance_id, kind)
        s = self.switches
        hide = s.hide_inputs or (s.hide_tool_args and kind == "tool")
        if not hide or "input" not in p or _is_placeholder(p["input"]):
            return p
        return {**p, "input": REDACTED, "redaction": _merge_summary(p.get("redaction"), 1, "input")}

    def _on_finished(self, p: dict[str, Any], run_id: str) -> dict[str, Any]:
        node_id = _identity(p, "nodeId")
        instance_id = _identity(p, "instanceId")
        kind = self._kind_of(run_id, node_id, instance_id) if node_id is not None else None
        if node_id is not None and instance_id is not None:
            with self._lock:
                self._instances.pop((run_id, node_id, instance_id), None)
        s = self.switches
        hide = s.hide_outputs or (s.hide_tool_results and kind == "tool")
        if not hide or "output" not in p or _is_placeholder(p["output"]):
            return p
        return {
            **p,
            "output": REDACTED,
            "redaction": _merge_summary(p.get("redaction"), 1, "output"),
        }

    def _on_token(self, p: dict[str, Any], run_id: str) -> dict[str, Any]:
        s = self.switches
        node_id = _identity(p, "nodeId")
        node_is_tool = (
            s.hide_tool_results
            and node_id is not None
            and self._kind_of(run_id, node_id, None) == "tool"
        )
        hide_all = s.hide_outputs or node_is_tool
        hide_tool_args = s.hide_tool_args or s.hide_inputs
        if not hide_all and not hide_tool_args:
            return p
        deltas = p.get("deltas")
        if not isinstance(deltas, (list, tuple)):
            raise _Uninspectable("deltas is not an array")
        count = 0
        out: list[Any] = []
        # One read of the sequence and of each delta; the copies are what is sent.
        for delta in list(deltas):
            if delta is None:
                out.append(None)
                continue
            if not isinstance(delta, Mapping):
                # A bare string (or number, list...) where a delta belongs: its
                # channel is unknown, so every hiding switch may cover it.
                raise _Uninspectable("a delta is not a mapping")
            d = _snapshot(delta)
            # Read even under hide_all: one rule for every port.
            channel = _identity(d, "t")
            hide = hide_all or (hide_tool_args and channel == "tool-args")
            if not hide or "v" not in d:
                out.append(d)
                continue
            value = d["v"]
            if not isinstance(value, str):
                # JSON null included: present and not a string (TS: not undefined).
                raise _Uninspectable("a covered delta value is not a string")
            text = str.__str__(value)
            if text == "":
                out.append(d)
                continue
            count += 1
            out.append({**d, "v": "", "chars": _utf16_length(text)})
        if count == 0:
            return {**p, "deltas": out}
        return {
            **p,
            "deltas": out,
            "redaction": _merge_summary(p.get("redaction"), count, "deltas"),
        }

    # -- kind tracking ----------------------------------------------------------

    def _remember(self, run_id: str, node_id: str, instance_id: str | None, kind: str) -> None:
        with self._lock:
            node_key = (run_id, node_id)
            self._nodes.pop(node_key, None)  # re-insert so the newest is last
            self._nodes[node_key] = kind
            while len(self._nodes) > _MAX_TRACKED_NODES:
                del self._nodes[next(iter(self._nodes))]
            if instance_id is None:
                return
            self._instances[(run_id, node_id, instance_id)] = kind
            while len(self._instances) > self._max_instances:
                del self._instances[next(iter(self._instances))]

    def _kind_of(self, run_id: str, node_id: str, instance_id: str | None) -> str | None:
        with self._lock:
            if instance_id is not None:
                by_instance = self._instances.get((run_id, node_id, instance_id))
                if by_instance is not None:
                    return by_instance
            by_node = self._nodes.get((run_id, node_id))
            if by_node is not None:
                return by_node
        # Last resort: the nodeId convention every adapter follows (decisions.md #1).
        return "tool" if node_id.startswith("tool:") else None
