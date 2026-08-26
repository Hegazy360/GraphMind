"""Bounded FIFO with drop-oldest semantics, for replay-on-attach.

Events emitted while no debugger is attached are retained here so that a
viewer attaching mid-run immediately sees the run so far. Envelopes keep their
original ``seq``, so viewers deduplicate the replay (decisions.md #5).
"""

from __future__ import annotations

from collections import deque
from typing import Deque, Generic, List, TypeVar

T = TypeVar("T")


class RingBuffer(Generic[T]):
    __slots__ = ("_items", "_dropped", "capacity")

    def __init__(self, capacity: int) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise ValueError(f"RingBuffer capacity must be a positive integer, got {capacity!r}")
        self.capacity = capacity
        self._items: Deque[T] = deque(maxlen=capacity)
        self._dropped = 0

    def push(self, item: T) -> None:
        if len(self._items) == self.capacity:
            self._dropped += 1
        self._items.append(item)

    def to_list(self) -> List[T]:
        """Oldest-to-newest snapshot. Does not consume."""
        return list(self._items)

    def clear(self) -> None:
        self._items.clear()

    @property
    def size(self) -> int:
        return len(self._items)

    @property
    def dropped(self) -> int:
        """Total items dropped since construction (diagnostics)."""
        return self._dropped
