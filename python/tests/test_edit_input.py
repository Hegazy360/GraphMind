"""The pure pieces of edited input (contract C2), Python port.

Parity with ``packages/client/test/edit-input.test.ts``: the shared
conformance fixture (``packages/client/test/fixtures/edit-input.json``) must
reproduce byte for byte, plus the Python-specific edges (non-JSON values,
hostile mappings, cycles) the fixture cannot express.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import pytest

from graphmind.edit_input import (
    MAX_REFUSAL_MESSAGE,
    VALIDATOR_FAILED,
    Refusal,
    ValidateInputContext,
    accept,
    merge_tool_input,
    normalize_validation,
    proposed_value_refusal,
    prototype_key_refusal,
    refuse,
    sanitize_short_text,
    wire_copy,
)
from graphmind.redaction import REDACTED

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "packages" / "client" / "test" / "fixtures" / "edit-input.json"
_ABSENT = object()


def dumps(value: Any) -> str:
    """Byte-level comparison: key order included."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _cases(section: str) -> Iterator[Any]:
    for case in _fixture()[section]:
        yield pytest.param(case, id=case["name"][:80])


def _field(case: Mapping[str, Any], key: str) -> Any:
    """A missing fixture field is an absent value: None in Python."""
    return case.get(key)


class TestConformanceFixture:
    def test_uses_the_shared_constants(self) -> None:
        fixture = _fixture()
        assert fixture["placeholder"] == REDACTED
        assert fixture["maxRefusalMessage"] == MAX_REFUSAL_MESSAGE
        refusals = {case["refusal"] for case in fixture["proposedValue"]}
        assert refusals == {"placeholder", "truncated", None}

    @pytest.mark.parametrize("case", list(_cases("proposedValue")))
    def test_proposed_value(self, case: dict[str, Any]) -> None:
        refusal = proposed_value_refusal(_field(case, "value"))
        assert (refusal.code if refusal is not None else None) == case["refusal"]

    @pytest.mark.parametrize("case", list(_cases("prototypeKeys")))
    def test_prototype_keys(self, case: dict[str, Any]) -> None:
        refusal = prototype_key_refusal(_field(case, "value"))
        assert (refusal is not None and refusal.code == "shape") is case["refused"]

    @pytest.mark.parametrize("case", list(_cases("normalizeValidation")))
    def test_normalize_validation(self, case: dict[str, Any]) -> None:
        assert dumps(normalize_validation(_field(case, "result"))) == dumps(case["expected"])

    @pytest.mark.parametrize("case", list(_cases("sanitizeShortText")))
    def test_sanitize_short_text(self, case: dict[str, Any]) -> None:
        assert sanitize_short_text(_field(case, "input")) == case["expected"]

    @pytest.mark.parametrize("case", list(_cases("mergeToolInput")))
    def test_merge_tool_input(self, case: dict[str, Any]) -> None:
        context = None if "inputHidden" not in case else ValidateInputContext(case["inputHidden"])
        result = merge_tool_input(_field(case, "live"), _field(case, "proposed"), context)
        assert dumps(result) == dumps(case["expected"])


class TestProposedValue:
    def test_messages_never_quote_the_value(self) -> None:
        secret = "SECRET-CANARY-91f2"
        for value in ({"q": f"{secret} {REDACTED}"}, {"q": f"{secret}…[truncated]"}):
            refusal = proposed_value_refusal(value)
            assert refusal is not None and secret not in (refusal.message or "")

    @pytest.mark.parametrize("value", [object(), {"when": b"raw"}, {1j: 2}])
    def test_a_value_json_cannot_write_is_a_shape_refusal(self, value: Any) -> None:
        assert proposed_value_refusal(value) == Refusal(
            "shape", "the value could not be read as JSON"
        )

    def test_a_cycle_is_a_shape_refusal_never_a_raise(self) -> None:
        cyclic: dict[str, Any] = {}
        cyclic["self"] = cyclic
        refusal = proposed_value_refusal(cyclic)
        assert refusal is not None and refusal.code == "shape"

    def test_what_safe_value_records_is_refused_when_sent_back(self) -> None:
        """Round trip: whatever the SDK's own recording bounds produce, pre-filled
        into an editor and sent back verbatim, never runs."""
        from graphmind.integrations._common import safe_value

        for original in (
            {"q": "x" * 20_001},
            {"blob": b"\x00" * 10},
            {"keys": {str(i): i for i in range(201)}},
            {"items": list(range(201))},
            {"deep": [[[[[[[[["bottom"]]]]]]]]]},
        ):
            recorded = json.loads(json.dumps(safe_value(original)))
            refusal = proposed_value_refusal(recorded)
            assert refusal is not None and refusal.code == "truncated", original.keys()


