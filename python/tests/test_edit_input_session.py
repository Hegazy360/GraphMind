"""Edited input through a live session (contract C2), Python port.

Parity with ``packages/client/test/edit-input-session.test.ts`` and the
live-session half of ``redaction-edit.test.ts``: the announcement, when a
pause is ``editable``, the refusal order and codes, the validating state
(refuse -> reopen under the same pause id; a resume while validating is
ignored; disconnect or pause timeout during validation continues with the
ORIGINAL input), the validation time limit (synchronous work included), the
hand-off of the validator to the HOST thread / task, ``requestId`` echoes, the
client-side inject guard under every debugger, and redaction of the answers.
Sync gates run on a helper thread (they block it); async gates in the test's
own event loop.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import importlib
import json
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from graphmind.edit_input import ValidateInputContext, accept, merge_tool_input, refuse
from graphmind.gate import CONTINUE, GateDecision, GateNode
from graphmind.redaction import REDACTED

TOOL = GateNode("tool:search", "tool", "search")
LLM = GateNode("llm:step", "llm", "step")
EDITS = ["edit-input"]
CANARY = "EDIT-CANARY-5e1f0"
HOST_VAR: contextvars.ContextVar[str] = contextvars.ContextVar("host_var", default="unset")
#: The module (``graphmind.session`` the attribute is the ``gm.session()`` function).
session_module = importlib.import_module("graphmind.session")


def background(fn: Callable[[], Any]) -> concurrent.futures.Future[Any]:
    """Run ``fn`` on its own thread (a sync gate blocks the thread it runs on)."""
    future: concurrent.futures.Future[Any] = concurrent.futures.Future()

    def run() -> None:
        try:
            future.set_result(fn())
        except BaseException as exc:
            future.set_exception(exc)

    threading.Thread(target=run, name="host", daemon=True).start()
    return future


def settled_within(future: concurrent.futures.Future[Any], seconds: float) -> Any:
    try:
        return future.result(timeout=seconds)
    except concurrent.futures.TimeoutError:
        return "pending"


def pause_id_of(frame: dict[str, Any]) -> str:
    return frame["payload"]["pauseId"]


def nth_of_type(view: Any, type_: str, n: int, timeout: float = 8.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        frames = view.of_type(type_)
        if len(frames) >= n:
            return frames[n - 1]
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {n} x {type_}; got {len(frames)}")
        time.sleep(0.005)


def tool_edit(live: Any = None) -> tuple[dict[str, Any], list[Any]]:
    """Gate options for a tool with live arguments ``{"query": "AMS", "limit": 5}``,
    validated by the default merge; ``seen`` records every proposed input."""
    base = {"query": "AMS", "limit": 5} if live is None else live
    seen: list[Any] = []

    def validate(proposed: Any, context: ValidateInputContext) -> Any:
        seen.append(proposed)
        return merge_tool_input(base, proposed, context)

    return {"editable": True, "validate_input": validate}, seen


@pytest.fixture
def setup(make_gm: Any, viewer: Any) -> Any:
    def factory(
        hub: list[str] | None = EDITS,
        breakpoints: list[dict[str, Any]] | None = None,
        viewer_options: dict[str, Any] | None = None,
        **gm_options: Any,
    ) -> tuple[Any, Any]:
        view = viewer(
            breakpoints=[{}] if breakpoints is None else breakpoints,
            hub_capabilities=hub,
            **(viewer_options or {}),
        )
        instance = make_gm(url=view.url, **gm_options)
        assert instance.ready(timeout=5.0) is True
        return instance.session, view

    return factory


def all_frames_valid(view: Any, validate_frame: Any) -> None:
    for frame in view.frames():
        if frame.get("type") not in ("hello",):
            validate_frame(frame)


# -- announcement --------------------------------------------------------------


class TestAnnouncement:
    def test_announces_edit_input_by_default(self, setup: Any) -> None:
        _session, view = setup()
        assert "edit-input" in view.wait_for_type("hello")["payload"]["capabilities"]

    @pytest.mark.parametrize("value", ["1", "yes", "on", "TRUE ", "anything"])
    def test_the_kill_switch_removes_it_whatever_the_spelling(self, setup: Any, value: str) -> None:
        _session, view = setup(env={"GRAPHMIND_DISABLE_EDIT_INPUT": value})
        capabilities = view.wait_for_type("hello")["payload"]["capabilities"]
        assert "edit-input" not in capabilities and "pause" in capabilities

    @pytest.mark.parametrize("value", ["", "0", "false", "off", "no", " No "])
    def test_off_spellings_leave_it_announced(self, setup: Any, value: str) -> None:
        _session, view = setup(env={"GRAPHMIND_DISABLE_EDIT_INPUT": value})
        assert "edit-input" in view.wait_for_type("hello")["payload"]["capabilities"]


# -- exec.paused.editable ----------------------------------------------------------


class TestEditable:
    def test_true_when_the_integration_app_and_debugger_agree(
        self, setup: Any, validate_frame: Any
    ) -> None:
        session, view = setup()
        options, _ = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        paused = view.wait_for_type("exec.paused")
        assert list(paused["payload"]) == ["pauseId", "nodeId", "point", "editable"]
        assert paused["payload"]["editable"] is True
        view.resume(pause_id_of(paused), "continue")
        assert gate.result(5) == CONTINUE
        all_frames_valid(view, validate_frame)

    @pytest.mark.parametrize(
        ("label", "hub", "gm_options", "viewer_options"),
        [
            ("a 0.5 debugger (no hubCapabilities)", None, {}, {}),
            ("a debugger whose hubCapabilities lack edit-input", [], {}, {}),
            ("the echoed capabilities do not count", None, {}, {"echo_capabilities": True}),
            ("the kill switch", EDITS, {"env": {"GRAPHMIND_DISABLE_EDIT_INPUT": "1"}}, {}),
        ],
    )
    def test_absent_unless_every_condition_holds(
        self, setup: Any, label: str, hub: Any, gm_options: Any, viewer_options: Any
    ) -> None:
        session, view = setup(hub=hub, viewer_options=viewer_options, **gm_options)
        options, _ = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        paused = view.wait_for_type("exec.paused")
        # The 0.5 frame, byte for byte.
        assert list(paused["payload"]) == ["pauseId", "nodeId", "point"], label
        view.resume(pause_id_of(paused), "continue")
        assert gate.result(5) == CONTINUE

    def test_not_editable_when_the_integration_did_not_say_so(self, setup: Any) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL))
        paused = view.wait_for_type("exec.paused")
        assert "editable" not in paused["payload"]
        view.resume(pause_id_of(paused), "continue")
        gate.result(5)

    def test_detached_the_options_are_never_consulted(self, make_gm: Any) -> None:
        instance = make_gm(url="ws://127.0.0.1:9/ingest")
        calls: list[Any] = []
        decision = instance.session.gate(
            "before", TOOL, editable=True, validate_input=lambda *a: calls.append(a)
        )
        assert decision is CONTINUE and calls == []


# -- an accepted edit ----------------------------------------------------------------


class TestAcceptedEdit:
    def test_continue_with_input_at_before(self, setup: Any, validate_frame: Any) -> None:
        session, view = setup()
        options, seen = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(
            pauseId=pause_id, action="continue", input={"query": "LIS"}, requestId="r1"
        )
        decision = gate.result(5)
        assert decision.action == "continue" and decision.has_input
        assert decision.input == {"query": "LIS", "limit": 5}
        resumed = view.wait_for_type("exec.resumed")
        assert resumed["payload"] == {
            "pauseId": pause_id,
            "action": "continue",
            "edited": {"after": {"query": "LIS", "limit": 5}},
            "requestId": "r1",
        }
        assert seen == [{"query": "LIS"}]
        all_frames_valid(view, validate_frame)

    @pytest.mark.parametrize("point", ["after", "error"])
    def test_retry_with_input_at_after_and_error(self, setup: Any, point: str) -> None:
        session, view = setup(breakpoints=[{"point": point}])
        options, _ = tool_edit()
        gate = background(lambda: session.gate(point, TOOL, result="r", **options))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="retry", input={"limit": 1})
        decision = gate.result(5)
        assert (decision.action, decision.input) == ("retry", {"query": "AMS", "limit": 1})

    def test_without_a_validator_the_proposed_input_is_used_as_it_is(self, setup: Any) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL, editable=True))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input=["any", "json"])
        assert gate.result(5) == GateDecision("continue", input=["any", "json"])

    def test_decision_input_is_the_validator_value_itself_the_wire_its_json_copy(
        self, setup: Any
    ) -> None:
        session, view = setup()
        marker = object()
        value = {"when": marker, "n": 1}
        gate = background(
            lambda: session.gate(
                "before", TOOL, editable=True, validate_input=lambda p, c: accept(value)
            )
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"n": 1})
        decision = gate.result(5)
        assert decision.input is value and decision.input["when"] is marker
        after = view.wait_for_type("exec.resumed")["payload"]["edited"]["after"]
        assert after == {"when": repr(marker), "n": 1}

    def test_a_coroutine_validator_is_run_to_completion_in_a_sync_gate(self, setup: Any) -> None:
        session, view = setup()

        async def validate(proposed: Any, context: Any) -> Any:
            await asyncio.sleep(0.01)
            return accept({**proposed, "checked": True})

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        assert gate.result(5).input == {"q": 1, "checked": True}


class TestHostHandOff:
    """The validator is host code: it runs on the thread (or task) blocked in the
    gate, with the host's context variables — never on the transport's thread."""

    def test_sync_the_validator_runs_on_the_gated_thread(self, setup: Any) -> None:
        session, view = setup()
        observed: list[tuple[threading.Thread, str]] = []
        caller: list[threading.Thread] = []

        def validate(proposed: Any, context: Any) -> Any:
            observed.append((threading.current_thread(), HOST_VAR.get()))
            return accept(proposed)

        def host() -> Any:
            caller.append(threading.current_thread())
            HOST_VAR.set("host-value")
            return session.gate("before", TOOL, editable=True, validate_input=validate)

        gate = background(host)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        assert gate.result(5).input == {"q": 1}
        assert observed == [(caller[0], "host-value")]
        assert observed[0][0].name != "graphmind"

    async def test_async_the_validator_runs_in_the_gated_task(self, setup: Any) -> None:
        session, view = setup()
        observed: list[Any] = []

        async def validate(proposed: Any, context: Any) -> Any:
            observed.append((threading.current_thread(), HOST_VAR.get(), asyncio.current_task()))
            await asyncio.sleep(0)
            return accept(proposed)

        async def host() -> Any:
            HOST_VAR.set("task-value")
            return await session.gate_async("before", TOOL, editable=True, validate_input=validate)

        task = asyncio.ensure_future(host())
        pause_id = pause_id_of(await view.wait_for_type_async("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 2})
        decision = await asyncio.wait_for(task, 5)
        assert decision.input == {"q": 2}
        thread, value, _running = observed[0]
        assert thread is threading.current_thread() and value == "task-value"

    async def test_async_a_sync_validator_runs_in_the_gated_task_too(self, setup: Any) -> None:
        session, view = setup()
        threads: list[threading.Thread] = []

        def validate(proposed: Any, context: Any) -> Any:
            threads.append(threading.current_thread())
            return accept(proposed)

        task = asyncio.ensure_future(
            session.gate_async("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(await view.wait_for_type_async("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 3})
        assert (await asyncio.wait_for(task, 5)).input == {"q": 3}
        assert threads == [threading.current_thread()]


# -- a refused edit keeps the gate held ------------------------------------------------


class TestRefusals:
    def test_refuse_then_accept_under_the_same_pause_id(
        self, setup: Any, validate_frame: Any
    ) -> None:
        session, view = setup()
        verdicts = [refuse("schema", "limit must be at most 10")]

        def validate(proposed: Any, context: Any) -> Any:
            return verdicts.pop(0) if verdicts else accept(proposed)

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"limit": 99}, requestId="a")
        refused = view.wait_for_type("exec.refused")
        assert refused["payload"] == {
            "pauseId": pause_id,
            "code": "schema",
            "message": "limit must be at most 10",
            "requestId": "a",
        }
        assert settled_within(gate, 0.05) == "pending"
        assert session.stats().held_gates == 1
        view.resume_with(pauseId=pause_id, action="continue", input={"limit": 9}, requestId="b")
        assert gate.result(5).input == {"limit": 9}
        assert len(view.of_type("exec.paused")) == 1
        assert view.wait_for_type("exec.resumed")["payload"]["requestId"] == "b"
        all_frames_valid(view, validate_frame)

    def test_refuse_then_continue_without_input_runs_the_original(self, setup: Any) -> None:
        session, view = setup()
        gate = background(
            lambda: session.gate(
                "before", TOOL, editable=True, validate_input=lambda p, c: refuse("shape")
            )
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        view.wait_for_type("exec.refused")
        view.resume(pause_id, "continue")
        decision = gate.result(5)
        assert decision == CONTINUE and not decision.has_input
        assert "edited" not in view.wait_for_type("exec.resumed")["payload"]

    def test_two_refusals_then_abort(self, setup: Any) -> None:
        session, view = setup()
        verdicts = [refuse("schema", "first"), refuse("shape")]
        aborted: list[bool] = []

        def host() -> Any:
            with session.run("r") as ctx:
                decision = session.gate(
                    "before",
                    TOOL,
                    editable=True,
                    validate_input=lambda p, c: verdicts.pop(0),
                )
                aborted.append(ctx.aborted)
                return decision

        gate = background(host)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        nth_of_type(view, "exec.refused", 1)
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 2})
        nth_of_type(view, "exec.refused", 2)
        assert session.stats().held_gates == 1
        view.resume(pause_id, "abort")
        assert gate.result(5).action == "abort"
        assert aborted == [True]
        assert [f["payload"] for f in view.of_type("exec.refused")] == [
            {"pauseId": pause_id, "code": "schema", "message": "first"},
            {"pauseId": pause_id, "code": "shape"},
        ]

    @pytest.mark.parametrize(
        ("point", "action"),
        [
            ("before", "retry"),
            ("before", "inject"),
            ("before", "abort"),
            ("after", "continue"),
            ("after", "inject"),
            ("after", "abort"),
            ("error", "continue"),
            ("error", "inject"),
            ("error", "abort"),
        ],
    )
    def test_input_with_the_wrong_action_is_refused_shape(
        self, setup: Any, point: str, action: str
    ) -> None:
        session, view = setup(breakpoints=[{"point": point}])
        options, seen = tool_edit()
        gate = background(lambda: session.gate(point, TOOL, **options))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(
            pauseId=pause_id, action=action, input={"query": "LIS"}, output={"injected": True}
        )
        assert view.wait_for_type("exec.refused")["payload"]["code"] == "shape"
        assert settled_within(gate, 0.05) == "pending"
        assert seen == []  # the validator is never consulted
        view.resume(pause_id, "continue")
        assert gate.result(5) == CONTINUE

    @pytest.mark.parametrize(
        ("hub", "env", "editable", "code"),
        [
            (EDITS, {"GRAPHMIND_DISABLE_EDIT_INPUT": "on"}, True, "disabled"),
            ([], {}, True, "disabled"),
            (None, {}, True, "disabled"),
            (EDITS, {}, False, "unsupported"),
        ],
    )
    def test_refusal_codes_for_the_edit_conditions(
        self, setup: Any, hub: Any, env: Any, editable: bool, code: str
    ) -> None:
        session, view = setup(hub=hub, env=env)
        options, seen = tool_edit()
        options["editable"] = editable
        gate = background(lambda: session.gate("before", TOOL, **options))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"query": "LIS"})
        refused = view.wait_for_type("exec.refused")["payload"]
        assert refused["code"] == code and isinstance(refused["message"], str)
        assert settled_within(gate, 0.05) == "pending"
        assert seen == []
        view.resume(pause_id, "continue")
        assert gate.result(5) == CONTINUE

    @pytest.mark.parametrize("validate_input", ["merge_tool_input", True, {"validate": 1}])
    def test_a_validator_that_is_not_callable_fails_closed(
        self, setup: Any, validate_input: Any
    ) -> None:
        warnings: list[str] = []
        session, view = setup(logger=warnings.append)
        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate_input)
        )
        paused = view.wait_for_type("exec.paused")
        assert "editable" not in paused["payload"]
        view.resume_with(
            pauseId=pause_id_of(paused), action="continue", input={"x": 1}, requestId="q4"
        )
        refused = view.wait_for_type("exec.refused")["payload"]
        assert (refused["code"], refused["requestId"]) == ("unsupported", "q4")
        assert len([w for w in warnings if "validate_input is not callable" in w]) == 1
        view.resume(pause_id_of(paused), "continue")
        assert gate.result(5) == CONTINUE

    @pytest.mark.parametrize(
        ("value", "code"),
        [
            ({"query": REDACTED}, "placeholder"),
            ({"filter": {REDACTED: "x"}}, "placeholder"),
            ({"filter": {"__graphmindTruncated": True, "bytes": 9, "preview": "{"}}, "truncated"),
            ({"query": "AMS…[graphmind: truncated]"}, "truncated"),
            ({"state": {"__graphmind": "truncated", "preview": "{"}}, "truncated"),
            ({"query": "abc…[truncated]"}, "truncated"),
            ({"blob": "<2048 bytes>"}, "truncated"),
            ({"items": [1, "…[3 more]"]}, "truncated"),
        ],
    )
    def test_placeholders_and_previews_are_refused_before_the_validator(
        self, setup: Any, value: Any, code: str
    ) -> None:
        session, view = setup()
        options, seen = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input=value)
        assert view.wait_for_type("exec.refused")["payload"]["code"] == code
        assert seen == []
        view.resume(pause_id, "continue")
        gate.result(5)

    @pytest.mark.parametrize(
        "json_text",
        [
            '{"opts":{"__proto__":{"isAdmin":true}}}',
            '{"query":"LIS","constructor":{"prototype":{"polluted":true}}}',
        ],
    )
    def test_pollution_paths_are_refused_even_with_a_passthrough_validator(
        self, setup: Any, json_text: str
    ) -> None:
        session, view = setup()
        calls: list[Any] = []

        def passthrough(proposed: Any, context: Any) -> Any:
            calls.append(proposed)
            return accept(proposed)

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=passthrough)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input=json.loads(json_text))
        assert view.wait_for_type("exec.refused")["payload"]["code"] == "shape"
        assert calls == []
        view.resume(pause_id, "continue")
        gate.result(5)

    @pytest.mark.parametrize(
        "validate_input",
        [
            lambda p, c: (_ for _ in ()).throw(RuntimeError("SECRET-FROM-VALIDATOR")),
            lambda p, c: None,
            lambda p, c: {"ok": "yes"},
            lambda p, c: {"ok": False, "code": "nope"},
            lambda p, c: {"ok": True},
        ],
        ids=["raises", "returns-none", "ok-as-a-string", "unknown-code", "ok-without-value"],
    )
    def test_a_failing_validator_refuses_shape_and_leaks_nothing(
        self, setup: Any, validate_input: Any
    ) -> None:
        warnings: list[str] = []
        session, view = setup(logger=warnings.append)
        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate_input)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        refused = view.wait_for_type("exec.refused")
        assert refused["payload"]["code"] == "shape"
        assert "SECRET" not in json.dumps(view.frames()) and "SECRET" not in "".join(warnings)
        assert settled_within(gate, 0.05) == "pending"
        view.resume(pause_id, "continue")
        assert gate.result(5) == CONTINUE

    def test_an_accepted_value_with_no_json_form_is_refused(self, setup: Any) -> None:
        session, view = setup()
        cyclic: dict[str, Any] = {}
        cyclic["self"] = cyclic
        gate = background(
            lambda: session.gate(
                "before", TOOL, editable=True, validate_input=lambda p, c: accept(cyclic)
            )
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        refused = view.wait_for_type("exec.refused")["payload"]
        assert refused["code"] == "shape" and "no JSON form" in refused["message"]
        view.resume(pause_id, "continue")
        gate.result(5)

    def test_a_validator_message_is_sanitised_and_cut_to_200(self, setup: Any) -> None:
        session, view = setup()
        esc = "\x1b"
        gate = background(
            lambda: session.gate(
                "before",
                TOOL,
                editable=True,
                validate_input=lambda p, c: refuse("schema", f"{esc}[31mbad{'!' * 500}"),
            )
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        message = view.wait_for_type("exec.refused")["payload"]["message"]
        assert len(message) == 200 and esc not in message and message.startswith("[31mbad")
        view.resume(pause_id, "continue")
        gate.result(5)

    def test_a_resume_while_validating_is_ignored(self, setup: Any) -> None:
        session, view = setup()
        entered = threading.Event()
        release = threading.Event()
        calls: list[Any] = []

        def validate(proposed: Any, context: Any) -> Any:
            calls.append(proposed)
            entered.set()
            release.wait(5)
            return accept(proposed)

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": "first"})
        assert entered.wait(5)
        view.resume(pause_id, "abort")
        view.resume_with(pauseId=pause_id, action="continue", input={"q": "second"})
        time.sleep(0.1)
        assert settled_within(gate, 0.01) == "pending"
        release.set()
        assert gate.result(5).input == {"q": "first"}
        assert calls == [{"q": "first"}]
        assert view.of_type("exec.refused") == []


# -- validation time limits and fail-open ----------------------------------------------


class TestTimeLimits:
    async def test_an_async_validator_that_never_settles_is_refused_after_the_limit(
        self, setup: Any
    ) -> None:
        """The real limit (4 s), once: a never-settling validator cannot wedge a gate."""
        session, view = setup()
        started: list[float] = []

        async def never(proposed: Any, context: Any) -> Any:
            started.append(time.monotonic())
            await asyncio.Event().wait()

        task = asyncio.ensure_future(
            session.gate_async("before", TOOL, editable=True, validate_input=never)
        )
        pause_id = pause_id_of(await view.wait_for_type_async("exec.paused"))
        sent = time.monotonic()
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1}, requestId="slow")
        refused = await view.wait_for_async(lambda f: f.get("type") == "exec.refused", timeout=9)
        assert time.monotonic() - sent >= session_module.VALIDATION_TIMEOUT_MS / 1000 - 0.1
        assert refused["payload"] == {
            "pauseId": pause_id,
            "code": "shape",
            "message": "the input was not validated within 4 s",
            "requestId": "slow",
        }
        assert session.stats().held_gates == 1
        view.resume(pause_id, "continue")
        assert await asyncio.wait_for(task, 5) == CONTINUE

    def test_a_synchronous_validator_over_the_limit_is_refused_too(
        self, setup: Any, monkeypatch: Any
    ) -> None:
        monkeypatch.setattr(session_module, "VALIDATION_TIMEOUT_MS", 150)
        session, view = setup()

        def slow(proposed: Any, context: Any) -> Any:
            time.sleep(0.3)
            return accept(proposed)

        gate = background(lambda: session.gate("before", TOOL, editable=True, validate_input=slow))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        refused = view.wait_for_type("exec.refused")["payload"]
        assert refused["code"] == "shape" and "not validated within" in refused["message"]
        assert settled_within(gate, 0.05) == "pending"
        view.resume(pause_id, "continue")
        assert gate.result(5) == CONTINUE

    def test_a_coroutine_validator_in_a_sync_gate_is_bounded(
        self, setup: Any, monkeypatch: Any
    ) -> None:
        monkeypatch.setattr(session_module, "VALIDATION_TIMEOUT_MS", 150)
        session, view = setup()

        async def slow(proposed: Any, context: Any) -> Any:
            await asyncio.sleep(5)

        gate = background(lambda: session.gate("before", TOOL, editable=True, validate_input=slow))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        assert view.wait_for_type("exec.refused", timeout=3)["payload"]["code"] == "shape"
        view.resume(pause_id, "continue")
        assert gate.result(5) == CONTINUE

    def test_a_disconnect_during_validation_continues_with_the_original_input(
        self, setup: Any
    ) -> None:
        session, view = setup()
        entered = threading.Event()
        release = threading.Event()

        def validate(proposed: Any, context: Any) -> Any:
            entered.set()
            release.wait(5)
            return refuse("schema", "late")

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1}, requestId="d")
        assert entered.wait(5)
        view.kill_abruptly()
        from .conftest import wait_until

        wait_until(lambda: not session.attached, label="detach")
        release.set()
        decision = gate.result(5)
        assert decision == CONTINUE and not decision.has_input
        assert session.stats().held_gates == 0

    def test_a_pause_timeout_during_validation_continues_and_drops_the_verdict(
        self, setup: Any
    ) -> None:
        session, view = setup(pause_timeout=0.3)
        release = threading.Event()

        def validate(proposed: Any, context: Any) -> Any:
            release.wait(5)
            return accept({"q": "late"})

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1}, requestId="t")
        resumed = view.wait_for_type("exec.resumed", timeout=3)
        # Released by the timer: no requestId (nobody's answer), no edit.
        assert resumed["payload"] == {"pauseId": pause_id, "action": "continue"}
        release.set()
        decision = gate.result(5)
        assert decision == CONTINUE and not decision.has_input
        time.sleep(0.05)
        assert view.of_type("exec.refused") == []
        assert len(view.of_type("exec.resumed")) == 1

    def test_a_verdict_after_the_pause_deadline_continues_without_a_refusal(
        self, setup: Any
    ) -> None:
        session, view = setup(pause_timeout=0.2)
        entered = threading.Event()

        def validate(proposed: Any, context: Any) -> Any:
            entered.set()
            time.sleep(0.35)  # the deadline passes while this blocks
            return refuse("schema", "too late to matter")

        gate = background(
            lambda: session.gate("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        assert entered.wait(5)
        assert gate.result(5) == CONTINUE
        assert view.of_type("exec.refused") == []

    def test_a_refusal_does_not_restart_the_pause_timeout(self, setup: Any) -> None:
        session, view = setup(pause_timeout=0.6)
        gate = background(
            lambda: session.gate(
                "before", TOOL, editable=True, validate_input=lambda p, c: refuse("schema")
            )
        )
        paused_at = time.monotonic()
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        time.sleep(0.3)
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        view.wait_for_type("exec.refused")
        assert gate.result(5) == CONTINUE
        assert time.monotonic() - paused_at < 1.1  # one 0.6 s timer, not a second one

    async def test_cancelling_the_task_during_validation_discards_the_gate(
        self, setup: Any
    ) -> None:
        session, view = setup()
        entered = asyncio.Event()

        async def validate(proposed: Any, context: Any) -> Any:
            entered.set()
            await asyncio.sleep(10)

        task = asyncio.ensure_future(
            session.gate_async("before", TOOL, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(await view.wait_for_type_async("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1})
        await asyncio.wait_for(entered.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert session.stats().held_gates == 0
        resumed = await view.wait_for_type_async("exec.resumed")
        assert resumed["payload"] == {"pauseId": pause_id, "action": "continue"}


# -- composition, held time, requestId ----------------------------------------------------


class TestComposition:
    def test_step_mode_pauses_are_editable(self, setup: Any) -> None:
        session, view = setup(breakpoints=[], viewer_options={"mode": "step"})
        options, _ = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        paused = view.wait_for_type("exec.paused")
        assert paused["payload"]["editable"] is True
        view.resume_with(pauseId=pause_id_of(paused), action="continue", input={"limit": 2})
        assert gate.result(5).input == {"query": "AMS", "limit": 2}

    def test_a_loop_hold_is_editable_and_the_fingerprint_keeps_the_model_input(
        self, setup: Any
    ) -> None:
        session, view = setup(breakpoints=[])
        for _ in range(2):
            session.start_node("tool:search", "tool", "search", "i", input={"q": "same"})
        session.start_node("tool:search", "tool", "search", "i3", input={"q": "same"})
        options, _ = tool_edit({"q": "same"})
        gate = background(lambda: session.gate("before", TOOL, **options))
        paused = view.wait_for_type("exec.paused")["payload"]
        assert paused["reason"] == "loop" and paused["editable"] is True
        fingerprint = paused["loop"]["fingerprint"]
        view.resume_with(pauseId=paused["pauseId"], action="continue", input={"q": "fixed"})
        assert gate.result(5).input == {"q": "fixed"}
        assert fingerprint == paused["loop"]["fingerprint"]
        started = view.of_type("node.started")
        assert [f["payload"]["input"] for f in started] == [{"q": "same"}] * 3

    def test_held_ms_is_one_interval_however_many_refusals(self, setup: Any) -> None:
        session, view = setup()
        verdicts = [refuse("schema"), refuse("schema")]

        def host() -> Any:
            session.start_node("tool:search", "tool", "search", "c1", input={"q": 1})
            decision = session.gate(
                "before",
                TOOL,
                editable=True,
                validate_input=lambda p, c: verdicts.pop(0) if verdicts else accept(p),
            )
            session.finish_node("tool:search", "c1", 1.0, output="ok")
            return decision

        gate = background(host)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        opened = time.monotonic()
        for n in (1, 2):
            time.sleep(0.1)
            view.resume_with(pauseId=pause_id, action="continue", input={"q": n})
            nth_of_type(view, "exec.refused", n)
        time.sleep(0.1)
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 3})
        gate.result(5)
        total_ms = (time.monotonic() - opened) * 1000
        finished = view.wait_for_type("node.finished")["payload"]
        assert finished["heldMs"] >= 250 and finished["heldMs"] <= total_ms + 100
        assert len(view.of_type("exec.paused")) == 1 and len(view.of_type("exec.resumed")) == 1


class TestRequestId:
    @pytest.mark.parametrize("action", ["continue", "abort"])
    def test_echoed_on_a_plain_resume(self, setup: Any, action: str) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action=action, requestId="rq-1")
        gate.result(5)
        assert view.wait_for_type("exec.resumed")["payload"] == {
            "pauseId": pause_id,
            "action": action,
            "requestId": "rq-1",
        }

    def test_works_under_a_0_5_debugger(self, setup: Any) -> None:
        session, view = setup(hub=None)
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", requestId="old-hub")
        gate.result(5)
        assert view.wait_for_type("exec.resumed")["payload"]["requestId"] == "old-hub"

    def test_absent_from_the_resume_absent_from_the_answer(self, setup: Any) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume(pause_id, "continue")
        gate.result(5)
        assert view.wait_for_type("exec.resumed")["payload"] == {
            "pauseId": pause_id,
            "action": "continue",
        }

    def test_a_long_request_id_is_echoed_on_a_refusal_and_on_the_accepted_edit(
        self, setup: Any, validate_frame: Any
    ) -> None:
        session, view = setup()
        long_id = "r" * 300
        verdicts = [refuse("schema")]
        gate = background(
            lambda: session.gate(
                "before",
                TOOL,
                editable=True,
                validate_input=lambda p, c: verdicts.pop(0) if verdicts else accept(p),
            )
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 1}, requestId=long_id)
        assert view.wait_for_type("exec.refused")["payload"]["requestId"] == long_id
        view.resume_with(pauseId=pause_id, action="continue", input={"q": 2}, requestId=long_id)
        gate.result(5)
        assert view.wait_for_type("exec.resumed")["payload"]["requestId"] == long_id
        all_frames_valid(view, validate_frame)

    def test_a_request_id_that_is_not_a_string_is_not_echoed(self, setup: Any) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", requestId=7)
        gate.result(5)
        assert "requestId" not in view.wait_for_type("exec.resumed")["payload"]


# -- the inject guard (client side, every debugger) ------------------------------------


class TestInjectGuard:
    @pytest.mark.parametrize("hub", [EDITS, None], ids=["0.6-debugger", "0.5-debugger"])
    @pytest.mark.parametrize(
        ("output", "code"),
        [
            ({"answer": REDACTED}, "placeholder"),
            (
                {"rows": {"__graphmindTruncated": True, "bytes": 900000, "preview": "["}},
                "truncated",
            ),
            ("long…[graphmind: truncated]", "truncated"),
            ({"note": "payload truncated: showing first 10 of 99 JSON characters"}, "truncated"),
            ({"body": "<4096 bytes>"}, "truncated"),
            ({"text": "cut…[truncated]"}, "truncated"),
        ],
    )
    def test_a_placeholder_or_preview_is_never_injected(
        self, setup: Any, hub: Any, output: Any, code: str
    ) -> None:
        warnings: list[str] = []
        session, view = setup(hub=hub, logger=warnings.append)
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="inject", output=output, requestId="inj")
        refused = view.wait_for_type("exec.refused")["payload"]
        assert (refused["code"], refused["requestId"]) == (code, "inj")
        assert settled_within(gate, 0.05) == "pending"
        # Under a 0.5 debugger (which does not show exec.refused) the app log says why.
        logged = [w for w in warnings if "refused an injected value" in w]
        assert len(logged) == (1 if hub is None else 0)
        view.resume(pause_id, "retry")
        assert gate.result(5).action == "retry"

    def test_a_legitimate_truncated_field_is_injected(self, setup: Any) -> None:
        session, view = setup()
        gate = background(lambda: session.gate("before", TOOL))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        value = {"tree": [], "truncated": True, "note": "GitHub API capped the listing"}
        view.resume_with(pauseId=pause_id, action="inject", output=value)
        assert gate.result(5) == GateDecision("inject", value)

    def test_through_a_wrapped_tool_the_recorded_bytes_preview_never_becomes_the_result(
        self, make_gm: Any, viewer: Any
    ) -> None:
        view = viewer(breakpoints=[{"kind": "tool", "name": "fetch", "point": "after"}])
        instance = make_gm(url=view.url)
        assert instance.ready(5.0)

        @instance.tool
        def fetch() -> bytes:
            return b"\x00" * 64

        result = background(fetch)
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="inject", output="<64 bytes>")
        assert view.wait_for_type("exec.refused")["payload"]["code"] == "truncated"
        view.resume(pause_id, "continue")
        assert result.result(5) == b"\x00" * 64


# -- hidden inputs and redaction through the live session -----------------------------------


class TestHiddenInput:
    @pytest.mark.parametrize(
        ("env", "node", "hidden"),
        [
            ({"GRAPHMIND_HIDE_TOOL_ARGS": "1"}, TOOL, True),
            ({"GRAPHMIND_HIDE_TOOL_ARGS": "1"}, LLM, False),
            ({"GRAPHMIND_HIDE_INPUTS": "yes"}, LLM, True),
            ({"GRAPHMIND_HIDE_OUTPUTS": "1"}, TOOL, False),
            ({}, TOOL, False),
        ],
    )
    def test_the_context_says_whether_a_switch_hides_the_input(
        self, setup: Any, env: Any, node: GateNode, hidden: bool
    ) -> None:
        session, view = setup(env=env)
        contexts: list[ValidateInputContext] = []

        def validate(proposed: Any, context: ValidateInputContext) -> Any:
            contexts.append(context)
            return merge_tool_input({"account": "ACC-7731", "amount": 10}, proposed, context)

        gate = background(
            lambda: session.gate("before", node, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"amount": 5})
        decision = gate.result(5)
        assert [c.input_hidden for c in contexts] == [hidden]
        expected = {"amount": 5} if hidden else {"account": "ACC-7731", "amount": 5}
        assert decision.input == expected

    @pytest.mark.parametrize(
        ("gm_options", "node", "covered"),
        [
            ({"env": {"GRAPHMIND_HIDE_INPUTS": "1"}}, TOOL, True),
            ({"env": {"GRAPHMIND_HIDE_INPUTS": "yes"}}, LLM, True),
            ({"hide_inputs": True}, TOOL, True),
            ({"env": {"GRAPHMIND_HIDE_TOOL_ARGS": "on"}}, TOOL, True),
            ({"hide_tool_args": True}, TOOL, True),
            ({"env": {"GRAPHMIND_HIDE_TOOL_ARGS": "1"}}, LLM, False),
            ({"env": {"GRAPHMIND_HIDE_OUTPUTS": "1"}}, TOOL, False),
            ({"env": {"GRAPHMIND_HIDE_TOOL_RESULTS": "1"}}, TOOL, False),
            ({"env": {}}, TOOL, False),
        ],
    )
    def test_answers_are_redacted_exactly_when_the_input_is(
        self, setup: Any, validate_frame: Any, gm_options: Any, node: GateNode, covered: bool
    ) -> None:
        session, view = setup(**gm_options)
        calls: list[int] = []

        def validate(proposed: Any, context: Any) -> Any:
            calls.append(1)
            if len(calls) == 1:
                return refuse("schema", f"rejected {CANARY}")
            return accept(proposed)

        gate = background(
            lambda: session.gate("before", node, editable=True, validate_input=validate)
        )
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": CANARY})
        refused = view.wait_for_type("exec.refused")
        view.resume_with(pauseId=pause_id, action="continue", input={"q": CANARY})
        # The host always runs with the real edit.
        assert gate.result(5) == GateDecision("continue", input={"q": CANARY})
        resumed = view.wait_for_type("exec.resumed")
        if covered:
            assert refused["payload"] == {
                "pauseId": pause_id,
                "code": "schema",
                "redaction": {"count": 1, "keys": ["message"]},
            }
            assert resumed["payload"] == {
                "pauseId": pause_id,
                "action": "continue",
                "edited": {"after": REDACTED},
                "redaction": {"count": 1, "keys": ["edited"]},
            }
            assert CANARY not in json.dumps(view.frames())
        else:
            assert refused["payload"] == {
                "pauseId": pause_id,
                "code": "schema",
                "message": f"rejected {CANARY}",
            }
            assert resumed["payload"] == {
                "pauseId": pause_id,
                "action": "continue",
                "edited": {"after": {"q": CANARY}},
            }
        all_frames_valid(view, validate_frame)

    def test_frames_replayed_on_attach_are_already_redacted(self, setup: Any) -> None:
        from .conftest import wait_until

        session, view = setup(env={"GRAPHMIND_HIDE_TOOL_ARGS": "1"})
        gate = background(lambda: session.gate("before", TOOL, editable=True))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"q": CANARY})
        gate.result(5)
        view.wait_for_type("exec.resumed")
        view.drop_connections()
        session._transport.kick()
        wait_until(
            lambda: view.connection_count >= 2 and len(view.of_type("exec.resumed")) >= 2,
            timeout=8,
            label="replay",
        )
        assert CANARY not in json.dumps(view.frames())


class TestReattach:
    def test_hub_capabilities_are_re_read_on_every_attach(self, setup: Any) -> None:
        from .conftest import wait_until

        session, view = setup()
        view.hub_capabilities = []  # the debugger restarts without edits
        view.drop_connections()
        session._transport.kick()
        wait_until(
            lambda: view.connection_count >= 2 and session.attached, timeout=8, label="re-attach"
        )
        wait_until(lambda: len(view.of_type("hello")) >= 2, label="second hello")
        options, _ = tool_edit()
        gate = background(lambda: session.gate("before", TOOL, **options))
        paused = view.wait_for_type("exec.paused")
        assert "editable" not in paused["payload"]
        view.resume_with(pauseId=pause_id_of(paused), action="continue", input={"q": 1})
        assert view.wait_for_type("exec.refused")["payload"]["code"] == "disabled"
        view.resume(pause_id_of(paused), "continue")
        gate.result(5)


class TestInternalFailure:
    @pytest.mark.parametrize("mode", ["sync", "async"])
    def test_a_verdict_that_cannot_be_applied_fails_open_never_spins(
        self, setup: Any, monkeypatch: Any, mode: str
    ) -> None:
        warnings: list[str] = []
        session, view = setup(logger=warnings.append)

        def broken(*_args: Any) -> None:
            raise RuntimeError("internal")

        monkeypatch.setattr(session, "_apply_verdict", broken)
        monkeypatch.setattr(session._engine, "reopen", broken)
        options, _ = tool_edit()
        if mode == "sync":
            gate = background(lambda: session.gate("before", TOOL, **options))
        else:
            gate = background(lambda: asyncio.run(session.gate_async("before", TOOL, **options)))
        pause_id = pause_id_of(view.wait_for_type("exec.paused"))
        view.resume_with(pauseId=pause_id, action="continue", input={"limit": 1})
        decision = gate.result(5)
        assert decision == CONTINUE and not decision.has_input
        assert session.stats().held_gates == 0
        assert any("internal error applying an edit verdict" in w for w in warnings)
