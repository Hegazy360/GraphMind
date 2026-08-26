""""Never raise into the host app" plumbing.

Every internal failure degrades to a no-op plus a rate-limited warning: at most
one message per key per interval, so a permanently broken transport cannot spam
the host's logs. Mirrors ``packages/client/src/safe.ts``.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional

WarnSink = Callable[[str], None]


def _default_sink(message: str) -> None:
    # `logging` would require the host to configure handlers to see anything;
    # a debugger that cannot tell you it is broken is worse than a noisy one.
    import sys

    try:
        print(message, file=sys.stderr)
    except Exception:  # pragma: no cover - a closed stderr must not propagate
        pass


class RateLimitedWarner:
    """At most one warning per ``key`` per ``interval`` seconds."""

    __slots__ = ("_interval", "_last_at", "_lock", "_sink")

    def __init__(self, interval: float = 60.0, sink: Optional[WarnSink] = None) -> None:
        self._interval = interval
        self._sink: WarnSink = sink if sink is not None else _default_sink
        self._last_at: Dict[str, float] = {}
        self._lock = threading.Lock()

    def warn(self, key: str, message: str, cause: Any = None) -> None:
        try:
            now = time.monotonic()
            with self._lock:
                previous = self._last_at.get(key)
                if previous is not None and now - previous < self._interval:
                    return
                self._last_at[key] = now
            if isinstance(cause, BaseException):
                suffix = f" ({type(cause).__name__}: {cause})"
            elif cause is not None:
                suffix = f" ({cause})"
            else:
                suffix = ""
            self._sink(f"[graphmind] {message}{suffix}")
        except Exception:
            # Even a throwing sink must not propagate into the host.
            pass


class OnceWarner:
    """One warning per key for the lifetime of the process."""

    __slots__ = ("_seen", "_lock", "_sink")

    def __init__(self, sink: Optional[WarnSink] = None) -> None:
        self._sink: WarnSink = sink if sink is not None else _default_sink
        self._seen: set[str] = set()
        self._lock = threading.Lock()

    def warn(self, key: str, message: str, cause: Any = None) -> None:
        try:
            with self._lock:
                if key in self._seen:
                    return
                self._seen.add(key)
            suffix = f" ({type(cause).__name__}: {cause})" if isinstance(cause, BaseException) else ""
            self._sink(f"[graphmind] {message}{suffix}")
        except Exception:
            pass
