"""Loop hold, Python port.

Parity with ``packages/client/test/loop-guard.test.ts`` / ``loop-hold.test.ts``:
the conformance fixture (``packages/client/test/fixtures/loop-guard.json``)
byte for byte, a randomised differential file generated from the TypeScript
canonicaliser, and the hold itself on the real wire through a fake viewer —
continue / inject / abort / retry, fail-open when detached or disconnected,
the configuration surface, and the privacy rule for the fingerprint.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

import graphmind as gm
from graphmind.loop_guard import (
    DEFAULT_LOOP_IGNORE_KEYS,
    MAX_LOOP_RUNS,
    UNREADABLE,
    LoopGuard,
    canonical_call,
    canonicalize,
    fingerprint_call,
    js_number,
    parse_loop_allow,
    parse_loop_mode,
    parse_loop_threshold,
    resolve_loop_guard,
)
from graphmind.redaction import REDACTED

from .conftest import wait_until

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "packages" / "client" / "test" / "fixtures" / "loop-guard.json"
DIFFERENTIAL = Path(__file__).resolve().parent / "fixtures" / "differential.json"


def guard(options: Any = None, env: Mapping[str, str] | None = None) -> LoopGuard:
    return LoopGuard(resolve_loop_guard(options if options is not None else {}, env or {}))


def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class UnreadableMapping(Mapping[str, Any]):
    """An input whose every read raises (the fixture's ``unreadable: true``)."""

    def __getitem__(self, key: str) -> Any:
        raise RuntimeError("unreadable")

    def __iter__(self) -> Any:
        raise RuntimeError("unreadable")

    def __len__(self) -> int:
        raise RuntimeError("unreadable")

    def items(self) -> Any:
        raise RuntimeError("unreadable")


# -- conformance fixture -----------------------------------------------------------


class TestConformanceFixture:
    def test_states_the_defaults_this_implementation_uses(self) -> None:
        data = fixture()
        # Version 3: loop hold v3, a loop is the same call BACK-TO-BACK.
        assert data["version"] == 3
        assert data["defaults"] == {
            "threshold": 3,
            "mode": "pause",
            "kinds": ["tool"],
            "ignoreKeys": list(DEFAULT_LOOP_IGNORE_KEYS),
        }
        resolved = resolve_loop_guard(None, {})
        assert (resolved.threshold, resolved.mode) == (3, "pause")
        assert resolved.kinds == frozenset({"tool"})
        assert resolved.ignore_keys == frozenset({"_meta"})

    @pytest.mark.parametrize("case", fixture()["canonical"], ids=lambda c: c["name"][:70])
    def test_canonical_case_byte_for_byte(self, case: dict[str, Any]) -> None:
        ignore = case.get("ignoreKeys", DEFAULT_LOOP_IGNORE_KEYS)
        assert canonical_call(case["nodeId"], case["input"], ignore) == case["canonical"]
        digest = hashlib.sha256(case["canonical"].encode("utf-8")).hexdigest()[:32]
        assert digest == case["fingerprint"]
        assert fingerprint_call(case["nodeId"], case["input"], ignore) == case["fingerprint"]

    def test_every_call_names_its_kind_and_the_v3_shapes_are_exercised(self) -> None:
        sequences = fixture()["sequences"]
        assert all("kind" in call for seq in sequences for call in seq["calls"])
        assert any(call.get("unreadable") for seq in sequences for call in seq["calls"])
        assert any("kinds" in seq for seq in sequences)
        assert any(len(seq["trips"]) > 1 for seq in sequences)

    @pytest.mark.parametrize("seq", fixture()["sequences"], ids=lambda s: s["name"][:70])
    def test_sequence_trips_exactly_at_the_recorded_calls(self, seq: dict[str, Any]) -> None:
        options: dict[str, Any] = {"threshold": seq["threshold"]}
        if "ignoreKeys" in seq:
            options["ignore_keys"] = seq["ignoreKeys"]
        if "allowNodes" in seq:
            options["allow_nodes"] = seq["allowNodes"]
        if "kinds" in seq:
            options["kinds"] = seq["kinds"]
        g = guard(options)
        trips: list[dict[str, int]] = []
        for index, call in enumerate(seq["calls"]):
            kind = call["kind"]
            name = call.get("name", call["nodeId"].split(":", 1)[1])
            if call.get("unreadable"):
                value: Any = UnreadableMapping()
            elif call.get("inputAbsent"):
                value = None
            else:
                value = call["input"]
            fp = g.fingerprint(call["nodeId"], value)
            record = g.record("run", kind, call["nodeId"], name, fp, index)
            expected = seq["fingerprints"][index]
            if expected is None:
                assert record is None, f"{seq['name']}[{index}] is not fingerprinted"
            else:
                assert record is not None and record.fingerprint == expected, (
                    f"{seq['name']}[{index}]"
                )
            info = g.consult("run", kind, call["nodeId"], name)
            if info is not None:
                assert info.last_seq == index, f"{seq['name']}[{index}] lastSeq"
                trips.append({"at": index, "repeats": info.repeats, "firstAt": info.first_seq})
            # A retry of the same call (no new start) never trips again.
            assert g.consult("run", kind, call["nodeId"], name) is None, f"{seq['name']} retry"
        assert trips == seq["trips"], seq["name"]
        first = trips[0] if trips else None
        assert (first["at"] if first else None) == seq["tripsAt"]
        assert (first["repeats"] if first else None) == seq["repeatsAtTrip"]


class TestDifferential:
    def test_every_generated_value_canonicalises_like_the_typescript_reference(self) -> None:
        data = json.loads(DIFFERENTIAL.read_text(encoding="utf-8"))
        # Cases holding unpaired surrogates are double-encoded (Ruby cannot parse them).
        cases = data["canonical"] + json.loads(data["canonicalLoneSurrogates"])
        assert len(cases) >= 400
        for index, case in enumerate(cases):
            got = canonical_call(case["nodeId"], case["input"], case["ignoreKeys"])
            assert got == case["canonical"], f"case {index}"
            assert (
                fingerprint_call(case["nodeId"], case["input"], case["ignoreKeys"])
                == case["fingerprint"]
            )
        assert any('"[depth]"' in c["canonical"] for c in cases), (
            "the depth marker must be exercised"
        )


# -- canonical form, Python specifics ----------------------------------------------


class TestCanonical:
    @pytest.mark.parametrize(
        ("value", "text"),
        [
            (1.0, "1"),
            (-0.0, "0"),
            (0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123e-20, "1.23e-18"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (-2.5e-8, "-2.5e-8"),
            (12345678901234567.0, "12345678901234568"),
            (1e16, "10000000000000000"),
            (100.5, "100.5"),
        ],
    )
    def test_numbers_are_spelled_like_javascript(self, value: float, text: str) -> None:
        assert js_number(value) == text
        assert canonicalize(value) == text

    def test_non_finite_numbers_are_null(self) -> None:
        assert canonicalize([math.nan, math.inf, -math.inf]) == "[null,null,null]"

    def test_key_order_is_utf16_code_unit_order_not_code_point_order(self) -> None:
        # U+FFFF sorts AFTER U+1F600 by code point, BEFORE it by UTF-16 unit (0xD83D < 0xFFFF).
        assert canonicalize({"\uffff": 1, "😀": 2}) == '{"😀":2,"\uffff":1}'

    def test_python_containers_and_keys(self) -> None:
        assert canonicalize((1, 2)) == canonicalize([1, 2]) == "[1,2]"
        assert (
            canonicalize({1: "a", None: "c", 2.5: "d", False: "e"})
            == '{"1":"a","2.5":"d","false":"e","null":"c"}'
        )
        assert canonicalize({"b": 1, "a": {2: [1.0]}}) == '{"a":{"2":[1]},"b":1}'
        assert canonicalize({"k": {3, 1, 2}}) == canonicalize({"k": {2, 3, 1}})
        assert canonicalize(b"bytes") == '"bytes"'

    def test_bytes_that_are_not_utf8_never_collapse_into_the_same_call(self) -> None:
        # Verifier finding: decoding with "replace" turned every invalid byte into
        # U+FFFD, so b"\x80\x81" and b"\x90\x91" fingerprinted identically and the
        # third upload of DIFFERENT binary data was held as "identical arguments".
        assert fingerprint_call("tool:upload", {"data": b"\x80\x81"}) != fingerprint_call(
            "tool:upload", {"data": b"\x90\x91"}
        )
        assert canonicalize(b"\x80") != canonicalize("�")
        # Identical bytes still are the same call, and valid UTF-8 reads as text.
        assert fingerprint_call("tool:u", b"\xff\x00") == fingerprint_call("tool:u", b"\xff\x00")
        assert canonicalize(bytearray("é".encode())) == '"é"'

    def test_functions_are_dropped_from_objects_and_null_in_arrays(self) -> None:
        assert canonicalize({"a": 1, "f": lambda: 1, "m": print}) == '{"a":1}'
        assert canonicalize([len, 1]) == "[null,1]"

    def test_ignore_keys_are_removed_at_every_depth_and_only_by_exact_match(self) -> None:
        value = {"_meta": 1, "x": [{"_meta": {"p": 1}, "_metadata": 2}], "y": {"_meta": 3}}
        assert canonicalize(value, {"_meta"}) == '{"x":[{"_metadata":2}],"y":{}}'

    def test_cycles_and_depth_are_markers_and_shared_references_are_not_cycles(self) -> None:
        cyclic: dict[str, Any] = {"a": 1}
        cyclic["self"] = cyclic
        assert canonicalize(cyclic) == '{"a":1,"self":"[circular]"}'
        shared = {"k": 1}
        assert canonicalize([shared, shared]) == '[{"k":1},{"k":1}]'
        deep: Any = "leaf"
        for _ in range(200):
            deep = [deep]
        assert '"[depth]"' in canonicalize(deep)

    def test_pydantic_like_objects_use_model_dump_and_other_objects_their_repr(self) -> None:
        class Model:
            def model_dump(self) -> dict[str, Any]:
                return {"b": 2, "a": 1}

        class Plain:
            def __repr__(self) -> str:
                return "Plain()"

        assert canonicalize({"m": Model(), "p": Plain()}) == '{"m":{"a":1,"b":2},"p":"Plain()"}'

    def test_lone_surrogates_are_escaped_and_pairs_are_joined(self) -> None:
        assert canonicalize("a\ud800b") == '"a\\ud800b"'
        assert canonicalize("😀") == '"😀"'


# -- configuration -------------------------------------------------------------------


class TestConfiguration:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (None, 3),
            ("", 3),
            ("  ", 3),
            ("5", 5),
            (" 7 ", 7),
            ("0", 0),
            ("3.0", 3),
            ("1e1", 10),
            ("0x10", 16),
            ("-1", 3),
            ("2.5", 3),
            ("abc", 3),
            ("Infinity", 3),
            ("NaN", 3),
            ("1_000", 3),
        ],
    )
    def test_threshold_env(self, raw: Any, expected: int) -> None:
        assert parse_loop_threshold(raw) == expected

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (None, "pause"),
            ("warn", "warn"),
            (" OFF ", "off"),
            ("Pause", "pause"),
            ("0", "off"),
            ("false", "off"),
            ("none", "off"),
            ("hold", "pause"),
            ("", "pause"),
        ],
    )
    def test_mode_env(self, raw: Any, expected: str) -> None:
        assert parse_loop_mode(raw) == expected

    def test_allow_env(self) -> None:
        assert parse_loop_allow("pollJob, tool:heartbeat ,,") == ["pollJob", "tool:heartbeat"]
        assert (
            parse_loop_allow("") == []
            and parse_loop_allow(None) == []
            and parse_loop_allow(" , ") == []
        )

    def test_option_beats_env_beats_default_per_field(self) -> None:
        env = {
            "GRAPHMIND_LOOP_THRESHOLD": "5",
            "GRAPHMIND_ON_LOOP": "warn",
            "GRAPHMIND_LOOP_ALLOW": "a,b",
        }
        assert resolve_loop_guard(None, env).threshold == 5
        mixed = resolve_loop_guard({"threshold": 2}, env)
        assert (mixed.threshold, mixed.mode, mixed.allow_nodes) == (
            2,
            "warn",
            frozenset({"a", "b"}),
        )
        assert resolve_loop_guard({"allow_nodes": ["only"]}, env).allow_nodes == frozenset({"only"})
        assert resolve_loop_guard({"allowNodes": []}, env).allow_nodes == frozenset()
        assert resolve_loop_guard(False, env).mode == "off"
        assert resolve_loop_guard({"mode": "WARN"}, {}).mode == "pause"  # options are exact
        assert resolve_loop_guard({"threshold": True}, {}).threshold == 3
        assert resolve_loop_guard({"threshold": 4.0}, {}).threshold == 4
        assert resolve_loop_guard({"ignore_keys": []}, {}).ignore_keys == frozenset()
        assert resolve_loop_guard({"kinds": "tool"}, {}).kinds == frozenset({"tool"})
        assert resolve_loop_guard({"kinds": ["llm", 3]}, {}).kinds == frozenset({"llm"})

    def test_unreadable_options_fall_back_to_env_then_defaults(self) -> None:
        class Exploding(dict):  # type: ignore[type-arg]
            def get(self, *_: Any) -> Any:
                raise RuntimeError("boom")

            def __contains__(self, _: object) -> bool:
                raise RuntimeError("boom")

        assert resolve_loop_guard(Exploding(), {"GRAPHMIND_LOOP_THRESHOLD": "9"}).threshold == 9
        assert resolve_loop_guard(Exploding(), Exploding()).threshold == 3

    def test_a_session_survives_hostile_options(self, make_gm: Any) -> None:
        class Exploding(dict):  # type: ignore[type-arg]
            def get(self, *_: Any) -> Any:
                raise RuntimeError("boom")

        instance = make_gm(loop_guard=Exploding(), hide_inputs=object())
        instance.emit("node.started", {"nodeId": "tool:x", "kind": "tool", "name": "x"})
        assert instance.stats().seq >= 1


