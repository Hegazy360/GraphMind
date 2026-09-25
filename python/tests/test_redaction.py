"""Coarse redaction (the GRAPHMIND_HIDE_* kill switches), Python port.

Parity with ``packages/client/test/redaction.test.ts``: the cross-language
conformance fixture (``packages/client/test/fixtures/redaction.json``) must
reproduce byte for byte, a randomised differential file generated from the
TypeScript reference must too, and the switches must hold on the real wire —
including replay-on-attach, which is why redaction runs before the ring buffer.
"""

from __future__ import annotations

import json
import threading
from collections.abc import ItemsView, Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

import graphmind as gm
from graphmind.redaction import (
    DROP,
    FAILED_REDACTION_KEYS,
    REDACTED,
    RedactionSwitches,
    Redactor,
    env_flag_on,
    option_flag_on,
    resolve_redaction,
)

from .conftest import wait_until

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "packages" / "client" / "test" / "fixtures" / "redaction.json"
DIFFERENTIAL = Path(__file__).resolve().parent / "fixtures" / "differential.json"
RUN = "run-1"

_OPTION_NAMES = {
    "hideInputs": "hide_inputs",
    "hideOutputs": "hide_outputs",
    "hideToolArgs": "hide_tool_args",
    "hideToolResults": "hide_tool_results",
}


def on(**switches: bool) -> Redactor:
    return Redactor(RedactionSwitches(**switches))


