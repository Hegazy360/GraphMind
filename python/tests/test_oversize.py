"""An oversized event is shrunk at emit, never dropped (SHRINK-V2, Python port).

Parity with the TypeScript client's ``serializeWithinBudget``: after redaction
and held time, before the ring buffer, the payload PARSED BACK from the frame is
held to ``MAX_PAYLOAD_BYTES`` with ``graphmind.shrink.serialize_payload`` (the
event type passed), so what is buffered and sent is exactly what the debugger
stores. The fake viewer, like the real server, refuses frames over its socket
limit (websockets' default 1 MiB here): an unshrunk 17 MB event closes the
connection and vanishes, which is the bug this guards.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from typing import Any

import pytest

from graphmind.protocol import create_envelope, serialize_envelope
from graphmind.shrink import (
    MAX_PAYLOAD_BYTES,
    TRUNCATION_SUFFIX,
    is_valid_event_payload,
    js_stringify,
    serialize_payload,
    utf8_length,
)

from .conftest import wait_until

SECRET = "sk-live-do-not-print-me"
BUDGET_WARNING = "was shrunk to a preview (the debugger stores at most 512 KB per payload)"


def payload_bytes(frame: dict[str, Any]) -> int:
    text = js_stringify(frame["payload"])
    assert text is not None
    return utf8_length(text)


def buffered(instance: Any) -> list[dict[str, Any]]:
    return [json.loads(frame) for frame in instance.session._buffer.to_list()]


def finished(view: Any, node_id: str) -> dict[str, Any]:
    frames = [f for f in view.of_type("node.finished") if f["payload"]["nodeId"] == node_id]
    assert len(frames) == 1, frames
    return frames[0]


class TestAttached:
    def test_a_17_mb_tool_output_arrives_shrunk_valid_and_the_connection_survives(
        self, attached: Any, validate_frame: Callable[[dict[str, Any]], None]
    ) -> None:
        logs: list[str] = []
        instance, view = attached(gm_options={"logger": logs.append})
        huge = SECRET + "x" * (17 * 1024 * 1024)
        session = instance.session
        with instance.run("big"):
            session.start_node("tool:scrape", "tool", "scrape", "s1", input={"url": "u"})
            session.finish_node("tool:scrape", "s1", 12.5, output=huge)
            session.start_node("tool:after", "tool", "after", "a1")
            session.finish_node("tool:after", "a1", 1.0, output="small")
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished", timeout=20)

        frame = finished(view, "tool:scrape")
        validate_frame(frame)
        payload = frame["payload"]
        assert payload["instanceId"] == "s1" and payload["status"] == "ok"
        assert payload["durationMs"] == 12.5
        assert payload["__graphmindTruncated"] is True and payload["fields"] == ["output"]
        assert payload["output"] == huge[:2000] + TRUNCATION_SUFFIX
        assert payload["bytes"] == len(huge) + len(
            '{"nodeId":"tool:scrape","instanceId":"s1","durationMs":12.5,"status":"ok","output":""}'
        ) + len(',"heldMs":0')
        assert payload_bytes(frame) <= MAX_PAYLOAD_BYTES
        # The events after it were not lost: one connection, contiguous seqs.
        assert finished(view, "tool:after")["payload"]["output"] == "small"
        assert view.connection_count == 1
        seqs = [f["seq"] for f in view.frames() if f["type"] != "hello"]
        assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))
        # One warning, with the TS wording, never quoting the content.
        budget = [m for m in logs if BUDGET_WARNING in m]
        assert len(budget) == 1, logs
        assert f"an event of {payload['bytes']} bytes" in budget[0]
        assert SECRET not in "\n".join(logs)

    def test_6000_keyed_records_keep_the_first_256_and_count_the_rest(
        self, attached: Any, validate_frame: Callable[[dict[str, Any]], None]
    ) -> None:
        instance, view = attached()
        records = {
            f"id{i}": {
                "name": f"record {i}",
                "score": i * 1e-7,
                "tags": ["a", "b"],
                "blob": "z" * 80,
            }
            for i in range(6000)
        }
        with instance.run("keyed"):
            instance.session.start_node("tool:list", "tool", "list", "l1")
            instance.session.finish_node("tool:list", "l1", 3, output=records)
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        frame = finished(view, "tool:list")
        validate_frame(frame)
        output = frame["payload"]["output"]
        kept = [key for key in output if key.startswith("id")]
        assert kept == [f"id{i}" for i in range(256)]
        assert output["keysDropped"] == 6000 - 256
        assert output["id1"] == {"name": "record 1", "score": 1e-7, "tags": [], "blob": "z" * 80}
        assert frame["payload"]["fields"] == ["output"]
        # Byte for byte what the one algorithm gives for the wire payload.
        wire = json.loads(
            serialize_envelope(
                create_envelope(
                    "node.finished",
                    {
                        "nodeId": "tool:list",
                        "instanceId": "l1",
                        "durationMs": 3,
                        "status": "ok",
                        "output": records,
                        "heldMs": 0,
                    },
                    0,
                    "r",
                )
            )
        )["payload"]
        expected_text, _, truncated = serialize_payload(wire, MAX_PAYLOAD_BYTES, "node.finished")
        assert truncated
        assert js_stringify(frame["payload"]) == expected_text

    def test_one_warning_per_event_type_and_an_invalid_event_is_called_dropped(
        self, attached: Any
    ) -> None:
        logs: list[str] = []
        instance, view = attached(gm_options={"logger": logs.append})
        session = instance.session
        with instance.run("warns"):
            for i in range(3):
                session.finish_node(f"tool:t{i}", "i", 1, output="y" * 600_000)
            session.error_node("tool:e", "i", RuntimeError("m" * 700_000))
            # Not a valid node.finished to begin with (no status): only this can
            # end as the whole-payload marker, and the warning says so.
            session.emit("node.finished", {"nodeId": "tool:bad", "output": "q" * 600_000})
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        budget = [m for m in logs if BUDGET_WARNING in m]
        assert len(budget) == 2, logs  # node.finished once, node.error once
        invalid = [m for m in logs if "could not be shrunk to a valid event" in m]
        assert len(invalid) == 1 and "the debugger will drop it" in invalid[0]
        assert "a node.finished event of" in invalid[0]
        errors = view.of_type("node.error")
        assert errors and errors[-1]["payload"]["error"]["name"] == "RuntimeError"
        assert is_valid_event_payload("node.error", errors[-1]["payload"])

    def test_under_budget_frames_are_exactly_what_serialize_envelope_writes(
        self, attached: Any
    ) -> None:
        instance, view = attached()
        with instance.run("small"):
            instance.session.start_node("tool:s", "tool", "s", "1", input={"q": 1.0, "e": 1e-7})
            instance.session.finish_node("tool:s", "1", 2, output="ok \ud800")
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        for raw in instance.session._buffer.to_list():
            frame = json.loads(raw)
            rebuilt = serialize_envelope(
                create_envelope(
                    frame["type"], frame["payload"], frame["seq"], frame["runId"], frame["ts"]
                )
            )
            assert raw == rebuilt


class TestBudgetBoundary:
    """The pre-checks must be exact: Python's text is not JavaScript's."""

    @staticmethod
    def emit_output(make_gm: Any, output: Any) -> dict[str, Any]:
        instance = make_gm()  # detached: frames stay in the replay buffer
        instance.session.emit(
            "node.finished", {"nodeId": "n", "durationMs": 0, "status": "ok", "output": output}
        )
        return buffered(instance)[-1]

    @staticmethod
    def fill(prefix_bytes: int, target: int) -> str:
        return "x" * (target - prefix_bytes)

    def test_exactly_at_the_budget_is_untouched_and_one_byte_over_is_shrunk(
        self, make_gm: Any
    ) -> None:
        overhead = payload_bytes(self.emit_output(make_gm, ""))
        at = self.emit_output(make_gm, "x" * (MAX_PAYLOAD_BYTES - overhead))
        assert "__graphmindTruncated" not in at["payload"]
        assert payload_bytes(at) == MAX_PAYLOAD_BYTES
        over = self.emit_output(make_gm, "x" * (MAX_PAYLOAD_BYTES - overhead + 1))
        assert over["payload"]["__graphmindTruncated"] is True
        assert payload_bytes(over) <= MAX_PAYLOAD_BYTES

    def test_floats_python_writes_shorter_than_javascript_are_measured_as_javascript(
        self, make_gm: Any
    ) -> None:
        # Python writes 1e-06 (5 chars), JavaScript 0.000001 (8): 130,000 of them
        # are ~0.86 MB in Python's frame but ~1.2 MB as the debugger measures.
        over = self.emit_output(make_gm, [1e-06] * 130_000)
        assert over["payload"]["__graphmindTruncated"] is True
        assert over["payload"]["output"] == []
        # And 1e+20 (5 chars) is 21 digits in JavaScript: 60,000 of them are only
        # ~420 KB of frame text but ~1.3 MB of payload.
        over = self.emit_output(make_gm, [1e20] * 60_000)
        assert over["payload"]["__graphmindTruncated"] is True
        assert payload_bytes(over) <= MAX_PAYLOAD_BYTES

    def test_lone_surrogates_count_as_their_six_byte_escape(self, make_gm: Any) -> None:
        # 100,000 lone surrogates: 300 KB as raw UTF-8, 600 KB as JSON escapes.
        over = self.emit_output(make_gm, "\udc00" * 100_000)
        assert over["payload"]["__graphmindTruncated"] is True
        assert payload_bytes(over) <= MAX_PAYLOAD_BYTES
        assert over["payload"]["output"].startswith("\udc00" * 2000)

    def test_astral_text_just_under_the_budget_is_not_shrunk(self, make_gm: Any) -> None:
        overhead = payload_bytes(self.emit_output(make_gm, ""))
        count = (MAX_PAYLOAD_BYTES - overhead) // 4
        under = self.emit_output(make_gm, "\U0001f600" * count)
        assert "__graphmindTruncated" not in under["payload"]
        assert payload_bytes(under) > MAX_PAYLOAD_BYTES - 4
        over = self.emit_output(make_gm, "\U0001f600" * (count + 1))
        assert over["payload"]["__graphmindTruncated"] is True


class TestDetachedAndBuffer:
    def test_a_shrunk_event_is_buffered_shrunk_and_replayed_on_attach(
        self, make_gm: Any, viewer: Any, validate_frame: Callable[[dict[str, Any]], None]
    ) -> None:
        view = viewer()
        instance = make_gm(url=view.url, connect_timeout=0.3)
        session = instance.session
        # Emitted before any debugger is reachable: only the buffer holds it.
        instance.session._transport  # noqa: B018 - the transport exists, not yet attached
        with instance.run("detached"):
            session.start_node("tool:big", "tool", "big", "b1")
            session.finish_node("tool:big", "b1", 1, output="w" * 3_000_000)
            frames = buffered(instance)
            big = [
                f
                for f in frames
                if f["type"] == "node.finished" and f["payload"]["nodeId"] == "tool:big"
            ]
            assert big and big[0]["payload"]["__graphmindTruncated"] is True
            assert all(len(raw) < 600_000 for raw in session._buffer.to_list())
            assert instance.ready(timeout=5.0) is True
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        replayed = finished(view, "tool:big")
        validate_frame(replayed)
        assert replayed["payload"]["output"] == "w" * 2000 + TRUNCATION_SUFFIX
        assert view.connection_count == 1

    def test_the_ring_buffer_has_no_byte_ceiling_to_evict_for_a_big_item(
        self, make_gm: Any
    ) -> None:
        instance = make_gm(buffer_size=10)
        session = instance.session
        for i in range(5):
            session.emit("node.finished", {"nodeId": f"n{i}", "durationMs": 0, "status": "ok"})
        session.emit(
            "node.finished",
            {"nodeId": "big", "durationMs": 0, "status": "ok", "output": "b" * 5_000_000},
        )
        frames = [f for f in buffered(instance) if f["type"] == "node.finished"]
        assert [f["payload"]["nodeId"] for f in frames] == ["n0", "n1", "n2", "n3", "n4", "big"]
        assert instance.stats().dropped == 0


class TestSerializationFailuresAndOrdering:
    def test_a_cyclic_output_keeps_the_event_valid_and_warns_once(
        self, attached: Any, validate_frame: Callable[[dict[str, Any]], None]
    ) -> None:
        logs: list[str] = []
        instance, view = attached(gm_options={"logger": logs.append})
        cyclic: dict[str, Any] = {"secret": SECRET}
        cyclic["self"] = cyclic
        with instance.run("cycle"):
            instance.session.finish_node("tool:c", "c1", 1, output=cyclic)
            instance.session.finish_node("tool:d", "d1", 1, output=[cyclic])
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        frame = finished(view, "tool:c")
        validate_frame(frame)
        assert frame["payload"]["output"] == {
            "__graphmindTruncated": True,
            "bytes": 0,
            "preview": "[unserializable value]",
        }
        assert frame["payload"]["instanceId"] == "c1" and frame["payload"]["fields"] == ["output"]
        assert finished(view, "tool:d")["payload"]["output"] == []  # an array stays an array
        warned = [m for m in logs if "could not be serialized to JSON" in m]
        assert len(warned) == 1 and "replaced by a marker" in warned[0]
        assert SECRET not in "\n".join(logs)

    def test_concurrent_big_and_small_events_are_buffered_in_seq_order(self, make_gm: Any) -> None:
        instance = make_gm(buffer_size=5000)
        session = instance.session
        barrier = threading.Barrier(4)

        def worker(index: int) -> None:
            barrier.wait()
            for j in range(15):
                output = "o" * (2_000_000 if j % 5 == 0 else 10)
                session.emit(
                    "node.finished",
                    {"nodeId": f"t{index}:{j}", "durationMs": 0, "status": "ok", "output": output},
                )

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        frames = buffered(instance)
        assert [f["seq"] for f in frames] == list(range(len(frames)))
        assert len([f for f in frames if f["type"] == "node.finished"]) == 60
        assert all(payload_bytes(f) <= MAX_PAYLOAD_BYTES for f in frames)
        timestamps = [f["ts"] for f in frames]
        assert timestamps == sorted(timestamps)  # the clock is read in seq order

    def test_a_hidden_output_is_redacted_before_the_budget_is_measured(self, make_gm: Any) -> None:
        instance = make_gm(hide_outputs=True)
        instance.session.emit(
            "node.finished",
            {
                "nodeId": "n",
                "instanceId": "i",
                "durationMs": 0,
                "status": "ok",
                "output": SECRET * 100_000,
            },
        )
        frame = buffered(instance)[-1]
        assert frame["payload"]["output"] == "__REDACTED__"
        assert "__graphmindTruncated" not in frame["payload"]

    @pytest.mark.parametrize("hostile", [float("nan"), float("inf"), "\ud800"])
    def test_hostile_scalars_in_a_big_payload_still_shrink_to_valid_json(
        self, make_gm: Any, hostile: Any
    ) -> None:
        instance = make_gm()
        instance.session.emit(
            "node.finished",
            {
                "nodeId": "n",
                "durationMs": 0,
                "status": "ok",
                "output": [hostile, "p" * 700_000],
                "x": hostile,
            },
        )
        raw = instance.session._buffer.to_list()[-1]
        raw.encode("utf-8")  # sendable: no raw surrogate
        frame = json.loads(raw, parse_constant=lambda name: pytest.fail(f"bare {name}"))
        assert frame["payload"]["__graphmindTruncated"] is True
        assert is_valid_event_payload("node.finished", frame["payload"])
