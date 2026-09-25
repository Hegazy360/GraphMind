"""SHRINK-V2, Python port: ``graphmind.shrink`` against the cross-language
conformance fixture ``packages/schema/test/fixtures/shrink.json`` (version 2),
byte for byte, plus the parts of the contract the fixture does not spell out:
JSON.stringify's text for Python values, UTF-16 cuts, the wire-schema check the
reference does with zod (differentially against ``packages/schema/schema.json``),
idempotence and the "valid event in, valid event within budget out" invariant.
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path
from typing import Any

import pytest

from graphmind import shrink
from graphmind.shrink import (
    MAX_PAYLOAD_BYTES,
    SKELETON_PLANS,
    is_valid_event_payload,
    js_stringify,
    serialize_payload,
    utf8_length,
    utf16_length,
    utf16_prefix,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "packages" / "schema" / "test" / "fixtures" / "shrink.json"
SCHEMA = REPO_ROOT / "packages" / "schema" / "schema.json"


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


FIXTURE_DATA = load_fixture()


def expand(node: Any) -> Any:
    """The fixture's compact generator notation (its ``generator`` field)."""
    if isinstance(node, list):
        return [expand(item) for item in node]
    if not isinstance(node, dict):
        return node
    if len(node) == 1:
        ((key, arg),) = node.items()
        if key == "$repeat":
            return arg[0] * arg[1]
        if key == "$array":
            return [expand(arg[0]) for _ in range(arg[1])]
        if key == "$concat":
            return "".join(expand(part) for part in arg)
        if key == "$keys":
            prefix, count, item = arg
            return {f"{prefix}{i}": expand(item) for i in range(count)}
        if key == "$merge":
            merged: dict[str, Any] = {}
            for part in arg:
                merged.update(expand(part))
            return merged
    return {key: expand(value) for key, value in node.items()}


def utf8(text: str) -> bytes:
    return text.encode("utf-8")


# -- the fixture ------------------------------------------------------------------------


def test_fixture_is_version_2_with_50_cases() -> None:
    assert FIXTURE_DATA["version"] == 2
    assert len(FIXTURE_DATA["cases"]) == 50


def test_constants_match_the_fixture() -> None:
    constants = FIXTURE_DATA["constants"]
    assert constants == {
        "MAX_PAYLOAD_BYTES": shrink.MAX_PAYLOAD_BYTES,
        "PREVIEW_CHARS": shrink.PREVIEW_CHARS,
        "MAX_SHRINK_DEPTH": shrink.MAX_SHRINK_DEPTH,
        "TRUNCATION_SUFFIX": shrink.TRUNCATION_SUFFIX,
        "MAX_SHRINK_KEYS": shrink.MAX_SHRINK_KEYS,
        "MAX_TRIM_FIELDS": shrink.MAX_TRIM_FIELDS,
        "SKELETON_CHARS": shrink.SKELETON_CHARS,
        "SKELETON_MIN_CHARS": shrink.SKELETON_MIN_CHARS,
    }


def test_skeleton_plans_match_the_fixture_including_key_order() -> None:
    expected = FIXTURE_DATA["skeletonPlans"]

    def ordered(plan: Any) -> Any:
        if isinstance(plan, dict):
            return [(key, ordered(value)) for key, value in plan.items()]
        return plan

    assert ordered(SKELETON_PLANS) == ordered(expected)


