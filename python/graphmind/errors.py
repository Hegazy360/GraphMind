"""Abort plumbing and error serialization.

Mirrors ``packages/client/src/errors.ts``. The debugger's ``abort`` action
must surface as an error the host's SDK treats as *terminal* — never as a
transient failure that provider retry logic will re-issue. In Python there is
no ``AbortController``; the run context carries a flag plus an event, and
instrumentation raises :class:`GraphMindAbortError`.
"""

from __future__ import annotations

import traceback
from typing import Any

# Names that mean "this was cancelled on purpose, do not retry". The TS client
# recognises the same two, plus Python's own cancellation exceptions.
_ABORT_NAMES = frozenset({"AbortError", "GraphMindAbortError", "CancelledError"})


class GraphMindAbortError(Exception):
    """Raised into the host when the debugger resolves a gate with ``abort``.

    ``.name`` is ``"AbortError"`` so wire payloads match what the TypeScript
    client emits for the same situation.
    """

    name = "AbortError"

    def __init__(self, message: str = "Run aborted by GraphMind debugger") -> None:
        super().__init__(message)


def is_abort_error(error: BaseException | None) -> bool:
    """True for GraphMind aborts and for stdlib cancellation exceptions."""
    if error is None:
        return False
    if isinstance(error, GraphMindAbortError):
        return True
    # asyncio.CancelledError inherits BaseException on 3.8+, so name-match too.
    return type(error).__name__ in _ABORT_NAMES


def _short_stack(error: BaseException, limit: int = 4096) -> str | None:
    try:
        text = "".join(
            traceback.format_exception(type(error), error, error.__traceback__)
        )
    except Exception:  # pragma: no cover - formatting a broken traceback
        return None
    if not text:
        return None
    return text[:limit]


def to_error_info(error: Any) -> dict[str, Any]:
    """Serialize any raised object into the wire ``ErrorInfo`` shape."""
    if isinstance(error, BaseException):
        # A custom `.name` (GraphMindAbortError) wins over the class name so
        # the viewer shows "AbortError" like the TypeScript client does.
        name = getattr(error, "name", None)
        if not isinstance(name, str) or not name:
            name = type(error).__name__
        info: dict[str, Any] = {"name": name, "message": str(error)}
        stack = _short_stack(error)
        if stack is not None:
            info["stack"] = stack
        return info
    return {"name": "Error", "message": str(error)}
