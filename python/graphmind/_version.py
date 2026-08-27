"""The package version, read from installed metadata.

Derived rather than hardcoded: a constant here and the version in
pyproject.toml drift the moment one is bumped without the other, and the
version travels on the wire (`run.started.sdk`), so a stale one quietly
mislabels every recorded run.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _installed_version

try:
    __version__ = _installed_version("graphmind-ai")
except PackageNotFoundError:  # not installed (e.g. running straight from a checkout)
    __version__ = "0.0.0+dev"