# -- the counting ------------------------------------------------------------------


def rec(g: LoopGuard, run: str, node_id: Any, value: Any, seq: int, kind: str = "tool") -> Any:
    """Record one start the way the session does (fingerprint outside the lock)."""
    name = node_id.split(":", 1)[-1] if isinstance(node_id, str) else None
    return g.record(run, kind, node_id, name, g.fingerprint(node_id, value), seq)


def held(g: LoopGuard, run: str, node_id: str, kind: str = "tool") -> Any:
    return g.consult(run, kind, node_id, node_id.split(":", 1)[-1])


class TestGuard:
    def test_unreadable_input_clears_the_streak(self) -> None:
        class Boom:
            def model_dump(self) -> Any:
                return self  # a self-returning conversion is not a faithful read

        g = guard()
        for i, value in enumerate([{"q": 1}, {"q": 1}, {"q": Boom()}, {"q": 1}, {"q": 1}]):
            rec(g, "r", "tool:s", value, i)
        assert held(g, "r", "tool:s") is None  # streak is 2, not 4

        class Raises:
            def __repr__(self) -> str:
                raise RuntimeError("no")

        g2 = guard()
        for i in range(5):
            rec(g2, "r", "tool:s", {"v": Raises()}, i)
        assert held(g2, "r", "tool:s") is None
        assert g2.tracked_streaks == 0

    def test_trips_once_per_repeat_and_again_on_the_next(self) -> None:
        g = guard()
        for i in range(3):
            rec(g, "r", "tool:s", {}, i)
        info = held(g, "r", "tool:s")
        assert info is not None and (info.repeats, info.first_seq, info.last_seq) == (3, 0, 2)
        assert held(g, "r", "tool:s") is None  # a retry of the same instance
        rec(g, "r", "tool:s", {}, 9)
        info = held(g, "r", "tool:s")
        assert info is not None and (info.repeats, info.last_seq) == (4, 9)

    def test_another_watched_call_of_the_same_kind_replaces_the_streak_v3(self) -> None:
        # v2 kept one streak per node that other tools did not reset; v3 keeps one
        # per KIND, so A, B, A, B, A is never a loop.
        g = guard()
        for i, node in enumerate(["tool:a", "tool:b", "tool:a", "tool:b", "tool:a"]):
            rec(g, "r", node, {"same": True}, i)
            assert held(g, "r", node) is None
        assert g.tracked_streaks == 1

    def test_the_long_session_shape_is_never_a_loop_v3(self) -> None:
        g = guard()
        seq = 0
        for _ in range(3):
            rec(g, "session", "tool:list_issues", {}, seq)
            assert held(g, "session", "tool:list_issues") is None
            seq += 1
            for other in ("tool:read_file", "tool:grep", "tool:edit"):
                rec(g, "session", other, {"path": f"f{seq}"}, seq)
                seq += 1

    def test_unwatched_starts_touch_no_streak_v3(self) -> None:
        g = guard({"allow_nodes": ["poll"]})
        rec(g, "r", "tool:s", {}, 0)
        rec(g, "r", "llm:model", {"messages": [1]}, 1, kind="llm")  # other kind
        rec(g, "r", "tool:poll", {}, 2)  # allow-listed by name
        rec(g, "r", "tool:s", {}, 3)
        rec(g, "r", "llm:model", {"messages": [2]}, 4, kind="llm")
        rec(g, "r", "tool:s", {}, 5)
        info = held(g, "r", "tool:s")
        assert info is not None and (info.repeats, info.first_seq, info.last_seq) == (3, 0, 5)
        assert held(g, "r", "tool:poll") is None

    def test_keeps_one_independent_streak_per_watched_kind_v3(self) -> None:
        g = guard({"kinds": ["tool", "llm"]})
        for i in range(3):
            rec(g, "r", "tool:t", {"x": 1}, 2 * i)
            rec(g, "r", "llm:m", {"p": 1}, 2 * i + 1, kind="llm")
        tool = held(g, "r", "tool:t")
        llm = held(g, "r", "llm:m", kind="llm")
        assert tool is not None and (tool.repeats, tool.first_seq) == (3, 0)
        assert llm is not None and (llm.repeats, llm.first_seq) == (3, 1)
        assert g.tracked_streaks == 2

    def test_a_gate_whose_node_is_not_the_streak_owner_never_holds_v3(self) -> None:
        g = guard()
        for i in range(3):
            rec(g, "r", "tool:a", {}, i)
        assert held(g, "r", "tool:b") is None
        assert held(g, "r", "tool:a") is not None

    def test_an_unreadable_input_or_a_non_string_node_id_clears_the_kind_streak_v3(
        self,
    ) -> None:
        g = guard()
        for i in range(2):
            rec(g, "r", "tool:a", {}, i)
        assert g.record("r", "tool", "tool:a", "a", UNREADABLE, 2) is None
        assert g.tracked_streaks == 0
        rec(g, "r", "tool:a", {}, 3)
        rec(g, "r", "tool:a", {}, 4)
        assert held(g, "r", "tool:a") is None  # 2, restarted at 3
        assert rec(g, "r", 42, {}, 5) is None  # a nodeId that is not a string
        assert g.tracked_streaks == 0
        # an allow-listed or unwatched unreadable start clears nothing
        g2 = guard({"allow_nodes": ["tool:p"]})
        rec(g2, "r", "tool:a", {}, 0)
        g2.record("r", "tool", "tool:p", "p", UNREADABLE, 1)
        g2.record("r", "llm", "llm:x", "x", UNREADABLE, 2)
        assert g2.tracked_streaks == 1

    def test_a_str_subclass_cannot_lie_its_way_into_or_out_of_a_streak(self) -> None:
        class Liar(str):
            def __eq__(self, other: object) -> bool:
                return True

            def __ne__(self, other: object) -> bool:
                return False

            __hash__ = str.__hash__

        g = guard()
        for i in range(3):
            rec(g, "r", "tool:a", {}, i)
        assert g.consult("r", "tool", Liar("tool:b"), "b") is None
        assert g.consult("r", Liar("tool"), "tool:a", "a") is not None

    def test_claim_warning_with_a_kind_claims_that_kinds_streak_only_v3(self) -> None:
        g = guard({"kinds": ["tool", "llm"]})
        rec(g, "r", "tool:x", {}, 0)
        rec(g, "r", "llm:x", {}, 1, kind="llm")
        assert g.claim_warning("r", "tool:x", "llm") is False
        assert g.claim_warning("r", "tool:x", "tool") is True
        assert g.claim_warning("r", "tool:x") is False  # already claimed
        assert g.claim_warning("r", "llm:x") is True
        assert g.claim_warning("nope", "tool:x") is False

    def test_runs_are_independent_and_state_is_bounded(self) -> None:
        g = guard()
        rec(g, "long", "tool:s", {}, 0)
        for i in range(MAX_LOOP_RUNS * 2):
            rec(g, f"short-{i}", "tool:s", {}, 0)
            if i % 10 == 0:
                rec(g, "long", "tool:s", {}, i)
        assert g.tracked_runs == MAX_LOOP_RUNS
        assert held(g, "long", "tool:s") is not None  # still remembered (LRU)

        # v2 kept up to 4,096 nodes per run; v3 keeps ONE streak per kind per run.
        g2 = guard({"kinds": ["tool", "llm"]})
        for i in range(5000):
            rec(g2, "r", f"tool:{i}", {}, i)
            rec(g2, "r", f"llm:{i}", {}, i, kind="llm")
        assert g2.tracked_streaks == 2

    def test_concurrent_recording_never_corrupts_and_never_raises(self) -> None:
        g = guard({"kinds": ["tool", "llm"]})
        errors: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                for i in range(400):
                    run = f"run-{i % 70}"
                    kind = "tool" if i % 2 else "llm"
                    rec(g, run, f"{kind}:{n % 3}", {"i": i % 4}, i, kind=kind)
                    g.consult(run, kind, f"{kind}:{n % 3}", str(n % 3))
                    g.claim_warning(run, f"{kind}:{n % 3}")
            except BaseException as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        assert errors == []
        assert g.tracked_runs <= MAX_LOOP_RUNS and g.tracked_streaks <= 2 * MAX_LOOP_RUNS

    def test_fingerprinting_a_1kb_input_is_cheap(self) -> None:
        value = {"query": "x" * 600, "filters": {f"k{i}": i for i in range(40)}}
        assert len(json.dumps(value)) >= 1000
        g = guard()
        started = time.perf_counter()
        for _ in range(2000):
            g.fingerprint("tool:s", value)
        per_call_ms = (time.perf_counter() - started) * 1000 / 2000
        assert per_call_ms < 0.5, per_call_ms


