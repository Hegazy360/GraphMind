"""Shared fixtures: a real fake-viewer server, GraphMind factories, and the
JSON-Schema validator built from ``packages/schema/schema.json``.

No network, no API keys: every provider call in this suite goes through an
``httpx.MockTransport``, and the only socket in play is a loopback WebSocket to
the fake viewer.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import graphmind as gm
from graphmind.api import GraphMind

from .helpers.fake_viewer import FakeViewer

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "packages" / "schema" / "schema.json"


@pytest.fixture(scope="session")
def wire_schema() -> dict[str, Any]:
    if not SCHEMA_PATH.exists():  # pragma: no cover - only in a partial checkout
        pytest.skip(f"wire schema artifact not found at {SCHEMA_PATH}")
    return json.loads(SCHEMA_PATH.read_text())


@pytest.fixture(scope="session")
def validate_frame(wire_schema: dict[str, Any]) -> Callable[[dict[str, Any]], None]:
    """Validate one envelope against the published wire contract."""
    from jsonschema import Draft202012Validator

    validator = Draft202012Validator(wire_schema)

    def check(frame: dict[str, Any]) -> None:
        errors = sorted(validator.iter_errors(frame), key=lambda e: e.path)
        if errors:
            detail = "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:5])
            raise AssertionError(f"frame {frame.get('type')!r} violates schema.json — {detail}")

    return check


@pytest.fixture
def viewer() -> Any:
    created: list[FakeViewer] = []

    def factory(**kwargs: Any) -> FakeViewer:
        instance = FakeViewer(**kwargs)
        created.append(instance)
        return instance

    yield factory
    for instance in created:
        instance.close()


@pytest.fixture
def make_gm() -> Any:
    """Factory for isolated GraphMind instances (never the module-level default)."""
    created: list[GraphMind] = []

    def factory(url: str | None = None, **options: Any) -> GraphMind:
        options.setdefault("enabled", True)
        options.setdefault("retry_interval", 60.0)
        options.setdefault("env", {})
        options.setdefault("logger", lambda message: None)
        instance = GraphMind(url=url, **options)
        created.append(instance)
        return instance

    yield factory
    for instance in created:
        instance.dispose()


@pytest.fixture
def attached(make_gm: Any, viewer: Any) -> Any:
    """A GraphMind instance already attached to a fresh fake viewer."""

    def factory(**viewer_options: Any) -> Any:
        gm_options = viewer_options.pop("gm_options", {})
        view = viewer(**viewer_options)
        instance = make_gm(url=view.url, **gm_options)
        assert instance.ready(timeout=5.0) is True, "handshake did not complete"
        return instance, view

    return factory


@pytest.fixture(autouse=True)
def _reset_default_instance() -> Any:
    yield
    gm.reset()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: Any) -> None:
    for key in ("GRAPHMIND", "GRAPHMIND_DISABLED", "GRAPHMIND_URL"):
        monkeypatch.delenv(key, raising=False)
    os.environ.setdefault("PYTHONUNBUFFERED", "1")


def wait_until(
    predicate: Callable[[], bool], timeout: float = 5.0, label: str = "condition"
) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {label}")
        time.sleep(0.005)
