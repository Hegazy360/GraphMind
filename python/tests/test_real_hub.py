"""A Python app against the REAL hub (``packages/cli`` dist): an editable tool
gate, edited through the hub's HTTP resume endpoint with the agent token.

The end-to-end proof of contract C2 + C3 for the Python SDK: ``graphmind serve
--allow-control=edit`` lists ``edit-input`` in ``hello.ack.hubCapabilities``,
the SDK offers its tool gate as ``editable``, ``POST
/api/runs/:runId/pauses/:pauseId/resume`` with ``Authorization: Bearer
<agent token>`` forwards the edit, the SDK validates it on the host thread
against the function's signature (a refusal comes back as HTTP 422 with the
gate still held), and the accepted edit runs the REAL function — recorded as
``exec.resumed.edited`` with the hub-stamped ``principal``.

Skipped when Node or the built CLI (``pnpm -r --filter './packages/**' run
build``) is not available. The hub runs on a free port of its own, with its
own ``GRAPHMIND_HOME`` and database, so it never touches a developer's.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from graphmind.api import GraphMind

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / "packages" / "cli" / "dist" / "cli.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None or not CLI.exists(), reason="needs node and the built CLI (packages/cli/dist)"
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Hub:
    """``graphmind serve --json`` on a free port, in a throwaway home."""

    def __init__(
        self, home: Path, allow_control: str = "edit", extra_args: tuple[str, ...] = ()
    ) -> None:
        self.home = home
        self.port = _free_port()
        self._log = (home / "serve.log").open("w")
        env = {
            **os.environ,
            "GRAPHMIND_HOME": str(home),
            "GRAPHMIND_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
        }
        env.pop("GRAPHMIND_URL", None)
        self.process = subprocess.Popen(
            [
                str(NODE),
                str(CLI),
                "serve",
                "--port",
                str(self.port),
                "--db",
                str(home / "graphmind.db"),
                f"--allow-control={allow_control}",
                *extra_args,
                "--json",
            ],
            stdout=subprocess.PIPE,
            # A file, not a pipe nobody drains: the hub's log can never block it.
            stderr=self._log,
            env=env,
            text=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        if not line:
            self.close()
            log = (home / "serve.log").read_text(errors="replace")
            raise RuntimeError(f"graphmind serve did not start: {log[-2000:]}")
        started = json.loads(line)
        assert started["port"] == self.port
        run_file = home / "run" / f"serve-{self.port}.json"
        self.agent_token: str = json.loads(run_file.read_text())["agentToken"]
        self.base = f"http://127.0.0.1:{self.port}"

    @property
    def ingest_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ingest"

    def request(
        self, method: str, path: str, body: Any = None, token: str | None = None
    ) -> tuple[int, Any]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"content-type": "application/json"} if body is not None else {}
        if token is not None:
            headers["authorization"] = f"Bearer {token}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null")

    def resume(self, run_id: str, pause_id: str, body: dict[str, Any]) -> tuple[int, Any]:
        return self.request(
            "POST",
            f"/api/runs/{run_id}/pauses/{pause_id}/resume",
            {**body, "timeoutMs": 10_000},
            self.agent_token,
        )

    def wait_for_pause(self, predicate: Any, timeout: float = 10.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            _status, body = self.request("GET", "/api/pauses?wait=1")
            for pause in body.get("pauses", []):
                if predicate(pause):
                    return pause
        raise AssertionError("no matching pause appeared on the hub")

    def set_breakpoint(self, matcher: dict[str, Any]) -> None:
        """``breakpoint.set`` over ``/ws/ui`` with the agent token (level edit >= resume)."""
        from websockets.asyncio.client import connect

        async def send() -> None:
            async with connect(
                f"ws://127.0.0.1:{self.port}/ws/ui",
                additional_headers={"authorization": f"Bearer {self.agent_token}"},
            ) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": "control",
                            "envelope": {
                                "gm": 1,
                                "seq": 0,
                                "ts": int(time.time() * 1000),
                                "runId": "*",
                                "type": "breakpoint.set",
                                "payload": {"matcher": matcher},
                            },
                        }
                    )
                )
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    message = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    if message.get("type") == "error":
                        raise AssertionError(f"breakpoint refused: {message}")
                    if message.get("type") == "state" and matcher in message.get(
                        "state", message
                    ).get("breakpoints", []):
                        return
                raise AssertionError("the hub never confirmed the breakpoint")

        asyncio.run(send())

    def events(self, run_id: str) -> list[dict[str, Any]]:
        _status, body = self.request("GET", f"/api/runs/{run_id}/events")
        return body["events"]

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.process.stdout is not None:
            self.process.stdout.close()
        self._log.close()


@pytest.fixture
def hub(tmp_path: Path) -> Any:
    instance = Hub(tmp_path)
    try:
        yield instance
    finally:
        instance.close()


def background(fn: Any) -> concurrent.futures.Future[Any]:
    future: concurrent.futures.Future[Any] = concurrent.futures.Future()

    def run() -> None:
        try:
            future.set_result(fn())
        except BaseException as exc:
            future.set_exception(exc)

    threading.Thread(target=run, daemon=True).start()
    return future


def test_an_editable_tool_gate_edited_through_the_http_resume_endpoint(hub: Hub) -> None:
    _status, session_info = hub.request("GET", "/api/session", token=hub.agent_token)
    assert session_info["principal"] == "agent" and session_info["agentLevel"] == "edit"
    assert "edit-input" in session_info["hubCapabilities"]
    hub.set_breakpoint({"kind": "tool", "name": "search"})

    gm = GraphMind(url=hub.ingest_url, enabled=True, env={}, retry_interval=60.0)
    try:
        assert gm.ready(timeout=5.0) is True
        calls: list[tuple[str, int]] = []

        @gm.tool
        def search(query: str, limit: int = 10) -> str:
            calls.append((query, limit))
            return f"{query}:{limit}"

        def agent() -> str:
            with gm.run("real-hub-edit"):
                return search("AMS", limit=3)

        result = background(agent)
        pause = hub.wait_for_pause(lambda p: p.get("nodeId") == "tool:search")
        assert pause["editable"] is True and pause["point"] == "before"
        run_id, pause_id = pause["runId"], pause["pauseId"]

        # The held node's input, as `graphmind wait` shows it.
        _status, detail = hub.request("GET", f"/api/runs/{run_id}/pauses/{pause_id}")
        assert detail["pause"]["node"]["input"] == {"query": "AMS", "limit": 3}

        # An edit the function cannot take: refused by the SDK (on the host
        # thread, against the signature); the gate stays held.
        status, refused = hub.resume(
            run_id, pause_id, {"action": "continue", "input": {"page": 2}, "requestId": "r-1"}
        )
        assert status == 422, refused
        assert refused["outcome"] == "refused" and refused["code"] == "schema"
        assert "page" in refused.get("message", "")
        assert calls == []

        # A recorded preview is refused by the hub itself (the client's marker list).
        status, preview = hub.resume(
            run_id, pause_id, {"action": "continue", "input": {"query": "AMS…[truncated]"}}
        )
        assert status in (403, 422), preview
        assert preview["outcome"] == "refused" and preview["code"] == "truncated"

        # The fix: top-level keys replace, `limit` keeps its live value.
        status, resumed = hub.resume(
            run_id, pause_id, {"action": "continue", "input": {"query": "LIS"}, "requestId": "r-2"}
        )
        assert status == 200, resumed
        assert resumed["outcome"] == "resumed"
        assert result.result(10) == "LIS:3"
        assert calls == [("LIS", 3)]
    finally:
        gm.dispose()

    events = hub.events(run_id)
    refusals = [e["payload"] for e in events if e["type"] == "exec.refused"]
    assert refusals and refusals[0]["pauseId"] == pause_id and refusals[0]["code"] == "schema"
    answers = [e["payload"] for e in events if e["type"] == "exec.resumed"]
    edited = [a for a in answers if a.get("pauseId") == pause_id]
    assert len(edited) == 1
    assert edited[0]["edited"] == {"after": {"query": "LIS", "limit": 3}}
    assert edited[0]["principal"] == "agent"
    started = [
        e["payload"]
        for e in events
        if e["type"] == "node.started" and e["payload"]["nodeId"] == "tool:search"
    ]
    # The recorded call (and the loop fingerprint) keep what the model asked for.
    assert started[0]["input"] == {"query": "AMS", "limit": 3}


def test_the_default_pause_on_error_gate_is_editable_and_a_retry_with_input_recovers(
    hub: Hub,
) -> None:
    gm = GraphMind(url=hub.ingest_url, enabled=True, env={}, retry_interval=60.0)
    try:
        assert gm.ready(timeout=5.0) is True

        @gm.tool
        def book(flight: str, seat: str) -> str:
            return f"{flight}/{seat}"

        def agent() -> str:
            with gm.run("real-hub-error"):
                return book("TP123")  # the model forgot `seat`

        result = background(agent)
        pause = hub.wait_for_pause(lambda p: p.get("nodeId") == "tool:book")
        assert pause["point"] == "error" and pause["editable"] is True
        status, body = hub.resume(
            pause["runId"], pause["pauseId"], {"action": "retry", "input": {"seat": "12A"}}
        )
        assert status == 200, body
        assert result.result(10) == "TP123/12A"
    finally:
        gm.dispose()


def test_under_no_edit_input_the_gate_is_not_offered_and_plain_resumes_work(
    tmp_path: Path,
) -> None:
    hub = Hub(tmp_path, extra_args=("--no-edit-input",))
    try:
        _status, session_info = hub.request("GET", "/api/session", token=hub.agent_token)
        assert "edit-input" not in session_info["hubCapabilities"]
        gm = GraphMind(url=hub.ingest_url, enabled=True, env={}, retry_interval=60.0)
        try:
            assert gm.ready(timeout=5.0) is True

            @gm.tool
            def book(flight: str, seat: str) -> str:
                return f"{flight}/{seat}"

            result = background(lambda: book("TP123"))
            pause = hub.wait_for_pause(lambda p: p.get("nodeId") == "tool:book")
            assert pause.get("editable") is not True
            status, body = hub.resume(
                pause["runId"], pause["pauseId"], {"action": "retry", "input": {"seat": "1A"}}
            )
            assert status == 403 and body["outcome"] == "refused", body
            status, body = hub.resume(pause["runId"], pause["pauseId"], {"action": "continue"})
            assert status == 200, body
            with pytest.raises(TypeError):
                result.result(10)
        finally:
            gm.dispose()
    finally:
        hub.close()
