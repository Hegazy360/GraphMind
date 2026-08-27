"""Everything this client puts on the wire must validate against the published
contract, ``packages/schema/schema.json`` — the same artifact the CLI, the
viewer and the TypeScript client are built from.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from graphmind.protocol import (
    EVENT_TYPES,
    PROTOCOL_VERSION,
    create_envelope,
    parse_envelope_json,
    serialize_envelope,
)

from .conftest import wait_until


def test_every_frame_from_a_full_run_validates(
    attached: Any, validate_frame: Callable[[dict[str, Any]], None]
) -> None:
    instance, viewer = attached(breakpoints=[{"kind": "tool", "name": "flaky"}])

    @instance.tool
    def flaky(x: int) -> int:
        raise ValueError("boom")

    @instance.tool
    def good(x: int) -> int:
        return x * 2

    def resume_everything() -> None:
        paused = viewer.wait_for(lambda f: f.get("type") == "exec.paused")
        viewer.resume(paused["payload"]["pauseId"], "continue")

    import threading

    threading.Thread(target=resume_everything, daemon=True).start()

    with instance.run("schema-run"):
        assert good(21) == 42
        with pytest.raises(ValueError):
            flaky(1)
        instance.session.push_token("llm:step", "text", "hello")
        instance.graph_hint([{"nodeId": "llm:step", "kind": "llm", "name": "step"}])
        with instance.span("planning", kind="chain") as span:
            span.set_output({"plan": ["a", "b"]})
    instance.session.flush()

    wait_until(lambda: len(viewer.of_type("run.finished")) >= 1, label="run.finished", timeout=8.0)

    frames = viewer.frames()
    assert len(frames) >= 10
    seen = set()
    for frame in frames:
        validate_frame(frame)
        seen.add(frame["type"])

    # The interesting ones actually happened.
    assert {
        "hello",
        "run.started",
        "run.finished",
        "node.started",
        "node.finished",
        "node.error",
        "node.token",
        "graph.hint",
        "exec.paused",
        "exec.resumed",
    } <= seen


@pytest.mark.parametrize(
    ("type_", "payload"),
    [
        ("run.started", {"app": "a", "sdk": {"name": "python", "version": "0.1.0"}}),
        ("run.finished", {"status": "ok"}),
        ("graph.hint", {"nodes": [{"nodeId": "n", "kind": "tool", "name": "n"}]}),
        (
            "node.started",
            {"nodeId": "tool:x", "kind": "tool", "name": "x", "instanceId": "i", "input": {}},
        ),
        ("node.token", {"nodeId": "llm:step", "deltas": [{"t": "text", "v": "hi"}]}),
        (
            "node.finished",
            {
                "nodeId": "tool:x",
                "instanceId": "i",
                "durationMs": 1.5,
                "status": "ok",
                "output": 1,
                "usage": {"inputTokens": 1, "outputTokens": 2},
            },
        ),
        (
            "node.error",
            {"nodeId": "tool:x", "instanceId": "i", "error": {"name": "E", "message": "m"}},
        ),
        ("exec.paused", {"pauseId": "p", "nodeId": "tool:x", "point": "before"}),
        ("exec.resumed", {"pauseId": "p", "action": "inject"}),
    ],
)
def test_each_event_type_validates(
    type_: str, payload: dict[str, Any], validate_frame: Callable[[dict[str, Any]], None]
) -> None:
    validate_frame(create_envelope(type_, payload, 0, "run_1"))


def test_all_event_types_are_covered_by_the_parametrized_cases() -> None:
    covered = {
        "run.started",
        "run.finished",
        "graph.hint",
        "node.started",
        "node.token",
        "node.finished",
        "node.error",
        "exec.paused",
        "exec.resumed",
    }
    assert covered == set(EVENT_TYPES)


def test_serialization_never_raises_on_hostile_values() -> None:
    class Exploding:
        def __repr__(self) -> str:
            raise RuntimeError("no repr for you")

    cyclic: dict[str, Any] = {}
    cyclic["self"] = cyclic

    frame = serialize_envelope(create_envelope("node.finished", {"output": Exploding()}, 0, "r"))
    assert "graphmind" in frame or "unserializable" in frame or "output" in frame

    frame2 = serialize_envelope(create_envelope("node.finished", {"output": cyclic}, 1, "r"))
    assert "_graphmindSerializationError" in frame2


def test_parse_rejects_foreign_protocol_versions() -> None:
    result = parse_envelope_json(
        '{"gm": 99, "seq": 0, "ts": 0, "runId": "r", "type": "hello", "payload": {}}'
    )
    assert result.kind == "version-mismatch"
    assert result.received == 99


def test_parse_tolerates_unknown_types_for_forward_compatibility() -> None:
    result = parse_envelope_json(
        f'{{"gm": {PROTOCOL_VERSION}, "seq": 0, "ts": 0, "runId": "r",'
        ' "type": "future.thing", "payload": {}}'
    )
    assert result.kind == "unknown-type"


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        '{"seq": 0}',
        '{"gm": 1, "seq": -1, "ts": 0, "runId": "r", "type": "hello", "payload": {}}',
        '{"gm": 1, "seq": 0, "ts": 0, "runId": 5, "type": "hello", "payload": {}}',
        '{"gm": 1, "seq": 0, "ts": 0, "runId": "r", "type": "hello", "payload": 3}',
    ],
)
def test_parse_rejects_malformed_frames(text: str) -> None:
    assert parse_envelope_json(text).kind == "invalid"