def dumps(value: Any) -> str:
    """Byte-level comparison: key order and number spelling included."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def as_out(type_: str, result: Any) -> dict[str, Any]:
    """A fixture ``out`` entry: ``{type, payload}``, or ``{type, dropped: true}``
    when the redactor failed closed and dropped the event."""
    if result is DROP:
        return {"type": type_, "dropped": True}
    return {"type": type_, "payload": result}


FAILED = {"count": 0, "keys": ["input", "output", "deltas"], "failed": True}


# -- the cross-language conformance fixture -------------------------------------


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _cases() -> Iterator[Any]:
    for case in _fixture()["cases"]:
        yield pytest.param(case, id=case["name"][:80])


class TestConformanceFixture:
    def test_uses_the_shared_placeholder(self) -> None:
        fixture = _fixture()
        assert fixture["placeholder"] == REDACTED == "__REDACTED__"
        assert list(FAILED_REDACTION_KEYS) == FAILED["keys"] == ["input", "output", "deltas"]
        assert len(fixture["cases"]) >= 7

    @pytest.mark.parametrize("case", list(_cases()))
    def test_case_reproduces_byte_for_byte(self, case: dict[str, Any]) -> None:
        switches = {_OPTION_NAMES[k]: v for k, v in case["switches"].items()}
        redactor = Redactor(resolve_redaction(switches, {}))
        produced = [
            as_out(
                e["type"], redactor.apply(e["type"], e["payload"], "fixture-run", e.get("nodeKind"))
            )
            for e in case["in"]
        ]
        assert len(produced) == len(case["out"])
        for index, (got, want) in enumerate(zip(produced, case["out"], strict=True)):
            assert dumps(got) == dumps(want), f"{case['name']} [{index}]"

    @pytest.mark.parametrize("case", list(_cases()))
    def test_case_reproduces_through_the_environment_too(self, case: dict[str, Any]) -> None:
        env = {
            f"GRAPHMIND_{_OPTION_NAMES[k].upper()}": "true" if v else "0"
            for k, v in case["switches"].items()
        }
        redactor = Redactor(resolve_redaction(None, env))
        produced = [
            as_out(e["type"], redactor.apply(e["type"], e["payload"], "r", e.get("nodeKind")))
            for e in case["in"]
        ]
        assert dumps(produced) == dumps(case["out"])

    def test_is_not_vacuous(self) -> None:
        for case in _fixture()["cases"]:
            any_on = any(case["switches"].values())
            # Compared without `nodeKind`, which only `in` entries carry.
            events = [{"type": e["type"], "payload": e["payload"]} for e in case["in"]]
            assert (dumps(events) != dumps(case["out"])) is any_on, case["name"]

    def test_fixture_inputs_are_never_mutated(self) -> None:
        for case in _fixture()["cases"]:
            events = json.loads(dumps(case["in"]))
            before = dumps(events)
            redactor = on(
                hide_inputs=True, hide_outputs=True, hide_tool_args=True, hide_tool_results=True
            )
            for e in events:
                redactor.apply(e["type"], e["payload"], "r", e.get("nodeKind"))
            assert dumps(events) == before


class TestDifferential:
    """Randomised event streams run through the TypeScript Redactor
    (tests/fixtures/gen_differential.mjs) must come out identical here."""

    def test_every_generated_stream_matches_the_typescript_reference(self) -> None:
        data = json.loads(DIFFERENTIAL.read_text(encoding="utf-8"))
        # Streams holding unpaired surrogates are double-encoded (Ruby cannot parse them).
        streams = data["redaction"] + json.loads(data["redactionLoneSurrogates"])
        assert len(streams) >= 100
        compared = changed = dropped = failed = 0
        for index, stream in enumerate(streams):
            sw = stream["switches"]
            redactor = Redactor(
                RedactionSwitches(
                    sw["hideInputs"], sw["hideOutputs"], sw["hideToolArgs"], sw["hideToolResults"]
                )
            )
            for position, (event, want) in enumerate(zip(stream["in"], stream["out"], strict=True)):
                got = as_out(
                    event["type"], redactor.apply(event["type"], event["payload"], event["runId"])
                )
                assert dumps(got) == dumps(want), f"stream {index} event {position}"
                compared += 1
                changed += dumps(got.get("payload")) != dumps(event["payload"])
                dropped += "dropped" in got
                payload = got.get("payload")
                summary = payload.get("redaction") if isinstance(payload, dict) else None
                failed += isinstance(summary, dict) and summary.get("failed") is True
        assert compared > 1000
        assert dropped > 0 and failed > 0, "the differential file must exercise failing closed"
        assert changed > 200, "the differential file must exercise redaction, not only pass-through"


# -- switch parsing and precedence ---------------------------------------------


class TestSwitches:
    @pytest.mark.parametrize(
        "value", ["1", "true", "TRUE", " True ", "\t1\n", "yes", "on", "2", "1.0", "truee"]
    )
    def test_env_values_that_turn_a_switch_on(self, value: str) -> None:
        # A privacy switch fails closed on spelling: anything but an off word.
        assert env_flag_on(value) is True

    @pytest.mark.parametrize(
        "value", [None, "", "  ", "0", "false", "FALSE", " off ", "no", "No", 1, True]
    )
    def test_env_values_that_do_not(self, value: Any) -> None:
        assert env_flag_on(value) is False

    @pytest.mark.parametrize("value", [True, 1, 1.0, "1", "true", " TRUE "])
    def test_option_values_that_turn_a_switch_on(self, value: Any) -> None:
        assert option_flag_on(value) is True

    @pytest.mark.parametrize("value", [False, None, 0, 2, "no", "", [], {}, object()])
    def test_option_values_that_do_not(self, value: Any) -> None:
        assert option_flag_on(value) is False

    def test_either_source_turns_a_switch_on_and_env_is_a_floor(self) -> None:
        s = resolve_redaction(
            {"hide_inputs": False, "hide_outputs": True},
            {"GRAPHMIND_HIDE_INPUTS": "1", "GRAPHMIND_HIDE_TOOL_RESULTS": "true"},
        )
        assert s.as_dict() == {
            "hide_inputs": True,  # env on, option False cannot lower it
            "hide_outputs": True,
            "hide_tool_args": False,
            "hide_tool_results": True,
        }

    def test_hostile_options_and_env_never_raise(self) -> None:
        class Exploding(dict):  # type: ignore[type-arg]
            def get(self, *_: Any) -> Any:
                raise RuntimeError("boom")

        s = resolve_redaction(Exploding(), Exploding())
        assert s.any is False
        s = resolve_redaction(Exploding(), {"GRAPHMIND_HIDE_OUTPUTS": "1"})
        assert s.hide_outputs is True


# -- the rules, one by one ------------------------------------------------------


class TestRules:
    def test_off_returns_the_very_same_object(self) -> None:
        payload = {"nodeId": "tool:a", "kind": "tool", "name": "a", "input": {"s": 1}}
        assert on().apply("node.started", payload, RUN) is payload

    def test_never_mutates_the_callers_payload(self) -> None:
        payload = {
            "nodeId": "tool:a",
            "kind": "tool",
            "name": "a",
            "instanceId": "1",
            "input": {"s": 1},
        }
        out = on(hide_inputs=True).apply("node.started", payload, RUN)
        assert payload["input"] == {"s": 1} and "redaction" not in payload
        assert out["input"] == REDACTED and out["redaction"] == {"count": 1, "keys": ["input"]}

    def test_null_counts_as_a_value_and_absent_does_not(self) -> None:
        red = on(hide_outputs=True)
        assert (
            red.apply("node.finished", {"nodeId": "llm:x", "output": None}, RUN)["output"]
            == REDACTED
        )
        absent = {"nodeId": "llm:x", "durationMs": 1, "status": "ok"}
        # Equal, not the same object: with a switch on, node.* events are always
        # redacted from a one-read snapshot (fail closed; see TestFailsClosed).
        assert red.apply("node.finished", absent, RUN) == absent

    def test_chars_counts_utf16_code_units_like_javascript(self) -> None:
        out = on(hide_outputs=True).apply(
            "node.token",
            {"nodeId": "llm:x", "deltas": [{"t": "text", "v": "a😀é"}, {"t": "text", "v": "日本"}]},
            RUN,
        )
        assert [d["chars"] for d in out["deltas"]] == [4, 2]
        assert all(d["v"] == "" for d in out["deltas"])

    def test_node_error_is_never_redacted(self) -> None:
        payload = {
            "nodeId": "tool:a",
            "instanceId": "1",
            "error": {"name": "E", "message": "SECRET"},
        }
        red = on(hide_inputs=True, hide_outputs=True, hide_tool_args=True, hide_tool_results=True)
        assert red.apply("node.error", payload, RUN) is payload

    @pytest.mark.parametrize("count", [1.5, -1, float("nan"), float("inf"), 2**60, "3", True])
    def test_an_invalid_prior_count_is_not_carried_into_the_sum(self, count: Any) -> None:
        out = on(hide_outputs=True).apply(
            "node.finished",
            {"nodeId": "llm:x", "output": "S", "redaction": {"count": count, "keys": ["input"]}},
            RUN,
        )
        if isinstance(count, (str, bool)):
            # not a JS number: the summary is replaced, not merged
            assert out["redaction"] == {"count": 1, "keys": ["output"]}
        else:
            assert out["redaction"] == {"count": 1, "keys": ["input", "output"]}
        assert isinstance(out["redaction"]["count"], int)

    def test_an_integral_float_prior_count_merges_as_an_integer(self) -> None:
        out = on(hide_outputs=True).apply(
            "node.finished",
            {"nodeId": "llm:x", "output": "S", "redaction": {"count": 2.0, "keys": []}},
            RUN,
        )
        assert dumps(out["redaction"]) == '{"count":3,"keys":["output"]}'

    def test_tool_results_follow_the_instance_kind_not_the_node_prefix(self) -> None:
        red = on(hide_tool_results=True)
        red.apply(
            "node.started",
            {"nodeId": "custom:search", "kind": "tool", "name": "s", "instanceId": "1"},
            RUN,
        )
        red.apply(
            "node.started",
            {"nodeId": "tool:odd", "kind": "llm", "name": "o", "instanceId": "2"},
            RUN,
        )
        assert (
            red.apply(
                "node.finished", {"nodeId": "custom:search", "instanceId": "1", "output": 1}, RUN
            )["output"]
            == REDACTED
        )
        assert (
            red.apply("node.finished", {"nodeId": "tool:odd", "instanceId": "2", "output": 1}, RUN)[
                "output"
            ]
            == 1
        )

    def test_runs_are_kept_apart(self) -> None:
        red = on(hide_tool_results=True)
        red.apply(
            "node.started",
            {"nodeId": "x:a", "kind": "tool", "name": "a", "instanceId": "1"},
            "run-a",
        )
        red.apply(
            "node.started",
            {"nodeId": "x:a", "kind": "llm", "name": "a", "instanceId": "1"},
            "run-b",
        )
        assert (
            red.apply("node.finished", {"nodeId": "x:a", "instanceId": "1", "output": 1}, "run-a")[
                "output"
            ]
            == REDACTED
        )
        assert (
            red.apply("node.finished", {"nodeId": "x:a", "instanceId": "1", "output": 1}, "run-b")[
                "output"
            ]
            == 1
        )

    def test_instance_tracking_is_bounded_and_forgets_finished_instances(self) -> None:
        red = Redactor(RedactionSwitches(hide_tool_results=True), max_instances=50)
        for i in range(500):
            red.apply(
                "node.started",
                {"nodeId": f"x:{i}", "kind": "tool", "name": "n", "instanceId": str(i)},
                RUN,
            )
        assert red.tracked_instances == 50
        red.apply("node.finished", {"nodeId": "x:499", "instanceId": "499", "output": 1}, RUN)
        assert red.tracked_instances == 49

    def test_hostile_payloads_never_raise_and_never_pass_through(self) -> None:
        # Was "comes back as the very same object" before redaction failed closed
        # (internal/decisions.md): a payload the redactor cannot read is never sent
        # raw while a switch is on.
        class Exploding(dict):  # type: ignore[type-arg]
            def get(self, *_: Any) -> Any:
                raise RuntimeError("boom")

        red = on(hide_inputs=True, hide_outputs=True, hide_tool_results=True)
        hidden = {"node.started": "input", "node.finished": "output"}
        for type_ in ("node.started", "node.finished", "node.token"):
            hostile = Exploding(nodeId="tool:a", input="S", output="S")
            out = red.apply(type_, hostile, RUN)
            assert isinstance(out, dict) and out is not hostile
            if type_ in hidden:
                assert out[hidden[type_]] == REDACTED
            else:  # no deltas under a covering switch: the failed form
                assert out == {"nodeId": "tool:a", "deltas": [], "redaction": FAILED}
            assert red.apply(type_, "not a dict", RUN) is DROP
            assert red.apply(type_, None, RUN) is DROP

    def test_concurrent_threads_never_corrupt_the_tracking(self) -> None:
        red = on(hide_tool_results=True)
        errors: list[BaseException] = []

        def worker(n: int) -> None:
            try:
                for i in range(300):
                    iid = f"{n}-{i}"
                    red.apply(
                        "node.started",
                        {"nodeId": f"x:{n}", "kind": "tool", "name": "x", "instanceId": iid},
                        RUN,
                    )
                    out = red.apply(
                        "node.finished", {"nodeId": f"x:{n}", "instanceId": iid, "output": i}, RUN
                    )
                    assert out["output"] == REDACTED
            except BaseException as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        assert errors == []
        assert red.tracked_instances == 0


# -- on the real wire -------------------------------------------------------------


def _frames(view: Any, type_: str) -> list[dict[str, Any]]:
    return view.of_type(type_)


class TestSession:
    def test_env_switch_hides_tool_args_and_results_on_the_wire_but_not_from_the_host(
        self, attached: Any, validate_frame: Any
    ) -> None:
        instance, view = attached(
            gm_options={
                "env": {"GRAPHMIND_HIDE_TOOL_ARGS": "1", "GRAPHMIND_HIDE_TOOL_RESULTS": "true"}
            }
        )

        @instance.tool
        def lookup(email: str) -> dict[str, str]:
            return {"ssn": "123-45-6789", "email": email}

        with instance.run("r"):
            with instance.span("plan", kind="custom", input={"prompt": "VISIBLE-PROMPT"}) as span:
                span.set_output({"plan": "VISIBLE-PLAN"})
            result = lookup("alice@example.com")
        assert result == {"ssn": "123-45-6789", "email": "alice@example.com"}  # host untouched

        wait_until(lambda: len(_frames(view, "run.finished")) == 1, label="run.finished")
        raw = json.dumps(view.frames())
        assert "alice@example.com" not in raw and "123-45-6789" not in raw
        assert "VISIBLE-PROMPT" in raw and "VISIBLE-PLAN" in raw
        started = next(
            f for f in _frames(view, "node.started") if f["payload"]["nodeId"] == "tool:lookup"
        )
        finished = next(
            f for f in _frames(view, "node.finished") if f["payload"]["nodeId"] == "tool:lookup"
        )
        assert started["payload"]["input"] == REDACTED
        assert started["payload"]["redaction"] == {"count": 1, "keys": ["input"]}
        assert finished["payload"]["output"] == REDACTED
        assert finished["payload"]["redaction"] == {"count": 1, "keys": ["output"]}
        assert finished["payload"]["heldMs"] == 0  # the other bookkeeping still runs
        for frame in view.frames():
            if frame.get("type") not in ("hello",):
                validate_frame(frame)

    def test_option_hides_outputs_and_streamed_tokens(self, attached: Any) -> None:
        instance, view = attached(gm_options={"hide_outputs": True, "token_interval": 0.001})
        session = instance.session
        with instance.run("r"):
            session.start_node("llm:step", "llm", "step", "l1", input={"messages": ["VISIBLE-IN"]})
            session.push_token("llm:step", "text", "SECRET-TOKEN-😀")
            session.flush()
            session.error_node("llm:step", "l1", ValueError("error text stays: E-CLUE"))
            session.finish_node("llm:step", "l1", 3.14159, output={"text": "SECRET-OUT"})
        wait_until(lambda: len(_frames(view, "run.finished")) == 1, label="run.finished")
        raw = json.dumps(view.frames(), ensure_ascii=False)
        assert "SECRET-TOKEN" not in raw and "SECRET-OUT" not in raw
        assert "VISIBLE-IN" in raw and "E-CLUE" in raw
        token = _frames(view, "node.token")[0]["payload"]
        assert token["deltas"] == [{"t": "text", "v": "", "chars": 15}]
        finished = next(
            f for f in _frames(view, "node.finished") if f["payload"]["nodeId"] == "llm:step"
        )
        assert finished["payload"]["durationMs"] == 3.14

    def test_redaction_happens_before_the_ring_buffer_so_replay_on_attach_is_redacted(
        self, make_gm: Any, viewer: Any
    ) -> None:
        view = viewer()
        instance = make_gm(url=view.url, env={"GRAPHMIND_HIDE_INPUTS": "1"})
        # Emitted while detached: these sit in the ring buffer.
        with instance.run("early"):
            instance.session.start_node("tool:t", "tool", "t", "1", input={"k": "BUFFERED-SECRET"})
            instance.session.finish_node("tool:t", "1", 1.0, output="ok")
        assert instance.ready(timeout=5.0)
        wait_until(lambda: len(_frames(view, "run.finished")) >= 1, label="replayed run.finished")
        raw = json.dumps(view.frames())
        assert "BUFFERED-SECRET" not in raw
        assert _frames(view, "node.started")[-1]["payload"]["input"] == REDACTED

    def test_env_floor_beats_an_option_that_tries_to_lower_it(self, attached: Any) -> None:
        instance, view = attached(
            gm_options={"hide_inputs": False, "env": {"GRAPHMIND_HIDE_INPUTS": "1"}}
        )
        instance.emit(
            "node.started", {"nodeId": "llm:x", "kind": "llm", "name": "x", "input": "SECRET"}
        )
        frame = view.wait_for(lambda f: f.get("type") == "node.started")
        assert frame["payload"]["input"] == REDACTED

    def test_process_environment_is_read_when_no_env_is_passed(
        self, monkeypatch: Any, viewer: Any
    ) -> None:
        monkeypatch.setenv("GRAPHMIND_HIDE_TOOL_ARGS", "1")
        view = viewer()
        instance = gm.GraphMind(
            url=view.url, enabled=True, retry_interval=60.0, logger=lambda m: None
        )
        try:
            assert instance.ready(timeout=5.0)
            instance.emit(
                "node.started", {"nodeId": "tool:x", "kind": "tool", "name": "x", "input": "SECRET"}
            )
            frame = view.wait_for(lambda f: f.get("type") == "node.started")
            assert frame["payload"]["input"] == REDACTED
        finally:
            instance.dispose()

    def test_disabled_session_is_a_no_op(self, make_gm: Any) -> None:
        instance = make_gm(enabled=False, hide_inputs=True)
        instance.emit(
            "node.started", {"nodeId": "tool:x", "kind": "tool", "name": "x", "input": "S"}
        )
        assert instance.stats().seq == 0


# -- fails closed (internal/decisions.md "Redaction fails closed on internal error") --


SECRET = "FAILCLOSED-CANARY-7c1e"
ALL_ON = {
    "hide_inputs": True,
    "hide_outputs": True,
    "hide_tool_args": True,
    "hide_tool_results": True,
}


class Hostile(Mapping[str, Any]):
    """A mapping that holds real fields but raises on the reads named in ``bad``
    (``"*"`` = the whole-mapping reads ``items`` / ``__iter__`` / ``__len__``).
    Records every key read, so a test can prove a hidden field was never read."""

    def __init__(self, data: dict[str, Any], bad: set[str]) -> None:
        self._data = data
        self._bad = bad
        self.reads: list[str] = []

    def __getitem__(self, key: str) -> Any:
        self.reads.append(key)
        if key in self._bad:
            raise RuntimeError(f"read of {key} raised {SECRET}")
        return self._data[key]

    def __iter__(self) -> Any:
        if "*" in self._bad:
            raise RuntimeError(SECRET)
        return iter(self._data)

    def __len__(self) -> int:
        if "*" in self._bad:
            raise RuntimeError(SECRET)
        return len(self._data)

    def items(self) -> Any:
        if "*" in self._bad:
            raise RuntimeError(SECRET)
        return ItemsView(self)


def started_payload(**extra: Any) -> dict[str, Any]:
    return {
        "nodeId": "tool:lookup",
        "parentId": "agent:root",
        "kind": "tool",
        "name": "lookup",
        "instanceId": "i1",
        "input": {"email": SECRET},
        "loose": SECRET,
        **extra,
    }


def finished_payload(**extra: Any) -> dict[str, Any]:
    return {
        "nodeId": "tool:lookup",
        "instanceId": "i1",
        "durationMs": 12.5,
        "heldMs": 3,
        "status": "ok",
        "usage": {"inputTokens": 1, "outputTokens": 2.0},
        "output": {"ssn": SECRET},
        "loose": SECRET,
        **extra,
    }


def recording() -> tuple[list[tuple[str, str]], Any]:
    warnings: list[tuple[str, str]] = []
    return warnings, lambda key, message: warnings.append((key, message))


class TestFailsClosed:
    def test_node_started_whose_reads_raise_gets_the_failed_form_and_input_is_never_read(
        self, validate_frame: Any
    ) -> None:
        warnings, warn = recording()
        red = Redactor(RedactionSwitches(hide_tool_args=True), warn=warn)
        hostile = Hostile(started_payload(), {"*"})
        out = red.apply("node.started", hostile, RUN)
        assert dumps(out) == dumps(
            {
                "nodeId": "tool:lookup",
                "parentId": "agent:root",
                "kind": "tool",
                "name": "lookup",
                "instanceId": "i1",
                "input": REDACTED,
                "redaction": FAILED,
            }
        )
        assert "input" not in hostile.reads and SECRET not in dumps(out)
        assert [key for key, _ in warnings] == ["redaction:failed"]
        assert SECRET not in warnings[0][1]  # never quotes the error or the payload
        validate_frame(
            {"gm": 1, "seq": 0, "ts": 1, "runId": RUN, "type": "node.started", "payload": out}
        )
        # The kind was still learned: this instance's node.finished is judged a tool.
        red2 = Redactor(RedactionSwitches(hide_tool_results=True))
        red2.apply("node.started", Hostile(started_payload(nodeId="x:odd"), {"*"}), RUN)
        finished = red2.apply("node.finished", finished_payload(nodeId="x:odd"), RUN)
        assert finished["output"] == REDACTED

    def test_node_finished_whose_output_read_raises_keeps_timing_status_usage(
        self, validate_frame: Any
    ) -> None:
        red = on(hide_outputs=True)
        hostile = Hostile(finished_payload(), {"*", "output"})
        out = red.apply("node.finished", hostile, RUN)
        assert dumps(out) == dumps(
            {
                "nodeId": "tool:lookup",
                "instanceId": "i1",
                "durationMs": 12.5,
                "heldMs": 3,
                "status": "ok",
                "usage": {"inputTokens": 1, "outputTokens": 2},
                "output": REDACTED,
                "redaction": FAILED,
            }
        )
        assert "output" not in hostile.reads
        validate_frame(
            {"gm": 1, "seq": 0, "ts": 1, "runId": RUN, "type": "node.finished", "payload": out}
        )

    def test_node_token_whose_deltas_cannot_be_read_keeps_identity_and_empties_deltas(
        self,
    ) -> None:
        red = on(hide_outputs=True)
        hostile = Hostile(
            {"nodeId": "llm:a", "instanceId": "i", "deltas": [{"t": "text", "v": SECRET}]},
            {"*", "deltas"},
        )
        out = red.apply("node.token", hostile, RUN)
        assert out == {"nodeId": "llm:a", "instanceId": "i", "deltas": [], "redaction": FAILED}
        assert "deltas" not in hostile.reads
        # A tuple of deltas is an array on the wire: redacted, not failed.
        tup = red.apply(
            "node.token", {"nodeId": "llm:a", "deltas": ({"t": "text", "v": "ab"},)}, RUN
        )
        assert tup["deltas"] == [{"t": "text", "v": "", "chars": 2}]

    @pytest.mark.parametrize(
        ("type_", "field"),
        [
            ("node.started", "nodeId"),
            ("node.started", "kind"),
            ("node.started", "name"),
            ("node.started", "instanceId"),
            ("node.finished", "nodeId"),
            ("node.finished", "durationMs"),
            ("node.finished", "status"),
            ("node.token", "nodeId"),
        ],
    )
    def test_an_unreadable_required_field_drops_the_event_with_one_warning(
        self, type_: str, field: str
    ) -> None:
        warnings, warn = recording()
        red = Redactor(RedactionSwitches(**ALL_ON), warn=warn)
        base = {
            "node.started": started_payload(),
            "node.finished": finished_payload(),
            "node.token": {"nodeId": "llm:a", "deltas": [{"t": "text", "v": SECRET}]},
        }[type_]
        assert red.apply(type_, Hostile(base, {"*", field}), RUN) is DROP
        assert [key for key, _ in warnings] == ["redaction:dropped"]
        assert SECRET not in warnings[0][1]

    @pytest.mark.parametrize("field", ["parentId", "heldMs", "usage", "instanceId"])
    def test_an_unreadable_optional_field_is_omitted(self, field: str) -> None:
        red = on(**ALL_ON)
        if field == "parentId":
            out = red.apply("node.started", Hostile(started_payload(), {"*", field}), RUN)
        else:
            out = red.apply("node.finished", Hostile(finished_payload(), {"*", field}), RUN)
        assert out is not DROP and field not in out and out["redaction"] == FAILED

    def test_schema_invalid_required_fields_drop_and_invalid_optional_fields_are_omitted(
        self, validate_frame: Any
    ) -> None:
        red = on(**ALL_ON)
        for bad in (
            {"kind": "robot"},
            {"kind": 3},
            {"name": None},
            {"instanceId": 7},
            {"nodeId": ["x"]},
        ):
            assert red.apply("node.started", Hostile(started_payload(**bad), {"*"}), RUN) is DROP
        for bad in (
            {"durationMs": -1},
            {"durationMs": float("nan")},
            {"durationMs": float("inf")},
            {"durationMs": True},
            {"durationMs": 10**400},
            {"status": "done"},
        ):
            assert red.apply("node.finished", Hostile(finished_payload(**bad), {"*"}), RUN) is DROP
        out = red.apply(
            "node.finished",
            Hostile(
                finished_payload(
                    instanceId=5,
                    heldMs=-2,
                    usage={"inputTokens": -1, "outputTokens": 2},
                ),
                {"*"},
            ),
            RUN,
        )
        assert out == {
            "nodeId": "tool:lookup",
            "durationMs": 12.5,
            "status": "ok",
            "output": REDACTED,
            "redaction": FAILED,
        }
        started = red.apply("node.started", Hostile(started_payload(parentId=9), {"*"}), RUN)
        assert "parentId" not in started
        for payload, type_ in ((out, "node.finished"), (started, "node.started")):
            validate_frame(
                {"gm": 1, "seq": 0, "ts": 1, "runId": RUN, "type": type_, "payload": payload}
            )

    @pytest.mark.parametrize("junk", [None, 42, "SECRET-STRING", ["SECRET"], object(), b"SECRET"])
    def test_a_payload_that_is_not_a_mapping_is_dropped(self, junk: Any) -> None:
        red = on(hide_tool_args=True)
        for type_ in ("node.started", "node.finished", "node.token"):
            assert red.apply(type_, junk, RUN) is DROP

    def test_a_raising_warn_sink_and_a_mapping_whose_every_read_raises_never_raise(self) -> None:
        def sink(key: str, message: str) -> None:
            raise RuntimeError("sink")

        class Everything(Mapping[str, Any]):
            def __getitem__(self, key: str) -> Any:
                raise KeyboardInterruptLike()

            def __iter__(self) -> Any:
                raise RuntimeError("iter")

            def __len__(self) -> int:
                raise RuntimeError("len")

            def __contains__(self, key: object) -> bool:
                raise RuntimeError("contains")

        class KeyboardInterruptLike(Exception):
            pass

        red = Redactor(RedactionSwitches(**ALL_ON), warn=sink)
        for type_ in ("node.started", "node.finished", "node.token"):
            assert red.apply(type_, Everything(), RUN) is DROP

        class BadClass:
            @property  # type: ignore[misc]
            def __class__(self) -> Any:
                raise RuntimeError("isinstance reads __class__")

        for type_ in ("node.started", "node.finished", "node.token"):
            assert red.apply(type_, BadClass(), RUN) is DROP

    def test_closes_the_non_raising_ways_past_the_switch(self) -> None:
        red = on(hide_inputs=True, hide_outputs=True)

        class LyingContains(dict):  # type: ignore[type-arg]
            def __contains__(self, key: object) -> bool:
                return False

        out = red.apply("node.started", LyingContains(started_payload()), RUN)
        assert out["input"] == REDACTED and SECRET not in dumps(
            {k: v for k, v in out.items() if k != "loose"}
        )

        class Stateful(dict):  # type: ignore[type-arg]
            """items() answers differently on its second read."""

            calls = 0

            def items(self) -> Any:
                Stateful.calls += 1
                if Stateful.calls == 1:
                    return [
                        ("nodeId", "llm:x"),
                        ("durationMs", 1),
                        ("status", "ok"),
                        ("output", "safe"),
                    ]
                return [("nodeId", "llm:x"), ("output", SECRET)]

        out = red.apply("node.finished", Stateful(), RUN)
        # What was inspected is what is sent: a plain dict, not the stateful object.
        assert type(out) is dict and dumps(out).count(SECRET) == 0
        assert json.dumps(out) == json.dumps(out)

        class LiarKey(str):
            __hash__ = str.__hash__

            def __eq__(self, other: object) -> bool:
                return False

        class HashKey(str):
            def __hash__(self) -> int:
                return 12345

        for key_type in (LiarKey, HashKey):
            payload = {"nodeId": "tool:a", "kind": "tool", "name": "a", key_type("input"): SECRET}
            out = red.apply("node.started", payload, RUN)
            assert SECRET not in json.dumps(out), key_type

        class LiarStr(str):
            def __eq__(self, other: object) -> bool:
                return True

            __hash__ = str.__hash__

        # a value that claims to be the placeholder / an empty text is still hidden
        out = red.apply(
            "node.started",
            {"nodeId": "llm:a", "kind": "llm", "name": "a", "input": LiarStr(SECRET)},
            RUN,
        )
        assert out["input"] == REDACTED
        tok = red.apply(
            "node.token", {"nodeId": "llm:a", "deltas": [{"t": "text", "v": LiarStr(SECRET)}]}, RUN
        )
        assert SECRET not in json.dumps(tok) and tok["deltas"][0]["chars"] == len(SECRET)
        # a channel that lies about being tool-args under hide_tool_args
        red_args = on(hide_tool_args=True)

        class NotToolArgs(str):
            def __eq__(self, other: object) -> bool:
                return False

            __hash__ = str.__hash__

        tok = red_args.apply(
            "node.token",
            {"nodeId": "llm:a", "deltas": [{"t": NotToolArgs("tool-args"), "v": SECRET}]},
            RUN,
        )
        assert SECRET not in json.dumps(tok)
        # and a kind that lies about being a tool under hide_tool_args
        out = red_args.apply(
            "node.started",
            {"nodeId": "x:a", "kind": NotToolArgs("tool"), "name": "a", "input": SECRET},
            RUN,
        )
        assert out["input"] == REDACTED

    def test_with_every_switch_off_a_hostile_payload_passes_through_untouched(self) -> None:
        red = on()
        hostile = Hostile(started_payload(), {"*", "input", "nodeId"})
        assert red.apply("node.started", hostile, RUN) is hostile
        assert hostile.reads == []

    def test_other_event_types_are_never_inspected_even_with_a_switch_on(self) -> None:
        red = on(**ALL_ON)
        # exec.resumed / exec.refused are inspected since 0.6.0 (edited input,
        # contract C2): see TestPauseAnswers.
        for type_ in ("node.error", "run.started", "run.finished", "exec.paused", "graph.hint"):
            hostile = Hostile({"nodeId": "x"}, {"*", "nodeId"})
            assert red.apply(type_, hostile, RUN) is hostile and hostile.reads == []
        assert red.apply("node.error", "raw", RUN) == "raw"


class TestFailsClosedOnTheWire:
    def test_hostile_payloads_never_put_a_hidden_value_on_the_wire_live_or_replayed(
        self, make_gm: Any, viewer: Any, validate_frame: Any
    ) -> None:
        logs: list[str] = []
        view = viewer()
        instance = make_gm(
            url=view.url,
            env={"GRAPHMIND_HIDE_INPUTS": "1", "GRAPHMIND_HIDE_OUTPUTS": "1"},
            logger=logs.append,
        )
        session = instance.session

        def hostile_burst(run: str) -> None:
            with instance.run(run):
                # failed form: identity readable, whole-mapping reads raise
                session.emit("node.started", Hostile(started_payload(), {"*", "input"}))
                session.emit(
                    "node.token", Hostile({"nodeId": "tool:lookup", "deltas": [SECRET]}, {"*"})
                )
                session.emit(
                    "node.token",
                    {"nodeId": "tool:lookup", "deltas": [{"t": "text", "v": {"s": SECRET}}]},
                )
                session.emit("node.finished", Hostile(finished_payload(), {"*", "output"}))
                # dropped: nothing identifiable
                session.emit("node.started", Hostile(started_payload(), {"*", "nodeId"}))
                session.emit("node.started", SECRET)  # type: ignore[arg-type]
                # and the session keeps working
                session.start_node("tool:ok", "tool", "ok", "k1", input={"q": SECRET})
                session.finish_node("tool:ok", "k1", 1.0, output=SECRET)

        hostile_burst("detached")  # buffered, replayed on attach
        assert instance.ready(timeout=5.0)
        hostile_burst("attached")
        wait_until(lambda: len(view.of_type("run.finished")) == 2, label="both runs finished")
        frames = view.frames()
        raw = json.dumps(frames, ensure_ascii=False)
        assert SECRET not in raw
        for frame in frames:
            if frame.get("type") != "hello":
                validate_frame(frame)
        failed = [
            f
            for f in frames
            if isinstance(f.get("payload"), dict)
            and f["payload"].get("redaction", {}).get("failed")
        ]
        assert len(failed) == 8  # started + 2 tokens + finished, per run
        assert {f["runId"] for f in failed}.__len__() == 2
        ok_started = [
            f for f in view.of_type("node.started") if f["payload"]["nodeId"] == "tool:ok"
        ]
        assert len(ok_started) == 2 and ok_started[0]["payload"]["input"] == REDACTED
        # one rate-limited warning per outcome, never quoting the data or the error
        assert len([m for m in logs if "redaction failed" in m]) == 1
        assert len([m for m in logs if "dropped it" in m]) == 1
        assert SECRET not in "\n".join(logs)

    def test_a_dropped_event_takes_no_seq_and_never_raises_even_when_the_logger_raises(
        self, attached: Any
    ) -> None:
        """A dropped event takes no seq (decisions.md, loop v3 / fail-closed).

        It used to take one, leaving a hole the receiver cannot tell from a lost
        event. TypeScript and Ruby behave this way too; the three are pinned by
        the same cross-language probe.
        """

        def logger(message: str) -> None:
            raise RuntimeError("logger")

        instance, view = attached(gm_options={"hide_tool_args": True, "logger": logger})
        session = instance.session
        with instance.run("r"):
            before = instance.stats().seq
            session.emit("node.started", Hostile(started_payload(), {"*", "kind"}))
            session.emit("node.started", None)  # type: ignore[arg-type]
            assert instance.stats().seq == before  # nothing sent, no seq spent
            session.start_node("tool:t", "tool", "t", "1", input=SECRET)
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        seqs = [f["seq"] for f in view.frames() if f.get("type") != "hello"]
        # The next event that IS sent takes the seq the drops did not, and the
        # stream the viewer sees has no hole in it.
        assert before in seqs
        assert seqs == sorted(seqs) and seqs == list(range(seqs[0], seqs[0] + len(seqs)))
        starts = [f for f in view.of_type("node.started") if f["payload"]["nodeId"] != "agent:r"]
        assert [f["payload"]["nodeId"] for f in starts] == ["tool:t"], starts
        assert starts[0]["payload"]["input"] == REDACTED
        assert SECRET not in json.dumps(view.frames())


class TestFailsClosedOnIdentityFieldsThatAreNotStrings:
    """Verifier pass (loop v3 / fail-closed, 2026-09-14). The switches decide by
    identity fields — a start's ``kind``, the ``nodeId`` / ``instanceId`` a
    result's kind is looked up by, a delta's ``t`` — but the wire serializer's
    fallback turns ``bytes`` (decoded), ``model_dump()`` / ``to_dict()`` results
    and ``repr`` into strings. Before the fix ``kind=b"tool"`` was "not a tool"
    to the redactor while the frame said ``"kind": "tool"`` with the arguments
    visible: a schema-valid event carrying the hidden value."""

    CANARY = "COERCED-CANARY-9b2f"

    class _Repr:
        def __init__(self, text: str) -> None:
            self.text = text

        def __repr__(self) -> str:
            return self.text

    class _Dump:
        def __init__(self, text: str) -> None:
            self.text = text

        def model_dump(self) -> str:
            return self.text

    def test_bytes_repr_or_model_dump_identities_never_smuggle_a_hidden_value_onto_the_wire(
        self, make_gm: Any, viewer: Any, validate_frame: Any
    ) -> None:
        canary = self.CANARY
        logs: list[str] = []
        view = viewer()
        instance = make_gm(
            url=view.url,
            env={"GRAPHMIND_HIDE_TOOL_ARGS": "1", "GRAPHMIND_HIDE_TOOL_RESULTS": "1"},
            logger=logs.append,
        )
        assert instance.ready(timeout=5.0)
        session = instance.session
        r, d = self._Repr, self._Dump
        with instance.run("coerced"):
            # a start's kind
            for kind in (b"tool", r("tool"), d("tool")):
                session.emit(
                    "node.started",
                    {
                        "nodeId": "tool:a",
                        "kind": kind,
                        "name": "a",
                        "instanceId": "a1",
                        "input": {"q": canary},
                    },
                )
            # a result whose own nodeId / instanceId is not a str
            session.emit(
                "node.started",
                {"nodeId": "mcp:d", "kind": "tool", "name": "d", "instanceId": "d1", "input": 1},
            )
            session.emit(
                "node.finished",
                {
                    "nodeId": b"mcp:d",
                    "instanceId": "d1",
                    "durationMs": 1,
                    "status": "ok",
                    "output": {"r": canary},
                },
            )
            session.emit(
                "node.started",
                {"nodeId": "mcp:e", "kind": "tool", "name": "e", "instanceId": "e1", "input": 1},
            )
            session.emit(
                "node.started",
                {"nodeId": "mcp:e", "kind": "llm", "name": "e", "instanceId": "e2", "input": 1},
            )
            session.emit(
                "node.finished",
                {
                    "nodeId": "mcp:e",
                    "instanceId": r("e1"),
                    "durationMs": 1,
                    "status": "ok",
                    "output": {"r": canary},
                },
            )
            # tokens: a coerced nodeId of a tool, a coerced tool-args channel
            session.emit(
                "node.token", {"nodeId": r("mcp:e"), "deltas": [{"t": "text", "v": canary}]}
            )
            session.emit(
                "node.token", {"nodeId": "llm:f", "deltas": [{"t": b"tool-args", "v": canary}]}
            )
            session.emit(
                "node.token", {"nodeId": "llm:f", "deltas": [{"t": d("tool-args"), "v": canary}]}
            )
            # the session keeps streaming and still redacts a well-formed call
            session.start_node("tool:after", "tool", "after", "z1", input={"q": canary})
        wait_until(lambda: len(view.of_type("run.finished")) == 1, label="run.finished")
        frames = view.frames()
        assert canary not in json.dumps(frames, ensure_ascii=False)
        for frame in frames:
            if frame.get("type") != "hello":
                validate_frame(frame)
        starts = [f["payload"]["nodeId"] for f in view.of_type("node.started")]
        assert starts == ["agent:coerced", "mcp:d", "mcp:e", "mcp:e", "tool:after"], starts
        failed = {"count": 0, "keys": ["input", "output", "deltas"], "failed": True}
        finished = [
            f["payload"]
            for f in view.of_type("node.finished")
            if f["payload"]["nodeId"] != "agent:coerced"
        ]
        assert [
            (p["nodeId"], "instanceId" in p, p["output"], p["redaction"]) for p in finished
        ] == [("mcp:e", False, REDACTED, failed)], finished
        tokens = [f["payload"] for f in view.of_type("node.token")]
        assert tokens == [
            {"nodeId": "llm:f", "deltas": [], "redaction": failed},
            {"nodeId": "llm:f", "deltas": [], "redaction": failed},
        ], tokens
        assert canary not in "\n".join(logs)
        assert len([m for m in logs if "dropped it" in m]) == 1
        assert len([m for m in logs if "redaction failed" in m]) == 1


# -- exec.resumed / exec.refused (edited input, contract C2) ---------------------

EDIT_CANARY = "EDIT-CANARY-5e1f0"
RESUMED = {
    "pauseId": "pause_1",
    "action": "continue",
    "edited": {"after": {"q": EDIT_CANARY}},
    "requestId": "req-1",
}
REFUSED = {
    "pauseId": "pause_1",
    "code": "schema",
    "message": f"q must not be {EDIT_CANARY}",
    "requestId": "req-1",
}


class TestPauseAnswers:
    """Parity with ``packages/client/test/redaction-edit.test.ts`` (Redactor part);
    the live-session half is in test_edit_input_session.py."""

    @pytest.mark.parametrize(
        ("switches", "kind", "covered"),
        [
            ({"hide_inputs": True}, "tool", True),
            ({"hide_inputs": True}, "llm", True),
            ({"hide_tool_args": True}, "tool", True),
            ({"hide_tool_args": True}, "llm", False),
            ({"hide_tool_args": True}, None, True),
            ({"hide_tool_args": True}, 7, True),  # not a string: unknown, counts as a tool
            ({"hide_outputs": True}, "tool", False),
            ({"hide_tool_results": True}, "tool", False),
            ({}, "tool", False),
        ],
    )
    def test_coverage_matrix(self, switches: dict[str, bool], kind: Any, covered: bool) -> None:
        red = on(**switches)
        resumed = red.apply("exec.resumed", RESUMED, RUN, kind)
        refused = red.apply("exec.refused", REFUSED, RUN, kind)
        assert red.covers_pause_input(kind) is covered
        if not covered:
            # Not covered: the very same objects, nothing copied.
            assert resumed is RESUMED and refused is REFUSED
            return
        assert dumps(resumed) == dumps(
            {
                "pauseId": "pause_1",
                "action": "continue",
                "edited": {"after": REDACTED},
                "requestId": "req-1",
                "redaction": {"count": 1, "keys": ["edited"]},
            }
        )
        assert dumps(refused) == dumps(
            {
                "pauseId": "pause_1",
                "code": "schema",
                "requestId": "req-1",
                "redaction": {"count": 1, "keys": ["message"]},
            }
        )
        # The integration's objects are never modified.
        assert RESUMED["edited"] == {"after": {"q": EDIT_CANARY}}
        assert EDIT_CANARY in REFUSED["message"]

    def test_a_str_subclass_kind_is_judged_by_its_plain_value(self) -> None:
        class Lying(str):
            def __eq__(self, other: object) -> bool:
                return False

            __hash__ = str.__hash__

        assert on(hide_tool_args=True).covers_pause_input(Lying("tool")) is True

    def test_other_types_ignore_the_kind(self) -> None:
        red = on(hide_tool_args=True)
        payload = {"pauseId": "p", "nodeId": "tool:x", "point": "before"}
        assert red.apply("exec.paused", payload, RUN, "tool") is payload

    def test_resumed_whose_edited_read_raises_gets_the_failed_form(self) -> None:
        warnings: list[str] = []
        red = Redactor(
            RedactionSwitches(hide_tool_args=True), warn=lambda key, _m: warnings.append(key)
        )
        hostile = Hostile(
            {"pauseId": "pause_9", "action": "retry", "requestId": "rq", "edited": {"after": SECRET}},
            {"*", "edited"},
        )
        out = red.apply("exec.resumed", hostile, RUN, "tool")
        assert dumps(out) == dumps(
            {
                "pauseId": "pause_9",
                "action": "retry",
                "edited": {"after": REDACTED},
                "requestId": "rq",
                "redaction": {"count": 0, "keys": ["edited"], "failed": True},
            }
        )
        assert warnings == ["redaction:failed"]
        assert "edited" in hostile.reads  # read only to learn it may be there

    def test_resumed_without_edited_keeps_no_edit_in_its_failed_form(self) -> None:
        red = on(hide_inputs=True)
        hostile = Hostile({"pauseId": "p", "action": "abort"}, {"*"})
        out = red.apply("exec.resumed", hostile, RUN, "llm")
        assert dumps(out) == dumps(
            {
                "pauseId": "p",
                "action": "abort",
                "redaction": {"count": 0, "keys": ["edited"], "failed": True},
            }
        )

    def test_refused_whose_message_read_raises_gets_the_failed_form(self) -> None:
        red = on(hide_inputs=True)
        hostile = Hostile({"pauseId": "pause_2", "code": "schema", "message": SECRET}, {"*"})
        out = red.apply("exec.refused", hostile, RUN, "tool")
        assert dumps(out) == dumps(
            {
                "pauseId": "pause_2",
                "code": "schema",
                "redaction": {"count": 0, "keys": ["message"], "failed": True},
            }
        )
        assert "message" not in hostile.reads

    @pytest.mark.parametrize(
        ("type_", "fields"),
        [
            ("exec.resumed", {"pauseId": "p", "action": "explode"}),
            ("exec.resumed", {"pauseId": b"p", "action": "continue"}),
            ("exec.refused", {"pauseId": "p", "code": "nope"}),
            ("exec.refused", {"pauseId": "p"}),
        ],
    )
    def test_an_invalid_identity_in_a_hostile_payload_is_dropped(
        self, type_: str, fields: dict[str, Any]
    ) -> None:
        warnings: list[str] = []
        red = Redactor(
            RedactionSwitches(hide_inputs=True), warn=lambda key, _m: warnings.append(key)
        )
        assert red.apply(type_, Hostile(fields, {"*"}), RUN, "tool") is DROP
        assert warnings == ["redaction:dropped"]

    def test_a_bytes_pause_id_is_not_inspectable(self) -> None:
        red = on(hide_inputs=True)
        assert red.apply("exec.refused", {**REFUSED, "pauseId": b"pause_1"}, RUN, "tool") is DROP

    def test_never_raises(self) -> None:
        class Evil(Mapping[str, Any]):
            def __getitem__(self, key: str) -> Any:
                raise RuntimeError(SECRET)

            def __iter__(self) -> Any:
                raise RuntimeError(SECRET)

            def __len__(self) -> int:
                raise RuntimeError(SECRET)

        red = on(hide_inputs=True, hide_tool_args=True)
        for type_ in ("exec.resumed", "exec.refused"):
            assert red.apply(type_, Evil(), RUN, "tool") is DROP
