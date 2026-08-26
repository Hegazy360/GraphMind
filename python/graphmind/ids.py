"""Node identity (decisions.md #1) and compact unique ids.

``node_id`` is stable per **logical** node, so the canvas renders one node per
code location; ``instance_id`` distinguishes repeated executions (tool call id,
step index, run id). Concurrent executions of the same logical node are told
apart purely by ``instance_id`` — which is why every ``node.finished`` /
``node.error`` this package emits carries one.
"""

from __future__ import annotations

import itertools
import os
import uuid

#: The single logical LLM node of a provider-SDK agent loop (matches the
#: TypeScript adapter, so the viewer renders Python and TS runs identically).
LLM_NODE_ID = "llm:step"
LLM_NODE_NAME = "step"


def tool_node_id(tool_name: str) -> str:
    return f"tool:{tool_name}"


def agent_node_id(run_name: str) -> str:
    return f"agent:{run_name}"


def llm_node_id(name: str) -> str:
    return f"llm:{name}"


def chain_node_id(name: str) -> str:
    return f"chain:{name}"


def retriever_node_id(name: str) -> str:
    return f"retriever:{name}"


def _base() -> str:
    return uuid.uuid4().hex[:6]


_base_value = _base()
_counter = itertools.count(1)


def new_id(prefix: str) -> str:
    """Globally unique id (runs)."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def next_id(prefix: str) -> str:
    """Compact per-process unique id (pauses, fallback instance ids)."""
    return f"{prefix}_{_base_value}_{next(_counter)}"


def _reset_after_fork() -> None:
    """Re-seed so a forked worker cannot mint ids that collide with its parent."""
    global _base_value, _counter
    _base_value = _base()
    _counter = itertools.count(1)


if hasattr(os, "register_at_fork"):  # pragma: no branch - always true on POSIX
    os.register_at_fork(after_in_child=_reset_after_fork)
