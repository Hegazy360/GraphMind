"""``exec.paused.instanceId`` (0.6.0): a gate whose integration knows which
execution it holds names it, so a debugger can tell parallel calls of one node
apart (the viewer then targets that call exactly). Parity with
``packages/client/test/paused-instance.test.ts``.
"""

from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Any

from graphmind.gate import GateNode

from .helpers.providers import CHAT_COMPLETION, json_responder, make_openai


def background(fn: Any, *args: Any, **kwargs: Any) -> concurrent.futures.Future[Any]:
    future: concurrent.futures.Future[Any] = concurrent.futures.Future()

    def run() -> None:
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:
            future.set_exception(exc)

    threading.Thread(target=run, daemon=True).start()
    return future


def _paused(view: Any, count: int, timeout: float = 8.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frames = view.of_type("exec.paused")
        if len(frames) >= count:
            return [f["payload"] for f in frames]
        time.sleep(0.01)
    raise AssertionError(f"expected {count} exec.paused frames")


def _started(view: Any, node_id: str) -> list[dict[str, Any]]:
    return [f["payload"] for f in view.of_type("node.started") if f["payload"]["nodeId"] == node_id]


def test_parallel_tool_calls_each_name_their_own_execution(
    attached: Any, validate_frame: Any
) -> None:
    instance, view = attached(breakpoints=[{"kind": "tool", "name": "search"}])

    @instance.tool
    def search(query: str) -> str:
        return query.upper()

    first = background(search, "ams")
    second = background(search, "lis")
    pauses = _paused(view, 2)
    started = _started(view, "tool:search")
    assert len(started) == 2
    named = {p["instanceId"] for p in pauses}
    assert named == {s["instanceId"] for s in started} and len(named) == 2
    for pause in pauses:
        view.resume(pause["pauseId"], "continue")
    assert {first.result(5), second.result(5)} == {"AMS", "LIS"}
    for frame in view.frames():
        if frame["type"] != "hello":
            validate_frame(frame)


def test_an_llm_step_names_its_execution(attached: Any) -> None:
    instance, view = attached(breakpoints=[{"kind": "llm"}])
    client, _recorder = make_openai(json_responder(CHAT_COMPLETION))
    instance.instrument_openai(client)
    result = background(
        client.chat.completions.create,
        model="gpt-test",
        messages=[{"role": "user", "content": "hi"}],
    )
    [pause] = _paused(view, 1)
    [started] = _started(view, "llm:step")
    assert pause["instanceId"] == started["instanceId"]
    view.resume(pause["pauseId"], "continue")
    assert result.result(5).choices[0].message.content == "Lisbon is sunny."


def test_a_gate_node_without_an_instance_sends_none(attached: Any) -> None:
    instance, view = attached(breakpoints=[{"kind": "tool", "name": "t"}])
    session = instance.session
    gate = background(session.gate, "before", GateNode("tool:t", "tool", "t"))
    [pause] = _paused(view, 1)
    assert "instanceId" not in pause
    view.resume(pause["pauseId"], "continue")
    assert gate.result(5).action == "continue"
