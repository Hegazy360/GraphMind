"""Tool gates take edited arguments (contract C2, W2), Python port.

Parity with ``packages/client/test/tool-edit.test.ts`` and the TS tool
wrappers: ``gm.tool`` / ``gm.wrap_tools`` offer every gate of a call whose
arguments bind to the signature as ``editable``; ``continue`` + input at
``before`` and ``retry`` + input at ``after`` / ``error`` call the REAL function
with the edit merged into the live arguments, checked against the signature;
the latest accepted edit stays the call's arguments (a plain retry re-runs
it); ``node.started`` keeps what the caller passed. LLM gates are never
editable.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import threading
from typing import Any

import pytest

from graphmind.edit_input import ValidateInputContext
from graphmind.gate import GateDecision
from graphmind.tool_edit import (
    ToolEdit,
    bind_arguments,
    call_arguments,
    edited_args,
    signature_check,
    tool_args_validator,
    tool_gate_options,
)

from .helpers.providers import CHAT_COMPLETION, json_responder, make_openai

EDITS = ["edit-input"]
VISIBLE = ValidateInputContext(False)
HIDDEN = ValidateInputContext(True)


def background(fn: Any, *args: Any, **kwargs: Any) -> concurrent.futures.Future[Any]:
    future: concurrent.futures.Future[Any] = concurrent.futures.Future()

    def run() -> None:
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:
            future.set_exception(exc)

    threading.Thread(target=run, daemon=True).start()
    return future


def pause_id_of(frame: dict[str, Any]) -> str:
    return frame["payload"]["pauseId"]


@pytest.fixture
def attached_edits(make_gm: Any, viewer: Any) -> Any:
    def factory(breakpoints: list[dict[str, Any]], **gm_options: Any) -> tuple[Any, Any]:
        view = viewer(breakpoints=breakpoints, hub_capabilities=EDITS)
        instance = make_gm(url=view.url, **gm_options)
        assert instance.ready(timeout=5.0) is True
        return instance, view

    return factory


# -- the pure pieces ---------------------------------------------------------------


def search(query: str, limit: int = 10, *, region: str = "eu") -> dict[str, Any]:
    return {"query": query, "limit": limit, "region": region}


def varargs(first: int, /, *rest: int, **options: Any) -> Any:
    return (first, rest, options)


SEARCH = inspect.signature(search)
VARARGS = inspect.signature(varargs)


class TestSignatureCheck:
    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ({"query": "a", "page": 2}, 'field "page" is not a parameter of this tool'),
            ({"limit": 1}, 'field "query" is required'),
            ({"first": 1, "rest": {"x": 1}}, 'field "rest" must be array, got object'),
            ({"first": 1, "options": ["x"]}, 'field "options" must be object, got array'),
            ({"first": 1, "options": {"rest": 1}}, 'field "options" repeats the parameter "rest"'),
            (
                {"query": "a", "x" * 60: 1},
                f'field "{"x" * 47}…" is not a parameter of this tool',
            ),
        ],
    )
    def test_refuses_what_the_function_could_not_receive(self, value: Any, message: str) -> None:
        signature = VARARGS if "first" in value else SEARCH
        assert signature_check(signature)(value, VISIBLE) == {
            "ok": False,
            "code": "schema",
            "message": message,
        }

    def test_accepts_a_complete_call_and_types_are_the_function_s_business(self) -> None:
        value = {"query": 7, "limit": "many"}
        assert signature_check(SEARCH)(value, VISIBLE) == {"ok": True, "value": value}

    def test_a_positional_only_name_may_repeat_inside_kwargs(self) -> None:
        value = {"first": 1, "options": {"first": 2}}
        assert signature_check(VARARGS)(value, VISIBLE)["ok"] is True

    def test_a_value_that_is_not_a_dict_is_refused(self) -> None:
        assert signature_check(SEARCH)(["query"], VISIBLE)["code"] == "schema"


class TestCallArguments:
    def test_round_trips_the_recorded_shape(self) -> None:
        live = bind_arguments(SEARCH, ("AMS",), {"region": "us"})
        assert live == {"query": "AMS", "limit": 10, "region": "us"}
        assert call_arguments(SEARCH, live) == (("AMS", 10), {"region": "us"})

    def test_varargs_and_kwargs(self) -> None:
        live = bind_arguments(VARARGS, (1, 2, 3), {"flag": True})
        assert live == {"first": 1, "rest": (2, 3), "options": {"flag": True}}
        args, kwargs = call_arguments(VARARGS, {"first": 9, "rest": [8], "options": {"k": 1}})
        assert varargs(*args, **kwargs) == (9, (8,), {"k": 1})

    def test_left_out_parameters_take_their_defaults(self) -> None:
        args, kwargs = call_arguments(SEARCH, {"query": "LIS"})
        assert search(*args, **kwargs) == {"query": "LIS", "limit": 10, "region": "eu"}

    def test_arguments_that_do_not_bind_cannot_take_an_edit(self) -> None:
        assert bind_arguments(SEARCH, (1, 2, 3, 4), {}) is None
        assert bind_arguments(None, (), {}) is None


class TestValidatorAndOptions:
    def test_merge_then_check(self) -> None:
        validate = tool_args_validator({"query": "AMS", "limit": 10}, signature_check(SEARCH))
        assert validate({"limit": 1}, VISIBLE) == {
            "ok": True,
            "value": {"query": "AMS", "limit": 1},
        }
        # A hidden input takes only a full replacement: `query` is not completed.
        assert validate({"limit": 1}, HIDDEN)["message"] == 'field "query" is required'
        assert validate(["not", "an", "object"], VISIBLE)["code"] == "shape"

    def test_options_are_empty_while_detached_and_the_plan_is_not_evaluated(self) -> None:
        class Detached:
            attached = False

        calls: list[int] = []
        assert tool_gate_options(Detached(), lambda: calls.append(1)) == {}
        assert calls == []

    def test_options_while_attached(self) -> None:
        class Attached:
            attached = True

        options = tool_gate_options(Attached(), ToolEdit({"q": 1}), after="R")
        assert options["editable"] is True and options["result"] == "R"
        assert options["validate_input"]({"q": 2}, VISIBLE) == {"ok": True, "value": {"q": 2}}
        assert tool_gate_options(Attached(), None) == {}

    @pytest.mark.parametrize(
        ("decision", "expected"),
        [
            (GateDecision("continue", input={"q": 1}), (True, {"q": 1})),
            (GateDecision("retry", input={"q": 1}), (True, {"q": 1})),
            (GateDecision("continue"), (False, None)),
            (GateDecision("inject", {"q": 1}), (False, None)),
            (GateDecision("abort"), (False, None)),
        ],
    )
    def test_edited_args(self, decision: GateDecision, expected: Any) -> None:
        assert edited_args(decision) == expected


# -- wrapped tools against a (fake) debugger ------------------------------------------


class TestWrappedTools:
    def test_continue_with_input_calls_the_real_function_with_the_merged_arguments(
        self, attached_edits: Any, validate_frame: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "search"}])
        calls: list[Any] = []

        @instance.tool
        def search(query: str, limit: int = 10, *, region: str = "eu") -> str:
            calls.append((query, limit, region))
            return f"{query}:{limit}:{region}"

        result = background(search, "AMS", region="us")
        paused = view.wait_for_type("exec.paused")
        assert paused["payload"]["editable"] is True
        view.resume_with(
            pauseId=pause_id_of(paused), action="continue", input={"query": "LIS"}, requestId="e1"
        )
        assert result.result(5) == "LIS:10:us"
        assert calls == [("LIS", 10, "us")]
        started = view.wait_for_type("node.started")["payload"]
        # node.started (and so the loop fingerprint) keeps what the caller passed.
        assert started["input"] == {"query": "AMS", "limit": 10, "region": "us"}
        resumed = view.wait_for_type("exec.resumed")["payload"]
        assert resumed["edited"] == {"after": {"query": "LIS", "limit": 10, "region": "us"}}
        assert resumed["requestId"] == "e1"
        for frame in view.frames():
            if frame["type"] != "hello":
                validate_frame(frame)

    def test_an_edit_the_signature_cannot_take_is_refused_and_the_gate_stays_held(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "search"}])

        @instance.tool
        def search(query: str, limit: int = 10) -> str:
            return f"{query}:{limit}"

        result = background(search, "AMS")
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"page": 2})
        refused = view.wait_for_type("exec.refused")["payload"]
        assert refused == {
            "pauseId": pause_id,
            "code": "schema",
            "message": 'field "page" is not a parameter of this tool',
        }
        view.resume_with(pauseId=pause_id, action="continue", input={"limit": 3})
        assert result.result(5) == "AMS:3"

    def test_error_gate_retry_with_input_fixes_a_missing_argument(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "book", "point": "error"}])
        calls: list[Any] = []

        @instance.tool
        def book(flight: str, seat: str) -> str:
            calls.append((flight, seat))
            return f"{flight}/{seat}"

        # The model forgot `seat`: the call raises TypeError, the error gate holds.
        result = background(book, "TP123")
        paused = view.wait_for_type("exec.paused")
        assert (paused["payload"]["point"], paused["payload"]["editable"]) == ("error", True)
        view.resume_with(pauseId=pause_id_of(paused), action="retry", input={"seat": "12A"})
        assert result.result(5) == "TP123/12A"
        assert calls == [("TP123", "12A")]

    def test_after_gate_retry_with_input_re_runs_with_the_edit_then_a_plain_retry_keeps_it(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "search", "point": "after"}])
        calls: list[Any] = []

        @instance.tool
        def search(query: str) -> str:
            calls.append(query)
            return query.upper()

        result = background(search, "ams")
        first = view.wait_for_type("exec.paused")
        view.resume_with(pauseId=pause_id_of(first), action="retry", input={"query": "lis"})
        second = view.wait_for(
            lambda f: (
                f.get("type") == "exec.paused"
                and f["payload"]["pauseId"] != first["payload"]["pauseId"]
            )
        )
        view.resume(pause_id_of(second), "retry")  # plain retry: the latest accepted edit
        third = view.wait_for(
            lambda f: (
                f.get("type") == "exec.paused"
                and f["payload"]["pauseId"] not in (pause_id_of(first), pause_id_of(second))
            )
        )
        view.resume(pause_id_of(third), "continue")
        assert result.result(5) == "LIS"
        assert calls == ["ams", "lis", "lis"]

    def test_varargs_tools_are_edited_through_their_recorded_shape(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "tool"}])

        @instance.tool
        def total(*numbers: int, scale: int = 1) -> int:
            return sum(numbers) * scale

        result = background(total, 1, 2)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        assert view.wait_for_type("node.started")["payload"]["input"] == {
            "numbers": [1, 2],
            "scale": 1,
        }
        view.resume_with(pauseId=pause_id, action="continue", input={"numbers": [5, 5], "scale": 3})
        assert result.result(5) == 30

    def test_under_hide_tool_args_only_a_full_replacement_is_accepted(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits(
            [{"kind": "tool", "name": "pay"}], env={"GRAPHMIND_HIDE_TOOL_ARGS": "1"}
        )

        @instance.tool
        def pay(account: str, amount: int) -> str:
            return f"{account}:{amount}"

        result = background(pay, "ACC-7731", 10)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"amount": 5})
        refused = view.wait_for_type("exec.refused")["payload"]
        # A switch covers the input: the message is omitted, and the refusal never
        # depends on the hidden value (nothing was merged from it).
        assert refused == {
            "pauseId": pause_id,
            "code": "schema",
            "redaction": {"count": 1, "keys": ["message"]},
        }
        view.resume_with(
            pauseId=pause_id, action="continue", input={"account": "ACC-1", "amount": 5}
        )
        assert result.result(5) == "ACC-1:5"
        resumed = view.wait_for_type("exec.resumed")["payload"]
        assert resumed["edited"] == {"after": "__REDACTED__"}

    def test_a_callable_without_a_signature_is_not_editable(self, attached_edits: Any) -> None:
        instance, view = attached_edits([{"kind": "tool"}])
        wrapped = instance.tool(max, name="max")
        result = background(wrapped, 3, 7)
        paused = view.wait_for_type("exec.paused")
        assert "editable" not in paused["payload"]
        view.resume(pause_id_of(paused), "continue")
        assert result.result(5) == 7

    def test_detached_nothing_is_bound_and_the_call_runs(self, make_gm: Any) -> None:
        instance = make_gm(url="ws://127.0.0.1:9/ingest")

        @instance.tool
        def search(query: str) -> str:
            return query

        assert search("x") == "x"

    async def test_async_tools_take_edits_on_their_task(self, attached_edits: Any) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "fetch"}])
        threads: list[threading.Thread] = []

        @instance.tool
        async def fetch(url: str, retries: int = 0) -> str:
            threads.append(threading.current_thread())
            await asyncio.sleep(0)
            return f"{url}#{retries}"

        task = asyncio.ensure_future(fetch("https://a.test"))
        pause_id = pause_id_of(await view.wait_for_type_async("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"retries": 2})
        assert await asyncio.wait_for(task, 5) == "https://a.test#2"
        assert threads == [threading.current_thread()]

    async def test_async_error_gate_retry_with_input(self, attached_edits: Any) -> None:
        instance, view = attached_edits([{"kind": "tool", "name": "lookup", "point": "error"}])

        @instance.tool
        async def lookup(key: str) -> str:
            if key == "bad":
                raise KeyError(key)
            return key

        task = asyncio.ensure_future(lookup("bad"))
        paused = await view.wait_for_type_async("exec.paused")
        assert paused["payload"]["point"] == "error"
        view.resume_with(pauseId=pause_id_of(paused), action="retry", input={"key": "good"})
        assert await asyncio.wait_for(task, 5) == "good"


class TestLlmGatesAreNeverEditable:
    def test_an_instrumented_llm_call_pauses_without_editable_and_an_edit_is_unsupported(
        self, attached_edits: Any
    ) -> None:
        instance, view = attached_edits([{"kind": "llm"}])
        client, _recorder = make_openai(json_responder(CHAT_COMPLETION))
        instance.instrument_openai(client)
        result = background(
            client.chat.completions.create,
            model="gpt-test",
            messages=[{"role": "user", "content": "hi"}],
        )
        paused = view.wait_for_type("exec.paused")
        assert paused["payload"]["nodeId"] == "llm:step" and "editable" not in paused["payload"]
        view.resume_with(pauseId=pause_id_of(paused), action="continue", input={"model": "x"})
        assert view.wait_for_type("exec.refused")["payload"]["code"] == "unsupported"
        view.resume(pause_id_of(paused), "continue")
        assert result.result(5).choices[0].message.content == "Lisbon is sunny."