@pytest.mark.parametrize("case", FIXTURE_DATA["cases"], ids=lambda case: case["name"])
def test_reproduces_the_fixture_byte_for_byte(case: dict[str, Any]) -> None:
    payload = expand(case["input"])
    args: list[Any] = [payload, case.get("maxBytes", MAX_PAYLOAD_BYTES)]
    text, out, truncated = serialize_payload(*args, type=case.get("type"))
    expected = case["expected"]
    assert truncated is expected["truncated"]
    if "json" in expected:
        assert text == expected["json"]
    else:
        assert utf8_length(text) == expected["jsonBytes"]
        assert utf16_prefix(text, 160) == expected["jsonHead"]
        assert hashlib.sha256(utf8(text)).hexdigest() == expected["jsonSha256"]
    # The returned payload is exactly what the text says.
    assert js_stringify(out) == text
    if not truncated:
        assert out is payload
    # Idempotent: the result fed back in is within budget and unchanged.
    again = serialize_payload(
        json.loads(text), case.get("maxBytes", MAX_PAYLOAD_BYTES), case.get("type")
    )
    assert again[0] == text and again[2] is False


# -- JSON.stringify text ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        # Numbers in ECMAScript Number::toString form (values from node -p).
        (1.0, "1"),
        (-0.0, "0"),
        (0.5, "0.5"),
        (1e-05, "0.00001"),
        (1e-06, "0.000001"),
        (1e-07, "1e-7"),
        (1.5e-07, "1.5e-7"),
        (1e16, "10000000000000000"),
        (1.5e16, "15000000000000000"),
        (123456789012345.6, "123456789012345.6"),
        (1e21, "1e+21"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (5e-324, "5e-324"),
        (2**53 - 1, "9007199254740991"),
        (2**53 + 1, "9007199254740992"),
        (12345678901234567890, "12345678901234567000"),
        (10**21, "1e+21"),
        (-(10**22), "-1e+22"),
        (10**400, "null"),
        (float("nan"), "null"),
        (float("inf"), "null"),
        ([float("-inf"), 1.0, 2], "[null,1,2]"),
        ({"a": 1e-7, "b": "1e-07 1.0 NaN"}, '{"a":1e-7,"b":"1e-07 1.0 NaN"}'),
        # Strings: raw non-ASCII, U+2028 raw, controls lowercase, lone surrogates escaped.
        ("é中\U0001f600\u2028\u2029", '"é中\U0001f600\u2028\u2029"'),
        ('"\\\n\t\b\f\r\x00\x1f\x7f', '"\\"\\\\\\n\\t\\b\\f\\r\\u0000\\u001f\x7f"'),
        ("\ud800x\udfff", '"\\ud800x\\udfff"'),
        ("\ud83d" + "\ude00", '"\U0001f600"'),  # two code points JS sees as one pair
        ({"\ud800": [True, False, None]}, '{"\\ud800":[true,false,null]}'),
        ("\x00" + "0" * 16, '"\\u0000' + "0" * 16 + '"'),  # looks like a placeholder
        ({"__proto__": {}}, '{"__proto__":{}}'),
    ],
)
def test_js_stringify_matches_json_stringify(value: Any, expected: str) -> None:
    assert js_stringify(value) == expected


def test_js_stringify_reports_unserializable_values() -> None:
    cyclic: dict[str, Any] = {}
    cyclic["self"] = cyclic
    assert js_stringify(cyclic) is None
    assert js_stringify({"s": {1, 2}}) is None
    assert js_stringify(object()) is None


def test_utf16_measures_and_cuts() -> None:
    assert utf16_length("a\U0001f600b") == 4
    assert utf16_length("\ud800") == 1
    assert utf16_prefix("a\U0001f600b", 2) == "a\ud83d"  # splits the pair like JS
    assert utf16_prefix("a\U0001f600b", 3) == "a\U0001f600"
    assert utf16_prefix("\U0001f600" * 3, 100) == "\U0001f600" * 3
    assert utf8_length('"\\ud800"') == 8
    assert utf8_length("\U0001f600") == 4
    assert utf8_length("\ud800") == 3  # TextEncoder: U+FFFD