class TestPrototypeKeys:
    def test_is_cycle_safe_and_never_raises(self) -> None:
        cyclic: dict[str, Any] = {"q": 1}
        cyclic["self"] = cyclic
        assert prototype_key_refusal(cyclic) is None

        class Hostile(Mapping[str, Any]):
            def __getitem__(self, key: str) -> Any:
                raise RuntimeError("boom")

            def __iter__(self) -> Iterator[str]:
                raise RuntimeError("boom")

            def __len__(self) -> int:
                return 1

            def __contains__(self, key: object) -> bool:
                raise RuntimeError("boom")

        refusal = prototype_key_refusal(Hostile())
        assert refusal == Refusal("shape", "the edited input could not be read")

    def test_tuples_are_walked_like_lists(self) -> None:
        assert prototype_key_refusal(({"__proto__": {}},)) is not None


class TestMergeToolInput:
    def test_unmentioned_keys_keep_their_live_objects(self) -> None:
        import datetime

        since = datetime.datetime(2026, 1, 1)
        result = merge_tool_input({"query": "AMS", "since": since}, {"query": "LIS"})
        assert result["ok"] is True
        assert result["value"]["since"] is since

    def test_returns_a_new_dict_and_modifies_neither_argument(self) -> None:
        live = {"a": 1, "b": 2}
        proposed = {"b": 3, "c": 4}
        result = merge_tool_input(live, proposed)
        assert result == {"ok": True, "value": {"a": 1, "b": 3, "c": 4}}
        assert live == {"a": 1, "b": 2} and proposed == {"b": 3, "c": 4}
        assert result["value"] is not live and result["value"] is not proposed

    def test_a_mapping_that_is_not_a_dict_is_not_a_plain_object(self) -> None:
        from types import MappingProxyType

        assert merge_tool_input({}, MappingProxyType({"q": 1})) == refuse(
            "shape", "the edited arguments must be a plain JSON object"
        )
        assert merge_tool_input({}, {1: "x"})["code"] == "shape"

    def test_a_cyclic_edit_is_merged_without_looping(self) -> None:
        proposed: dict[str, Any] = {"query": "LIS"}
        proposed["self"] = proposed
        assert merge_tool_input({"limit": 1}, proposed)["ok"] is True

    def test_any_object_with_input_hidden_counts_as_the_context(self) -> None:
        class Ctx:
            input_hidden = True

        assert merge_tool_input({"a": 1}, {"b": 2}, Ctx()) == accept({"b": 2})

    def test_the_context_is_read_only(self) -> None:
        context = ValidateInputContext(True)
        with pytest.raises(AttributeError):
            context.input_hidden = False  # type: ignore[misc]
        assert ValidateInputContext("yes").input_hidden is False  # type: ignore[arg-type]


class TestNormalizeValidation:
    def test_a_result_whose_fields_raise_is_a_shape_refusal(self) -> None:
        class Hostile(dict):  # type: ignore[type-arg]
            def get(self, key: Any, default: Any = None) -> Any:
                raise RuntimeError("boom")

        assert normalize_validation(Hostile(ok=True)) == dict(VALIDATOR_FAILED)

    def test_each_failure_is_a_fresh_dict(self) -> None:
        first = normalize_validation(None)
        first["code"] = "schema"
        assert normalize_validation(None)["code"] == "shape"

    def test_a_str_subclass_code_is_read_as_its_plain_value(self) -> None:
        class Sneaky(str):
            def __eq__(self, other: object) -> bool:
                return True

            __hash__ = str.__hash__

        verdict = normalize_validation({"ok": False, "code": Sneaky("schema")})
        assert verdict == {"ok": False, "code": "schema"}
        assert type(verdict["code"]) is str


class TestSanitize:
    def test_the_cut_is_exactly_the_limit(self) -> None:
        text = sanitize_short_text("a" * 5000)
        assert text is not None and len(text) == MAX_REFUSAL_MESSAGE and text.endswith("…")

    def test_a_lone_surrogate_at_the_cut_is_dropped_like_javascript(self) -> None:
        text = sanitize_short_text("a" * 198 + "\ud83d" + "b" * 10)
        assert text == "a" * 198 + "…"


class TestWireCopy:
    def test_is_the_event_serializer_round_trip(self) -> None:
        import datetime
        import math

        ok, copy = wire_copy({"n": 1, "nan": math.nan, "t": (1, 2)})
        assert ok and copy == {"n": 1, "nan": None, "t": [1, 2]}
        ok, copy = wire_copy({"at": datetime.date(2026, 1, 2)})
        assert ok and copy == {"at": repr(datetime.date(2026, 1, 2))}

    def test_a_cycle_has_no_copy(self) -> None:
        cyclic: dict[str, Any] = {}
        cyclic["self"] = cyclic
        assert wire_copy(cyclic) == (False, None)
