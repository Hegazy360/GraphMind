"""Frames are valid JSON: NaN / Infinity are written as null (like
``JSON.stringify``) and lone surrogates as ``\\udXXX`` escapes.

Before: ``serialize_envelope`` wrote the bare literals ``NaN`` / ``Infinity``,
which no strict JSON parser accepts, so the debugger dropped the whole event
(a node stuck "running"); and a lone surrogate was written raw, so the frame
could not be encoded as UTF-8 at all — the WebSocket send raised and the
connection dropped. Both are checked against a STRICT parse on the receiving
side (the fake viewer's ``json.loads`` swapped for one that rejects the
literals, as JavaScript's ``JSON.parse`` does).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any

import pytest

from graphmind.protocol import create_envelope, serialize_envelope

from .conftest import wait_until
from .helpers import fake_viewer


def strict_loads(text: Any) -> Any:
    def reject(name: str) -> Any:
        raise ValueError(f"not JSON: bare {name}")

    return json.loads(text, parse_constant=reject)


class StrictJson:
    loads = staticmethod(strict_loads)
    dumps = staticmethod(json.dumps)


@pytest.fixture
def strict_viewer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fake_viewer, "json", StrictJson)


NON_FINITE = [float("nan"), float("inf"), float("-inf")]


class Model:
    """A host object serialised through ``default=`` that carries a NaN."""

    def model_dump(self) -> dict[str, Any]:
        return {"loss": float("nan"), "ok": 1.5}


@pytest.mark.parametrize("value", NON_FINITE, ids=["nan", "inf", "-inf"])
def test_non_finite_floats_become_null_at_any_depth(value: float) -> None:
    payload = {
        "nodeId": "n",
        "instanceId": "i",
        "durationMs": 1.0,
        "status": "ok",
        "output": {"a": [1, value, {"deep": [[value]]}], value: "key", "s": "NaN Infinity"},
        "heldMs": value,
        "model": Model(),
    }
    frame = serialize_envelope(create_envelope("node.finished", payload, 3, "run_1", ts=5))
    parsed = strict_loads(frame)
    out = parsed["payload"]
    assert out["output"]["a"] == [1, None, {"deep": [[None]]}]
    assert out["output"]["s"] == "NaN Infinity"  # strings untouched
    assert out["heldMs"] is None
    assert out["model"] == {"loss": None, "ok": 1.5}
    # Everything else is exactly what json.dumps writes.
    assert frame.startswith(
        '{"gm": 1, "seq": 3, "ts": 5, "runId": "run_1", "type": "node.finished"'
    )


def test_a_frame_without_non_finite_values_is_unchanged() -> None:
    envelope = create_envelope("node.finished", {"x": [1.5, 1e-7, "é", 10**30]}, 0, "r", ts=1)
    assert serialize_envelope(envelope) == json.dumps(envelope, ensure_ascii=False)


def test_lone_surrogates_are_escaped_and_pairs_are_joined() -> None:
    envelope = create_envelope(
        "node.started",
        {"input": "a\ud800b", "pair": "\ud83d" + "\ude00", "\udfff": 1},
        0,
        "r",
        ts=1,
    )
    frame = serialize_envelope(envelope)
    frame.encode("utf-8")  # would raise before the fix
    assert '"a\\ud800b"' in frame and '"\U0001f600"' in frame and '"\\udfff": 1' in frame
    assert strict_loads(frame)["payload"]["input"] == "a\ud800b"


def test_a_cyclic_field_degrades_only_that_field() -> None:
    cyclic: dict[str, Any] = {}
    cyclic["self"] = cyclic
    payload = {
        "nodeId": "n",
        "durationMs": math.pi,
        "status": "ok",
        "output": cyclic,
        "n": float("nan"),
    }
    frame = strict_loads(serialize_envelope(create_envelope("node.finished", payload, 0, "r")))
    out = frame["payload"]
    assert out["nodeId"] == "n" and out["status"] == "ok" and out["n"] is None
    assert out["output"] == {
        "__graphmindTruncated": True,
        "bytes": 0,
        "preview": "[unserializable value]",
    }
    assert out["fields"] == ["output"] and out["_graphmindSerializationError"] is True


def test_nan_input_reaches_a_strict_viewer_and_the_node_finishes(
    strict_viewer: None, attached: Any, validate_frame: Callable[[dict[str, Any]], None]
) -> None:
    instance, view = attached()
    session = instance.session
    with instance.run("nan"):
        session.start_node(
            "tool:score", "tool", "score", "s1", input={"x": float("nan"), "y": [float("inf")]}
        )
        session.finish_node("tool:score", "s1", 1.0, output=float("nan"), usage=None)
        session.start_node("tool:after", "tool", "after", "a1", input="\ud800")
        session.finish_node("tool:after", "a1", 1.0)
    wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
    started = [f for f in view.of_type("node.started") if f["payload"]["nodeId"] == "tool:score"]
    assert len(started) == 1
    assert started[0]["payload"]["input"] == {"x": None, "y": [None]}
    finished = [f for f in view.of_type("node.finished") if f["payload"]["nodeId"] != "agent:nan"]
    assert [f["payload"]["nodeId"] for f in finished] == ["tool:score", "tool:after"]
    for frame in view.frames():
        validate_frame(frame)
    assert view.connection_count == 1