def test_an_astral_string_is_cut_at_2000_units_not_code_points() -> None:
    text = "\U0001f600" * 300_000  # 600,000 units
    out_text, out, truncated = serialize_payload(
        {"nodeId": "n", "durationMs": 0, "status": "ok", "output": text}, type="node.finished"
    )
    assert truncated
    output = out["output"]
    assert output.endswith(shrink.TRUNCATION_SUFFIX)
    assert output[: -len(shrink.TRUNCATION_SUFFIX)] == "\U0001f600" * 1000
    assert utf8_length(out_text) <= MAX_PAYLOAD_BYTES


# -- the wire-schema check ----------------------------------------------------------------


def _schema_validator() -> Any:
    from jsonschema import Draft202012Validator

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def _mutations(rng: random.Random) -> list[Any]:
    return [
        "s",
        "",
        0,
        -1,
        1.5,
        2**53,
        True,
        None,
        [],
        {},
        ["x"],
        {"name": "n", "message": "m"},
        "tool",
        "ok",
        "before",
        "loop",
        "text",
        {"inputTokens": 1, "outputTokens": 2},
        {"count": 1, "keys": ["input"]},
        {"repeats": 3, "firstSeq": 1, "lastSeq": 3, "fingerprint": "f"},
        [{"t": "text", "v": "hi"}],
        [{"t": "text"}],
        [{"nodeId": "a", "kind": "tool", "name": "a"}],
        [{"nodeId": "a", "kind": "nope", "name": "a"}],
        {"name": "x", "version": "1"},
    ]


VALID = {
    "run.started": {"app": "a", "sdk": {"name": "python", "version": "1"}, "meta": {"k": 1}},
    "run.finished": {"status": "error", "error": {"name": "E", "message": "m", "stack": "s"}},
    "graph.hint": {"nodes": [{"nodeId": "n", "kind": "server", "name": "n", "parentId": "p"}]},
    "node.started": {
        "nodeId": "n",
        "parentId": "p",
        "kind": "prompt",
        "name": "n",
        "instanceId": "i",
        "input": None,
        "collapsed": True,
        "redaction": {"count": 0, "keys": []},
    },
    "node.token": {"nodeId": "n", "deltas": [{"t": "tool-args", "v": ""}]},
    "node.finished": {
        "nodeId": "n",
        "instanceId": "i",
        "output": [1],
        "usage": {"inputTokens": 0, "outputTokens": 5},
        "durationMs": 0.25,
        "heldMs": 0,
        "status": "aborted",
    },
    "node.error": {"nodeId": "n", "error": {"name": "E", "message": "m"}, "heldMs": 1.5},
    "exec.paused": {
        "pauseId": "p",
        "nodeId": "n",
        "point": "error",
        "reason": "loop",
        "loop": {"repeats": 3, "firstSeq": 1, "lastSeq": 3, "fingerprint": "f"},
    },
    "exec.resumed": {"pauseId": "p", "action": "retry"},
    "exec.refused": {"pauseId": "p", "code": "schema", "message": "amount: expected a number"},
}


def test_every_known_type_has_a_valid_sample_and_unknown_types_are_not_judged() -> None:
    assert set(VALID) == set(SKELETON_PLANS)
    for type_, payload in VALID.items():
        assert is_valid_event_payload(type_, payload), type_
        assert not is_valid_event_payload(type_, [payload]), type_
    assert is_valid_event_payload("node.custom", 5) is True
    assert is_valid_event_payload("__proto__", None) is True


