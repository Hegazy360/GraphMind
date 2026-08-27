"""Framework integrations.

Every integration imports its third-party package **lazily** (or not at all —
the OpenAI and Anthropic patches are pure duck-typing), so ``import graphmind``
never pulls in a framework you do not use and never fails because one is
missing.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "AsyncGraphMindCallbackHandler",
    "GraphMindCallbackHandler",
    "instrument_anthropic",
    "instrument_openai",
    "wrap_anthropic",
    "wrap_openai",
]


def __getattr__(name: str) -> Any:
    if name in ("instrument_openai", "wrap_openai"):
        from .openai import instrument_openai

        return instrument_openai
    if name in ("instrument_anthropic", "wrap_anthropic"):
        from .anthropic import instrument_anthropic

        return instrument_anthropic
    if name in ("GraphMindCallbackHandler", "AsyncGraphMindCallbackHandler"):
        from . import langchain

        return getattr(langchain, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