# -- the hold on the wire ------------------------------------------------------------


def paused_frames(view: Any) -> list[dict[str, Any]]:
    return view.of_type("exec.paused")


def start_worker(fn: Any, *args: Any) -> tuple[threading.Thread, dict[str, Any]]:
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["value"] = fn(*args)
        except BaseException as exc:
            box["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, box


class TestHold:
    def test_third_identical_call_is_held_with_loop_details_matching_the_wire(
        self, attached: Any, validate_frame: Any
    ) -> None:
        instance, view = attached()
        calls: list[str] = []

        @instance.tool
        def search_flights(origin: str, dest: str) -> str:
            calls.append(origin)
            return "no flights"

        def agent() -> list[str]:
            out = []
            with instance.run("loop"):
                for _ in range(3):
                    out.append(search_flights("AMS", "LIS"))
            return out

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        time.sleep(0.2)
        assert len(calls) == 2, "the held (third) call must not have run"
        payload = paused["payload"]
        assert payload["reason"] == "loop" and payload["point"] == "before"
        assert payload["nodeId"] == "tool:search_flights"
        loop = payload["loop"]
        starts = [
            f
            for f in view.of_type("node.started")
            if f["payload"]["nodeId"] == "tool:search_flights"
        ]
        assert loop["repeats"] == 3
        assert loop["firstSeq"] == starts[0]["seq"] and loop["lastSeq"] == starts[2]["seq"]
        expected = fingerprint_call(
            "tool:search_flights", {"origin": "AMS", "dest": "LIS"}, {"_meta"}
        )
        assert loop["fingerprint"] == expected
        validate_frame(paused)

        view.resume(payload["pauseId"], "continue")
        thread.join(5)
        assert box.get("value") == ["no flights"] * 3 and len(calls) == 3

    def test_continue_then_the_fourth_is_held_again_inject_and_abort_do_their_jobs(
        self, attached: Any
    ) -> None:
        instance, view = attached()
        ran: list[int] = []

        @instance.tool
        def poll(job: int) -> str:
            ran.append(job)
            return "pending"

        def agent() -> Any:
            results = []
            with instance.run("loop"):
                for _ in range(5):
                    results.append(poll(7))
            return results

        thread, box = start_worker(agent)
        first = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert first["payload"]["loop"]["repeats"] == 3
        view.resume(first["payload"]["pauseId"], "continue")
        second = view.wait_for(
            lambda f: (
                f.get("type") == "exec.paused"
                and f["payload"]["pauseId"] != first["payload"]["pauseId"]
            )
        )
        assert second["payload"]["loop"]["repeats"] == 4
        view.resume(second["payload"]["pauseId"], "inject", {"status": "done"})
        third = view.wait_for(
            lambda f: (
                f.get("type") == "exec.paused"
                and f["payload"]["pauseId"]
                not in (first["payload"]["pauseId"], second["payload"]["pauseId"])
            )
        )
        assert third["payload"]["loop"]["repeats"] == 5
        view.resume(third["payload"]["pauseId"], "abort")
        thread.join(5)
        assert isinstance(box.get("error"), gm.GraphMindAbortError)
        assert ran == [7, 7, 7]  # 1, 2, continued 3rd; 4th injected; 5th aborted
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        assert view.of_type("run.finished")[0]["payload"]["status"] == "aborted"
        injected = [f for f in view.of_type("node.finished") if f["payload"].get("injected")]
        assert injected and injected[0]["payload"]["output"] == {"status": "done"}

    def test_retry_of_the_held_instance_does_not_hold_twice(self, attached: Any) -> None:
        instance, view = attached(breakpoints=[{"point": "error"}])
        attempts: list[int] = []

        @instance.tool
        def flaky(n: int) -> str:
            attempts.append(n)
            if len(attempts) == 3:
                raise ValueError("boom")
            return "ok"

        def agent() -> Any:
            with instance.run("r"):
                return [flaky(1), flaky(1), flaky(1)]

        thread, box = start_worker(agent)
        loop_hold = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert loop_hold["payload"]["reason"] == "loop"
        view.resume(loop_hold["payload"]["pauseId"], "continue")
        error_hold = view.wait_for(
            lambda f: f.get("type") == "exec.paused" and f["payload"]["point"] == "error"
        )
        assert "reason" not in error_hold["payload"] and "loop" not in error_hold["payload"]
        view.resume(error_hold["payload"]["pauseId"], "retry")
        thread.join(5)
        assert box.get("value") == ["ok", "ok", "ok"] and len(attempts) == 4
        loop_holds = [f for f in paused_frames(view) if f["payload"].get("reason") == "loop"]
        assert len(loop_holds) == 1, "retry re-entered the before-gate without a new node.started"
        assert len(paused_frames(view)) == 2

    def test_different_arguments_never_hold_and_interleaved_calls_are_not_a_loop(
        self, attached: Any
    ) -> None:
        # pause_timeout: a regression that holds must FAIL the assertion, not hang.
        instance, view = attached(gm_options={"pause_timeout": 2.0})
        search = instance.tool(lambda q: q, name="search")
        read = instance.tool(lambda i: i, name="read")
        with instance.run("r"):
            for page in range(6):
                search({"q": "x", "page": page})
        assert paused_frames(view) == []

        # Loop hold v3 (internal/decisions.md "a loop is the same call BACK-TO-BACK"):
        # this test used to pin the v2 per-node rule, under which search, read,
        # search, read, search held the third search. Another watched tool call
        # between identical calls now replaces the streak, so it is never held.
        with instance.run("r2"):
            search("x")
            read(1)
            search("x")
            read(2)
            search("x")
        assert paused_frames(view) == []

    def test_async_tools_are_held_too(self, attached: Any) -> None:
        instance, view = attached()

        @instance.tool
        async def fetch(url: str) -> str:
            return "same"

        async def agent() -> list[str]:
            async with instance.run("async-loop"):
                return [await fetch("u"), await fetch("u"), await fetch("u")]

        thread, box = start_worker(lambda: asyncio.run(agent()))
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert held["payload"]["reason"] == "loop"
        view.resume(held["payload"]["pauseId"], "inject", "injected")
        thread.join(5)
        assert box.get("value") == ["same", "same", "injected"]

    def test_the_fingerprint_is_hidden_when_tool_args_are_hidden(self, attached: Any) -> None:
        instance, view = attached(gm_options={"hide_tool_args": True})
        tool = instance.tool(lambda email: "x", name="lookup")
        thread, _ = start_worker(lambda: [tool("alice@example.com") for _ in range(3)])
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        loop = held["payload"]["loop"]
        assert loop["fingerprint"] == REDACTED
        assert loop["repeats"] == 3 and isinstance(loop["firstSeq"], int)
        view.resume(held["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "alice@example.com" not in json.dumps(view.frames())

    def test_the_fingerprint_is_hidden_under_hide_inputs_but_not_hide_outputs(
        self, attached: Any
    ) -> None:
        for options, hidden in (({"hide_inputs": True}, True), ({"hide_outputs": True}, False)):
            instance, view = attached(gm_options=options)
            tool = instance.tool(lambda v: v, name="t")
            thread, _ = start_worker(lambda tool=tool: [tool(1) for _ in range(3)])
            held = view.wait_for(lambda f: f.get("type") == "exec.paused")
            assert (held["payload"]["loop"]["fingerprint"] == REDACTED) is hidden, options
            view.resume(held["payload"]["pauseId"], "continue")
            thread.join(5)

    def test_a_kind_that_lies_about_being_a_tool_still_hides_the_fingerprint(
        self, attached: Any
    ) -> None:
        # Python-only: a str subclass can answer `== "tool"` with False while it
        # serialises (and is watched) as "tool". The redactor already judges the
        # plain string; the fingerprint beside the hidden input must too.
        class NotTool(str):
            def __eq__(self, other: object) -> bool:
                return False

            __hash__ = str.__hash__

        instance, view = attached(gm_options={"hide_tool_args": True})
        session = instance.session
        kind = NotTool("tool")

        def agent() -> Any:
            with instance.run("liar"):
                for i in range(3):
                    session.start_node("tool:t", kind, "t", f"i{i}", input={"pin": "4711"})
                return session.gate("before", gm.GateNode("tool:t", kind, "t"))

        thread, box = start_worker(agent)
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert held["payload"]["reason"] == "loop"
        assert held["payload"]["loop"]["fingerprint"] == REDACTED
        view.resume(held["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box and "4711" not in json.dumps(view.frames())

    def test_an_unrelated_breakpoint_hold_carries_no_loop_details(self, attached: Any) -> None:
        instance, view = attached(
            breakpoints=[{"kind": "tool", "name": "other", "point": "before"}]
        )
        same = instance.tool(lambda: 1, name="same")
        other = instance.tool(lambda: 2, name="other")

        def agent() -> None:
            same()
            same()
            same()
            other()

        thread, _ = start_worker(agent)
        loop_hold = view.wait_for(lambda f: f.get("type") == "exec.paused")
        view.resume(loop_hold["payload"]["pauseId"], "continue")
        plain = view.wait_for(
            lambda f: f.get("type") == "exec.paused" and f["payload"]["nodeId"] == "tool:other"
        )
        assert set(plain["payload"]) == {"pauseId", "nodeId", "point"}
        view.resume(plain["payload"]["pauseId"], "continue")
        thread.join(5)


class TestBackToBackV3:
    """Loop hold v3 on the real wire (parity with loop-hold.test.ts, block
    "loop hold v3 — back-to-back only")."""

    def test_the_long_session_identical_calls_separated_by_other_tools_are_never_held(
        self, attached: Any
    ) -> None:
        # The bug v3 fixes: one long run (an mcp-proxy host session, an implicit
        # run) calls list_issues({}) now and then with other tools between; v2
        # held the third one as "Loop: 3x list_issues". pause_timeout makes a
        # regression fail the assertion instead of hanging the suite.
        logs: list[str] = []
        instance, view = attached(gm_options={"pause_timeout": 2.0, "logger": logs.append})
        ran: list[str] = []
        list_issues = instance.tool(lambda: ran.append("list") or [], name="list_issues")
        read_file = instance.tool(lambda path: ran.append(path) or "text", name="read_file")
        grep = instance.tool(lambda pattern: ran.append(pattern) or [], name="grep")
        started = time.monotonic()
        with instance.run("long-session"):
            for minute in (1, 20, 45):
                list_issues()
                read_file(f"src/{minute}.py")
                grep(f"TODO-{minute}")
        assert time.monotonic() - started < 1.5, "a call was held"
        assert paused_frames(view) == []
        assert ran.count("list") == 3
        assert not [m for m in logs if "possible loop" in m]

    def test_the_same_three_calls_back_to_back_are_held(self, attached: Any) -> None:
        instance, view = attached()
        ran: list[str] = []
        list_issues = instance.tool(lambda: ran.append("list") or [], name="list_issues")
        read_file = instance.tool(lambda path: "text", name="read_file")

        def agent() -> None:
            with instance.run("back-to-back"):
                read_file("a")
                list_issues()
                list_issues()
                list_issues()

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        time.sleep(0.1)
        assert ran == ["list", "list"], "the held (third) call must not have run"
        loop = paused["payload"]["loop"]
        starts = [
            f for f in view.of_type("node.started") if f["payload"]["nodeId"] == "tool:list_issues"
        ]
        assert paused["payload"]["reason"] == "loop" and loop["repeats"] == 3
        assert loop["firstSeq"] == starts[0]["seq"] and loop["lastSeq"] == starts[2]["seq"]
        view.resume(paused["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box and ran == ["list"] * 3

    def test_detached_the_long_session_never_warns_either(self, make_gm: Any) -> None:
        logs: list[str] = []
        instance = make_gm(url="ws://127.0.0.1:1/ingest", logger=logs.append, connect_timeout=0.05)
        status = instance.tool(lambda: "ok", name="status")
        other = instance.tool(lambda n: n, name="other")
        with instance.run("r"):
            for n in range(10):
                status()
                other(n)
        assert not [m for m in logs if "possible loop" in m], logs
        with instance.run("r2"):
            for _ in range(3):
                status()
        assert len([m for m in logs if "possible loop" in m]) == 1

    def test_model_tool_model_tool_an_llm_step_does_not_break_the_tool_streak(
        self, attached: Any
    ) -> None:
        instance, view = attached()
        session = instance.session
        ran: list[int] = []
        weather = instance.tool(lambda city: ran.append(1) or "sunny", name="weather")

        def agent() -> None:
            with instance.run("agent"):
                for step in range(3):
                    session.start_node("llm:model", "llm", "model", f"m{step}", input={"n": step})
                    session.finish_node("llm:model", f"m{step}", 1.0, output={"tool": "weather"})
                    weather("Lisbon")

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert paused["payload"]["nodeId"] == "tool:weather"
        assert paused["payload"]["loop"]["repeats"] == 3 and len(ran) == 2
        view.resume(paused["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box and len(ran) == 3

    def test_an_allow_listed_poller_between_identical_calls_is_invisible_and_a_a_b_a_a_is_not(
        self, attached: Any
    ) -> None:
        instance, view = attached(
            gm_options={"pause_timeout": 2.0, "loop_guard": {"allow_nodes": ["poll_job"]}}
        )
        fetch = instance.tool(lambda: "x", name="fetch")
        other = instance.tool(lambda: "y", name="other")
        poll = instance.tool(lambda: "pending", name="poll_job")
        with instance.run("a-a-b-a-a"):
            fetch()
            fetch()
            other()
            fetch()
            fetch()
        assert paused_frames(view) == []

        def agent() -> None:
            with instance.run("poller"):
                fetch()
                poll()
                fetch()
                poll()
                poll()
                fetch()

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert paused["payload"]["nodeId"] == "tool:fetch"
        assert paused["payload"]["loop"]["repeats"] == 3
        view.resume(paused["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box
        assert all(f["payload"]["nodeId"] == "tool:fetch" for f in paused_frames(view))

    def test_an_input_whose_read_raises_clears_the_streak_and_never_raises(
        self, attached: Any
    ) -> None:
        class InputRaises(dict):  # type: ignore[type-arg]
            def __getitem__(self, key: Any) -> Any:
                if key == "input":
                    raise RuntimeError("unreadable input")
                return super().__getitem__(key)

        instance, view = attached(gm_options={"pause_timeout": 2.0})
        session = instance.session

        def start(i: int, hostile: bool = False) -> None:
            payload = {"nodeId": "tool:t", "kind": "tool", "name": "t", "instanceId": f"i{i}"}
            payload["input"] = {"q": 1}
            session.emit("node.started", InputRaises(payload) if hostile else payload)

        with instance.run("r"):
            start(0)
            start(1)
            start(2, hostile=True)  # clears: never raises into the host
            start(3)
            start(4)
            assert session.gate("before", gm.GateNode("tool:t", "tool", "t")).action == "continue"
        wait_until(
            lambda: (
                len([f for f in view.of_type("node.started") if f["payload"]["nodeId"] == "tool:t"])
                == 5
            ),
            label="all five starts, the hostile one included",
        )
        assert paused_frames(view) == []

        def agent() -> Any:
            with instance.run("r2"):
                for i in range(2):
                    start(i)
                start(2, hostile=True)
                for i in range(3, 6):
                    start(i)
                return session.gate("before", gm.GateNode("tool:t", "tool", "t"))

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        r2 = [
            f
            for f in view.of_type("node.started")
            if f["runId"] == paused["runId"] and f["payload"]["nodeId"] == "tool:t"
        ]
        assert paused["payload"]["loop"]["repeats"] == 3
        assert paused["payload"]["loop"]["firstSeq"] == r2[3]["seq"]  # restarted after the clear
        view.resume(paused["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box

    def test_a_start_whose_kind_cannot_be_read_touches_no_streak(self, attached: Any) -> None:
        class KindRaises(dict):  # type: ignore[type-arg]
            def __getitem__(self, key: Any) -> Any:
                if key == "kind":
                    raise RuntimeError("unreadable kind")
                return super().__getitem__(key)

        instance, view = attached()
        session = instance.session
        node = {"nodeId": "tool:t", "kind": "tool", "name": "t", "input": {}}

        def agent() -> Any:
            with instance.run("r"):
                session.emit("node.started", {**node, "instanceId": "1"})
                session.emit("node.started", {**node, "instanceId": "2"})
                session.emit("node.started", KindRaises({**node, "nodeId": "tool:x"}))
                session.emit("node.started", {**node, "instanceId": "3"})
                return session.gate("before", gm.GateNode("tool:t", "tool", "t"))

        thread, box = start_worker(agent)
        paused = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert paused["payload"]["loop"]["repeats"] == 3
        view.resume(paused["payload"]["pauseId"], "continue")
        thread.join(5)
        assert "error" not in box

    def test_kinds_tool_and_llm_keep_independent_streaks_in_a_live_session(
        self, attached: Any
    ) -> None:
        instance, view = attached(gm_options={"loop_guard": {"kinds": ["tool", "llm"]}})
        session = instance.session
        llm = gm.GateNode("llm:model", "llm", "model")
        tool = gm.GateNode("tool:t", "tool", "t")

        def agent() -> list[str]:
            actions = []
            with instance.run("r"):
                for i in range(3):
                    session.start_node("llm:model", "llm", "model", f"m{i}", input={"p": 1})
                    session.start_node("tool:t", "tool", "t", f"t{i}", input={"q": 1})
                actions.append(session.gate("before", llm).action)
                actions.append(session.gate("before", tool).action)
            return actions

        thread, box = start_worker(agent)
        first = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert first["payload"]["nodeId"] == "llm:model"
        assert first["payload"]["loop"]["repeats"] == 3
        view.resume(first["payload"]["pauseId"], "continue")
        second = view.wait_for(
            lambda f: f.get("type") == "exec.paused" and f["payload"]["nodeId"] == "tool:t"
        )
        assert second["payload"]["loop"]["repeats"] == 3
        view.resume(second["payload"]["pauseId"], "continue")
        thread.join(5)
        assert box.get("value") == ["continue", "continue"]


class TestFailOpen:
    def test_detached_never_holds_and_warns_once_per_streak_without_arguments(
        self, make_gm: Any
    ) -> None:
        logs: list[str] = []
        instance = make_gm(url="ws://127.0.0.1:1/ingest", logger=logs.append, connect_timeout=0.05)
        tool = instance.tool(lambda token: "same", name="search")
        started = time.monotonic()
        with instance.run("r"):
            for _ in range(7):
                assert tool("SECRET-ARG") == "same"
        assert time.monotonic() - started < 2.0
        loop_logs = [m for m in logs if "possible loop" in m]
        assert len(loop_logs) == 1, logs
        assert "search (tool:search)" in loop_logs[0] and "3\u00d7" in loop_logs[0]
        assert "no debugger is attached" in loop_logs[0]
        assert "SECRET-ARG" not in loop_logs[0]

    def test_warn_mode_never_holds_even_when_attached(self, attached: Any) -> None:
        logs: list[str] = []
        instance, view = attached(
            gm_options={
                "env": {"GRAPHMIND_ON_LOOP": "warn"},
                "logger": logs.append,
                "pause_timeout": 2.0,
            }
        )
        tool = instance.tool(lambda: 1, name="t")
        with instance.run("r"):
            for _ in range(5):
                tool()
        assert paused_frames(view) == []
        assert len([m for m in logs if "GRAPHMIND_ON_LOOP=warn" in m]) == 1

    @pytest.mark.parametrize(
        "options",
        [
            {"env": {"GRAPHMIND_ON_LOOP": "off"}},
            {"env": {"GRAPHMIND_LOOP_THRESHOLD": "0"}},
            {"loop_guard": False},
            {"loop_guard": {"allow_nodes": ["t"]}},
            {"loop_guard": {"allow_nodes": ["tool:t"]}},
            {"env": {"GRAPHMIND_LOOP_ALLOW": "x, t"}},
            {"env": {"GRAPHMIND_LOOP_THRESHOLD": "6"}},
        ],
    )
    def test_switched_off_allowed_or_below_threshold_never_holds(
        self, attached: Any, options: Any
    ) -> None:
        logs: list[str] = []
        instance, view = attached(
            gm_options={**options, "logger": logs.append, "pause_timeout": 2.0}
        )
        tool = instance.tool(lambda: 1, name="t")
        with instance.run("r"):
            for _ in range(5):
                tool()
        assert paused_frames(view) == []
        assert not [m for m in logs if "possible loop" in m]

    def test_threshold_from_env_holds_exactly_there(self, attached: Any) -> None:
        instance, view = attached(gm_options={"env": {"GRAPHMIND_LOOP_THRESHOLD": "5"}})
        count: list[int] = []
        tool = instance.tool(lambda: count.append(1), name="t")
        thread, _ = start_worker(lambda: [tool() for _ in range(5)])
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert held["payload"]["loop"]["repeats"] == 5 and len(count) == 4
        view.resume(held["payload"]["pauseId"], "continue")
        thread.join(5)

    def test_a_debugger_that_disconnects_mid_hold_releases_it(self, attached: Any) -> None:
        instance, view = attached()
        tool = instance.tool(lambda: "ran", name="t")
        thread, box = start_worker(lambda: [tool() for _ in range(3)])
        view.wait_for(lambda f: f.get("type") == "exec.paused")
        view.kill_abruptly()
        thread.join(5)
        assert not thread.is_alive()
        assert box.get("value") == ["ran", "ran", "ran"]

    def test_pause_timeout_releases_a_loop_hold(self, attached: Any) -> None:
        instance, view = attached(gm_options={"pause_timeout": 0.3})
        tool = instance.tool(lambda: "ran", name="t")
        started = time.monotonic()
        assert [tool() for _ in range(3)] == ["ran"] * 3
        assert 0.25 < time.monotonic() - started < 3
        resumed = view.wait_for(lambda f: f.get("type") == "exec.resumed")
        assert resumed["payload"]["action"] == "continue"

    def test_a_debugger_that_attaches_late_holds_the_next_identical_call(
        self, make_gm: Any, viewer: Any
    ) -> None:
        view = viewer()
        instance = make_gm(url=view.url)
        tool = instance.tool(lambda: 1, name="t")
        # Emitted before any handshake: detached, never held.
        tool()
        tool()
        tool()
        assert instance.ready(timeout=5.0)
        thread, _ = start_worker(tool)
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert held["payload"]["loop"]["repeats"] == 4
        view.resume(held["payload"]["pauseId"], "continue")
        thread.join(5)

    def test_many_concurrent_runs_are_held_and_all_released_on_disconnect(
        self, attached: Any
    ) -> None:
        instance, view = attached()
        tool = instance.tool(lambda n: n, name="t")

        def agent(n: int) -> list[int]:
            with instance.run(f"run-{n}"):
                return [tool(n) for _ in range(3)]

        workers = [start_worker(agent, n) for n in range(10)]
        wait_until(lambda: len(paused_frames(view)) == 10, timeout=10, label="10 loop holds")
        assert {f["runId"] for f in paused_frames(view)}.__len__() == 10
        assert instance.stats().held_gates == 10
        view.kill_abruptly()
        for thread, box in workers:
            thread.join(5)
            assert not thread.is_alive() and "error" not in box


class TestIntegrations:
    def test_a_langchain_tool_called_through_the_callback_handler_is_held(
        self, attached: Any
    ) -> None:
        pytest.importorskip("langchain_core")
        from langchain_core.tools import tool as lc_tool

        instance, view = attached(gm_options={"hide_tool_args": True, "hide_tool_results": True})
        handler = instance.callback_handler()
        ran: list[str] = []

        @lc_tool
        def lookup(city: str) -> str:
            """Look a city up."""
            ran.append(city)
            return f"{city}: sunny"

        def agent() -> list[str]:
            with instance.run("lc-agent"):
                return [
                    lookup.invoke({"city": "SECRET-CITY"}, config={"callbacks": [handler]})
                    for _ in range(3)
                ]

        thread, box = start_worker(agent)
        held = view.wait_for(lambda f: f.get("type") == "exec.paused")
        assert held["payload"]["reason"] == "loop" and held["payload"]["nodeId"] == "tool:lookup"
        assert held["payload"]["loop"]["repeats"] == 3
        assert held["payload"]["loop"]["fingerprint"] == REDACTED
        time.sleep(0.1)
        assert len(ran) == 2
        view.resume(held["payload"]["pauseId"], "continue")
        thread.join(5)
        assert box.get("value") == ["SECRET-CITY: sunny"] * 3
        assert "SECRET-CITY" not in json.dumps(
            [f for f in view.frames() if f["payload"].get("nodeId") == "tool:lookup"]
        )


class TestDroppedStartClearsTheStreak:
    """Cross-language divergence probe (loop-v3 verifier; decisions.md "A dropped
    event takes no seq and clears its kind's loop streak"): a node.started the
    fail-closed redactor DROPS never reaches the wire, so it is not "the call
    right before" the next one and must clear its kind's streak. Ruby already
    behaved this way; Python counted the dropped start and warned at call 3."""

    def test_hide_inputs_detached_a_dropped_second_call_means_no_loop_at_call_three(
        self, make_gm: Any
    ) -> None:
        logs: list[str] = []
        instance = make_gm(
            url="ws://127.0.0.1:1/ingest",
            connect_timeout=0.05,
            env={"GRAPHMIND_HIDE_INPUTS": "1"},
            logger=logs.append,
        )
        session = instance.session

        def start(i: int, instance_id: Any) -> None:
            session.emit(
                "node.started",
                {
                    "nodeId": "tool:a",
                    "kind": "tool",
                    "name": "a",
                    "instanceId": instance_id,
                    "input": {"q": "same"},
                },
            )

        def loop_warnings() -> list[str]:
            return [m for m in logs if "possible loop" in m]

        def starts_buffered() -> int:
            frames = [json.loads(frame) for frame in session._buffer.to_list()]
            return len(
                [
                    f
                    for f in frames
                    if f["type"] == "node.started" and f["payload"]["nodeId"] == "tool:a"
                ]
            )

        with instance.run("r"):
            start(1, "i1")
            seq_before_drop = instance.stats().seq
            start(2, 2)  # instanceId not a string: dropped by the redactor
            assert starts_buffered() == 1
            # ...and takes NO seq: no hole in the sequence (decision (a)).
            assert instance.stats().seq == seq_before_drop
            assert [m for m in logs if "dropped" in m], logs  # the redactor said so
            start(3, "i3")
            assert loop_warnings() == []  # the bug: warned here (1, dropped 2, 3 = "3x")
            start(4, "i4")
            assert loop_warnings() == []  # the streak restarted at call 3
            start(5, "i5")
            # Non-vacuous: three readable back-to-back starts still warn.
            assert len(loop_warnings()) == 1, logs
        assert starts_buffered() == 4
        seqs = [json.loads(frame)["seq"] for frame in session._buffer.to_list()]
        assert seqs == list(range(len(seqs)))  # contiguous: the drop left no hole
