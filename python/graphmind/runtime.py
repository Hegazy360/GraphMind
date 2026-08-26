"""The background asyncio loop that owns every GraphMind socket.

Most production Python agent code is **synchronous**, and a lot of the rest is
asyncio. Rather than pick a side, the whole transport lives on one dedicated
daemon thread running its own event loop:

* sync user code never needs an event loop to be debugged;
* async user code is never blocked by socket I/O, and its own loop is never
  touched (no ``nest_asyncio``, no loop hijacking, no ``run_until_complete``);
* gates resolve from this thread into either world through
  :class:`concurrent.futures.Future`.

The thread is a daemon and every scheduled callback is guarded, so a broken
debugger can neither keep the interpreter alive nor raise into the host. The
loop is re-created after ``fork()`` so pre-forking servers (gunicorn, uvicorn
workers, Celery) keep working in the child.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import threading
from concurrent.futures import Future
from typing import Any, Callable, Coroutine, List, Optional


class Runtime:
    """A lazily started daemon thread hosting one asyncio event loop."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()

    # -- lifecycle ------------------------------------------------------------

    def ensure_started(self) -> Optional[asyncio.AbstractEventLoop]:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            return loop
        with self._lock:
            loop = self._loop
            if loop is not None and not loop.is_closed():
                return loop
            self._ready.clear()
            try:
                new_loop = asyncio.new_event_loop()
            except Exception:
                return None
            thread = threading.Thread(
                target=self._run, args=(new_loop,), name="graphmind", daemon=True
            )
            self._loop = new_loop
            self._thread = thread
            thread.start()
            # Bounded: if the interpreter cannot start the thread we fall back
            # to "detached" rather than hanging the host.
            if not self._ready.wait(timeout=2.0):
                return None
            return new_loop

    def _run(self, loop: asyncio.AbstractEventLoop) -> None:
        asyncio.set_event_loop(loop)
        loop.call_soon(self._ready.set)
        try:
            loop.run_forever()
        except Exception:  # pragma: no cover - run_forever only raises on bugs
            pass
        finally:
            try:
                pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True)
                    )
            except Exception:
                pass
            try:
                loop.close()
            except Exception:
                pass

    @property
    def loop(self) -> Optional[asyncio.AbstractEventLoop]:
        loop = self._loop
        if loop is None or loop.is_closed():
            return None
        return loop

    def is_runtime_thread(self) -> bool:
        return threading.current_thread() is self._thread

    # -- scheduling -----------------------------------------------------------

    def call_soon(self, fn: Callable[..., Any], *args: Any) -> bool:
        """Schedule ``fn`` on the loop thread. FIFO, thread-safe, never raises."""
        loop = self.ensure_started()
        if loop is None:
            return False
        try:
            loop.call_soon_threadsafe(_guarded, fn, args)
            return True
        except RuntimeError:
            # Loop closed between the check and the call.
            return False
        except Exception:
            return False

    def spawn(self, coro: "Coroutine[Any, Any, Any]") -> bool:
        """Fire-and-forget a coroutine on the loop thread."""
        loop = self.ensure_started()
        if loop is None:
            coro.close()
            return False
        try:
            loop.call_soon_threadsafe(_spawn_on_loop, loop, coro)
            return True
        except Exception:
            try:
                coro.close()
            except Exception:
                pass
            return False

    def submit(self, coro: "Coroutine[Any, Any, Any]") -> "Optional[Future[Any]]":
        """Run a coroutine on the loop thread and return a waitable future."""
        loop = self.ensure_started()
        if loop is None:
            coro.close()
            return None
        try:
            return asyncio.run_coroutine_threadsafe(coro, loop)
        except Exception:
            try:
                coro.close()
            except Exception:
                pass
            return None

    def stop(self) -> None:
        """Stop the loop and let the daemon thread exit. Idempotent."""
        with self._lock:
            loop = self._loop
            thread = self._thread
            self._loop = None
            self._thread = None
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:
            return
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def _reset_after_fork(self) -> None:
        # The loop thread does not survive fork(); forget it so the next use
        # starts a fresh one in this process.
        self._loop = None
        self._thread = None
        self._ready = threading.Event()
        self._lock = threading.Lock()


def _guarded(fn: Callable[..., Any], args: Any) -> None:
    try:
        fn(*args)
    except Exception:
        pass


def _spawn_on_loop(loop: asyncio.AbstractEventLoop, coro: "Coroutine[Any, Any, Any]") -> None:
    try:
        task = loop.create_task(coro)
        # Keep a strong reference: bare tasks can be GC'd mid-flight.
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)
    except Exception:
        try:
            coro.close()
        except Exception:
            pass


_BACKGROUND_TASKS: "set[asyncio.Task[Any]]" = set()

#: Process-wide runtime. One loop thread serves every session.
runtime = Runtime()

#: Sessions register a shutdown hook so gates fail open at interpreter exit.
_shutdown_hooks: "List[Callable[[], None]]" = []
_shutdown_lock = threading.Lock()


def register_shutdown_hook(hook: Callable[[], None]) -> None:
    with _shutdown_lock:
        _shutdown_hooks.append(hook)


def unregister_shutdown_hook(hook: Callable[[], None]) -> None:
    with _shutdown_lock:
        try:
            _shutdown_hooks.remove(hook)
        except ValueError:
            pass


@atexit.register
def _shutdown() -> None:
    with _shutdown_lock:
        hooks = list(_shutdown_hooks)
        _shutdown_hooks.clear()
    for hook in hooks:
        try:
            hook()
        except Exception:
            pass
    runtime.stop()


if hasattr(os, "register_at_fork"):  # pragma: no branch - always true on POSIX
    os.register_at_fork(after_in_child=runtime._reset_after_fork)