def test_the_payload_check_agrees_with_schema_json_on_thousands_of_mutations() -> None:
    """Differential: every mutated payload is judged the same by the Python
    check and by the published JSON Schema (the zod export). Numbers that only
    zod rejects (unsafe integers, which the JSON Schema calls integers) are
    left out of the generator on purpose and pinned separately below."""
    validator = _schema_validator()
    rng = random.Random(20260914)
    mutations = _mutations(rng)
    checked = 0
    disagreements: list[Any] = []
    for type_, base in VALID.items():
        keys = sorted({*base, *(k for plan in [SKELETON_PLANS[type_]] for k in plan)})
        for _ in range(400):
            payload = json.loads(json.dumps(base))
            for _ in range(rng.randint(1, 3)):
                key = rng.choice([*keys, "extra"])
                action = rng.random()
                if action < 0.25:
                    payload.pop(key, None)
                else:
                    value = rng.choice(mutations)
                    if value == 2**53:
                        value = 7
                    payload[key] = json.loads(json.dumps(value))
            envelope = {"gm": 1, "seq": 0, "ts": 1, "runId": "r", "type": type_, "payload": payload}
            schema_ok = not any(True for _ in validator.iter_errors(envelope))
            if is_valid_event_payload(type_, payload) != schema_ok:
                disagreements.append((type_, payload, schema_ok))
            checked += 1
    assert checked == 400 * len(VALID)
    assert disagreements == []


@pytest.mark.parametrize(
    ("payload", "valid"),
    [
        ({"nodeId": "n", "durationMs": 1, "status": "ok"}, True),
        ({"nodeId": "n", "durationMs": -0.0, "status": "ok"}, True),
        ({"nodeId": "n", "durationMs": -1, "status": "ok"}, False),
        ({"nodeId": "n", "durationMs": float("nan"), "status": "ok"}, False),
        ({"nodeId": "n", "durationMs": float("inf"), "status": "ok"}, False),
        ({"nodeId": "n", "durationMs": 10**400, "status": "ok"}, False),
        ({"nodeId": "n", "durationMs": True, "status": "ok"}, False),
        ({"nodeId": "n", "durationMs": 1, "status": "ok", "instanceId": None}, False),
        (
            {
                "nodeId": "n",
                "durationMs": 1,
                "status": "ok",
                "usage": {"inputTokens": 2**53, "outputTokens": 0},
            },
            False,
        ),
        (
            {
                "nodeId": "n",
                "durationMs": 1,
                "status": "ok",
                "usage": {"inputTokens": 3.0, "outputTokens": 0},
            },
            True,
        ),
        (
            {
                "nodeId": "n",
                "durationMs": 1,
                "status": "ok",
                "usage": {"inputTokens": 1.5, "outputTokens": 0},
            },
            False,
        ),
    ],
)
def test_zod_number_rules(payload: dict[str, Any], valid: bool) -> None:
    assert is_valid_event_payload("node.finished", payload) is valid


# -- the invariant --------------------------------------------------------------------------


def _bulk(rng: random.Random) -> Any:
    unit = rng.choice(
        ["a", "\u00e9", "\u4e2d", "\U0001f600", "\x01", "\ud800", '"', "\\", "\u2028"]
    )
    shape = rng.randrange(6)
    if shape == 0:
        return unit * rng.randint(200_000, 700_000)
    if shape == 1:  # records keyed by id, with floats JavaScript spells differently
        count = rng.randint(3000, 9000)
        return {f"id{i}": {"name": "record", "score": 1e-7 * i} for i in range(count)}
    if shape == 2:  # a typed array's JSON: integer-like keys only
        return {str(i): i * 0.5 for i in range(rng.randint(50_000, 120_000))}
    if shape == 3:
        return [unit * 1000] * rng.randint(600, 1200)
    if shape == 4:
        deep: Any = unit * 600_000
        for i in range(12):
            deep = {f"k{i}": deep, "n": i}
        return deep
    return {f"f{i}": unit * 3000 for i in range(rng.randint(200, 400))}


#: Required string fields per type that accept any string.
FREE_STRINGS = {
    "run.started": ["app"],
    "graph.hint": [],
    "run.finished": [],
    "node.started": ["nodeId", "name", "instanceId"],
    "node.token": ["nodeId"],
    "node.finished": ["nodeId"],
    "node.error": ["nodeId"],
    "exec.paused": ["pauseId", "nodeId"],
    "exec.resumed": ["pauseId"],
    "exec.refused": ["pauseId"],
}


