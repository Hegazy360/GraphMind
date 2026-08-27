"""Overhead budgets.

Instrumentation you have to remember to remove is instrumentation nobody uses,
so the disabled and detached paths are measured, not asserted by hand-wave.
Budgets are generous (CI machines are noisy) but tight enough to catch a
regression that puts real work on the hot path.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

ITERATIONS = 2000


def _per_call_us(fn: Callable[[], Any], iterations: int = ITERATIONS) -> float:
    fn()  # warm up
    start = time.perf_counter()
    for _ in range(iterations):
        fn()
    return (time.perf_counter() - start) / iterations * 1e6


def test_disabled_wrapper_is_effectively_free(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", enabled=False)

    def raw(a: int, b: int) -> int:
        return a + b

    wrapped = instance.tool(raw)

    baseline = _per_call_us(lambda: raw(1, 2))
    instrumented = _per_call_us(lambda: wrapped(1, 2))
    overhead = instrumented - baseline

    print(
        f"\ndisabled: baseline={baseline:.2f}us wrapped={instrumented:.2f}us "
        f"overhead={overhead:.2f}us/call"
    )
    assert overhead < 20, f"disabled overhead {overhead:.2f}us/call is too high"


def test_detached_wrapper_stays_well_under_a_millisecond(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)

    def raw(a: int, b: int) -> int:
        return a + b

    wrapped = instance.tool(raw)
    wrapped(1, 2)
    assert instance.attached is False

    baseline = _per_call_us(lambda: raw(1, 2))
    instrumented = _per_call_us(lambda: wrapped(1, 2))
    overhead = instrumented - baseline

    print(
        f"\ndetached: baseline={baseline:.2f}us wrapped={instrumented:.2f}us "
        f"overhead={overhead:.2f}us/call"
    )
    # Detached still serializes two envelopes into the replay ring buffer.
    assert overhead < 1000, f"detached overhead {overhead:.2f}us/call exceeds the 1ms budget"


def test_detached_gate_is_a_constant_time_fast_path(make_gm: Any) -> None:
    from graphmind.gate import CONTINUE, GateNode

    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05)
    node = GateNode("tool:x", "tool", "x")
    session = instance.session
    assert session.gate("before", node) is CONTINUE

    per_call = _per_call_us(lambda: session.gate("before", node), 20000)
    print(f"\ndetached gate: {per_call:.3f}us/call")
    assert per_call < 20, f"detached gate costs {per_call:.3f}us/call"


def test_the_ring_buffer_bounds_memory_when_detached(make_gm: Any) -> None:
    instance = make_gm(url="ws://127.0.0.1:1/ingest", connect_timeout=0.05, buffer_size=64)

    @instance.tool
    def work(n: int) -> int:
        return n

    for n in range(200):
        work(n)

    stats = instance.stats()
    assert stats.buffered == 64
    assert stats.dropped > 300
    assert stats.seq > 400
