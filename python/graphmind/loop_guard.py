"""Loop guard: hold an agent that makes the same tool call again, back-to-back.

Port of ``packages/client/src/loop-guard.ts`` (read that file's header for the
full rationale); held to the cross-language conformance fixture
``packages/client/test/fixtures/loop-guard.json`` (version 3).

The session fingerprints ``(nodeId, input)`` where ``node.started`` is emitted
and CONSULTS the streak at the next ``before`` gate of that node:

* mode ``pause`` + debugger attached: the Nth identical back-to-back call is
  HELD through the normal gate path (``pause_timeout`` and fail-open release
  on disconnect apply) with ``reason: "loop"`` and ``loop: {repeats,
  firstSeq, lastSeq, fingerprint}`` on ``exec.paused``;
* mode ``pause`` + detached, or mode ``warn``: ONE warning per streak and
  execution continues (the count keeps running, so a debugger that attaches
  later holds the next identical call);
* mode ``off`` or threshold ``0``: nothing at all.

Counting (rule v3, internal/decisions.md "Loop hold v3: a loop is the same
call BACK-TO-BACK" — identical in TypeScript and Ruby):

1. Per run, per node KIND, the guard keeps ONE streak:
   ``{nodeId, fingerprint, count, firstSeq, lastSeq}``.
2. A WATCHED start (guard enabled, kind in ``kinds``, not in ``allow_nodes``)
   with a readable input: same ``(nodeId, fingerprint)`` as its kind's streak
   -> count += 1; otherwise the streak is REPLACED by a fresh one (count 1).
3. A watched start whose input cannot be read (a read raises, a conversion is
   not faithful — or its nodeId is not a string) CLEARS its kind's streak.
4. Unwatched starts (other kinds, allow-listed nodes) touch no streak, so an
   LLM step between two identical tool calls does not break the tool streak.
5. The ``before`` gate holds when the gated node's kind streak belongs to this
   nodeId and count >= threshold; each count holds at most once, so a
   ``retry`` (no new ``node.started``) runs on and the next identical
   back-to-back call holds again.
6. Memory: one streak per (run, kind); runs are LRU-bounded.

Why back-to-back: under ``graphmind mcp-proxy`` a whole host session is one
run, and an agent calling ``list_issues({})`` at minute 1, 20 and 45 with
other tools between was held as a loop. A false hold freezes the user's
agent. Accepted consequence: a model ALTERNATING between tools (search, read,
search, read) is not held.

Fingerprint = first 32 hex chars of SHA-256 over the canonical JSON of
``[nodeId, input]``: keys sorted by UTF-16 code unit, no whitespace, numbers in
JavaScript's shortest round-trip form (``1.0`` -> ``1``, ``1e-07`` ->
``1e-7``, non-finite -> ``null``), strings escaped like ``JSON.stringify``,
keys in ``ignore_keys`` (default: MCP's ``_meta``) removed at every level,
cycles and depth > 64 replaced by markers. Python values JSON cannot express
are canonicalised the way the wire serializer degrades them (``model_dump`` /
``dict`` / ``to_dict``, sets as sorted arrays, bytes as UTF-8 text (an
invalid byte escaped as its own lone surrogate, never U+FFFD), other
objects as their ``repr``); an input that raises while being read breaks the
streak instead of looking identical to the next one.

Everything here is bookkeeping: never raises into the host, keeps no
reference to a host object, thread-safe.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import types
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

DEFAULT_LOOP_THRESHOLD = 3
DEFAULT_LOOP_MODE = "pause"
DEFAULT_LOOP_KINDS: tuple[str, ...] = ("tool",)
#: Keys that change on every request without changing the request. Only MCP's
#: reserved ``_meta`` (where clients put a per-request ``progressToken``).
#: Pagination keys are deliberately NOT here: page 3 is not page 2.
DEFAULT_LOOP_IGNORE_KEYS: tuple[str, ...] = ("_meta",)

#: Distinct runs whose loop state is kept; least recently used evicted past this.
#: (Each run keeps one streak per watched kind — there is no per-node state.)
MAX_LOOP_RUNS = 64
_MAX_DEPTH = 64
_FINGERPRINT_HEX_CHARS = 32
_LOOP_MODES = ("pause", "warn", "off")

_DECIMAL_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
_RADIX_RE = re.compile(r"^0([xXoObB])([0-9a-fA-F]+)$")
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


# -- configuration ----------------------------------------------------------


def _js_number(text: str) -> float | None:
    """What JavaScript's ``Number(text)`` gives for the spellings that matter
    (decimal, exponent, 0x/0o/0b); ``None`` where it would be NaN."""
    if _DECIMAL_RE.match(text):
        try:
            return float(text)
        except (ValueError, OverflowError):
            return None
    radix = _RADIX_RE.match(text)
    if radix:
        base = {"x": 16, "o": 8, "b": 2}[radix.group(1).lower()]
        try:
            return float(int(radix.group(2), base))
        except (ValueError, OverflowError):
            return None
    if text in ("Infinity", "+Infinity", "-Infinity"):
        return math.inf
    return None


def parse_loop_threshold(raw: Any, fallback: int = DEFAULT_LOOP_THRESHOLD) -> int:
    """``GRAPHMIND_LOOP_THRESHOLD``: a non-negative integer, anything else ->
    ``fallback``. Never raises."""
    if not isinstance(raw, str):
        return fallback
    text = raw.strip()
    if text == "":
        return fallback
    value = _js_number(text)
    if value is None or not math.isfinite(value) or not value.is_integer() or value < 0:
        return fallback
    return int(value)


def parse_loop_allow(raw: Any) -> list[str]:
    """``GRAPHMIND_LOOP_ALLOW``: comma-separated node ids or names that
    legitimately repeat (``pollJob,tool:heartbeat``). Whitespace around entries
    is ignored, empty entries are dropped; anything not a string -> ``[]``."""
    if not isinstance(raw, str):
        return []
    return [entry.strip() for entry in raw.split(",") if entry.strip()]


def parse_loop_mode(raw: Any, fallback: str = DEFAULT_LOOP_MODE) -> str:
    """``GRAPHMIND_ON_LOOP``: ``pause`` | ``warn`` | ``off`` (case-insensitive;
    ``0`` / ``false`` / ``none`` mean off); anything else -> ``fallback``."""
    if not isinstance(raw, str):
        return fallback
    text = raw.strip().lower()
    if text in _LOOP_MODES:
        return text
    if text in ("0", "false", "none"):
        return "off"
    return fallback


def _valid_threshold(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if not math.isfinite(value) or not float(value).is_integer() or value < 0:
            return None
    except (OverflowError, ValueError):
        return None
    return int(value)


class ResolvedLoopGuard:
    __slots__ = ("allow_nodes", "ignore_keys", "kinds", "mode", "threshold")

    def __init__(
        self,
        threshold: int,
        mode: str,
        ignore_keys: frozenset[str],
        allow_nodes: frozenset[str],
        kinds: frozenset[str],
    ) -> None:
        self.threshold = threshold
        self.mode = mode
        self.ignore_keys = ignore_keys
        self.allow_nodes = allow_nodes
        self.kinds = kinds

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"ResolvedLoopGuard(threshold={self.threshold}, mode={self.mode!r}, "
            f"ignore_keys={sorted(self.ignore_keys)}, allow_nodes={sorted(self.allow_nodes)}, "
            f"kinds={sorted(self.kinds)})"
        )


def _option(options: Mapping[str, Any], snake: str, camel: str) -> Any:
    if snake in options:
        return options[snake]
    return options.get(camel)


def _string_set(value: Any, default: Any) -> frozenset[str]:
    if isinstance(value, (list, tuple, set, frozenset)):
        return frozenset(item for item in value if isinstance(item, str))
    return frozenset(default)


def _resolve_strict(options: Any, env: Mapping[str, str]) -> ResolvedLoopGuard:
    if options is False:
        opts: Mapping[str, Any] = {"mode": "off"}
    elif isinstance(options, Mapping):
        opts = options
    else:
        opts = {}
    threshold = _valid_threshold(opts.get("threshold"))
    if threshold is None:
        threshold = parse_loop_threshold(env.get("GRAPHMIND_LOOP_THRESHOLD"))
    mode = opts.get("mode")
    if not (isinstance(mode, str) and mode in _LOOP_MODES):
        mode = parse_loop_mode(env.get("GRAPHMIND_ON_LOOP"))
    return ResolvedLoopGuard(
        threshold=threshold,
        mode=mode,
        ignore_keys=_string_set(
            _option(opts, "ignore_keys", "ignoreKeys"), DEFAULT_LOOP_IGNORE_KEYS
        ),
        allow_nodes=_string_set(
            _option(opts, "allow_nodes", "allowNodes"),
            parse_loop_allow(env.get("GRAPHMIND_LOOP_ALLOW")),
        ),
        kinds=_string_set(opts.get("kinds"), DEFAULT_LOOP_KINDS),
    )


def resolve_loop_guard(options: Any, env: Mapping[str, str]) -> ResolvedLoopGuard:
    """Precedence per field: option > environment > default.

    ``options`` is ``False`` (shorthand for ``{"mode": "off"}``), ``None``, or a
    mapping with ``threshold``, ``mode``, ``ignore_keys``, ``allow_nodes``,
    ``kinds`` (camelCase spellings accepted too); ``GRAPHMIND_LOOP_THRESHOLD``,
    ``GRAPHMIND_ON_LOOP`` and ``GRAPHMIND_LOOP_ALLOW`` fill what the options
    leave out (an ``allow_nodes`` list replaces the env list). Never raises: unreadable
    options are ignored as a whole, an unreadable environment falls back to
    the defaults.
    """
    try:
        return _resolve_strict(options, env)
    except Exception:
        try:
            return _resolve_strict(None, env)
        except Exception:
            return _resolve_strict(None, {})


# -- canonical JSON + fingerprint ------------------------------------------


class _Lossy(Exception):
    """A value could not be read faithfully: not comparable to anything."""


def _quote(text: str) -> str:
    """JSON-escaped exactly like ``JSON.stringify`` (controls as lowercase
    ``\\u00xx``, non-ASCII raw, lone surrogates escaped)."""
    if _SURROGATE_RE.search(text) is not None:
        # A Python str can hold surrogate code points: re-pair valid pairs the
        # way a UTF-16 JS string would see them, then escape the lone ones.
        try:
            text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
        except Exception:
            pass
        pieces: list[str] = []
        last = 0
        for match in _SURROGATE_RE.finditer(text):
            pieces.append(json.dumps(text[last : match.start()], ensure_ascii=False)[1:-1])
            pieces.append(f"\\u{ord(match.group(0)):04x}")
            last = match.end()
        pieces.append(json.dumps(text[last:], ensure_ascii=False)[1:-1])
        return '"' + "".join(pieces) + '"'
    return json.dumps(text, ensure_ascii=False)


def js_number(value: float) -> str:
    """``JSON.stringify`` of a finite double: ECMAScript Number::toString."""
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr() is the shortest round-trip decimal; Decimal gives digits + exponent.
    _, digit_tuple, exponent = Decimal(float.__repr__(abs(float(value)))).as_tuple()
    digits = "".join(str(d) for d in digit_tuple).lstrip("0")
    trailing = len(digits) - len(digits.rstrip("0"))
    digits = digits.rstrip("0")
    assert isinstance(exponent, int)
    exponent += trailing
    k = len(digits)
    n = k + exponent  # value = 0.d1d2..dk * 10^n
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mantissa = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _utf16_sort_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


_FUNCTION_TYPES = (
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    types.LambdaType,
)


def _is_dropped(value: Any) -> bool:
    """What JSON.stringify drops from objects (and writes null for in arrays)."""
    return isinstance(value, _FUNCTION_TYPES)


def _object_key(key: Any) -> str:
    """How ``json.dumps`` spells a dict key; unsupported key types are lossy."""
    if isinstance(key, str):
        return key
    if key is True:
        return "true"
    if key is False:
        return "false"
    if key is None:
        return "null"
    if isinstance(key, int):
        return str(int(key))
    if isinstance(key, float):
        return js_number(key) if math.isfinite(key) else "null"
    raise _Lossy


def _canon(value: Any, ignore: frozenset[str], depth: int, seen: set[int]) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, int):
        return str(int(value))
    if isinstance(value, float):
        return js_number(float(value)) if math.isfinite(value) else "null"
    if _is_dropped(value):
        return "null"
    if depth > _MAX_DEPTH:
        return '"[depth]"'
    marker = id(value)
    if marker in seen:
        return '"[circular]"'
    seen.add(marker)
    try:
        if isinstance(value, Mapping):
            entries: list[tuple[str, Any]] = []
            for raw_key, item in value.items():
                key = _object_key(raw_key)
                if key in ignore or _is_dropped(item):
                    continue
                entries.append((key, item))
            entries.sort(key=lambda entry: _utf16_sort_key(entry[0]))
            parts = [f"{_quote(k)}:{_canon(v, ignore, depth + 1, seen)}" for k, v in entries]
            return "{" + ",".join(parts) + "}"
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(_canon(item, ignore, depth + 1, seen) for item in value) + "]"
        if isinstance(value, (set, frozenset)):
            # A set has no order; make one, so equal sets fingerprint equally.
            items = sorted(_canon(item, ignore, depth + 1, seen) for item in value)
            return "[" + ",".join(items) + "]"
        if isinstance(value, (bytes, bytearray)):
            # "surrogateescape", not "replace": every invalid byte keeps its own
            # identity (as an escaped lone surrogate), so different binary data
            # can never collapse into one "identical arguments" call.
            return _quote(bytes(value).decode("utf-8", "surrogateescape"))
        # The wire serializer's degradations (protocol._fallback), unbounded here
        # because truncating would make different inputs look identical.
        for attr in ("model_dump", "dict", "to_dict"):
            method = getattr(value, attr, None)
            if callable(method):
                try:
                    replaced = method()
                except Exception:
                    continue
                if replaced is value:
                    raise _Lossy
                return _canon(replaced, ignore, depth + 1, seen)
        return _quote(repr(value))
    finally:
        seen.discard(marker)


def canonicalize(value: Any, ignore_keys: Any = ()) -> str:
    """Canonical JSON of one value. Unreadable values become ``"[unserializable]"``."""
    try:
        return _canon(value, frozenset(ignore_keys), 0, set())
    except Exception:
        return '"[unserializable]"'


def canonical_call(node_id: str, input: Any, ignore_keys: Any = ()) -> str:
    """The canonical string a fingerprint hashes: ``[nodeId, input]``."""
    return f"[{_quote(node_id)},{canonicalize(input, ignore_keys)}]"


def _digest(canonical: str) -> str:
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()[
        :_FINGERPRINT_HEX_CHARS
    ]


def fingerprint_call(node_id: str, input: Any, ignore_keys: Any = ()) -> str:
    """SHA-256 (first 32 hex chars) of :func:`canonical_call`."""
    return _digest(canonical_call(node_id, input, ignore_keys))


def comparable_fingerprint(node_id: str, input: Any, ignore_keys: frozenset[str]) -> str | None:
    """The fingerprint the guard compares, or ``None`` when the input could
    not be read faithfully (it must neither extend nor start a streak)."""
    try:
        return _digest(f"[{_quote(node_id)},{_canon(input, ignore_keys, 0, set())}]")
    except Exception:
        return None


# -- the guard ---------------------------------------------------------------


class LoopInfo:
    """What ``exec.paused.loop`` carries when ``reason`` is ``loop``."""

    __slots__ = ("fingerprint", "first_seq", "last_seq", "repeats")

    def __init__(self, repeats: int, first_seq: int, last_seq: int, fingerprint: str) -> None:
        self.repeats = repeats
        self.first_seq = first_seq
        self.last_seq = last_seq
        self.fingerprint = fingerprint

    def to_wire(self) -> dict[str, Any]:
        return {
            "repeats": self.repeats,
            "firstSeq": self.first_seq,
            "lastSeq": self.last_seq,
            "fingerprint": self.fingerprint,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"LoopInfo({self.to_wire()})"


class _Streak:
    """Rule 1: the one streak a run keeps per watched kind."""

    __slots__ = ("fingerprint", "first_seq", "last_seq", "node_id", "repeats", "tripped", "warned")

    def __init__(self, node_id: str, fingerprint: str, seq: int) -> None:
        self.node_id = node_id
        self.fingerprint = fingerprint
        self.repeats = 1
        self.first_seq = seq
        self.last_seq = seq
        #: This count already held (or was consulted past the threshold).
        self.tripped = False
        #: This streak already produced its one warning.
        self.warned = False


class LoopRecord:
    """Result of recording one ``node.started``."""

    __slots__ = ("at_threshold", "fingerprint", "first_seq", "last_seq", "repeats")

    def __init__(
        self, repeats: int, first_seq: int, last_seq: int, fingerprint: str, at_threshold: bool
    ) -> None:
        self.repeats = repeats
        self.first_seq = first_seq
        self.last_seq = last_seq
        self.fingerprint = fingerprint
        self.at_threshold = at_threshold


#: Sentinel for an input (or a fingerprint) that could not be read: pass it to
#: :meth:`LoopGuard.fingerprint` when reading the start's input raised, and
#: :meth:`LoopGuard.record` treats it as rule 3 (clear the kind's streak).
UNREADABLE = object()


def _plain(value: Any) -> Any:
    """A ``str`` subclass as the plain string it serialises as (its ``__eq__`` /
    ``__hash__`` cannot lie to the bookkeeping); anything else unchanged."""
    return str.__str__(value) if isinstance(value, str) else value


class LoopGuard:
    def __init__(self, config: ResolvedLoopGuard) -> None:
        self.config = config
        self._lock = threading.Lock()
        # run -> kind -> streak; dicts keep insertion order (LRU by re-insertion)
        self._runs: dict[str, dict[str, _Streak]] = {}

    @property
    def enabled(self) -> bool:
        return self.config.mode != "off" and self.config.threshold > 0

    @property
    def mode(self) -> str:
        return self.config.mode

    @property
    def threshold(self) -> int:
        return self.config.threshold

    @property
    def tracked_runs(self) -> int:
        return len(self._runs)

    @property
    def tracked_streaks(self) -> int:
        """Streaks currently kept, across runs (at most runs x watched kinds)."""
        with self._lock:
            return sum(len(streaks) for streaks in self._runs.values())

    def applies_to(self, kind: Any, node_id: Any, name: Any) -> bool:
        """Is a start of this node WATCHED? Decided by kind and the allow list
        only: a watched start whose nodeId is not a string is still watched
        (and clears its kind's streak, rule 3)."""
        kind, node_id, name = _plain(kind), _plain(node_id), _plain(name)
        if not self.enabled or not isinstance(kind, str) or kind not in self.config.kinds:
            return False
        allow = self.config.allow_nodes
        if not allow:
            return True
        return not (
            (isinstance(node_id, str) and node_id in allow)
            or (isinstance(name, str) and name in allow)
        )

    def fingerprint(self, node_id: Any, input: Any) -> Any:
        """The comparable fingerprint, or :data:`UNREADABLE` (input unreadable,
        passed as :data:`UNREADABLE`, or a nodeId that is not a string). Pure:
        call it outside any lock (it walks the whole input)."""
        if input is UNREADABLE or not isinstance(node_id, str):
            return UNREADABLE
        fingerprint = comparable_fingerprint(node_id, input, self.config.ignore_keys)
        return UNREADABLE if fingerprint is None else fingerprint

    def record(
        self, run_id: str, kind: Any, node_id: Any, name: Any, fingerprint: Any, seq: int
    ) -> LoopRecord | None:
        """``node.started`` (rules 2-4) with a fingerprint from
        :meth:`fingerprint`; ``seq`` is the envelope seq of that start. Returns
        None when the node is not watched, or when its fingerprint is
        :data:`UNREADABLE` — the latter clears the kind's streak."""
        if not self.applies_to(kind, node_id, name):
            return None  # rule 4: touches no streak
        kind, node_id = _plain(kind), _plain(node_id)
        with self._lock:
            if not isinstance(fingerprint, str) or not isinstance(node_id, str):
                # Rule 3: the call DID happen, with arguments nobody can compare,
                # so the previous call is no longer "the call right before" the next.
                streaks = self._runs.get(run_id)
                if streaks is not None:
                    streaks.pop(kind, None)
                return None
            streaks = self._streaks_for(run_id)
            streak = streaks.get(kind)
            if (
                streak is not None
                and streak.node_id == node_id
                and streak.fingerprint == fingerprint
            ):
                streak.repeats += 1
                streak.last_seq = seq
                streak.tripped = False
            else:
                # Plain copies: never keep a reference to a host object.
                streak = _Streak(node_id, _plain(fingerprint), seq)
                streaks[kind] = streak
            return LoopRecord(
                streak.repeats,
                streak.first_seq,
                streak.last_seq,
                fingerprint,
                streak.repeats >= self.config.threshold,
            )

    def consult(self, run_id: str, kind: Any, node_id: Any, name: Any) -> LoopInfo | None:
        """``before`` gate (rule 5): is this node's latest start the Nth identical
        back-to-back call? Trips at most once per count."""
        if not self.applies_to(kind, node_id, name):
            return None
        kind, node_id = _plain(kind), _plain(node_id)
        with self._lock:
            streaks = self._runs.get(run_id)
            streak = streaks.get(kind) if streaks is not None else None
            if (
                streak is None
                or streak.node_id != node_id
                or streak.tripped
                or streak.repeats < self.config.threshold
            ):
                return None
            streak.tripped = True
            return LoopInfo(streak.repeats, streak.first_seq, streak.last_seq, streak.fingerprint)

    def claim_warning(self, run_id: str, node_id: Any, kind: Any = None) -> bool:
        """The single warning for the current streak of this node (of ``kind``,
        or of whichever watched kind's streak belongs to ``node_id``): True the
        first time only; False when no streak is this node's."""
        kind, node_id = _plain(kind), _plain(node_id)
        with self._lock:
            streaks = self._runs.get(run_id)
            if streaks is None:
                return False
            candidates: list[_Streak | None]
            if kind is None:
                candidates = list(streaks.values())
            else:
                candidates = [streaks.get(kind)] if isinstance(kind, str) else []
            for streak in candidates:
                if streak is None or streak.node_id != node_id:
                    continue
                if streak.warned:
                    return False
                streak.warned = True
                return True
            return False

    def forget(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)

    def _streaks_for(self, run_id: str) -> dict[str, _Streak]:
        # Least recently used, not oldest created: a long run still calling
        # tools must not lose its streak to MAX_LOOP_RUNS short runs.
        streaks = self._runs.pop(run_id, None)
        if streaks is None:
            if len(self._runs) >= MAX_LOOP_RUNS:
                del self._runs[next(iter(self._runs))]
            streaks = {}
        self._runs[run_id] = streaks  # re-insert: least recently used is first
        return streaks