def _hostile(rng: random.Random, type_: str) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(json.dumps(VALID[type_]))
    strategy = rng.randrange(5)
    bulk = _bulk(rng)
    if strategy == 0:
        payload["extra"] = bulk  # a loose field
    elif strategy == 1 and FREE_STRINGS[type_]:  # megabytes in a required string
        payload[rng.choice(FREE_STRINGS[type_])] = (
            bulk if isinstance(bulk, str) else "\U0001f600" * 300_000
        )
    elif strategy == 2:  # inside a required or optional nested object
        nested = [key for key, value in payload.items() if isinstance(value, dict)]
        if nested:
            payload[rng.choice(nested)]["bulk"] = bulk
        else:
            payload["extra"] = bulk
    elif strategy == 3:  # many medium top-level fields, before the required ones
        wide = {f"w{i}": "m" * 3000 for i in range(rng.randint(250, 4200))}
        payload = {**wide, **payload}
    else:  # a wide object inside the required error (node.error / run.finished)
        target = payload.get("error")
        if isinstance(target, dict):
            payload["error"] = {**{f"x{i}": i for i in range(10_000)}, **target}
            payload["error"]["message"] = "\ud83d" * 400_000
        else:
            payload["extra"] = bulk
    return payload


@pytest.mark.parametrize("seed", range(3))
def test_a_valid_event_shrinks_to_a_valid_event_within_budget(seed: int) -> None:
    rng = random.Random(seed)
    shrunk = 0
    for type_ in VALID:
        for max_bytes in (4096, 65536, MAX_PAYLOAD_BYTES):
            payload = _hostile(rng, type_)
            assert is_valid_event_payload(type_, payload)
            snapshot = json.dumps(payload)
            text, out, truncated = serialize_payload(payload, max_bytes, type_)
            shrunk += truncated
            assert json.dumps(payload) == snapshot, "input mutated"
            assert utf8_length(text) <= max_bytes, (type_, max_bytes)
            assert is_valid_event_payload(type_, out), (type_, max_bytes, text[:300])
            assert js_stringify(out) == text
            again = serialize_payload(json.loads(text), max_bytes, type_)
            assert again[0] == text and again[2] is False
    assert shrunk >= 20  # the generator really produces oversized events


def test_the_unserializable_path_degrades_field_by_field() -> None:
    cyclic: dict[str, Any] = {}
    cyclic["self"] = cyclic
    payload = {"nodeId": "n", "durationMs": 1, "status": "ok", "output": cyclic}
    _text, out, truncated = serialize_payload(payload, MAX_PAYLOAD_BYTES, "node.finished")
    assert truncated
    assert out["output"] == {
        "__graphmindTruncated": True,
        "bytes": 0,
        "preview": "[unserializable value]",
    }
    assert out["fields"] == ["output"]
    assert is_valid_event_payload("node.finished", out)
    # A required field that cannot serialise: the skeleton (validity) still wins.
    bad = {"nodeId": "n", "instanceId": "i", "error": {"name": "E", "message": "m", "x": {1, 2}}}
    _text, out, truncated = serialize_payload(bad, MAX_PAYLOAD_BYTES, "node.error")
    assert truncated and is_valid_event_payload("node.error", out)
    assert (
        out["error"] == {"name": "E", "message": "m"}
        and out["preview"] == "[unserializable payload]"
    )
    # Not a dict at all: the whole marker.
    assert serialize_payload({1, 2})[1] == {
        "__graphmindTruncated": True,
        "bytes": 0,
        "preview": "[unserializable payload]",
    }


def test_under_budget_payloads_are_returned_as_the_same_object() -> None:
    payload = {"nodeId": "n", "durationMs": 1.0, "status": "ok", "output": "\ud800"}
    text, out, truncated = serialize_payload(payload, MAX_PAYLOAD_BYTES, "node.finished")
    assert out is payload and truncated is False
    assert text == '{"nodeId":"n","durationMs":1,"status":"ok","output":"\\ud800"}'
