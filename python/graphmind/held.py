"""Held-time ledger: how much of a node instance's wall-clock duration was the
*debugger* holding it, rather than the node running.

Port of ``packages/client/src/held-ledger.ts`` — read that file's header for
the full rationale. In short: ``durationMs`` keeps its meaning (wall clock,
held time INCLUDED, so stored runs and importers are unaffected) and the
loose field ``heldMs`` on ``node.finished`` / ``node.error`` is the debugger's
share; "ran" is ``durationMs - heldMs``.

Attribution pins a hold to one of the node's open instances when it opens:

* ``before`` / ``error`` gates -> the most recently started open instance
  (for ``error``, an instance ``node.error`` named is preferred);
* ``after`` gates -> the oldest open instance;
* no open instance -> not attributed (a hold that opens after an instance
  finished is not inside that instance's ``durationMs``).

The hold is also pinned to every open *ancestor* instance (following the
``parentId`` from ``node.started``) and to the run's root instance — the node
whose ``instanceId`` is the ``runId``, which is how every SDK emits the
``agent:<run>`` node — because a tool held for 40 s sits inside the agent
node's 45 s too, whether or not the tool declared a parent. Each instance
accumulates the UNION of the intervals during which at least one hold pinned
to it was open, so two children held at the same time do not count twice in
their parent.

Exact whenever executions of one logical node do not overlap; a documented
heuristic for overlapping instances of the same node.

Thread-safe (one lock, never held while calling out), bounded, never raises.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

from .clock import monotonic_ms, normalize_duration_ms

DEFAULT_MAX_TRACKED_INSTANCES = 10_000
_MAX_DEPTH = 64


class _Instance:
    __slots__ = ("errored", "held_ms", "held_since", "instance_id", "key", "node_key", "open_holds")

    def __init__(
        self, key: tuple[str, str, str], node_key: tuple[str, str], instance_id: str
    ) -> None:
        self.key = key
        self.node_key = node_key
        self.instance_id = instance_id
        #: Union of closed held intervals so far (raw ms on the ledger clock).
        self.held_ms = 0.0
        #: Holds currently open against this instance (directly or via a descendant).
        self.open_holds = 0
        #: Clock reading when ``open_holds`` went 0 -> 1.
        self.held_since = 0.0
        self.errored = False


class HeldLedger:
    """Pins gate holds to node instances and sums the time each was held."""

    def __init__(
        self,
        max_instances: int = DEFAULT_MAX_TRACKED_INSTANCES,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._max = max(1, int(max_instances))
        self._clock = clock if clock is not None else monotonic_ms
        self._lock = threading.Lock()
        # dict preserves insertion order -> oldest-first eviction
        self._instances: dict[tuple[str, str, str], _Instance] = {}
        self._by_node: dict[tuple[str, str], list[_Instance]] = {}
        self._parent_by_node: dict[tuple[str, str], str] = {}
        # run_id -> the open instance whose instance_id is the run_id (the agent node)
        self._root_by_run: dict[str, _Instance] = {}
        # pause_id -> every instance the hold is pinned to (target first)
        self._holds: dict[str, list[_Instance]] = {}

    # -- instance lifecycle ---------------------------------------------------

    def started(
        self, run_id: str, node_id: str, instance_id: str, parent_id: str | None = None
    ) -> None:
        node_key = (run_id, node_id)
        key = (run_id, node_id, instance_id)
        with self._lock:
            existing = self._instances.get(key)
            if existing is not None:
                self._remove(existing)
            if len(self._instances) >= self._max:
                self._remove(next(iter(self._instances.values())))
            if len(self._parent_by_node) >= self._max * 4:
                self._parent_by_node.clear()
            if isinstance(parent_id, str) and parent_id != node_id:
                self._parent_by_node[node_key] = parent_id
            instance = _Instance(key, node_key, instance_id)
            self._instances[key] = instance
            if instance_id == run_id:
                self._root_by_run[run_id] = instance
            self._by_node.setdefault(node_key, []).append(instance)

    def errored(self, run_id: str, node_id: str, instance_id: str | None) -> None:
        with self._lock:
            instance = self._pick(run_id, node_id, instance_id)
            if instance is not None:
                instance.errored = True

    def peek(self, run_id: str, node_id: str, instance_id: str | None) -> float | None:
        """Held so far for an open instance (a hold open right now included);
        ``None`` when the instance is unknown."""
        now = self._clock()
        with self._lock:
            instance = self._pick(run_id, node_id, instance_id)
            return None if instance is None else self._total(instance, now)

    def finished(self, run_id: str, node_id: str, instance_id: str | None) -> float | None:
        """Close the instance and return its held total; ``None`` when unknown.

        A hold still open against it is credited up to now (that time IS inside
        the ``durationMs`` just measured) and unpinned from it.
        """
        now = self._clock()
        with self._lock:
            instance = self._pick(run_id, node_id, instance_id)
            if instance is None:
                return None
            held = self._total(instance, now)
            self._remove(instance)
            return held

    # -- holds ----------------------------------------------------------------

    def hold_opened(self, pause_id: str, run_id: str, node_id: str, point: str) -> None:
        now = self._clock()
        with self._lock:
            instances = self._by_node.get((run_id, node_id))
            target: _Instance | None = None
            if instances:
                if point == "after":
                    target = instances[0]
                else:
                    if point == "error":
                        for candidate in reversed(instances):
                            if candidate.errored:
                                target = candidate
                                break
                    if target is None:
                        target = instances[-1]
                    if point == "error":
                        target.errored = False  # one hold per failure
            # No open instance of the held node (LangChain's after/error gates
            # fire AFTER node.finished): the hold is outside every instance of
            # this node's durationMs and must not be charged to the next one —
            # but the open ancestors and the run root are still running while
            # the developer looks, and it IS inside theirs.
            pinned: list[_Instance] = [] if target is None else [target]
            # Ancestors: the newest open instance of each parent up the chain.
            current = (run_id, node_id)
            seen = {current}
            for _ in range(_MAX_DEPTH):
                parent_id = self._parent_by_node.get(current)
                if parent_id is None:
                    break
                parent_key = (run_id, parent_id)
                if parent_key in seen:
                    break
                seen.add(parent_key)
                parents = self._by_node.get(parent_key)
                if parents:
                    pinned.append(parents[-1])
                current = parent_key
            root = self._root_by_run.get(run_id)
            if root is not None and all(root is not p for p in pinned):
                pinned.append(root)
            if not pinned:
                return
            for instance in pinned:
                if instance.open_holds == 0:
                    instance.held_since = now
                instance.open_holds += 1
            self._holds[pause_id] = pinned

    def hold_closed(self, pause_id: str) -> None:
        now = self._clock()
        with self._lock:
            pinned = self._holds.pop(pause_id, None)
            if pinned is None:
                return
            for instance in pinned:
                self._release(instance, now)

    # -- diagnostics ----------------------------------------------------------

    @property
    def tracked_instances(self) -> int:
        with self._lock:
            return len(self._instances)

    @property
    def open_holds(self) -> int:
        with self._lock:
            return len(self._holds)

    # -- internals (call with the lock held) ----------------------------------

    @staticmethod
    def _total(instance: _Instance, now: float) -> float:
        open_ms = max(0.0, now - instance.held_since) if instance.open_holds > 0 else 0.0
        return normalize_duration_ms(instance.held_ms + open_ms)

    @staticmethod
    def _release(instance: _Instance, now: float) -> None:
        if instance.open_holds == 0:
            return
        instance.open_holds -= 1
        if instance.open_holds == 0:
            instance.held_ms += max(0.0, now - instance.held_since)

    def _pick(self, run_id: str, node_id: str, instance_id: str | None) -> _Instance | None:
        instances = self._by_node.get((run_id, node_id))
        if not instances:
            return None
        if instance_id is not None:
            # An unknown instanceId is not "the newest one".
            return self._instances.get((run_id, node_id, instance_id))
        return instances[-1]

    def _remove(self, instance: _Instance) -> None:
        self._instances.pop(instance.key, None)
        run_id = instance.node_key[0]
        if self._root_by_run.get(run_id) is instance:
            self._root_by_run.pop(run_id, None)
        siblings = self._by_node.get(instance.node_key)
        if siblings is not None:
            try:
                siblings.remove(instance)
            except ValueError:
                pass
            if not siblings:
                self._by_node.pop(instance.node_key, None)
        if instance.open_holds > 0:
            for pause_id, pinned in list(self._holds.items()):
                if instance in pinned:
                    pinned.remove(instance)
                    if not pinned:
                        self._holds.pop(pause_id, None)
            instance.open_holds = 0
