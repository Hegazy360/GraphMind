"""Duration clock.

Every GraphMind duration (``durationMs``, ``heldMs``) is measured on
:func:`time.perf_counter` — monotonic and sub-microsecond on every supported
platform — never on wall time. ``time.time()`` steps under NTP adjustment and
is millisecond-ish at best; ``time.monotonic()`` is only guaranteed
millisecond resolution on some platforms (historically Windows). Wall-clock
fields on the wire (envelope ``ts``) stay integer epoch milliseconds; only
elapsed-time measurement lives here.

Port of ``packages/client/src/clock.ts``. The wire contract for a duration:

* rounded to 0.01 ms (two decimals),
* clamped to ``>= 0``,
* never NaN / infinite (those become ``0``).

The clock is read through :func:`monotonic_ms` at call time so tests can
substitute it with :func:`set_clock`.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable

Clock = Callable[[], float]

_override: Clock | None = None


def _perf_ms() -> float:
    return time.perf_counter() * 1000.0


def monotonic_ms() -> float:
    """Milliseconds on the monotonic clock. Fractional; only differences mean anything."""
    if _override is not None:
        return _override()
    return _perf_ms()


def set_clock(clock: Clock | None) -> Clock | None:
    """Install a clock for tests (``None`` restores ``perf_counter``). Returns the previous one."""
    global _override
    previous = _override
    _override = clock
    return previous


def normalize_duration_ms(raw: object) -> float:
    """Coerce a raw millisecond measurement into the wire contract."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.0
    value = float(raw)
    if math.isnan(value) or math.isinf(value) or value <= 0.0:
        return 0.0
    return round(value, 2)


def elapsed_ms(started_at: float, now: float | None = None) -> float:
    """Elapsed since a :func:`monotonic_ms` reading, normalised for the wire."""
    current = monotonic_ms() if now is None else now
    return normalize_duration_ms(current - started_at)
