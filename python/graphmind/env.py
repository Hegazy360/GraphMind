"""Kill switches and environment-derived defaults.

Precedence for "is GraphMind enabled" (mirrors ``packages/client/src/env.ts``,
with a Python-flavoured production check because there is no ``NODE_ENV``):

1. ``GRAPHMIND_DISABLED=1``  -> disabled, always. Ops-level kill switch; beats
   an explicit ``enabled=True`` passed in code.
2. explicit ``enabled=`` argument -> as given.
3. **looks like production** -> disabled unless ``GRAPHMIND=1``.
4. otherwise -> enabled.

"Looks like production" is deliberately a *documented, boring* rule: the first
variable that is set out of ``GRAPHMIND_ENV``, ``ENVIRONMENT``, ``APP_ENV``,
``PYTHON_ENV``, ``ENV``, ``DJANGO_ENV``, ``FLASK_ENV``, ``NODE_ENV`` decides,
and it counts as production when its value is ``production``/``prod``
(case-insensitive). No heuristics over hostnames, cloud metadata or TTYs — a
debugger that silently turns itself off for surprising reasons is worse than
one you must switch on.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

EnvLike = Mapping[str, str]

DEFAULT_URL = "ws://127.0.0.1:4747/ingest"

#: Checked in order; the first one that is *set* decides the environment.
ENV_VARS = (
    "GRAPHMIND_ENV",
    "ENVIRONMENT",
    "APP_ENV",
    "PYTHON_ENV",
    "ENV",
    "DJANGO_ENV",
    "FLASK_ENV",
    "NODE_ENV",
)

_PRODUCTION_VALUES = frozenset({"production", "prod"})


def _env(env: EnvLike | None) -> EnvLike:
    return os.environ if env is None else env


def looks_like_production(env: EnvLike | None = None) -> bool:
    """True when the first set environment variable in :data:`ENV_VARS` is production."""
    source = _env(env)
    for key in ENV_VARS:
        value = source.get(key)
        if value is None or value == "":
            continue
        return value.strip().lower() in _PRODUCTION_VALUES
    return False


def resolve_enabled(explicit: bool | None = None, env: EnvLike | None = None) -> bool:
    """Apply the kill-switch precedence documented in this module."""
    source = _env(env)
    if source.get("GRAPHMIND_DISABLED") == "1":
        return False
    if explicit is not None:
        return explicit
    return not (looks_like_production(source) and source.get("GRAPHMIND") != "1")


def resolve_url(explicit: str | None = None, env: EnvLike | None = None) -> str:
    """Viewer endpoint: explicit argument, then ``GRAPHMIND_URL``, then the default."""
    if explicit is not None:
        return explicit
    return _env(env).get("GRAPHMIND_URL") or DEFAULT_URL
