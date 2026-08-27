"""Transport: handshake, attach guarantee, replay-on-attach, reconnect."""

from __future__ import annotations

from typing import Any

from graphmind.protocol import PROTOCOL_VERSION

from .conftest import wait_until


def test_hello_carries_protocol_capabilities_and_sdk(attached: Any) -> None:
    _instance, viewer = attached()
    hello = viewer.wait_for_type("hello")

    assert hello["gm"] == PROTOCOL_VERSION
    assert hello["runId"] == "*"
    payload = hello["payload"]
    assert payload["versions"]["protocol"] == PROTOCOL_VERSION
    assert payload["versions"]["client"]
    assert set(payload["capabilities"]) == {"pause", "step", "inject", "retry", "abort"}
    assert payload["sdk"]["name"] == "python"


def test_ready_resolves_true_once_attached(attached: Any) -> None:
    instance, _viewer = attached()
    assert instance.attached is True
    # A second call short-circuits.
    assert instance.ready(timeout=0.1) is True


def test_ready_returns_false_when_no_viewer_listens(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.1)
    assert instance.ready(timeout=1.0) is False
    assert instance.attached is False


def test_ready_returns_false_when_disabled(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", enabled=False)
    assert instance.ready(timeout=0.2) is False


async def test_ready_async_resolves(viewer: Any, make_gm: Any) -> None:
    view = viewer()
    instance = make_gm(url=view.url)
    assert await instance.ready_async(timeout=5.0) is True


def test_breakpoints_and_mode_are_armed_from_hello_ack(attached: Any) -> None:
    instance, _viewer = attached(breakpoints=[{"kind": "tool", "name": "search"}], mode="step")
    breakpoints, mode = instance.session._engine.snapshot()
    assert breakpoints == [{"kind": "tool", "name": "search"}]
    assert mode == "step"


def test_replay_on_attach_resends_buffered_events_with_original_seq(
    viewer: Any, make_gm: Any
) -> None:
    view = viewer()
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    # Emitted while detached: buffered only.
    with instance.run("early"):
        pass
    assert instance.stats().buffered >= 4
    assert view.frames() == []

    # Now point a second instance at the live viewer and re-emit the buffer by
    # attaching: the client replays everything it still holds.
    instance.session._transport._url = view.url
    assert instance.ready(timeout=5.0) is True

    wait_until(lambda: len(view.of_type("run.started")) >= 1, label="replayed run.started")
    replayed = view.of_type("run.started")[0]
    assert replayed["payload"]["meta"]["name"] == "early"
    # Original seq preserved so viewers can deduplicate (decisions.md #5).
    seqs = [f["seq"] for f in view.frames() if f["type"] != "hello"]
    assert seqs == sorted(seqs)


def test_version_mismatch_keeps_the_client_detached(viewer: Any, make_gm: Any) -> None:
    view = viewer(ack_protocol=PROTOCOL_VERSION + 1)
    instance = make_gm(url=view.url)
    assert instance.ready(timeout=1.5) is False
    assert instance.attached is False


def test_handshake_timeout_keeps_the_client_detached(viewer: Any, make_gm: Any) -> None:
    view = viewer(auto_ack=False)
    instance = make_gm(url=view.url, handshake_timeout=0.2)
    assert instance.ready(timeout=1.5) is False
    assert instance.attached is False


def test_reconnect_after_viewer_restart(viewer: Any, make_gm: Any) -> None:
    view = viewer()
    instance = make_gm(url=view.url, retry_interval=0.2)
    assert instance.ready(timeout=5.0) is True

    view.kill_abruptly()
    wait_until(lambda: instance.attached is False, timeout=5.0, label="detach")

    # ready() kicks an immediate reconnect instead of waiting out the interval.
    replacement = viewer()
    instance.session._transport._url = replacement.url
    assert instance.ready(timeout=5.0) is True
